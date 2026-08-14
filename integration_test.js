require('dotenv').config({ path: '../.env.local' });
const axios = require('axios');
const crypto = require('crypto');
const { prisma } = require('./prisma');

function createId() { return crypto.randomBytes(16).toString('hex'); }
function createToken() { return crypto.randomBytes(32).toString('hex'); }

(async () => {
  try {
    // Ensure prisma can connect
    await prisma.$connect();
  } catch (err) {
    console.error('Prisma connect failed', err.message || err);
    process.exit(1);
  }

  let user = await prisma.user.findFirst();
  if (!user) {
    console.log('No user found — creating test user');
    const hashed = '$2a$10$EzUe6cQmX4G3Q1kzG8Qf6e4yYQF0cHqG9Q2y3vV9G1Q9G1a';
    user = await prisma.user.create({ data: { id: createId(), username: 'testuser', email: `test+${Date.now()}@example.com`, password: hashed, balance: 100000 } });
  }

  // Create a session token
  const token = createToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await prisma.session.create({ data: { id: createId(), email: user.email, token, userId: user.id, expiresAt, updatedAt: new Date() } });

  const base = 'http://localhost:4000';
  const authHeader = { headers: { Authorization: `Bearer ${token}` } };

  console.log('Performing deposit of 500');
  try {
    const dep = await axios.post(`${base}/api/wallet/deposit`, { amount: 500, paymentMethod: 'upi' }, authHeader);
    console.log('deposit response:', dep.data);
  } catch (err) {
    console.error('deposit error:', err.response ? err.response.data : err.message);
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
    console.log('portfolio:', Object.keys(pf.data).length ? (pf.data.totalInvested ? { totalInvested: pf.data.totalInvested, balance: pf.data.balance } : pf.data) : pf.data);
  } catch (err) {
    console.error('portfolio error:', err.response ? err.response.data : err.message);
  }

  // Show recent backend.log lines
  const fs = require('fs');
  try {
    const logs = fs.readFileSync('../backend.log', 'utf8');
    console.log('\n--- backend.log (last 200 lines) ---');
    const lines = logs.split('\n').slice(-200).join('\n');
    console.log(lines);
  } catch (e) {
    console.warn('Could not read backend.log', e.message || e);
  }

  await prisma.$disconnect();
})();
