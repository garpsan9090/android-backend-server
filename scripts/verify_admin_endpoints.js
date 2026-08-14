const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local') });
const axios = require('axios');

const base = process.env.BASE_URL || `http://localhost:${process.env.PORT || 4000}`;

(async () => {
  try {
    await axios.get(`${base}/api/health`, { timeout: 3000 });
  } catch (err) {
    console.error('Backend not responding at', base);
    process.exit(2);
  }

  const username = `ci_check_${Date.now()}`;
  const password = 'StrongP@ssw0rd!';
  const creationKey = process.env.ADMIN_CREATION_KEY;
  if (!creationKey) {
    console.error('ADMIN_CREATION_KEY not configured in env');
    process.exit(2);
  }

  try {
    await axios.post(`${base}/api/admin/signup`, { username, password, creationKey }, { timeout: 5000 });
  } catch (err) {
    // ignore if already exists
  }

  const login = await axios.post(`${base}/api/admin/login`, { username, password }, { timeout: 5000 });
  const token = login.data && login.data.token;
  if (!token) throw new Error('Login failed, no token returned');

  const summaryRes = await axios.get(`${base}/api/admin/summary`, { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 });
  if (typeof summaryRes.data.totalPortfolioValue !== 'number') throw new Error('totalPortfolioValue missing or not a number');

  const usersRes = await axios.get(`${base}/api/admin/users`, { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 });
  if (!Array.isArray(usersRes.data.users)) throw new Error('users array missing');
  if (usersRes.data.users.length && typeof usersRes.data.users[0].portfolioValue === 'undefined') throw new Error('portfolioValue missing on user objects');

  console.log('verify_admin_endpoints: OK', { totalPortfolioValue: summaryRes.data.totalPortfolioValue, users: usersRes.data.users.length });
  process.exit(0);
})().catch((err) => {
  console.error('verify_admin_endpoints: FAILED', err?.message || err);
  process.exit(1);
});
