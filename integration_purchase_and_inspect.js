require('dotenv').config({ path: '../backend/.env.local' });
const axios = require('axios');
const crypto = require('crypto');
const { prisma } = require('./prisma');

function createId() { return crypto.randomBytes(16).toString('hex'); }

(async () => {
  try { await prisma.$connect(); } catch (err) { console.error('Prisma connect failed', err); process.exit(1); }

  let user = await prisma.user.findFirst();
  if (!user) {
    user = await prisma.user.create({ data: { id: createId(), username: 'Test User', email: `testuser@example.com`, password: 'pass', balance: 50000 } });
  }

  const token = createId();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await prisma.session.create({ data: { id: createId(), email: user.email, token, userId: user.id, expiresAt, updatedAt: new Date() } });

  const base = 'http://localhost:4000';
  const authHeader = { headers: { Authorization: `Bearer ${token}` } };

  console.log('Attempting portfolio purchase of 10000 plan');
  try {
    const res = await axios.post(`${base}/api/portfolio/purchase`, { planId: `plan-${Date.now()}`, planName: '10k plan', planType: 'equity', amount: 10000, amountLabel: '₹10,000', returnLabel: 'Up to 10%', returnPercent: 10, durationLabel: '30 Days', totalReturn: 11000 }, authHeader);
    console.log('purchase response:', res.data);
  } catch (err) {
    console.error('purchase error:', err.response ? err.response.data : err.message);
  }

  try {
    const bal = await axios.get(`${base}/api/wallet/balance`, authHeader);
    console.log('wallet/balance:', bal.data);
  } catch (err) { console.error('balance error:', err.response ? err.response.data : err.message); }

  try {
    const pf = await axios.get(`${base}/api/portfolio`, authHeader);
    console.log('portfolio:', pf.data);
  } catch (err) { console.error('portfolio error:', err.response ? err.response.data : err.message); }

  // Inspect Upstash keys
  const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN) {
    const keys = [
      `profile:${user.id}`,
      `wallet:balance:${user.id}`,
      `wallet:transactions:${user.id}`,
      `portfolio:${user.id}`,
    ];
    const axiosClient = require('axios').create({ baseURL: UPSTASH_REDIS_REST_URL, headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` } });
    for (const key of keys) {
      try {
        const getRes = await axiosClient.get(`/get/${encodeURIComponent(key)}`);
        const ttlRes = await axiosClient.get(`/ttl/${encodeURIComponent(key)}`);
        console.log('\nKey:', key);
        console.log('GET:', getRes.data);
        console.log('TTL:', ttlRes.data);
      } catch (e) {
        console.error('inspect error for', key, e.response ? e.response.data : e.message);
      }
    }
  }

  await prisma.$disconnect();
})();
