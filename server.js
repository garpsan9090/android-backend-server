const path = require('path');
const dotenvPath = path.resolve(__dirname, '.env.local');
require('dotenv').config({ path: dotenvPath });
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { prisma } = require('./prisma');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const axios = require('axios');
const IORedis = require('ioredis');
const { authenticator } = require('otplib');
const { getPortfolioSummaryForUser, claimPendingWeekEarnings } = require('./services/investmentEarnings');

const REDIS_URL = process.env.REDIS_URL || process.env.REDIS || null;
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || null;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || null;

const hasRedis = Boolean(REDIS_URL);
const hasUpstashRest = Boolean(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);
let redisClient = null;

function createUpstashRedisClient(baseUrl, token) {
  const client = axios.create({
    baseURL: baseUrl,
    timeout: 10000,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  async function execute(command) {
    const response = await client.post('', command);
    if (response.data?.error) {
      throw new Error(response.data.error);
    }
    return response.data?.result;
  }

  return {
    get: async (key) => execute(['get', key]),
    set: async (key, value, mode, ttl) => {
      const command = mode === 'EX' ? ['set', key, value, 'EX', String(ttl)] : ['set', key, value];
      return execute(command);
    },
    del: async (...keys) => execute(['del', ...keys]),
  };
}

if (hasRedis) {
  redisClient = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: 2,
    connectTimeout: 10000,
  });
} else if (hasUpstashRest) {
  redisClient = createUpstashRedisClient(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN);
}

const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 30);

if (redisClient) {
  if (hasRedis) {
    redisClient.on('connect', () => {
      console.log(`Redis cache connected: ${REDIS_URL}`);
    });
    redisClient.on('error', (err) => {
      console.warn('[Redis] connection error', err?.message || err);
    });
  } else {
    console.log('Redis cache configured via Upstash REST API');
  }
} else {
  console.log('Redis cache disabled: no REDIS_URL or UPSTASH_REDIS_REST_URL configured');
}

// If we have a standard Redis configured, preload user balances and F&O cooldown keys
async function preloadRedisState() {
  if (!hasRedis || !redisClient) return;
  try {
    console.log('[startup] preloading user balances into Redis');
    const users = await prisma.user.findMany({ select: { id: true, balance: true } });
    const pipeline = redisClient.pipeline();
    for (const u of users) {
      pipeline.set(`wallet:balance:${u.id}`, String(Math.max(0, Math.floor(Number(u.balance || 0)))), 'EX', 60 * 60 * 24 * 7); // 7 days
    }
    await pipeline.exec();
    console.log('[startup] preloaded balances into Redis for', users.length, 'users');
  } catch (err) {
    console.warn('[startup] failed to preload Redis state', err?.message || err);
  }
}

preloadRedisState().catch(() => {});

async function cacheGet(key) {
  if (!redisClient) return null;
  // Do not allow slow/unreachable Redis to block API responses.
  if (!redisClient) return null;
  const getPromise = (async () => {
    try {
      const raw = await redisClient.get(key);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        // support legacy values where payload was stored directly
        if (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, 'payload')) {
          return parsed.payload;
        }
        return parsed;
      } catch (e) {
        return raw;
      }
    } catch (err) {
      console.warn('[cacheGet] failed', err?.message || err);
      return null;
    }
  })();

  // If cache doesn't respond quickly, fall back to DB (avoid long waits)
  const timeoutMs = 300; // short timeout for reads
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
  return Promise.race([getPromise, timeout]);
}

async function cacheSet(key, value, ttl = CACHE_TTL_SECONDS) {
  if (!redisClient) return;
  // avoid double-wrapping when caller already provided a wrapper
  let payload;
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'payload') && Object.prototype.hasOwnProperty.call(value, 'lastUpdated')) {
    payload = JSON.stringify(value);
  } else {
    const wrapper = { payload: value, lastUpdated: Date.now() };
    payload = JSON.stringify(wrapper);
  }

  // Try to set quickly; don't block the request path on slow Redis.
  const setOp = (async () => {
    try {
      await redisClient.set(key, payload, 'EX', Math.max(1, ttl));
    } catch (err) {
      throw err;
    }
  })();

  const timeoutMs = 300; // short timeout to avoid long waits
  const timeout = new Promise((resolve) => setTimeout(() => resolve('__CACHE_TIMEOUT__'), timeoutMs));
  const res = await Promise.race([setOp.then(() => 'ok').catch((e) => { throw e; }), timeout]);
  if (res === '__CACHE_TIMEOUT__') {
    console.warn('[cacheSet] timeout, scheduling background retry for', key);
    // Schedule background retries without blocking response
    (function scheduleRetries(attempt = 0) {
      const delays = [1000, 2000, 4000];
      setTimeout(async () => {
        try {
          await redisClient.set(key, payload, 'EX', Math.max(1, ttl));
          console.log('[cacheSet] background retry succeeded for', key);
        } catch (err) {
          if (attempt + 1 < delays.length) {
            scheduleRetries(attempt + 1);
          } else {
            console.warn('[cacheSet] background retries failed for', key, err?.message || err);
          }
        }
      }, delays[Math.min(attempt, delays.length - 1)]);
    })();
  }
}

// Set only if incoming lastUpdated is newer than existing cache entry
async function cacheSetIfNewer(key, value, ttl = CACHE_TTL_SECONDS, lastUpdated = Date.now()) {
  if (!redisClient) return;
  try {
    const raw = await cacheGetRaw(key, 300);
    if (raw && raw.lastUpdated && raw.lastUpdated > lastUpdated) {
      // existing cache is newer; skip
      return;
    }
  } catch (e) {
    // ignore read errors and proceed to set
  }
  const wrapper = { payload: value, lastUpdated };
  await cacheSet(key, wrapper, ttl);
}

// Helper to read raw wrapper (payload + metadata) with timeout
async function cacheGetRaw(key, timeoutMs = 300) {
  if (!redisClient) return null;
  const getPromise = (async () => {
    try {
      const raw = await redisClient.get(key);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    } catch (err) {
      return null;
    }
  })();
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
  return Promise.race([getPromise, timeout]);
}

async function cacheDel(...keys) {
  if (!redisClient || keys.length === 0) return;

  const delOp = (async () => {
    try {
      await redisClient.del(...keys);
    } catch (err) {
      throw err;
    }
  })();

  const timeoutMs = 300;
  const timeout = new Promise((resolve) => setTimeout(() => resolve('__CACHE_TIMEOUT__'), timeoutMs));
  const res = await Promise.race([delOp.then(() => 'ok').catch((e) => { throw e; }), timeout]);
  if (res === '__CACHE_TIMEOUT__') {
    console.warn('[cacheDel] timeout, scheduling background retry for', keys);
    (function scheduleRetries(attempt = 0) {
      const delays = [1000, 2000, 4000];
      setTimeout(async () => {
        try {
          await redisClient.del(...keys);
          console.log('[cacheDel] background retry succeeded for', keys);
        } catch (err) {
          if (attempt + 1 < delays.length) {
            scheduleRetries(attempt + 1);
          } else {
            console.warn('[cacheDel] background retries failed for', keys, err?.message || err);
          }
        }
      }, delays[Math.min(attempt, delays.length - 1)]);
    })();
  }
}

function profileCacheKey(userId) {
  return `profile:${userId}`;
}

function walletBalanceCacheKey(userId) {
  return `wallet:balance:${userId}`;
}

function walletTransactionsCacheKey(userId) {
  return `wallet:transactions:${userId}`;
}

function bankAccountsCacheKey(userId) {
  return `bankAccounts:${userId}`;
}

function portfolioCacheKey(userId) {
  return `portfolio:${userId}`;
}

function invalidateUserCache(userId) {
  return cacheDel(
    profileCacheKey(userId),
    walletBalanceCacheKey(userId),
    walletTransactionsCacheKey(userId),
    bankAccountsCacheKey(userId),
    portfolioCacheKey(userId)
  );
}

async function cacheUserProfile(user) {
  if (!user) return;
  const key = profileCacheKey(user.id);
  const payload = {
    user: {
      username: user.username,
      email: user.email,
      phoneNumber: user.phoneNumber,
      balance: user.balance,
    },
  };
  await cacheSetIfNewer(key, payload, CACHE_TTL_SECONDS, Date.now()).catch(() => {});
}

async function cacheUserWalletBalance(user) {
  if (!user) return;
  await cacheSetIfNewer(walletBalanceCacheKey(user.id), { balance: user.balance }, CACHE_TTL_SECONDS, Date.now()).catch(() => {});
}

async function cacheUserWalletTransactions(userId, transactions) {
  if (!userId || !Array.isArray(transactions)) return;
  await cacheSetIfNewer(walletTransactionsCacheKey(userId), transactions, CACHE_TTL_SECONDS, Date.now()).catch(() => {});
}

async function cacheUserBankAccounts(userId, accounts) {
  if (!userId || !Array.isArray(accounts)) return;
  await cacheSetIfNewer(bankAccountsCacheKey(userId), accounts, CACHE_TTL_SECONDS, Date.now()).catch(() => {});
}

async function cacheUserPortfolio(userId, response) {
  if (!response) return;
  await cacheSetIfNewer(portfolioCacheKey(userId), response, CACHE_TTL_SECONDS, Date.now()).catch(() => {});
}

async function findOrCreateBankAccount(userId, bankAccount) {
  if (!userId || !bankAccount || !bankAccount.accountNumber) return null;

  const accountNumber = String(bankAccount.accountNumber).trim();
  const existing = bankAccount.id
    ? await prisma.bankAccount.findFirst({ where: { id: bankAccount.id, userId } })
    : await prisma.bankAccount.findFirst({ where: { userId, accountNumber } });

  if (existing) {
    return existing.id;
  }

  const newAccount = await prisma.bankAccount.create({
    data: {
      id: createId(),
      userId,
      accountHolderName: String(bankAccount.holder || bankAccount.accountHolderName || 'Unknown').trim(),
      accountNumber,
      ifscCode: String(bankAccount.ifsc || bankAccount.ifscCode || '').trim(),
      bankName: String(bankAccount.bankName || '').trim(),
      branchName: String(bankAccount.branchName || '').trim(),
      isVerified: false,
    },
  });

  return newAccount.id;
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

// Serve the admin static UI at /admin
const adminStaticPath = path.join(__dirname, 'admin');
app.use('/admin', express.static(adminStaticPath));
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(adminStaticPath, 'index.html'));
});

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
    quantity: 1,
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

const TOTP_ISSUER = 'Upward Investments';

function createTwoFactorSecret() {
  return authenticator.generateSecret();
}

function createTwoFactorOtpAuthUrl(email, secret) {
  return authenticator.keyuri(email, TOTP_ISSUER, secret);
}

function verifyTwoFactorCode(code, secret) {
  if (!code || !secret) return false;
  try {
    return authenticator.check(code.trim(), secret.trim());
  } catch (err) {
    return false;
  }
}

function toIndiaMidnight(date) {
  const local = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  local.setHours(0, 0, 0, 0);
  return local;
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// --- Admin endpoints (used by the admin UI served at /admin) ---
app.post('/api/admin/signup', async (req, res) => {
  const { username, password, creationKey } = req.body || {};
  if (!username || !password || !creationKey) return res.status(400).json({ error: 'username, password and creationKey are required' });

  const masterKey = (process.env.ADMIN_CREATION_KEY || '').trim();
  if (!masterKey) return res.status(403).json({ error: 'Admin creation key not configured' });
  if (creationKey !== masterKey) return res.status(403).json({ error: 'Invalid admin creation key' });

  const existing = await prisma.admin.findUnique({ where: { username } });
  if (existing) return res.status(409).json({ error: 'Username already taken' });

  const hashed = await bcrypt.hash(password, 10);
  const secretKey = crypto.randomBytes(24).toString('hex');
  const admin = await prisma.admin.create({ data: { id: createId(), username, password: hashed, secretKey } });

  return res.json({ message: 'Admin created', secretKey: admin.secretKey, adminId: admin.id });
});

app.post('/api/admin/password-reset', async (req, res) => {
  const { username, password, secretKey } = req.body || {};
  if (!username || !password || !secretKey) return res.status(400).json({ error: 'username, password and secretKey are required' });

  const admin = await prisma.admin.findUnique({ where: { username } });
  if (!admin) return res.status(404).json({ error: 'Admin not found' });

  // allow either the admin's secretKey or the master ADMIN_CREATION_KEY to reset
  const masterKey = (process.env.ADMIN_CREATION_KEY || '').trim();
  if (secretKey !== admin.secretKey && secretKey !== masterKey) return res.status(403).json({ error: 'Invalid secret key' });

  const hashed = await bcrypt.hash(password, 10);
  await prisma.admin.update({ where: { id: admin.id }, data: { password: hashed } });
  return res.json({ message: 'Password updated' });
});

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });

  const admin = await prisma.admin.findUnique({ where: { username } });
  if (!admin) return res.status(401).json({ error: 'Invalid credentials' });

  const match = await bcrypt.compare(password, admin.password);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });

  if (admin.twoFactorEnabled) {
    return res.json({ requires2fa: true, adminId: admin.id });
  }

  const token = createToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await prisma.session.create({ data: { id: createId(), email: admin.username, token, userId: null, expiresAt, updatedAt: new Date() } });

  return res.json({ token, admin: { id: admin.id, username: admin.username } });
});

app.get('/api/admin/verify-session', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Invalid session' });
  const admin = await prisma.admin.findUnique({ where: { username: session.email } });
  if (!admin) return res.status(401).json({ error: 'Invalid admin session' });
  return res.json({ admin: { id: admin.id, username: admin.username } });
});

app.post('/api/admin/2fa/setup', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Missing admin token' });
  const admin = await prisma.admin.findUnique({ where: { username: session.email } });
  if (!admin) return res.status(404).json({ error: 'Admin not found' });

  const secret = createTwoFactorSecret();
  const otpauthUrl = createTwoFactorOtpAuthUrl(admin.username, secret);
  await prisma.admin.update({ where: { id: admin.id }, data: { twoFactorSecret: secret } });
  return res.json({ secret, otpauthUrl });
});

app.post('/api/admin/2fa/enable', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Missing admin token' });
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code is required' });
  const admin = await prisma.admin.findUnique({ where: { username: session.email } });
  if (!admin || !admin.twoFactorSecret) return res.status(400).json({ error: 'Two-factor not setup' });
  if (!verifyTwoFactorCode(code, admin.twoFactorSecret)) return res.status(400).json({ error: 'Invalid code' });
  await prisma.admin.update({ where: { id: admin.id }, data: { twoFactorEnabled: true } });
  return res.json({ message: 'Two-factor enabled' });
});

app.post('/api/admin/2fa/verify', async (req, res) => {
  const { adminId, code } = req.body || {};
  if (!adminId || !code) return res.status(400).json({ error: 'adminId and code are required' });
  const admin = await prisma.admin.findUnique({ where: { id: adminId } });
  if (!admin || !admin.twoFactorSecret) return res.status(400).json({ error: 'Invalid admin or 2FA not configured' });
  if (!verifyTwoFactorCode(code, admin.twoFactorSecret)) return res.status(400).json({ error: 'Invalid code' });
  const token = createToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await prisma.session.create({ data: { id: createId(), email: admin.username, token, userId: null, expiresAt, updatedAt: new Date() } });
  return res.json({ token, admin: { id: admin.id, username: admin.username } });
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

  const safeUser = {
    username: user.username,
    email: user.email,
    phoneNumber: user.phoneNumber,
    balance: user.balance,
    twoFactorEnabled: Boolean(user.twoFactorEnabled),
  };

  if (user.twoFactorEnabled) {
    return res.json({ requires2fa: true, email: user.email });
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

  // Fetch fresh DB data for wallet, transactions, bank accounts, and portfolio
  try {
    const transactions = await prisma.transaction.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    const bankAccounts = await prisma.bankAccount.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });

    let portfolio = null;
    try {
      portfolio = await getPortfolioSummaryForUser({ userId: user.id, referenceDate: new Date() });
    } catch (err) {
      console.warn('[login] portfolio load failed', err?.message || err);
    }

    // Warm caches asynchronously but don't block the response
    Promise.all([
      cacheUserWalletBalance(user).catch(() => {}),
      cacheUserWalletTransactions(user.id, transactions).catch(() => {}),
      cacheUserBankAccounts(user.id, bankAccounts).catch(() => {}),
      portfolio ? cacheSetIfNewer(portfolioCacheKey(user.id), portfolio, CACHE_TTL_SECONDS, Date.now()).catch(() => {}) : Promise.resolve(),
    ]).catch(() => {});

    return res.json({ user: safeUser, token, wallet: { balance: user.balance, transactions }, bankAccounts, portfolio });
  } catch (err) {
    console.warn('[login] warm data load failed', err?.message || err);
    return res.json({ user: safeUser, token });
  }
});

app.post('/api/2fa/setup', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (user.twoFactorEnabled) {
    return res.status(400).json({ error: 'Two-factor authentication is already enabled' });
  }

  const secret = user.twoFactorSecret || createTwoFactorSecret();
  const otpauthUrl = createTwoFactorOtpAuthUrl(user.email, secret);

  await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorSecret: secret },
  });

  res.json({ secret, otpauthUrl });
});

app.post('/api/2fa/enable', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const { code } = req.body || {};
  if (!code) {
    return res.status(400).json({ error: 'Verification code is required' });
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  if (!user.twoFactorSecret) {
    return res.status(400).json({ error: 'Two-factor secret is not configured' });
  }

  if (!verifyTwoFactorCode(code, user.twoFactorSecret)) {
    return res.status(400).json({ error: 'Invalid verification code' });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorEnabled: true },
  });

  res.json({ message: 'Two-factor authentication enabled successfully' });
});

app.post('/api/2fa/disable', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorEnabled: false, twoFactorSecret: null },
  });

  res.json({ message: 'Two-factor authentication disabled successfully' });
});

app.post('/api/2fa/verify', async (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) {
    return res.status(400).json({ error: 'Email and verification code are required' });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (!verifyTwoFactorCode(code, user.twoFactorSecret)) {
    return res.status(400).json({ error: 'Invalid verification code' });
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
    twoFactorEnabled: Boolean(user.twoFactorEnabled),
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

  const response = { user: { username: user.username, email: user.email, phoneNumber: user.phoneNumber, balance: user.balance, twoFactorEnabled: Boolean(user.twoFactorEnabled) } };
  await cacheSetIfNewer(cacheKey, response, CACHE_TTL_SECONDS, Date.now()).catch(() => {});
  res.json(response);
});

app.get('/api/wallet/balance', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const balanceCache = await cacheGet(walletBalanceCacheKey(session.userId));
  const transactionsCache = await cacheGet(walletTransactionsCacheKey(session.userId));
  if (balanceCache && transactionsCache) {
    return res.json({ balance: balanceCache.balance, transactions: transactionsCache });
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
  await Promise.all([
    cacheUserWalletBalance(user),
    cacheUserWalletTransactions(user.id, transactions),
  ]).catch((err) => {
    console.warn('[cache] wallet warm up failed', err?.message || err);
  });

  res.json(response);
});

app.get('/api/wallet/bank-accounts', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const cached = await cacheGet(bankAccountsCacheKey(session.userId));
  if (cached) {
    return res.json({ bankAccounts: cached });
  }

  const accounts = await prisma.bankAccount.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: 'desc' },
  });

  await cacheUserBankAccounts(session.userId, accounts).catch((err) => {
    console.warn('[cache] bank accounts warm up failed', err?.message || err);
  });

  res.json({ bankAccounts: accounts });
});

app.post('/api/wallet/bank-accounts', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const { holder, accountNumber, bankName, ifsc, branchName } = req.body || {};
  if (!holder || !accountNumber || !bankName || !ifsc) {
    return res.status(400).json({ error: 'Bank account holder, number, bank name, and IFSC are required' });
  }

  const newAccount = await prisma.bankAccount.create({
    data: {
      id: createId(),
      userId: session.userId,
      accountHolderName: String(holder).trim(),
      accountNumber: String(accountNumber).trim(),
      ifscCode: String(ifsc).trim(),
      bankName: String(bankName).trim(),
      branchName: String(branchName || '').trim(),
      isVerified: false,
    },
  });

  await cacheDel(bankAccountsCacheKey(session.userId)).catch((err) => {
    console.warn('[cache] invalidate bank accounts failed', err?.message || err);
  });

  res.json({ bankAccount: newAccount });
});

app.delete('/api/wallet/bank-accounts/:id', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const accountId = req.params.id;
  if (!accountId) {
    return res.status(400).json({ error: 'Bank account id is required' });
  }

  const existing = await prisma.bankAccount.findFirst({ where: { id: accountId, userId: session.userId } });
  if (!existing) {
    return res.status(404).json({ error: 'Bank account not found' });
  }

  await prisma.bankAccount.delete({ where: { id: accountId } });
  await cacheDel(bankAccountsCacheKey(session.userId)).catch((err) => {
    console.warn('[cache] invalidate bank accounts failed', err?.message || err);
  });

  res.json({ success: true });
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
    await cacheSetIfNewer(cacheKey, response, CACHE_TTL_SECONDS, Date.now()).catch(() => {});
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
    await Promise.all([
      cacheDel(walletBalanceCacheKey(session.userId)),
      cacheDel(portfolioCacheKey(session.userId)),
      cacheDel(walletTransactionsCacheKey(session.userId)),
    ]).catch((err) => {
      console.warn('[cache] invalidate after weekly earnings claim failed', err?.message || err);
    });
    return res.json(result);
  } catch (error) {
    const message = error?.message || 'Unable to claim weekly earnings.';
    const status = error?.statusCode || 500;
    return res.status(status).json({ error: message });
  }
});

app.post('/api/referral/generate', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (user.referralCode) {
    return res.json({ referralCode: user.referralCode });
  }

  // Build a base code from username
  const rawName = String(user.username || 'USER').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const namePart = rawName.slice(0, 4).padEnd(4, 'X');

  // Use phone number last 4 digits if available, otherwise use a hash slice from email
  let digitsPart = '0000';
  if (user.phoneNumber) {
    const digits = String(user.phoneNumber).replace(/\D/g, '');
    digitsPart = digits.slice(-4).padStart(4, '0');
  } else if (user.email) {
    const hash = crypto.createHash('sha256').update(user.email).digest('hex');
    digitsPart = String(parseInt(hash.slice(0, 6), 16) % 10000).padStart(4, '0');
  } else {
    digitsPart = String(Math.floor(1000 + Math.random() * 9000));
  }

  let candidate = `${namePart}${digitsPart}`;
  // Ensure uniqueness
  let tries = 0;
  while (tries < 8) {
    const exists = await prisma.user.findFirst({ where: { referralCode: candidate } });
    if (!exists) break;
    // Append a random 3-digit suffix if collision
    const suffix = String(Math.floor(100 + Math.random() * 900));
    candidate = `${namePart}${digitsPart}${suffix}`.slice(0, 16);
    tries += 1;
  }

  try {
    const updated = await prisma.user.update({ where: { id: user.id }, data: { referralCode: candidate } });
    return res.json({ referralCode: updated.referralCode });
  } catch (err) {
    console.error('[referral] failed to save referral code', err);
    return res.status(500).json({ error: 'Unable to generate referral code' });
  }
});

app.post('/api/portfolio/purchase', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  try {
    console.log('[purchase] incoming request userId=', session?.userId, 'body=', JSON.stringify(req.body));
  } catch (err) {
    console.log('[purchase] incoming request (unable to stringify body)');
  }

  const purchaseStart = Date.now();

  const payload = req.body || {};
  const { planId, planName, planType, amount, amountLabel, returnLabel, returnPercent, durationLabel, totalReturn, premium } = payload;

  // Determine allowed plan amounts per planType
  const numericAmount = Number(amount || 0);
  if (!numericAmount || numericAmount <= 0) {
    return res.status(400).json({ error: 'Plan amount is required' });
  }

  let allowedAmountsForType = [];
  if (planType === 'fno' || planType === 'futures' || planType === 'options') {
    allowedAmountsForType = [10000, 30000, 50000];
  } else if (planType === 'commodities') {
    allowedAmountsForType = [10000, 15000, 25000];
  } else if (planType === 'equity') {
    allowedAmountsForType = [5000, 10000, 20000, 30000, 40000, 50000, 100000, 150000, 200000, 250000, 300000];
  } else {
    // Fallback to the safest small set
    allowedAmountsForType = [10000, 30000, 50000];
  }

  if (!allowedAmountsForType.includes(numericAmount)) {
    return res.status(400).json({ error: 'This plan is not available', supportedAmounts: allowedAmountsForType });
  }

  const planIdValue = String(planId || '').trim();
  if (!planIdValue) {
    return res.status(400).json({ error: 'Plan identifier is required' });
  }

  const quantity = Number(payload.quantity ?? 1);
  if (!quantity || quantity < 1) {
    return res.status(400).json({ error: 'Plan quantity must be at least 1' });
  }
  // For F&O plans enforce single-quantity purchases
  const isFno = (planType === 'fno' || planType === 'futures' || planType === 'options');
  if (isFno && quantity > 1) {
    return res.status(400).json({ error: 'Maximum allowed quantity for F&O plans is 1' });
  }

  // Enforce single-active/30-day cooldown only for F&O plans.
  // To guarantee a client-visible response within ~100ms, run these DB checks with a short timeout.
  // If checks don't complete quickly, we fall back to fast-ack (202) and let the background worker perform final validation.
  async function withTimeout(promise, ms) {
    let settled = false;
    return Promise.race([
      promise.then((r) => ({ ok: true, result: r })).catch((e) => ({ ok: false, error: e })),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), ms)),
    ]);
  }

  let checksTimedOut = false;
  if (isFno) {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const activePromise = prisma.transaction.findFirst({
        where: {
          userId: session.userId,
          type: 'investment',
          investmentPlanId: planIdValue,
          investmentStatus: { in: ['Active', 'Reinvested'] },
        },
      });
      const recentCompletedPromise = prisma.transaction.findFirst({
        where: {
          userId: session.userId,
          type: 'investment',
          investmentPlanId: planIdValue,
          investmentStatus: 'Completed',
          completedAt: { gte: thirtyDaysAgo },
        },
        orderBy: { completedAt: 'desc' },
      });

      const timeoutMs = 80; // keep under 100ms target
      const [activeRes, recentRes] = await Promise.all([
        withTimeout(activePromise, timeoutMs),
        withTimeout(recentCompletedPromise, timeoutMs),
      ]);

      if ((activeRes && activeRes.timeout) || (recentRes && recentRes.timeout)) {
        checksTimedOut = true;
      } else {
        if (activeRes && activeRes.ok && activeRes.result) {
          return res.status(409).json({ code: 'FNO_ACTIVE', error: 'You already have this F&O plan active. Wait until it completes before purchasing again.' });
        }

        const recentCompletedSamePlan = recentRes && recentRes.ok ? recentRes.result : null;
        if (recentCompletedSamePlan && recentCompletedSamePlan.completedAt) {
          const last = new Date(recentCompletedSamePlan.completedAt).getTime();
          const now = Date.now();
          const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
          const elapsed = now - last;
          const remainingMs = Math.max(0, THIRTY_DAYS_MS - elapsed);
          if (remainingMs > 0) {
            const retryAfterSeconds = Math.ceil(remainingMs / 1000);
            const days = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
            const hours = Math.floor((remainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
            const minutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
            const parts = [];
            if (days) parts.push(`${days} day${days > 1 ? 's' : ''}`);
            if (hours) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
            if (!days && minutes) parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
            const retryAfter = parts.length ? parts.join(' ') : 'less than a minute';

            return res.status(409).json({ code: 'FNO_COOLDOWN', error: 'You can purchase this plan again only after 30 days from completion', retryAfterSeconds, retryAfter });
          }
        }
      }
    } catch (err) {
      console.warn('[purchase] F&O checks failed quickly', err?.message || err);
      // If checks fail quickly, allow fast-ack fallback below
      checksTimedOut = true;
    }
  }

  // Fetch user quickly but don't block beyond the 100ms window. If we can't verify balance quickly,
  // fall back to fast-ack and let the background worker perform the definitive check.
  let user = null;
  try {
    const userRes = await withTimeout(prisma.user.findUnique({ where: { id: session.userId } }), 80);
    if (userRes && userRes.ok) {
      user = userRes.result;
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (user.balance < numericAmount) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }
    } else {
      // couldn't verify quickly; mark that checks timed out and continue to fast-ack
      checksTimedOut = true;
    }
  } catch (err) {
    console.warn('[purchase] user lookup failed quickly', err?.message || err);
    checksTimedOut = true;
  }

  // Perform validation and purchase atomically using DB-only flow (no Redis).
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Re-run F&O checks inside the transaction to avoid races
      if (isFno) {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const activeSamePlan = await tx.transaction.findFirst({
          where: {
            userId: session.userId,
            type: 'investment',
            investmentPlanId: planIdValue,
            investmentStatus: { in: ['Active', 'Reinvested'] },
          },
        });
        if (activeSamePlan) {
          const err = new Error('FNO_ACTIVE');
          err.code = 'FNO_ACTIVE';
          throw err;
        }

        const recentCompletedSamePlan = await tx.transaction.findFirst({
          where: {
            userId: session.userId,
            type: 'investment',
            investmentPlanId: planIdValue,
            investmentStatus: 'Completed',
            completedAt: { gte: thirtyDaysAgo },
          },
          orderBy: { completedAt: 'desc' },
        });
        if (recentCompletedSamePlan && recentCompletedSamePlan.completedAt) {
          const last = new Date(recentCompletedSamePlan.completedAt).getTime();
          const now = Date.now();
          const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
          const elapsed = now - last;
          const remainingMs = Math.max(0, THIRTY_DAYS_MS - elapsed);
          if (remainingMs > 0) {
            const retryAfterSeconds = Math.ceil(remainingMs / 1000);
            const days = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
            const hours = Math.floor((remainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
            const minutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
            const parts = [];
            if (days) parts.push(`${days} day${days > 1 ? 's' : ''}`);
            if (hours) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
            if (!days && minutes) parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
            const retryAfter = parts.length ? parts.join(' ') : 'less than a minute';
            const err = new Error('FNO_COOLDOWN');
            err.code = 'FNO_COOLDOWN';
            err.retryAfterSeconds = retryAfterSeconds;
            err.retryAfter = retryAfter;
            throw err;
          }
        }
      }

      // Atomically decrement balance only if sufficient funds
      const updateRes = await tx.user.updateMany({
        where: { id: session.userId, balance: { gte: numericAmount } },
        data: { balance: { decrement: numericAmount } },
      });
      if (!updateRes || updateRes.count === 0) {
        const err = new Error('INSUFFICIENT_BALANCE');
        err.code = 'INSUFFICIENT_BALANCE';
        throw err;
      }

      const purchasedAt = new Date();
      const durationDays = Math.max(parseDurationDays(durationLabel || '30 Days'), 1);
      const expiresAt = new Date(purchasedAt.getTime() + durationDays * 24 * 60 * 60 * 1000);

      const created = await tx.transaction.create({
        data: {
          id: createId(),
          type: 'investment',
          amount: numericAmount,
          status: 'completed',
          description: `Purchased ${planName || 'Investment Plan'}`,
          transactionId: `INV-${Date.now()}`,
          user: { connect: { id: session.userId } },
          investmentPlanId: planIdValue,
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

      const updatedUser = await tx.user.findUnique({ where: { id: session.userId } });
      return { updatedUser, transaction: created };
    });

    // Warm caches asynchronously (fire-and-forget)
    void Promise.all([
      cacheUserProfile({ ...result.updatedUser }),
      cacheUserWalletBalance(result.updatedUser),
      cacheDel(walletTransactionsCacheKey(session.userId)),
      cacheDel(portfolioCacheKey(session.userId)),
    ]).catch(() => {});

    res.json({ balance: result.updatedUser.balance });

    const elapsed = Date.now() - purchaseStart;
    console.log(`[purchase] processed in ${elapsed}ms userId=${session.userId} planId=${planId} amount=${numericAmount}`);
  } catch (err) {
    if (err && err.code === 'FNO_ACTIVE') {
      return res.status(409).json({ code: 'FNO_ACTIVE', error: 'You already have this F&O plan active. Wait until it completes before purchasing again.' });
    }
    if (err && err.code === 'FNO_COOLDOWN') {
      return res.status(409).json({ code: 'FNO_COOLDOWN', error: 'You can purchase this plan again only after 30 days from completion', retryAfterSeconds: err.retryAfterSeconds, retryAfter: err.retryAfter });
    }
    if (err && err.code === 'INSUFFICIENT_BALANCE') {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    console.error('[purchase] unexpected error in transaction', err);
    return res.status(500).json({ error: 'Unable to complete purchase at this time' });
  }
});

function parseWalletAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

app.post('/api/wallet/deposit', async (req, res) => {
  const session = await getSessionFromRequest(req);
  const amount = parseWalletAmount(req.body?.amount);
  const { paymentMethod } = req.body;
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }
  if (amount === null || amount < 100) {
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
      user: { connect: { id: user.id } },
      investmentName: '',
      // optional investment fields omitted for non-investment transactions
    },
  });

  // Warm caches asynchronously to avoid delaying response to client
  void Promise.all([
    cacheUserProfile(user),
    cacheUserWalletBalance(user),
    cacheDel(walletTransactionsCacheKey(user.id)),
    cacheDel(portfolioCacheKey(user.id)),
  ]).catch((err) => {
    console.warn('[cache] warm up failed after wallet deposit', err?.message || err);
  });

  res.json({ balance: user.balance, orderId: transaction.transactionId });
});

app.post('/api/wallet/withdraw', async (req, res) => {
  const session = await getSessionFromRequest(req);
  const amount = parseWalletAmount(req.body?.amount);
  const { paymentMethod, bankAccount } = req.body || {};
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }
  if (amount === null || amount < 100) {
    return res.status(400).json({ error: 'Withdrawal amount must be at least 100' });
  }

  const validPaymentMethods = ['bank', 'upi'];
  if (!paymentMethod || !validPaymentMethods.includes(paymentMethod)) {
    return res.status(400).json({ error: 'Invalid payment method' });
  }

  if (paymentMethod === 'bank') {
    if (!bankAccount || !bankAccount.accountNumber) {
      return res.status(400).json({ error: 'Bank account details are required for bank withdrawals' });
    }
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  if (user.balance < amount) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  let bankAccountId = null;
  if (paymentMethod === 'bank') {
    bankAccountId = await findOrCreateBankAccount(session.userId, bankAccount);
    if (!bankAccountId) {
      return res.status(400).json({ error: 'Invalid bank account details for withdrawal' });
    }
  }

  const [updatedUser] = await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { balance: { decrement: amount } },
    }),
    prisma.transaction.create({
      data: {
        id: createId(),
        type: 'withdraw',
        amount,
        status: 'pending',
        paymentMethod,
        description: 'Withdrawal request',
        transactionId: `WDR-${Date.now()}`,
        user: { connect: { id: user.id } },
        investmentName: '',
        ...(bankAccountId ? { BankAccount: { connect: { id: bankAccountId } } } : {}),
      },
    }),
  ]);

  await prisma.transaction.create({
    data: {
      id: createId(),
      type: 'withdraw',
      amount,
      status: 'pending',
      paymentMethod,
      description: 'Withdrawal request',
      transactionId: `WDR-${Date.now()}`,
      user: { connect: { id: user.id } },
      investmentName: '',
      ...(bankAccountId ? { BankAccount: { connect: { id: bankAccountId } } } : {}),
    },
  });

  // Warm caches asynchronously to avoid delaying response to client
  void Promise.all([
    cacheUserProfile({ ...user, balance: updatedUser.balance }),
    cacheUserWalletBalance(updatedUser),
    cacheDel(walletTransactionsCacheKey(user.id)),
    cacheDel(portfolioCacheKey(user.id)),
    cacheDel(bankAccountsCacheKey(user.id)),
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
