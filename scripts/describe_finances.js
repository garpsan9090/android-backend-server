const { prisma } = require('../prisma');

(async () => {
  try {
    const userCount = await prisma.user.count();
    const totalBalanceRes = await prisma.user.aggregate({ _sum: { balance: true } });
    const totalBalance = Number(totalBalanceRes._sum.balance || 0);

    const totalDepositedRes = await prisma.transaction.aggregate({ where: { type: 'deposit', status: 'completed' }, _sum: { amount: true } });
    const totalDeposited = Number(totalDepositedRes._sum.amount || 0);
    const totalWithdrawnRes = await prisma.transaction.aggregate({ where: { type: 'withdraw', status: 'completed' }, _sum: { amount: true } });
    const totalWithdrawn = Number(totalWithdrawnRes._sum.amount || 0);

    const pendingCount = await prisma.transaction.count({ where: { OR: [{ status: 'pending' }, { verificationStatus: 'pending' }] } });

    const recentPending = await prisma.transaction.findMany({ where: { OR: [{ status: 'pending' }, { verificationStatus: 'pending' }] }, orderBy: { createdAt: 'desc' }, take: 8, include: { user: true } });

    const investments = await prisma.transaction.findMany({ where: { type: 'investment' }, select: { amount: true, creditedEarnings: true, investmentStatus: true, userId: true } });
    const activeInvestments = investments.filter(i => ['Active','Reinvested'].includes(i.investmentStatus));
    const totalPortfolioValue = activeInvestments.reduce((s, t) => s + Number(t.amount||0) + Number(t.creditedEarnings||0), 0);

    console.log(JSON.stringify({ userCount, totalBalance, totalDeposited, totalWithdrawn, pendingCount, totalPortfolioValue, activeInvestmentsCount: activeInvestments.length, recentPendingCount: recentPending.length }, null, 2));
  } catch (err) {
    console.error(err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
