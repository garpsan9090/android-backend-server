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
    const existing = await prisma.admin.findMany();
    if (existing && existing.length > 0) {
      console.log('Found existing admin account(s):');
      existing.forEach((a) => {
        console.log(`- username: ${a.username}  id: ${a.id}  createdAt: ${a.createdAt.toISOString()}`);
      });
      process.exit(0);
    }

    const username = 'admin';
    const plain = crypto.randomBytes(9).toString('base64').replace(/\/+|=+/g, '').slice(0, 12);
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
    console.error('Failed to check/create admin:', err);
    process.exit(1);
  }
}

main();
