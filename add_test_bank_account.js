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

  const newAccount = await prisma.bankAccount.create({
    data: {
      id: 'test-bank-' + Date.now(),
      userId: user.id,
      accountHolderName: 'Test Holder',
      accountNumber: '1111222233334444',
      ifscCode: 'TEST0001',
      bankName: 'Test Bank',
      branchName: 'Main',
      isVerified: false,
    },
  });

  console.log('Created bank account:', { id: newAccount.id, userId: newAccount.userId });
  await prisma.$disconnect();
})();
