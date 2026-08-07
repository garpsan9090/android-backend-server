const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const envCandidates = [
  path.resolve(__dirname, '.env.local'),
  path.resolve(__dirname, '.env'),
];

const loadedEnvPath = envCandidates.find((envPath) => fs.existsSync(envPath));
if (loadedEnvPath) {
  dotenv.config({ path: loadedEnvPath, override: true });
  console.log(`Loaded backend env file: ${loadedEnvPath}`);
} else {
  console.warn('WARNING: No backend env file found at backend/.env.local or backend/.env.');
}

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { prisma } = require('./prisma');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const {
  processDailyInvestmentEarnings,
  isTradingDay,
  getIndiaMinutes,
  addIndiaDays,
} = require('./services/investmentEarnings');
const {
  buildPortfolioPlan,
  purchaseInvestment,
  reinvestInvestment,
} = require('./services/investmentPurchaseService');
const winston = require('winston');
const app = express();
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});
const port = process.env.PORT || 4000;

// Initialize metrics and optional Sentry
let promClient = null;
try {
  promClient = require('prom-client');
  const collectDefaultMetrics = promClient.collectDefaultMetrics;
  collectDefaultMetrics({ timeout: 5000 });
  app.get('/metrics', async (req, res) => {
    try {
      res.set('Content-Type', promClient.register.contentType);
      res.end(await promClient.register.metrics());
    } catch (err) {
      res.status(500).end(err.message);
    }
  });
} catch (e) {
  logger.warn('[server] prom-client not available', e && e.message ? e.message : e);
}

// Optional Sentry integration
try {
  const Sentry = require('@sentry/node');
  const SENTRY_DSN = process.env.SENTRY_DSN;
  if (SENTRY_DSN) {
    Sentry.init({ dsn: SENTRY_DSN, environment: process.env.NODE_ENV || 'development' });
    app.use(Sentry.Handlers.requestHandler());
    app.use(Sentry.Handlers.errorHandler());
    logger.info('[server] Sentry initialized');
  }
} catch (e) {
  logger.warn('[server] Sentry not available', e && e.message ? e.message : e);
}
const rawEmailUser = (process.env.EMAIL_USER || process.env.SMTP_USER || process.env.ADMIN_EMAIL || '').trim();
const rawEmailPass = (process.env.EMAIL_PASS || process.env.SMTP_PASS || process.env.APP_PASSWORD || '').replace(/\s+/g, '').trim();
const EMAIL_USER = rawEmailUser;
const EMAIL_PASS = rawEmailPass;
const EMAIL_FROM = (process.env.EMAIL_FROM || EMAIL_USER).trim();

if (process.env.EMAIL_PASS && rawEmailPass !== process.env.EMAIL_PASS) {
  console.warn('EMAIL_PASS contained whitespace and was normalized for SMTP auth.');
}

const SMTP_HOST = (process.env.SMTP_HOST || '').trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || '587');
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const emailConfigured = Boolean(EMAIL_USER && EMAIL_PASS && SMTP_HOST);
let emailTransporter = null;
if (emailConfigured) {
  emailTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS,
    },
  });

  emailTransporter.verify().then(() => {
    console.log('✅ Email transporter configured successfully');
  }).catch((error) => {
    console.warn('⚠️ Failed to verify email transporter:', error.message || error);
    emailTransporter = null;
  });
}

const OTP_EXPIRY_MINUTES = 5;
const OTP_MAX_VERIFY_ATTEMPTS = 5;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@upward.com').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || ADMIN_EMAIL).split(',').map((s) => s.trim().toLowerCase());
const ADMIN_CREATION_KEY = (process.env.ADMIN_CREATION_KEY || '').trim();

if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
  console.warn('WARNING: ADMIN_EMAIL and ADMIN_PASSWORD are not fully configured. Using defaults for the admin portal.');
}
if (ADMIN_CREATION_KEY) {
  console.info('Admin signup and password reset require ADMIN_CREATION_KEY.');
}

app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json());
app.use((req, res, next) => {
  logger.info('request', { method: req.method, url: req.originalUrl, host: req.headers.host, ip: req.ip });
  next();
});
app.use('/admin', express.static(path.join(__dirname, 'admin'), {
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  },
}));
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createId() {
  return crypto.randomBytes(16).toString('hex');
}

function encodeBase32(buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of buffer) {
    bits += byte.toString(2).padStart(8, '0');
  }

  let output = '';
  for (let index = 0; index < bits.length; index += 5) {
    const chunk = bits.slice(index, index + 5).padEnd(5, '0');
    output += alphabet[parseInt(chunk, 2)];
  }

  const paddingLength = (8 - (output.length % 8)) % 8;
  return output + '='.repeat(paddingLength);
}

function decodeBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = String(value || '').replace(/=+$/g, '').toUpperCase();
  let bits = '';

  for (const char of cleaned) {
    const index = alphabet.indexOf(char);
    if (index === -1) continue;
    bits += index.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let index = 0; index + 7 < bits.length; index += 8) {
    bytes.push(parseInt(bits.slice(index, index + 8), 2));
  }

  return Buffer.from(bytes);
}

function generateTwoFactorSecret() {
  return encodeBase32(crypto.randomBytes(20)).replace(/=+$/g, '');
}

function buildOtpAuthUrl(email, secret, issuer = 'Upward Investments') {
  const encodedEmail = encodeURIComponent(email);
  const encodedIssuer = encodeURIComponent(issuer);
  return `otpauth://totp/${encodedIssuer}:${encodedEmail}?secret=${secret}&issuer=${encodedIssuer}&digits=6&period=30`;
}

function generateTotp(secret, timestamp = Date.now()) {
  const counter = Math.floor(timestamp / 1000 / 30);
  const buffer = Buffer.alloc(8);
  let value = counter;

  for (let index = 7; index >= 0; index -= 1) {
    buffer[index] = value & 0xff;
    value >>= 8;
  }

  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);

  return String(binary % 1000000).padStart(6, '0');
}

function verifyTotp(secret, code) {
  const normalizedCode = String(code || '').trim().replace(/\s+/g, '');
  const now = Date.now();
  const timeWindow = 1;

  for (let offset = -timeWindow; offset <= timeWindow; offset += 1) {
    const candidate = generateTotp(secret, now + offset * 30 * 1000);
    if (candidate === normalizedCode) {
      return true;
    }
  }

  return false;
}

async function generateUniqueReferralCode(username) {
  const cleanedName = username.trim().split(/\s+/)[1] || username.trim().split(/\s+/)[0] || 'USER';
  const base = cleanedName.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 10) || 'USER';
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = `${base}${Math.floor(1000 + Math.random() * 9000)}`;
    const existing = await prisma.user.findUnique({ where: { referralCode: code } });
    if (!existing) {
      return code;
    }
  }
  return `${base}${Math.floor(100000 + Math.random() * 900000)}`;
}

async function ensureExistingReferralCodes() {
  const users = await prisma.user.findMany({
    where: { OR: [{ referralCode: null }, { referralCode: '' }] },
    select: { id: true, username: true },
  });

  for (const user of users) {
    const referralCode = await generateUniqueReferralCode(user.username);
    await prisma.user.update({ where: { id: user.id }, data: { referralCode } });
  }

  if (users.length) {
    console.log(`[referrals] Generated codes for ${users.length} existing users.`);
  }
}

function generateOTP() {
  return String(Math.floor(1000 + Math.random() * 9000));
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
  console.log(`[otp-debug] generated OTP for ${email}: ${otp}`);
  const subject = purpose === 'password_reset' ? 'Your password reset code' : 'Your signup verification code';
  const actionText = purpose === 'password_reset' ? 'password reset' : 'signup verification';

  if (!emailTransporter) {
    console.warn(`[${purpose}-otp] Email transporter is not configured for ${email}`);
    throw new Error('OTP email service is not configured');
  }

  const transporter = emailTransporter;

  const mailOptions = {
    from: `"Upward Investments" <${EMAIL_FROM}>`,
    replyTo: EMAIL_FROM,
    to: email,
    subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #7c3aed;">Upward Investments</h2>
        <p>Hello,</p>
        <p>Your ${actionText} code is:</p>
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
    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ OTP email sent to ${email}: accepted=${JSON.stringify(info.accepted)} rejected=${JSON.stringify(info.rejected)} messageId=${info.messageId} response=${info.response}`);
    if (info.rejected && info.rejected.length > 0) {
      console.warn(`⚠️ OTP email was rejected for ${email}: ${JSON.stringify(info.rejected)}`);
    }
    return { otp };
  } catch (error) {
    console.error('❌ Error sending OTP email:', error);
    await prisma.oTP.deleteMany({ where: { email, purpose } });
    throw new Error('Failed to send OTP email');
  }
}

async function dispatchOtpEmail(email, purpose = 'signup', otp) {
  const subject = purpose === 'password_reset' ? 'Your password reset code' : 'Your signup verification code';
  const actionText = purpose === 'password_reset' ? 'password reset' : 'signup verification';
  const transporter = emailTransporter;

  if (!transporter) {
    console.log(`[${purpose}-otp] Cannot dispatch OTP email, transporter not configured. OTP for ${email}: ${otp}`);
    return;
  }

  const mailOptions = {
    from: `"Upward Investments" <${EMAIL_FROM}>`,
    replyTo: EMAIL_FROM,
    to: email,
    subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #7c3aed;">Upward Investments</h2>
        <p>Hello,</p>
        <p>Your ${actionText} code is:</p>
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
    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ OTP email sent to ${email}: accepted=${JSON.stringify(info.accepted)} rejected=${JSON.stringify(info.rejected)} messageId=${info.messageId} response=${info.response}`);
    if (info.rejected && info.rejected.length > 0) {
      console.warn(`⚠️ OTP email was rejected for ${email}: ${JSON.stringify(info.rejected)}`);
    }
  } catch (error) {
    console.error(`❌ Async OTP email send failed for ${email}:`, error);
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


function getIndiaDateKey(date) {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

async function countUniqueCreditedTradingDays(userId, weekStart, weekEnd) {
  const earnings = await prisma.investmentEarning.findMany({
    where: {
      creditedAt: {
        gte: weekStart,
        lt: weekEnd,
      },
      transaction: {
        userId,
      },
    },
    select: { creditedAt: true },
  });

  const uniqueDays = new Set(earnings.map((record) => getIndiaDateKey(record.creditedAt)));
  return uniqueDays.size;
}

async function canClaimWeeklyEarnings(userId) {
  const now = new Date();
  const weekStart = getWeekStart(now);
  const weekEnd = getWeekEnd(now);

  const claimedThisWeek = await prisma.investmentEarning.findFirst({
    where: {
      status: 'claimed',
      claimedAt: {
        gte: weekStart,
        lt: weekEnd,
      },
      transaction: {
        userId,
      },
    },
  });

  if (claimedThisWeek) {
    return { canClaim: false, reason: 'already_claimed' };
  }

  const completedTradingDays = await countUniqueCreditedTradingDays(userId, weekStart, weekEnd);
  if (completedTradingDays < 5) {
    return { canClaim: false, reason: 'wait_for_5_days' };
  }

  return { canClaim: true };
}

async function getWeeklyEarningsData(userId) {
  const now = new Date();
  const weekStart = getWeekStart(now);
  const weekEnd = getWeekEnd(now);

  const unclaimed = await prisma.investmentEarning.findMany({
    where: {
      status: 'unclaimed',
      creditedAt: {
        gte: weekStart,
        lt: weekEnd,
      },
      transaction: {
        userId,
      },
    },
  });

  const claimedThisWeek = await prisma.investmentEarning.findFirst({
    where: {
      status: 'claimed',
      claimedAt: {
        gte: weekStart,
        lt: weekEnd,
      },
      transaction: {
        userId,
      },
    },
  });

  const totalUnclaimed = Number(unclaimed.reduce((sum, record) => sum + Number(record.amount), 0).toFixed(2));
  const completedTradingDays = await countUniqueCreditedTradingDays(userId, weekStart, weekEnd);

  return {
    totalUnclaimed,
    completedTradingDays,
    claimAllowed: !claimedThisWeek && completedTradingDays >= 5 && totalUnclaimed > 0,
    alreadyClaimed: Boolean(claimedThisWeek),
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
  };
}

function toIndiaMidnight(date) {
  const dt = new Date(date);
  const indiaDate = dt.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return new Date(`${indiaDate}T00:00:00+05:30`);
}

function getIndiaWeekday(date) {
  return new Date(date).toLocaleString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' });
}

function getWeekStart(date) {
  const indiaMidnight = toIndiaMidnight(date);
  const weekday = getIndiaWeekday(indiaMidnight);
  const weekdayIndex = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 0,
  }[weekday] ?? 1;

  const start = new Date(indiaMidnight);
  const diff = weekdayIndex === 0 ? -6 : 1 - weekdayIndex;
  start.setDate(start.getDate() + diff);
  return toIndiaMidnight(start);
}

function getWeekEnd(date) {
  const start = getWeekStart(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return toIndiaMidnight(end);
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

async function getAdminSessionFromRequest(req) {
  const session = await getSessionFromRequest(req);
  if (!session) return null;
  // Check if this session belongs to an admin by verifying the username exists in Admin table
  const admin = await prisma.admin.findUnique({ where: { username: session.email } });
  if (!admin) return null;
  return session;
}

async function getAdminFromRequest(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const session = await prisma.session.findFirst({
    where: { token, expiresAt: { gt: new Date() } },
  });
  if (!session) return null;
  return session;
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Admin session verification for admin UI
app.get('/api/admin/verify-session', async (req, res) => {
  const session = await getAdminSessionFromRequest(req);
  if (!session) return res.status(401).json({ authenticated: false });
  return res.json({ authenticated: true, email: session.email || null });
});

// Admin: add balance (credit user)
app.post('/api/admin/add-balance', async (req, res) => {
  const session = await getAdminSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { userId, website = 'default', amount, reason } = req.body || {};
  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than zero' });
  }

  let user = null;
  if (userId) {
    user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      // try by email/username
      user = await prisma.user.findFirst({ where: { OR: [{ email: userId }, { username: userId }] } });
    }
  }

  if (!user) return res.status(404).json({ error: 'User not found' });

  const numericAmount = Number(amount);
  if (numericAmount < 0 && user.balance + numericAmount < 0) {
    return res.status(400).json({ error: 'Insufficient user balance for deduction' });
  }

  const updatedUser = await prisma.user.update({ where: { id: user.id }, data: { balance: { increment: numericAmount } } });

  const transaction = await prisma.transaction.create({
    data: {
      id: createId(),
      type: numericAmount >= 0 ? 'deposit' : 'withdraw',
      amount: numericAmount,
      status: 'successful',
      paymentMethod: numericAmount >= 0 ? 'admin_credit' : 'admin_debit',
      description: reason || (numericAmount >= 0 ? 'Admin credited balance' : 'Admin deducted balance'),
      transactionId: `ADMIN-${numericAmount >= 0 ? 'CREDIT' : 'DEBIT'}-${Date.now()}`,
      userId: updatedUser.id,
    },
  });

  res.json({ message: 'Balance updated', user: { id: updatedUser.id, balance: updatedUser.balance } });
});

// Admin: get deposit settings
app.get('/api/admin/deposit-settings', async (req, res) => {
  const session = await getAdminSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const settings = await prisma.depositSetting.findFirst({ orderBy: { updatedAt: 'desc' } });
  res.json({ settings: settings || {} });
});

// Prepare uploads directory for admin QR images
const adminUploadsDir = path.join(__dirname, 'admin', 'uploads');
try { require('fs').mkdirSync(adminUploadsDir, { recursive: true }); } catch (e) { /* ignore */ }

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, adminUploadsDir),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  },
});
const upload = multer({ storage });

// Admin: update deposit settings (supports JSON and multipart/form-data with `qrFile`)
app.post('/api/admin/deposit-settings', upload.single('qrFile'), async (req, res) => {
  const session = await getAdminSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  // Build payload from either JSON body or multipart form
  const payload = req.body || {};
  if (req.file) {
    // expose path as a URL served by static admin assets
    payload.qrCodePath = `/admin/uploads/${req.file.filename}`;
  }

  try {
    const now = new Date();
    const existingSettings = await prisma.depositSetting.findUnique({ where: { key: 'default' } });
    const qrCodePath = req.file
      ? payload.qrCodePath
      : existingSettings?.qrCodePath || payload.qrCodePath || null;
    const upsert = await prisma.depositSetting.upsert({
      where: { key: 'default' },
      create: {
        id: createId(),
        key: 'default',
        upiId: payload.upiId || '',
        qrCodePath,
        bankAccountHolder: payload.bankAccountHolder || '',
        bankAccountNumber: payload.bankAccountNumber || '',
        bankIfsc: payload.bankIfsc || '',
        bankName: payload.bankName || '',
        bankBranch: payload.bankBranch || '',
        instructions: payload.instructions || '',
        updatedAt: now,
        createdAt: now,
      },
      update: {
        upiId: payload.upiId || '',
        qrCodePath,
        bankAccountHolder: payload.bankAccountHolder || '',
        bankAccountNumber: payload.bankAccountNumber || '',
        bankIfsc: payload.bankIfsc || '',
        bankName: payload.bankName || '',
        bankBranch: payload.bankBranch || '',
        instructions: payload.instructions || '',
        updatedAt: now,
      },
    });

    res.json({ message: 'Settings saved', settings: upsert });
  } catch (error) {
    console.error('[admin] Failed to save deposit settings', error);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// Admin: list pending transactions (withdraw/deposit)
app.get('/api/admin/pending-transactions', async (req, res) => {
  const session = await getAdminSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const transactions = await prisma.transaction.findMany({
    where: { type: { in: ['deposit', 'withdraw'] }, status: { in: ['processing', 'pending', 'verification_required'] } },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { BankAccount: true, },
  });

  res.json({ transactions });
});

// Admin: verify transaction (approve/reject)
app.post('/api/admin/verify-transaction', async (req, res) => {
  const session = await getAdminSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { transactionId, action, notes } = req.body || {};
  if (!transactionId || !action) return res.status(400).json({ error: 'transactionId and action are required' });

  const tx = await prisma.transaction.findUnique({ where: { id: transactionId } });
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  if (!['processing', 'pending', 'verification_required'].includes(tx.status)) {
    return res.status(400).json({ error: `Transaction is already ${tx.status}` });
  }

  if (action === 'approve') {
    await prisma.$transaction(async (database) => {
      if (tx.type === 'withdraw') {
        const debited = await database.user.updateMany({
          where: { id: tx.userId, balance: { gte: tx.amount } },
          data: { balance: { decrement: tx.amount } },
        });
        if (debited.count !== 1) {
          throw new Error('Insufficient balance to approve this withdrawal');
        }
      } else if (tx.type === 'deposit') {
        await database.user.update({ where: { id: tx.userId }, data: { balance: { increment: tx.amount } } });
      }

      await database.transaction.update({
        where: { id: tx.id },
        data: { status: 'successful', verificationNotes: notes || '' },
      });
    });
    return res.json({ message: 'Transaction approved' });
  }

  if (action === 'reject') {
    await prisma.transaction.update({ where: { id: tx.id }, data: { status: 'failed', verificationNotes: notes || '' } });
    return res.json({ message: 'Transaction rejected' });
  }

  res.status(400).json({ error: 'Unknown action' });
});

// Admin: download proof image for a transaction
app.get('/api/admin/download-proof', async (req, res) => {
  const session = await getAdminSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const transactionId = req.query.transactionId && String(req.query.transactionId);
  if (!transactionId) return res.status(400).json({ error: 'transactionId is required' });

  const tx = await prisma.transaction.findUnique({ where: { id: transactionId } });
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });

  if (!tx.proofUrl) return res.status(404).json({ error: 'No proof attached' });

  const proofFilename = path.basename(tx.proofUrl);
  const proofCandidates = tx.proofUrl.startsWith('/payment-proofs/')
    ? [
        path.join(__dirname, '..', 'payment-proofs', proofFilename),
        path.join(__dirname, 'payment-proofs', proofFilename),
        path.join(adminUploadsDir, proofFilename),
      ]
    : [path.join(adminUploadsDir, proofFilename)];
  const proofPath = proofCandidates.find((candidate) => fs.existsSync(candidate));
  if (!proofPath) return res.status(404).json({ error: 'Payment proof file is no longer available' });
  res.sendFile(proofPath, (err) => {
    if (err) {
      console.error('[admin] download-proof sendFile error', err);
      res.status(500).end();
    }
  });
});
function getConfiguredAdminSecretKey() {
  return (ADMIN_CREATION_KEY || 'UPWARD-ADMIN-SECRET-KEY').trim();
}

app.post('/api/admin/signup', async (req, res) => {
  const { username, password, creationKey } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (ADMIN_CREATION_KEY && creationKey !== ADMIN_CREATION_KEY) {
    return res.status(403).json({ error: 'Invalid admin secret key for signup' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const existingAdmin = await prisma.admin.findUnique({ where: { username } });
    if (existingAdmin) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const secretKey = getConfiguredAdminSecretKey();

    const admin = await prisma.admin.create({
      data: {
        id: createId(),
        username,
        password: hashedPassword,
        secretKey,
        twoFactorEnabled: false,
      },
    });

    res.status(201).json({ 
      message: 'Admin account created successfully', 
      adminId: admin.id,
      username: admin.username,
      secretKey: admin.secretKey,
    });
  } catch (err) {
    console.error('Admin signup error:', err);
    res.status(500).json({ error: 'Failed to create admin account' });
  }
});

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const admin = await prisma.admin.findUnique({ where: { username } });
    if (!admin) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const passwordMatch = await bcrypt.compare(password, admin.password);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (admin.twoFactorEnabled) {
      return res.status(200).json({ 
        requires2fa: true, 
        adminId: admin.id,
        message: 'Please verify with 2FA'
      });
    }

    const token = createToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.session.create({
      data: {
        id: createId(),
        email: admin.username,
        token,
        userId: null,
        expiresAt,
        updatedAt: new Date(),
      },
    });

    res.json({ token, admin: { id: admin.id, username: admin.username, secretKey: admin.secretKey } });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/admin/password-reset', async (req, res) => {
  const { username, secretKey, password } = req.body || {};
  if (!username || !secretKey || !password) {
    return res.status(400).json({ error: 'Username, admin secret key, and new password are required' });
  }

  if (!ADMIN_CREATION_KEY) {
    return res.status(500).json({ error: 'Admin reset is not configured on this server' });
  }

  if (secretKey !== ADMIN_CREATION_KEY) {
    return res.status(403).json({ error: 'Invalid admin secret key' });
  }

  try {
    const admin = await prisma.admin.findUnique({ where: { username } });
    if (!admin) {
      return res.status(404).json({ error: 'Admin account not found' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await prisma.admin.update({ where: { username }, data: { password: hashedPassword } });

    res.json({ message: 'Admin password reset successful' });
  } catch (err) {
    console.error('Admin password reset error:', err);
    res.status(500).json({ error: 'Failed to reset admin password' });
  }
});

app.post('/api/admin/2fa/setup', async (req, res) => {
  try {
    const { adminId } = req.body;
    if (!adminId) {
      return res.status(400).json({ error: 'Admin ID required' });
    }

    const admin = await prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    const secret = encodeBase32(crypto.randomBytes(20));
    const otpauthUrl = buildOtpAuthUrl(admin.username, secret, 'UpwardAdmin');

    res.json({ 
      secret, 
      otpauthUrl,
      message: 'Scan QR code with authenticator app'
    });
  } catch (err) {
    console.error('2FA setup error:', err);
    res.status(500).json({ error: 'Failed to setup 2FA' });
  }
});

app.post('/api/admin/2fa/enable', async (req, res) => {
  const { adminId, code, secret } = req.body;
  if (!adminId || !code || !secret) {
    return res.status(400).json({ error: 'Admin ID, code, and secret are required' });
  }

  try {
    const admin = await prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    const isValid = verifyTotp(secret, code);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    await prisma.admin.update({
      where: { id: adminId },
      data: {
        twoFactorEnabled: true,
        twoFactorSecret: secret,
      },
    });

    res.json({ message: '2FA enabled successfully' });
  } catch (err) {
    console.error('2FA enable error:', err);
    res.status(500).json({ error: 'Failed to enable 2FA' });
  }
});

app.post('/api/admin/2fa/verify', async (req, res) => {
  const { adminId, code } = req.body;
  if (!adminId || !code) {
    return res.status(400).json({ error: 'Admin ID and code are required' });
  }

  try {
    const admin = await prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin || !admin.twoFactorEnabled || !admin.twoFactorSecret) {
      return res.status(401).json({ error: 'Admin not found or 2FA not enabled' });
    }

    const isValid = verifyTotp(admin.twoFactorSecret, code);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    const token = createToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.session.create({
      data: {
        id: createId(),
        email: admin.username,
        token,
        userId: null,
        expiresAt,
        updatedAt: new Date(),
      },
    });

    res.json({ 
      token,
      adminId: admin.id,
      admin: { id: admin.id, username: admin.username, secretKey: admin.secretKey }
    });
  } catch (err) {
    console.error('2FA verify error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

app.post('/api/admin/2fa/disable', async (req, res) => {
  const session = await getAdminFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const admin = await prisma.admin.findUnique({ 
      where: { username: session.email } 
    });
    if (!admin) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    await prisma.admin.update({
      where: { id: admin.id },
      data: {
        twoFactorEnabled: false,
        twoFactorSecret: null,
      },
    });

    res.json({ message: '2FA disabled successfully' });
  } catch (err) {
    console.error('2FA disable error:', err);
    res.status(500).json({ error: 'Failed to disable 2FA' });
  }
});

app.get('/api/admin/verify', async (req, res) => {
  const session = await getAdminSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.json({ authenticated: true, email: session.email || null });
});

app.get('/api/admin/summary', async (req, res) => {
  const session = await getAdminSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const userCount = await prisma.user.count();
  const pendingCount = await prisma.transaction.count({
    where: { type: { in: ['deposit', 'withdraw'] }, status: { in: ['processing', 'pending', 'verification_required'] } },
  });
  const totalBalanceResult = await prisma.user.aggregate({ _sum: { balance: true } });
  const totalBalance = Number(totalBalanceResult._sum.balance || 0);
  // Compute totals from successful deposit and withdrawal transactions.
  const depositedAgg = await prisma.transaction.aggregate({
    _sum: { amount: true },
    where: { type: 'deposit', status: 'successful' },
  });
  const withdrawnAgg = await prisma.transaction.aggregate({
    _sum: { amount: true },
    where: { type: 'withdraw', status: 'successful' },
  });
  const totalDeposited = Number(depositedAgg._sum.amount || 0);
  const totalWithdrawn = Number(withdrawnAgg._sum.amount || 0);
  const computedWalletBalance = totalDeposited - totalWithdrawn;
  const recentPending = await prisma.transaction.findMany({
    where: { type: { in: ['deposit', 'withdraw'] }, status: { in: ['processing', 'pending', 'verification_required'] } },
    orderBy: { createdAt: 'desc' },
    take: 4,
    include: { user: true },
  });

  res.json({ userCount, pendingCount, totalBalance, recentPending, totalDeposited, totalWithdrawn, computedWalletBalance });
});

app.get('/api/admin/users', async (req, res) => {
  const session = await getAdminSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const search = (req.query.search || '').toString().trim();
  const where = search
    ? {
        OR: [
          { email: { contains: search } },
          { username: { contains: search } },
        ],
      }
    : {};

  const users = await prisma.user.findMany({
    where,
    select: {
      id: true,
      username: true,
      email: true,
      phoneNumber: true,
      balance: true,
      website: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  res.json({ users });
});

app.get('/api/admin/transactions', async (req, res) => {
  const session = await getAdminSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const status = (req.query.status || 'all').toString().trim().toLowerCase();
  const search = (req.query.search || '').toString().trim();

  const where = {};
  if (status && status !== 'all') {
    where.status = status;
  }
  if (search) {
    where.OR = [
      { paymentMethod: { contains: search } },
      { type: { contains: search } },
      { transactionId: { contains: search } },
      { user: { username: { contains: search } } },
      { user: { email: { contains: search } } },
    ];
  }

  const transactions = await prisma.transaction.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 300,
    include: { user: true },
  });

  res.json({ transactions });
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

  if (user.twoFactorEnabled) {
    return res.json({
      requires2fa: true,
      email: user.email,
      message: 'Two-step verification required',
    });
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

app.post('/api/2fa/setup', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const secret = user.twoFactorSecret || generateTwoFactorSecret();
  if (!user.twoFactorSecret) {
    await prisma.user.update({ where: { id: user.id }, data: { twoFactorSecret: secret } });
  }

  res.json({
    enabled: Boolean(user.twoFactorEnabled),
    secret,
    otpauthUrl: buildOtpAuthUrl(user.email, secret),
    message: 'Add this secret to your authenticator app.',
  });
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
  if (!user || !user.twoFactorSecret) {
    return res.status(400).json({ error: 'Two-factor setup has not been initialized' });
  }

  if (!verifyTotp(user.twoFactorSecret, code)) {
    return res.status(401).json({ error: 'Invalid verification code' });
  }

  await prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true } });

  res.json({ message: 'Two-step verification enabled successfully' });
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

  await prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: false, twoFactorSecret: null } });

  res.json({ message: 'Two-step verification disabled successfully' });
});

app.post('/api/2fa/verify', async (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) {
    return res.status(400).json({ error: 'Email and verification code are required' });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
    return res.status(400).json({ error: 'Two-step verification is not enabled for this account' });
  }

  if (!verifyTotp(user.twoFactorSecret, code)) {
    return res.status(401).json({ error: 'Invalid verification code' });
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
  const { email, purpose = 'signup' } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  if (purpose === 'signup') {
    const existingEmail = await prisma.user.findUnique({ where: { email } });
    if (existingEmail) {
      return res.status(409).json({ error: 'Email already registered' });
    }
  } else if (purpose === 'password_reset') {
    const existingEmail = await prisma.user.findUnique({ where: { email } });
    if (!existingEmail) {
      return res.status(404).json({ error: 'Email not registered' });
    }
  }

  try {
    await sendEmailOTP(email, purpose);
    return res.json({ message: 'OTP sent to your email address.' });
  } catch (error) {
    console.error(`[${purpose}-otp] Failed to send OTP`, error);
    return res.status(500).json({ error: 'Unable to send verification email right now.' });
  }
});

app.post('/api/register/verify-otp', async (req, res) => {
  const { email, otp, purpose = 'signup' } = req.body || {};
  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required' });
  }

  const isValid = await verifyOTP(email, otp, purpose);
  if (!isValid) {
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }

  res.json({ message: 'OTP verified successfully' });
});

app.get('/api/referral/validate/:code', async (req, res) => {
  const referralCode = (req.params.code || '').trim().toUpperCase();
  if (!referralCode) {
    return res.status(400).json({ error: 'Referral code is required' });
  }

  const referringUser = await prisma.user.findUnique({ where: { referralCode } });
  if (!referringUser) {
    return res.status(404).json({ error: 'Referral code not found' });
  }

  res.json({ referrerName: referringUser.username, referralCode: referringUser.referralCode });
});

app.post('/api/password-reset', async (req, res) => {
  const { email, otp, password } = req.body || {};
  if (!email || !otp || !password) {
    return res.status(400).json({ error: 'Email, OTP, and new password are required' });
  }

  const isValid = await verifyOTP(email, otp, 'password_reset');
  if (!isValid) {
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  await prisma.user.update({ where: { email }, data: { password: hashedPassword } });
  await prisma.oTP.deleteMany({ where: { email, purpose: 'password_reset' } });

  res.json({ message: 'Password reset successful' });
});

app.post('/api/register', async (req, res) => {
  const { username, email, password, phoneNumber, referralCode: referredByCode } = req.body;
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
  const referralCode = await generateUniqueReferralCode(username);
  let referredById = null;

  if (referredByCode) {
    const normalizedReferralCode = referredByCode.trim().toUpperCase();
    const referringUser = await prisma.user.findUnique({ where: { referralCode: normalizedReferralCode } });
    if (!referringUser) {
      return res.status(400).json({ error: 'Invalid referral code' });
    }
    referredById = referringUser.id;
  }

  const user = await prisma.user.create({
    data: {
      id: createId(),
      username,
      email,
      phoneNumber,
      password: hashedPassword,
      balance: 0,
      referralCode,
      referredById,
    },
  });

  await prisma.oTP.deleteMany({ where: { email, purpose: 'signup' } });

  res.json({ message: 'Registration successful', userId: user.id, referralCode });
});

app.get('/api/profile', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({
    user: {
      username: user.username,
      email: user.email,
      phoneNumber: user.phoneNumber,
      balance: user.balance,
      referralCode: user.referralCode,
      referralBonusEarned: user.referralBonusEarned,
      referralCount: user.referralCount,
      twoFactorEnabled: Boolean(user.twoFactorEnabled),
    },
  });
});

app.get('/api/wallet/balance', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
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

  res.json({ balance: user.balance, transactions });
});

app.get('/api/wallet/deposit-settings', async (req, res) => {
  const settings = await prisma.depositSetting.findFirst({ orderBy: { updatedAt: 'desc' } });
  const configuredBaseUrl = String(process.env.PUBLIC_API_URL || '').trim().replace(/\/$/, '');
  const baseUrl = configuredBaseUrl || `${req.protocol}://${req.get('host')}`;
  const payload = settings ? {
    upiId: settings.upiId,
    qrCodeUrl: settings.qrCodePath ? `${baseUrl}${settings.qrCodePath}` : null,
    bankAccountHolder: settings.bankAccountHolder,
    bankAccountNumber: settings.bankAccountNumber,
    bankIfsc: settings.bankIfsc,
    bankName: settings.bankName,
    bankBranch: settings.bankBranch,
    instructions: settings.instructions,
  } : {};
  res.json({ settings: payload });
});

app.get('/api/portfolio', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  void processDailyInvestmentEarnings().catch((error) => {
    logger.error('[portfolio] Background earnings processor failed', { error: error?.message || error });
  });

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const transactions = await prisma.transaction.findMany({
    where: { userId: user.id, type: 'investment' },
    orderBy: { createdAt: 'desc' },
  });

  const investmentIds = transactions.map((transaction) => transaction.id);
  const earnings = investmentIds.length
    ? await prisma.investmentEarning.findMany({
        where: { investmentId: { in: investmentIds } },
        select: { investmentId: true, amount: true, status: true },
      })
    : [];
  const earningsByInvestment = earnings.reduce((result, earning) => {
    const current = result[earning.investmentId] || { unclaimed: 0, claimed: 0 };
    const bucket = earning.status === 'claimed' ? 'claimed' : 'unclaimed';
    current[bucket] += Number(earning.amount || 0);
    result[earning.investmentId] = current;
    return result;
  }, {});

  const todayStart = toIndiaMidnight(new Date());
  const todayEnd = addIndiaDays(todayStart, 1);
  const todayEarnings = await prisma.investmentEarning.findMany({
    where: {
      creditedAt: {
        gte: todayStart,
        lt: todayEnd,
      },
      transaction: {
        userId: user.id,
      },
    },
    select: { investmentId: true, amount: true },
  });
  const todayEarningsByInvestment = todayEarnings.reduce((result, earning) => {
    result[earning.investmentId] = (result[earning.investmentId] || 0) + Number(earning.amount || 0);
    return result;
  }, {});

  const plans = transactions.map((transaction) => {
    const plan = buildPortfolioPlan(transaction);
    const earningsForPlan = earningsByInvestment[transaction.id] || { unclaimed: 0, claimed: 0 };
    return {
      ...plan,
      creditedEarnings: Number((earningsForPlan.unclaimed + earningsForPlan.claimed).toFixed(2)),
      portfolioEarnings: Number(earningsForPlan.unclaimed.toFixed(2)),
      claimedEarnings: Number(earningsForPlan.claimed.toFixed(2)),
      todayGain: Number(todayEarningsByInvestment[transaction.id] || 0),
    };
  });
  const plansByKey = plans.reduce((map, plan) => {
    const key = plan.id || plan.transactionId || `${plan.planName}-${plan.durationLabel}`;
    if (!map[key]) {
      map[key] = {
        ...plan,
        quantity: 0,
        amount: 0,
        totalReturn: 0,
        totalProfit: 0,
        dailyProfit: 0,
        todayGain: 0,
        creditedEarnings: 0,
        portfolioEarnings: 0,
        claimedEarnings: 0,
      };
    }

    map[key].quantity = (map[key].quantity || 0) + 1;
    map[key].amount = (map[key].amount || 0) + Number(plan.amount || 0);
    map[key].totalReturn = (map[key].totalReturn || 0) + Number(plan.totalReturn || 0);
    map[key].totalProfit = (map[key].totalProfit || 0) + Number(plan.totalProfit || 0);
    map[key].dailyProfit = (map[key].dailyProfit || 0) + Number(plan.dailyProfit || 0);
    map[key].creditedEarnings = (map[key].creditedEarnings || 0) + Number(plan.creditedEarnings || 0);
    map[key].portfolioEarnings = (map[key].portfolioEarnings || 0) + Number(plan.portfolioEarnings || 0);
    map[key].claimedEarnings = (map[key].claimedEarnings || 0) + Number(plan.claimedEarnings || 0);
    map[key].todayGain = (map[key].todayGain || 0) + Number(plan.todayGain || 0);

    if (plan.purchasedAt && (!map[key].purchasedAt || new Date(plan.purchasedAt) < new Date(map[key].purchasedAt))) {
      map[key].purchasedAt = plan.purchasedAt;
    }
    if (plan.expiresAt && (!map[key].expiresAt || new Date(plan.expiresAt) > new Date(map[key].expiresAt))) {
      map[key].expiresAt = plan.expiresAt;
    }

    return map;
  }, {});

  const plansWithQuantity = Object.values(plansByKey).map((plan) => {
    const aggregated = { ...plan };
    if (aggregated.quantity > 1 && aggregated.amountLabel) {
      aggregated.unitAmountLabel = aggregated.amountLabel;
      const formattedTotalAmount = `₹${Number(aggregated.amount).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: Number.isInteger(aggregated.amount) ? 0 : 2 })}`;
      aggregated.amountLabel = `${formattedTotalAmount} (${aggregated.quantity}× ${aggregated.unitAmountLabel})`;
    }
    return aggregated;
  });
  const weeklyData = await getWeeklyEarningsData(user.id);
  const now = new Date();
  const isTradingDayToday = getIndiaMinutes(now) >= 16 * 60 ? await isTradingDay(now) : false;

  res.json({ balance: user.balance, plans: plansWithQuantity, totalInvested: plansWithQuantity.reduce((sum, plan) => sum + plan.amount, 0), weeklyData, isTradingDay: isTradingDayToday });
});

app.post('/api/investment/claim-weekly-earnings', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const claimCheck = await canClaimWeeklyEarnings(user.id);
  if (!claimCheck.canClaim) {
    const message = claimCheck.reason === 'already_claimed'
      ? 'You have already claimed this week\'s earnings.'
      : 'Wait until 5 complete trading days to claim this week\'s earnings.';
    return res.status(400).json({ error: message });
  }

  const now = new Date();
  const weekStart = getWeekStart(now);
  const weekEnd = getWeekEnd(now);
  const unclaimedEarnings = await prisma.investmentEarning.findMany({
    where: {
      status: 'unclaimed',
      creditedAt: {
        gte: weekStart,
        lt: weekEnd,
      },
      transaction: {
        userId: user.id,
      },
    },
  });

  const totalAmount = Number(unclaimedEarnings.reduce((sum, record) => sum + Number(record.amount), 0).toFixed(2));
  if (!totalAmount) {
    return res.status(400).json({ error: 'No earnings available for claim this week.' });
  }

  await prisma.investmentEarning.updateMany({
    where: {
      id: { in: unclaimedEarnings.map((record) => record.id) },
    },
    data: {
      status: 'claimed',
      claimedAt: new Date(),
      updatedAt: new Date(),
    },
  });

  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: { balance: { increment: totalAmount } },
  });

  await prisma.transaction.create({
    data: {
      id: createId(),
      type: 'deposit',
      amount: totalAmount,
      status: 'successful',
      paymentMethod: 'weekly_earnings',
      description: 'Weekly earnings claimed to wallet',
      transactionId: `CLAIM-${Date.now()}`,
      userId: user.id,
    },
  });

  res.json({ message: 'Weekly earnings claimed successfully.', balance: updatedUser.balance, claimedAmount: totalAmount });
});

app.post('/api/portfolio/purchase', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const payload = req.body || {};
  const { planId, planName, planType, amount, amountLabel, returnLabel, returnPercent, durationLabel, premium } = payload;
  const investmentAmount = Number(amount || 0);
  const returnPct = Number(returnPercent || 0);

  if (investmentAmount <= 0) {
    return res.status(400).json({ error: 'Plan amount is required' });
  }

  if (!Number.isFinite(returnPct) || returnPct <= 0) {
    return res.status(400).json({ error: 'Invalid plan return percentage' });
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (user.balance < investmentAmount) {
    return res.status(400).json({ error: 'Wallet balance is insufficient' });
  }

  try {
    const transaction = await purchaseInvestment({
      userId: user.id,
      planId,
      planName,
      planType,
      amount: investmentAmount,
      amountLabel,
      returnLabel,
      returnPercent: returnPct,
      durationLabel: durationLabel || '1 Month',
      premium,
    });

    const winnerUser = await prisma.user.findUnique({ where: { id: session.userId }, include: { referredBy: true } });
    if (winnerUser?.referredBy) {
      const referralAmount = investmentAmount >= 100000 && investmentAmount <= 300000 ? 1000 : investmentAmount >= 5000 && investmentAmount <= 50000 ? 500 : 0;
      if (referralAmount > 0) {
        await prisma.$transaction(async (tx) => {
          const bonusClaimed = await tx.user.updateMany({
            where: { id: winnerUser.id, referralBonusPaid: false },
            data: { referralBonusPaid: true },
          });
          if (bonusClaimed.count !== 1) return;

          await tx.user.update({
            where: { id: winnerUser.referredBy.id },
            data: {
              balance: { increment: referralAmount },
              referralBonusEarned: { increment: referralAmount },
              referralCount: { increment: 1 },
            },
          });

          await tx.transaction.create({
            data: {
              id: createId(),
              type: 'deposit',
              amount: referralAmount,
              status: 'successful',
              paymentMethod: 'referral_bonus',
              description: `Referral bonus from ${winnerUser.username}`,
              transactionId: `REF-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
              userId: winnerUser.referredBy.id,
            },
          });
        });
      }
    }

    const transactions = await prisma.transaction.findMany({
      where: { userId: user.id, type: 'investment' },
      orderBy: { createdAt: 'desc' },
    });
    const plans = transactions.map(buildPortfolioPlan);

    const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
    res.json({ balance: updatedUser.balance, plans, totalInvested: plans.reduce((sum, plan) => sum + plan.amount, 0), investmentId: transaction.id });
  } catch (error) {
    console.error('[purchase] Failed to create investment', error);
    res.status(500).json({ error: 'Failed to create investment' });
  }
});

app.post('/api/investment/reinvest', async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const { investmentId } = req.body || {};
  if (!investmentId) {
    return res.status(400).json({ error: 'Investment ID is required for reinvestment' });
  }

  try {
    const newInvestment = await reinvestInvestment({ userId: session.userId, investmentId });
    const transactions = await prisma.transaction.findMany({
      where: { userId: session.userId, type: 'investment' },
      orderBy: { createdAt: 'desc' },
    });
    const plans = transactions.map(buildPortfolioPlan);

    res.json({ message: 'Reinvestment created successfully.', investmentId: newInvestment.id, plans, totalInvested: plans.reduce((sum, plan) => sum + plan.amount, 0) });
  } catch (error) {
    console.error('[reinvest] Failed to create reinvestment', error);
    res.status(400).json({ error: error.message || 'Failed to create reinvestment' });
  }
});

app.post('/api/wallet/deposit', upload.single('proof'), async (req, res) => {
  const session = await getSessionFromRequest(req);
  const { amount, paymentMethod, utrNumber } = req.body || {};
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const depositAmount = Number(amount || 0);
  if (!depositAmount || depositAmount < 100) {
    return res.status(400).json({ error: 'Deposit amount must be at least 100' });
  }
  if (!paymentMethod) {
    return res.status(400).json({ error: 'Payment method is required' });
  }
  if (!utrNumber || !String(utrNumber).trim()) {
    return res.status(400).json({ error: 'UTR number is required' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Payment proof screenshot is required' });
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const proofUrl = `/admin/uploads/${req.file.filename}`;
  const transaction = await prisma.transaction.create({
    data: {
      id: createId(),
      type: 'deposit',
      amount: depositAmount,
      status: 'processing',
      paymentMethod,
      description: `Deposit request via ${paymentMethod}`,
      transactionId: `DEP-${Date.now()}`,
      userId: user.id,
      utrNumber: String(utrNumber).trim(),
      proofUrl,
      verificationStatus: 'processing',
    },
  });

  res.json({ message: 'Deposit request submitted', transactionId: transaction.transactionId, status: transaction.status });
});

app.post('/api/wallet/withdraw', async (req, res) => {
  const session = await getSessionFromRequest(req);
  const { amount, paymentMethod, bankAccount } = req.body;
  if (!session) {
    return res.status(401).json({ error: 'Missing auth token' });
  }
  if (!amount || amount < 100) {
    return res.status(400).json({ error: 'Withdrawal amount must be at least 100' });
  }
  if (!bankAccount?.id || !bankAccount.holder || !bankAccount.accountNumber || !bankAccount.ifsc) {
    return res.status(400).json({ error: 'A bank account is required for withdrawal' });
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  if (user.balance < amount) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  const existingBankAccount = await prisma.bankAccount.findUnique({ where: { id: String(bankAccount.id) } });
  if (existingBankAccount && existingBankAccount.userId !== user.id) {
    return res.status(400).json({ error: 'Selected bank account is invalid' });
  }

  const savedBankAccount = existingBankAccount || await prisma.bankAccount.create({
    data: {
      id: String(bankAccount.id),
      userId: user.id,
      accountHolderName: String(bankAccount.holder).trim(),
      accountNumber: String(bankAccount.accountNumber).trim(),
      ifscCode: String(bankAccount.ifsc).trim().toUpperCase(),
      bankName: bankAccount.bankName ? String(bankAccount.bankName).trim() : null,
    },
  });

  const transaction = await prisma.transaction.create({
    data: {
      id: createId(),
      type: 'withdraw',
      amount,
      status: 'processing',
      paymentMethod,
      bankAccountId: savedBankAccount.id,
      description: 'Withdrawal request',
      transactionId: `WDR-${Date.now()}`,
      userId: user.id,
    },
  });

  res.json({ balance: user.balance, message: 'Withdrawal request submitted' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

cron.schedule('0 15 * * 1-5', async () => {
  console.log('[cron] Running daily investment earnings processor');
  try {
    await processDailyInvestmentEarnings();
  } catch (error) {
    console.error('[cron] Earnings processor failed', error);
  }
}, {
  timezone: 'Asia/Kolkata',
});

ensureExistingReferralCodes().catch((error) => {
  console.error('[referrals] Failed to generate existing user codes', error);
});

processDailyInvestmentEarnings().catch((error) => {
  console.error('[startup] Failed to run daily earnings processor', error);
});

app.listen(port, '0.0.0.0', async () => {
  console.log(`Backend server running on http://0.0.0.0:${port}`);
  console.log(`Backend server reachable at http://10.68.147.108:${port}`);
  
  // Test database connection
  try {
    const userCount = await prisma.user.count();
    const adminCount = await prisma.admin.count();
    console.log(`✓ Database connected successfully`);
    console.log(`  - Users in database: ${userCount}`);
    console.log(`  - Admins in database: ${adminCount}`);
  } catch (error) {
    console.error(`✗ Database connection failed:`, error.message);
  }
});
