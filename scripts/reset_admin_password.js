const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local') });
const { prisma } = require('../prisma');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

function randPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/\/+|=+/g, '').slice(0, 12);
}

async function main() {
  try {
    const username = process.argv[2];
    const provided = process.argv[3];
    if (!username) {
      console.error('Usage: node reset_admin_password.js <username> [newPassword]');
      process.exit(2);
    }

    const admin = await prisma.admin.findUnique({ where: { username } });
    if (!admin) {
      console.error('Admin not found:', username);
      process.exit(1);
    }

    const newPassword = provided || randPassword();
    const hashed = await bcrypt.hash(newPassword, 10);
    await prisma.admin.update({ where: { username }, data: { password: hashed } });

    console.log('Password reset for admin:', username);
    console.log('newPassword:', newPassword);
    process.exit(0);
  } catch (err) {
    console.error('Error resetting admin password:', err);
    process.exit(1);
  }
}

main();
