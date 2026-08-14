const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local') });
const { prisma } = require('../prisma');

async function listAccounts() {
  try {
    const email = process.argv[2] || 'jagathpj4@gmail.com';
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      console.error('User not found:', email);
      process.exit(1);
    }
    const accounts = await prisma.bankAccount.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
    console.log(`Bank accounts for ${email} (userId=${user.id}):`);
    console.log(JSON.stringify(accounts, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('Error listing bank accounts:', err);
    process.exit(1);
  }
}

listAccounts();
