const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local') });
const { prisma } = require('../prisma');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

async function createUser() {
  try {
    const email = 'jagathpj4@gmail.com';
    const phoneNumber = '9876543210';
    const plainPassword = 'Darling@143';
    const username = 'jagathpj4';
    const balance = 1200000; // 12 lakh

    const hashed = await bcrypt.hash(plainPassword, 10);
    const id = crypto.randomBytes(16).toString('hex');

    const user = await prisma.user.upsert({
      where: { email },
      update: {
        username,
        password: hashed,
        balance,
        phoneNumber,
      },
      create: {
        id,
        username,
        email,
        password: hashed,
        balance,
        phoneNumber,
      },
    });

    console.log('Upserted user:', { id: user.id, email: user.email, username: user.username, balance: user.balance });
    process.exit(0);
  } catch (err) {
    console.error('Error creating user:', err);
    process.exit(1);
  }
}

createUser();
