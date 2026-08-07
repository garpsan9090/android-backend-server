const crypto = require('crypto');
const { prisma } = require('../prisma');
const {
  toIndiaMidnight,
  getTradingDates,
  getTradingEndDateForWorkingDays,
  calculateTotalProfit,
  calculateDailyProfit,
  roundToTwo,
  getIndiaMinutes,
} = require('./investmentEarnings');

function determineWorkingDays(durationLabel, planType) {
  const normalizedLabel = String(durationLabel || '').trim().toLowerCase();
  if (normalizedLabel.includes('month')) {
    return 22;
  }
  const daysMatch = normalizedLabel.match(/(\d+)\s*days?/i);
  if (daysMatch) {
    return Number(daysMatch[1]);
  }
  const weeksMatch = normalizedLabel.match(/(\d+)\s*weeks?/i);
  if (weeksMatch) {
    return Number(weeksMatch[1]) * 5;
  }
  if (planType === 'fno') {
    return 5;
  }
  if (planType === 'equity') {
    return 22;
  }
  return 22;
}

function buildPortfolioPlan(transaction) {
  let details = {};
  try {
    if (transaction.investmentDetails) {
      details = typeof transaction.investmentDetails === 'string'
        ? JSON.parse(transaction.investmentDetails)
        : transaction.investmentDetails;
    }
  } catch {
    details = {};
  }

  const purchasedAt = transaction.investmentStartAt ? new Date(transaction.investmentStartAt) : new Date(transaction.createdAt);
  const expiresAt = transaction.investmentEndAt ? new Date(transaction.investmentEndAt) : new Date(details.expiresAt || purchasedAt);
  const amount = Number(transaction.amount || 0);
  const expectedReturn = Number(transaction.expectedReturn || 0);
  const returnPercent = Number(transaction.returnPercent || details.returnPercent || (amount && expectedReturn ? ((expectedReturn - amount) / amount) * 100 : 0));
  const totalProfit = Number(transaction.totalProfit ?? details.totalProfit ?? Math.max(expectedReturn - amount, 0));
  const workingDays = Number(transaction.workingDays || details.workingDays || 22);
  const dailyProfit = Number(transaction.dailyProfit ?? details.dailyProfit ?? (workingDays ? totalProfit / workingDays : 0));

  const investmentStatus = transaction.investmentStatus || 'Active';
  const availableActions = investmentStatus === 'Completed'
    ? ['Reinvest', 'Withdraw']
    : investmentStatus === 'Active'
      ? ['View Details']
      : ['View Details'];

  return {
    id: transaction.investmentPlanId || transaction.id,
    planName: transaction.investmentName || details.planName || 'Investment Plan',
    planType: details.planType || 'equity',
    amount,
    amountLabel: details.amountLabel || `₹${Number(transaction.amount || 0).toLocaleString('en-IN')}`,
    returnLabel: details.returnLabel || 'Up to 0%',
    returnPercent,
    durationLabel: transaction.investmentDuration || details.durationLabel || '22 Working Days',
    totalReturn: expectedReturn || amount + totalProfit,
    totalProfit,
    dailyProfit,
    premium: Boolean(details.premium),
    purchasedAt: purchasedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    workingDays,
    creditedEarnings: Number(transaction.creditedEarnings || 0),
    investmentStatus,
    availableActions,
    transactionId: transaction.transactionId,
  };
}

async function purchaseInvestment({
  userId,
  planId,
  planName,
  planType,
  amount,
  amountLabel,
  returnLabel,
  returnPercent,
  durationLabel,
  premium,
}) {
  const { enqueueFinalize } = require('../queues/finalizeQueue');

  const investmentAmount = Number(amount || 0);
  const returnPct = Number(returnPercent || 0);
  const purchaseTime = new Date();
  const purchaseDay = toIndiaMidnight(purchaseTime);
  const investmentStartAt = getIndiaMinutes(purchaseTime) >= 15 * 60
    ? new Date(purchaseDay.getTime() + 24 * 60 * 60 * 1000)
    : purchaseDay;
  const workingDays = determineWorkingDays(durationLabel, planType);
  const totalProfit = calculateTotalProfit(investmentAmount, returnPct);
  const dailyProfit = calculateDailyProfit(totalProfit, workingDays);
  const expectedReturn = roundToTwo(investmentAmount + totalProfit);

  const estimatedEnd = await getTradingEndDateForWorkingDays(investmentStartAt, workingDays);

  const transaction = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { balance: { decrement: investmentAmount } },
    });

    return tx.transaction.create({
      data: {
        id: crypto.randomBytes(16).toString('hex'),
        type: 'investment',
        amount: investmentAmount,
        status: 'successful',
        description: `Purchased ${planName || 'Investment Plan'}`,
        transactionId: `INV-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        userId,
        investmentPlanId: planId,
        investmentName: planName,
        investmentDuration: durationLabel || `${workingDays} Working Days`,
        investmentDurationDays: workingDays,
        returnPercent: returnPct,
        expectedReturn,
        totalProfit,
        dailyProfit,
        investmentStartAt,
        investmentEndAt: estimatedEnd,
        workingDays,
        creditedEarnings: 0,
        investmentStatus: 'Active',
        investmentDetails: JSON.stringify({
          planType,
          amountLabel,
          returnLabel,
          returnPercent: returnPct,
          premium,
          durationLabel: durationLabel || `${workingDays} Working Days`,
          expiresAt: estimatedEnd.toISOString(),
          workingDays,
          totalProfit,
          dailyProfit,
          tradingDays: [],
        }),
      },
    });
  });

  // enqueue background finalize work (best-effort)
  try {
    void enqueueFinalize(transaction.id);
  } catch (e) {
    console.error('[purchase] failed to enqueue finalize job', e && e.message ? e.message : e);
  }

  return transaction;
}
async function reinvestInvestment({ userId, investmentId }) {
  const investment = await prisma.transaction.findUnique({ where: { id: investmentId } });
  if (!investment || investment.userId !== userId) {
    throw new Error('Investment not found');
  }
  if (investment.investmentStatus !== 'Completed') {
    throw new Error('Only completed investments can be reinvested');
  }

  const details = typeof investment.investmentDetails === 'string'
    ? JSON.parse(investment.investmentDetails || '{}')
    : investment.investmentDetails || {};

  const reinvestAmount = Number(investment.amount || 0);
  const returnPct = Number(investment.returnPercent || details.returnPercent || 0);
  const planName = investment.investmentName || details.planName || 'Investment Plan';
  const planType = details.planType || 'equity';
  const planDurationLabel = investment.investmentDuration || details.durationLabel || '22 Working Days';
  const purchaseTime = new Date();
  const purchaseDay = toIndiaMidnight(purchaseTime);
  const investmentStartAt = getIndiaMinutes(purchaseTime) >= 15 * 60
    ? new Date(purchaseDay.getTime() + 24 * 60 * 60 * 1000)
    : purchaseDay;
  const workingDays = investment.investmentDurationDays || details.workingDays || 22;
  const investmentEndAt = await getTradingEndDateForWorkingDays(investmentStartAt, workingDays);
  const tradingDates = await getTradingDates(investmentStartAt, investmentEndAt);
  const totalProfit = calculateTotalProfit(reinvestAmount, returnPct);
  const dailyProfit = calculateDailyProfit(totalProfit, workingDays);
  const expectedReturn = roundToTwo(reinvestAmount + totalProfit);

  const newInvestment = await prisma.transaction.create({
    data: {
      id: crypto.randomBytes(16).toString('hex'),
      type: 'investment',
      amount: reinvestAmount,
      status: 'successful',
      description: `Reinvested ${planName}`,
      transactionId: `REINVEST-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      userId,
      investmentPlanId: investment.investmentPlanId,
      investmentName: planName,
      investmentDuration: planDurationLabel,
      investmentDurationDays: workingDays,
      returnPercent: returnPct,
      expectedReturn,
      totalProfit,
      dailyProfit,
      investmentStartAt,
      investmentEndAt,
      workingDays,
      creditedEarnings: 0,
      investmentStatus: 'Active',
      investmentDetails: JSON.stringify({
        planType,
        amountLabel: details.amountLabel || `₹${reinvestAmount.toLocaleString('en-IN')}`,
        returnLabel: details.returnLabel,
        returnPercent: returnPct,
        premium: Boolean(details.premium),
        durationLabel: planDurationLabel,
        expiresAt: investmentEndAt.toISOString(),
        workingDays,
        totalProfit,
        dailyProfit,
        tradingDays: tradingDates.map((date) => date.toISOString()),
        reinvestedFrom: investment.id,
      }),
      reinvestedFromId: investment.id,
    },
  });

  // enqueue finalize for reinvested plan
  try {
    const { enqueueFinalize } = require('../queues/finalizeQueue');
    void enqueueFinalize(newInvestment.id);
  } catch (e) {
    console.error('[reinvest] failed to enqueue finalize job', e && e.message ? e.message : e);
  }

  await prisma.transaction.update({
    where: { id: investment.id },
    data: {
      investmentStatus: 'Reinvested',
      referenceTxnId: newInvestment.id,
    },
  });

  return newInvestment;
}

module.exports = {
  buildPortfolioPlan,
  purchaseInvestment,
  reinvestInvestment,
};
