const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local') });
const { prisma } = require('../prisma');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

function createId() {
  return crypto.randomBytes(16).toString('hex');
}

async function main() {
  try {
    const username = process.argv[2];
    const plain = process.argv[3];
    if (!username || !plain) {
      console.error('Usage: node create_admin_manual.js <username> <password>');
      process.exit(2);
    }

    const existing = await prisma.admin.findUnique({ where: { username } });
    if (existing) {
      console.error('Admin already exists:', username);
      process.exit(1);
    }

    const hashed = await bcrypt.hash(plain, 10);
    const secretKey = crypto.randomBytes(16).toString('hex');
    const admin = await prisma.admin.create({
      data: {
        id: createId(),
        username,
        password: hashed,
        secretKey,
      },
    });

    console.log('Created new admin account:');
    console.log(`username: ${admin.username}`);
    console.log(`password: ${plain}`);
    console.log(`secretKey: ${secretKey}`);
    console.log('Store the password and secretKey securely.');
    process.exit(0);
  } catch (err) {
    console.error('Failed to create admin:', err.message || err);
    process.exit(1);
  }
}

main();
