const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local') });
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { prisma } = require('./prisma');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const IORedis = require('ioredis');
const { getPortfolioSummaryForUser, claimPendingWeekEarnings } = require('./services/investmentEarnings');

const REDIS_URL = process.env.REDIS_URL || process.env.REDIS || null;
const hasRedis = Boolean(REDIS_URL);
const redisClient = hasRedis
  ? new IORedis(REDIS_URL, {
      maxRetriesPerRequest: 2,
      connectTimeout: 10000,
    })
  : null;
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 30);

if (redisClient) {
  redisClient.on('connect', () => {
    console.log(`Redis cache connected: ${REDIS_URL}`);
  });
  redisClient.on('error', (err) => {
    console.warn('[Redis] connection error', err?.message || err);
  });
} else {
  console.log('Redis cache disabled: no REDIS_URL configured');
}

async function cacheGet(key) {
  if (!redisClient) return null;
  try {
    const raw = await redisClient.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn('[cacheGet] failed', err?.message || err);
    return null;
  }
}

async function cacheSet(key, value, ttl = CACHE_TTL_SECONDS) {
  if (!redisClient) return;
  try {
    await redisClient.set(key, JSON.stringify(value), 'EX', Math.max(1, ttl));
  } catch (err) {
    console.warn('[cacheSet] failed', err?.message || err);
  }
}

async function cacheDel(...keys) {
  if (!redisClient || keys.length === 0) return;
  try {
    await redisClient.del(...keys);
  } catch (err) {
    console.warn('[cacheDel] failed', err?.message || err);
  }
}

function profileCacheKey(userId) {
  return `profile:${userId}`;
}

function walletCacheKey(userId) {
  return `wallet:${userId}`;
}

function portfolioCacheKey(userId) {
  return `portfolio:${userId}`;
}

function invalidateUserCache(userId) {
  return cacheDel(profileCacheKey(userId), walletCacheKey(userId), portfolioCacheKey(userId));
}

async function cacheUserProfile(user) {
  if (!user) return;
  await cacheSet(profileCacheKey(user.id), {
    user: {
      username: user.username,
      email: user.email,
      phoneNumber: user.phoneNumber,
      balance: user.balance,
    },
  });
}

async function cacheUserWallet(user) {
  if (!user) return;
  await cacheSet(walletCacheKey(user.id), { balance: user.balance });
}

async function cacheUserPortfolio(userId, response) {
  if (!response) return;
  await cacheSet(portfolioCacheKey(userId), response);
}

const app = express();
const port = process.env.PORT || 4000;
const rawEmailUser = (process.env.EMAIL_USER || process.env.SMTP_USER || process.env.ADMIN_EMAIL || '').trim();
const rawEmailPass = (process.env.EMAIL_PASS || process.env.SMTP_PASS || process.env.APP_PASSWORD || '').replace(/\s+/g, '').trim();
const EMAIL_USER = rawEmailUser;
const EMAIL_PASS = rawEmailPass;
const EMAIL_FROM = (process.env.EMAIL_FROM || EMAIL_USER).trim();

if (process.env.EMAIL_PASS && rawEmailPass !== process.env.EMAIL_PASS) {
  console.warn('EMAIL_PASS contained whitespace and was normalized for SMTP auth.');
}

const OTP_EXPIRY_MINUTES = 5;
const OTP_RESEND_DELAY_SECONDS = 60;
const OTP_MAX_VERIFY_ATTEMPTS = 5;

app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json());

function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createId() {
  return crypto.randomBytes(16).toString('hex');
}

function generateOTP() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

async function canSendOTP(email, purpose = 'signup') {
  const lastOtp = await prisma.oTP.findFirst({
    where: { email, purpose },
    orderBy: { createdAt: 'desc' },
  });

  if (!lastOtp) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  const ageSeconds = Math.floor((Date.now() - new Date(lastOtp.createdAt).getTime()) / 1000);
  if (ageSeconds < OTP_RESEND_DELAY_SECONDS) {
    return {
      allowed: false,
      retryAfterSeconds: OTP_RESEND_DELAY_SECONDS - ageSeconds,
    };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

async function createOtpRecord(email, purpose = 'signup') {
  const otp = generateOTP();
  const hashedOtp = await bcrypt.hash(otp, 10);

  await prisma.oTP.deleteMany({ where: { email, purpose } });
  await prisma.oTP.create({
    data: {
      id: createId(),
      email,
      otp: hashedOtp,
      purpose,
      attempts: 0,
      verified: false,
      expiresAt: new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000),
    },
  });

  return otp;
}

async function sendEmailOTP(email, purpose = 'signup') {
  const otp = await createOtpRecord(email, purpose);
  const emailConfigured = Boolean(EMAIL_USER && EMAIL_PASS);

  if (!emailConfigured) {
    console.log(`[signup-otp] Email sender is not configured. OTP for ${email}: ${otp}`);
    throw new Error('Email sender is not configured. Set EMAIL_USER and EMAIL_PASS to send OTP via admin mail.');
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS,
    },
  });

  const mailOptions = {
    from: EMAIL_FROM,
    to: email,
    subject: 'Your signup verification code',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #7c3aed;">Upward Investments</h2>
        <p>Hello,</p>
        <p>Your signup verification code is:</p>
        <div style="background-color: #f3f4f6; padding: 20px; text-align: center; margin: 20px 0;">
          <span style="font-size: 28px; font-weight: bold; color: #7c3aed; letter-spacing: 4px;">${otp}</span>
        </div>
        <p>This code expires in ${OTP_EXPIRY_MINUTES} minutes.</p>
        <p>If you did not request this code, please ignore this email.</p>
        <br />
        <p>Best regards,<br />Upward Investments Team</p>
      </div>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ OTP email sent to ${email}`);
    return otp;
  } catch (error) {
    console.error('[signup-otp] Failed to send OTP email:', error);
    console.log(`[signup-otp] Falling back to logged OTP for ${email}: ${otp}`);
    return otp;
  }
}

async function verifyOTP(email, otp, purpose = 'signup') {
  const otpRecord = await prisma.oTP.findFirst({
    where: {
      email,
      purpose,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!otpRecord) {
    return false;
  }

  const isValid = await bcrypt.compare(otp, otpRecord.otp);
  if (!isValid) {
    const attempts = (otpRecord.attempts ?? 0) + 1;
    if (attempts >= OTP_MAX_VERIFY_ATTEMPTS) {
      await prisma.oTP.delete({ where: { id: otpRecord.id } });
    } else {
      await prisma.oTP.update({ where: { id: otpRecord.id }, data: { attempts } });
    }
    return false;
  }

  await prisma.oTP.update({ where: { id: otpRecord.id }, data: { verified: true } });
  return true;
}

function parseDurationDays(label) {
  const match = label?.match(/(\d+)\s*days?/i);
  return match ? Number(match[1]) : 30;
}

function buildPortfolioPlan(transaction, todayGain = 0) {
  let details = {};
  try {
    if (transaction.investmentDetails) {
      details = typeof transaction.investmentDetails === 'string' 
        ? JSON.parse(transaction.investmentDetails) 
        : transaction.investmentDetails;
    }
  } catch {
    details = {};
  }

  const purchasedAt = transaction.createdAt instanceof Date ? transaction.createdAt : new Date(transaction.createdAt);
  const durationDays = Math.max(parseDurationDays(transaction.investmentDuration || details.durationLabel || '30 Days'), 1);
  const expiresAt = new Date(purchasedAt.getTime() + durationDays * 24 * 60 * 60 * 1000);
  const totalProfit = Number(transaction.totalProfit ?? details.totalProfit ?? Math.max(Number(transaction.expectedReturn || 0) - Number(transaction.amount || 0), 0));
  const workingDays = Number(transaction.workingDays || details.workingDays || 22);
  const dailyProfit = Number(transaction.dailyProfit ?? details.dailyProfit ?? (workingDays ? totalProfit / workingDays : 0));

  return {
    id: transaction.investmentPlanId || transaction.id,
    planName: transaction.investmentName || details.planName || 'Investment Plan',
    planType: details.planType || 'equity',
    amount: Number(transaction.amount || 0),
    amountLabel: details.amountLabel || `₹${Number(transaction.amount || 0).toLocaleString('en-IN')}`,
    returnLabel: details.returnLabel || 'Up to 0%',
    returnPercent: Number(details.returnPercent || 0),
    durationLabel: transaction.investmentDuration || details.durationLabel || '30 Days',
    totalReturn: Number(transaction.expectedReturn || 0),
    totalProfit,
    dailyProfit,
    premium: Boolean(details.premium),
    purchasedAt: purchasedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    workingDays,
    creditedEarnings: Number(transaction.creditedEarnings || 0),
    todayGain: Number(todayGain || 0),
    portfolioEarnings: Number(transaction.creditedEarnings || 0),
    investmentStatus: transaction.investmentStatus,
    transactionId: transaction.transactionId,
  };
}

function getAuthToken(req) {
  const bearer = req.headers.authorization?.toString();
  if (bearer?.startsWith('Bearer ')) {
    return bearer.slice(7).trim();
  }
  const cookieHeader = req.headers.cookie?.toString();
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|; )session=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

async function getSessionFromRequest(req) {
  const token = getAuthToken(req);
  if (!token) return null;
  const session = await prisma.session.findUnique({ where: { token } });
  if (!session || session.expiresAt < new Date()) return null;
  return session;
}

function toIndiaMidnight(date) {
  const local = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  local.setHours(0, 0, 0, 0);
  return local;
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/login', async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) {
    return res.status(400).json({ error: 'Identifier and password are required' });
  }

  const user = await prisma.user.findFirst({
    where: {
      OR: [{ email: identifier }, { phoneNumber: identifier }],
    },
  });

  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = createToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      id: createId(),
      email: user.email,
      token,
      userId: user.id,
      expiresAt,
      updatedAt: new Date(),
    },
  });

  const safeUser = {
    username: user.username,
    email: user.email,
    phoneNumber: user.phoneNumber,
    balance: user.balance,
  };

  res.json({ user: safeUser, token });
});

app.post('/api/register/send-otp', async (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  const existingEmail = await prisma.user.findUnique({ where: { email } });
  if (existingEmail) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const rateLimit = await canSendOTP(email, 'signup');
  if (!rateLimit.allowed) {
    return res.status(429).json({
      error: `Please wait ${rateLimit.retryAfterSeconds} seconds before requesting a new OTP.`,
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
  }

  try {
    await sendEmailOTP(email, 'signup');
  } catch (error) {
    console.error('[signup-otp] Failed to send email', error);
    return res.status(500).json({ error: 'Unable to send verification email right now.' });
  }

  res.json({
    message: 'OTP sent to your email address.',
  });
});

app.post('/api/register/verify-otp', async (req, res) => {
  const { email, otp } = req.body || {};
  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required' });
  }

  const isValid = await verifyOTP(email, otp, 'signup');
  if (!isValid) {
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }

  res.json({ message: 'OTP verified successfully' });
});

app.post('/api/register', async (req, res) => {
  const { username, email, password, phoneNumber } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email, and password are required' });
  }

  const existingEmail = await prisma.user.findUnique({ where: { email } });
  if (existingEmail) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const existingUsername = await prisma.user.findUnique({ where: { username } });
  if (existingUsername) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  if (phoneNumber) {
    const existingPhone = await prisma.user.findUnique({ where: { phoneNumber } });
    if (existingPhone) {
      return res.status(409).json({ error: 'Phone number already registered' });
    }
  }

  const otpRecord = await prisma.oTP.findFirst({
    where: {
      email,
      purpose: 'signup',
      verified: true,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!otpRecord) {
    return res.status(403).json({ error: 'Please verify your email OTP before creating the account' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: {
      id: createId(),
      username,
      email,
      phoneNumber,
      password: hashedPassword,
      balance: 0,
    },
  });

  await prisma.oTP.deleteMany({ where: { email, purpose: 'signup' } });

  res.json({ message: 'Registration successful', userId: user.id });
});

app.get('/api/profile', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const cacheKey = profileCacheKey(session.userId);
  const cached = await cacheGet(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const response = { user: { username: user.username, email: user.email, phoneNumber: user.phoneNumber, balance: user.balance } };
  await cacheSet(cacheKey, response);
  res.json(response);
});

app.get('/api/wallet/balance', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const cacheKey = walletCacheKey(session.userId);
  const cached = await cacheGet(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const transactions = await prisma.transaction.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  const response = { balance: user.balance, transactions };
  await cacheSet(cacheKey, response);
  res.json(response);
});

app.get('/api/portfolio', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const cacheKey = portfolioCacheKey(session.userId);
  const cached = await cacheGet(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    const response = await getPortfolioSummaryForUser({ userId: session.userId, referenceDate: new Date() });
    await cacheSet(cacheKey, response);
    return res.json(response);
  } catch (error) {
    const message = error?.message || 'Unable to load portfolio.';
    return res.status(404).json({ error: message });
  }
});

app.post('/api/investment/claim-weekly-earnings', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  try {
    const result = await claimPendingWeekEarnings({ userId: session.userId, referenceDate: new Date() });
    return res.json(result);
  } catch (error) {
    const message = error?.message || 'Unable to claim weekly earnings.';
    const status = error?.statusCode || 500;
    return res.status(status).json({ error: message });
  }
});

app.post('/api/portfolio/purchase', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const payload = req.body || {};
  const { planId, planName, planType, amount, amountLabel, returnLabel, returnPercent, durationLabel, totalReturn, premium } = payload;

  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Plan amount is required' });
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (user.balance < Number(amount)) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  const purchasedAt = new Date();
  const durationDays = Math.max(parseDurationDays(durationLabel || '30 Days'), 1);
  const expiresAt = new Date(purchasedAt.getTime() + durationDays * 24 * 60 * 60 * 1000);

  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: { balance: { decrement: Number(amount) } },
  });

  const transaction = await prisma.transaction.create({
    data: {
      id: createId(),
      type: 'investment',
      amount: Number(amount),
      status: 'completed',
      description: `Purchased ${planName || 'Investment Plan'}`,
      transactionId: `INV-${Date.now()}`,
      userId: user.id,
      investmentPlanId: planId,
      investmentName: planName,
      investmentDuration: durationLabel,
      expectedReturn: Number(totalReturn || 0),
      investmentDetails: JSON.stringify({
        planType,
        amountLabel,
        returnLabel,
        returnPercent,
        premium,
        expiresAt: expiresAt.toISOString(),
      }),
    },
  });

  const transactions = await prisma.transaction.findMany({
    where: { userId: user.id, type: 'investment' },
    orderBy: { createdAt: 'desc' },
  });
  const plans = transactions.map(buildPortfolioPlan);
  const portfolioResponse = { balance: updatedUser.balance, plans, totalInvested: plans.reduce((sum, plan) => sum + plan.amount, 0) };

  await Promise.all([
    cacheUserProfile({ ...user, balance: updatedUser.balance }),
    cacheUserWallet(updatedUser),
    cacheUserPortfolio(user.id, portfolioResponse),
  ]).catch((err) => {
    console.warn('[cache] warm up failed after portfolio purchase', err?.message || err);
  });

  res.json(portfolioResponse);
});

app.post('/api/wallet/deposit', async (req, res) => {
  const session = await getSessionFromRequest(req);
  const { amount, paymentMethod } = req.body;
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }
  if (!amount || amount < 100) {
    return res.status(400).json({ error: 'Deposit amount must be at least 100' });
  }

  const user = await prisma.user.update({
    where: { id: session.userId },
    data: { balance: { increment: amount } },
  });

  const transaction = await prisma.transaction.create({
    data: {
      id: createId(),
      type: 'deposit',
      amount,
      status: 'completed',
      paymentMethod,
      description: 'Deposit to wallet',
      transactionId: `DEP-${Date.now()}`,
      userId: user.id,
    },
  });

  await Promise.all([
    cacheUserProfile(user),
    cacheUserWallet(user),
    cacheDel(portfolioCacheKey(user.id)),
  ]).catch((err) => {
    console.warn('[cache] warm up failed after wallet deposit', err?.message || err);
  });

  res.json({ balance: user.balance, orderId: transaction.transactionId });
});

app.post('/api/wallet/withdraw', async (req, res) => {
  const session = await getSessionFromRequest(req);
  const { amount, paymentMethod } = req.body;
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }
  if (!amount || amount < 100) {
    return res.status(400).json({ error: 'Withdrawal amount must be at least 100' });
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  if (user.balance < amount) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: { balance: { decrement: amount } },
  });

  await prisma.transaction.create({
    data: {
      id: createId(),
      type: 'withdraw',
      amount,
      status: 'pending',
      paymentMethod,
      description: 'Withdrawal request',
      transactionId: `WDR-${Date.now()}`,
      userId: user.id,
    },
  });

  await Promise.all([
    cacheUserProfile({ ...user, balance: updatedUser.balance }),
    cacheUserWallet(updatedUser),
    cacheDel(portfolioCacheKey(user.id)),
  ]).catch((err) => {
    console.warn('[cache] warm up failed after withdrawal', err?.message || err);
  });

  res.json({ balance: updatedUser.balance, message: 'Withdrawal request submitted' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => {
  console.log(`Backend server running on http://localhost:${port}`);
});
