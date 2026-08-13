require('dotenv').config({ path: '../backend/.env.local' });
const axios = require('axios');
const crypto = require('crypto');
const { prisma } = require('./prisma');

function createId() { return crypto.randomBytes(16).toString('hex'); }
function createToken() { return crypto.randomBytes(32).toString('hex'); }

(async () => {
  try {
    await prisma.$connect();
  } catch (err) {
    console.error('Prisma connect failed', err.message || err);
    process.exit(1);
  }

  let user = await prisma.user.findFirst();
  if (!user) {
    console.log('No user found — creating test user');
    const hashed = '$2a$10$EzUe6cQmX4G3Q1kzG8Qf6e4yYQF0cHqG9Q2y3vV9G1Q9G1a';
    user = await prisma.user.create({ data: { id: createId(), username: 'testuser', email: `test+${Date.now()}@example.com`, password: hashed, balance: 0 } });
  }

  const token = createToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await prisma.session.create({ data: { id: createId(), email: user.email, token, userId: user.id, expiresAt, updatedAt: new Date() } });

  const base = 'http://localhost:4000';
  const authHeader = { headers: { Authorization: `Bearer ${token}` } };

  console.log('Ensuring balance by depositing 10000');
  try {
    const dep = await axios.post(`${base}/api/wallet/deposit`, { amount: 10000, paymentMethod: 'upi' }, authHeader);
    console.log('deposit response:', dep.data);
  } catch (err) {
    console.error('deposit error:', err.response ? err.response.data : err.message);
  }

  console.log('Performing withdraw of 200 (upi)');
  try {
    const w = await axios.post(`${base}/api/wallet/withdraw`, { amount: 200, paymentMethod: 'upi' }, authHeader);
    console.log('withdraw response:', w.data);
  } catch (err) {
    console.error('withdraw error:', err.response ? err.response.data : err.message);
  }

  console.log('Fetching wallet/balance');
  try {
    const bal = await axios.get(`${base}/api/wallet/balance`, authHeader);
    console.log('wallet/balance:', bal.data);
  } catch (err) {
    console.error('balance error:', err.response ? err.response.data : err.message);
  }

  console.log('Fetching portfolio');
  try {
    const pf = await axios.get(`${base}/api/portfolio`, authHeader);
    console.log('portfolio:', pf.data);
  } catch (err) {
    console.error('portfolio error:', err.response ? err.response.data : err.message);
  }

  // Inspect Upstash keys
  const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    console.warn('No Upstash credentials in env; skipping cache inspection');
    await prisma.$disconnect();
    return;
  }

  const keys = [
    `profile:${user.id}`,
    `wallet:balance:${user.id}`,
    `wallet:transactions:${user.id}`,
    `portfolio:${user.id}`,
    `bankAccounts:${user.id}`,
  ];

  for (const key of keys) {
    try {
      const getUrl = `${UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`;
      const ttlUrl = `${UPSTASH_REDIS_REST_URL}/ttl/${encodeURIComponent(key)}`;
      const headers = { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` };
      const [getRes, ttlRes] = await Promise.all([
        axios.get(getUrl, { headers }).catch(e => e.response ? e.response.data : { error: e.message }),
        axios.get(ttlUrl, { headers }).catch(e => e.response ? e.response.data : { error: e.message }),
      ]);
      console.log(`
Key: ${key}`);
      console.log('GET:', JSON.stringify(getRes.data || getRes, null, 2));
      console.log('TTL:', JSON.stringify(ttlRes.data || ttlRes, null, 2));
    } catch (err) {
      console.error('cache inspect error for', key, err.response ? err.response.data : err.message);
    }
  }

  await prisma.$disconnect();
})();
