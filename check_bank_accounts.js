require('dotenv').config({ path: './.env.local' });
const { prisma } = require('./prisma');

(async () => {
  try {
    await prisma.$connect();
  } catch (e) {
    console.error('Prisma connect failed', e?.message || e);
    process.exit(1);
  }

  const user = await prisma.user.findFirst();
  if (!user) {
    console.log('No users found');
    await prisma.$disconnect();
    return;
  }

  console.log('Checking bank accounts for user:', user.id, user.email || user.username);
  const accounts = await prisma.bankAccount.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
  console.log('Found', accounts.length, 'bank accounts');
  for (const a of accounts) {
    console.log({ id: a.id, holder: a.accountHolderName, accountNumber: a.accountNumber, bankName: a.bankName, ifsc: a.ifscCode, createdAt: a.createdAt });
  }

  await prisma.$disconnect();
})();
