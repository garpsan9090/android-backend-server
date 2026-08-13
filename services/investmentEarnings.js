const crypto = require('crypto');
const axios = require('axios');
const { prisma } = require('../prisma');

const REDIS_URL = process.env.REDIS_URL || process.env.REDIS || null;
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || null;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || null;

let redisClient = null;

function createUpstashRedisClient(baseUrl, token) {
  const client = axios.create({
    baseURL: baseUrl,
    timeout: 10000,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  async function execute(command) {
    const response = await client.post('', command);
    if (response.data?.error) {
      throw new Error(response.data.error);
    }
    return response.data?.result;
  }

  return {
    get: async (key) => execute(['get', key]),
    set: async (key, value, mode, ttl) => {
      const command = mode === 'EX' ? ['set', key, value, 'EX', String(ttl)] : ['set', key, value];
      return execute(command);
    },
    del: async (...keys) => execute(['del', ...keys]),
  };
}

try {
  if (REDIS_URL) {
    const IORedis = require('ioredis');
    redisClient = new IORedis(REDIS_URL);
  } else if (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN) {
    redisClient = createUpstashRedisClient(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN);
  }
} catch (e) {
  // redis optional
}

const cacheMap = new Map();

async function cacheGet(key) {
  if (redisClient) {
    const raw = await redisClient.get(key);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, 'payload')) {
        return parsed.payload;
      }
      return parsed;
    } catch { return raw; }
  }
  const entry = cacheMap.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) { cacheMap.delete(key); return null; }
  return entry.value;
}

async function cacheSet(key, value, ttlSec = 60) {
  if (redisClient) {
    try {
      const wrapper = { payload: value, lastUpdated: Date.now() };
      await redisClient.set(key, JSON.stringify(wrapper), 'EX', Math.max(1, ttlSec));
    } catch {}
    return;
  }
  cacheMap.set(key, { value, expiry: Date.now() + ttlSec * 1000 });
}

async function cacheGetRaw(key) {
  if (redisClient) {
    try {
      const raw = await redisClient.get(key);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    } catch { return null; }
  }
  const entry = cacheMap.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) { cacheMap.delete(key); return null; }
  return { payload: entry.value, lastUpdated: entry.expiry - entry.value }; // best-effort
}

async function cacheSetIfNewer(key, value, ttlSec = 60, lastUpdated = Date.now()) {
  if (!redisClient) return cacheSet(key, value, ttlSec);
  try {
    const existing = await cacheGetRaw(key);
    if (existing && existing.lastUpdated && existing.lastUpdated > lastUpdated) {
      return;
    }
    const wrapper = { payload: value, lastUpdated };
    await redisClient.set(key, JSON.stringify(wrapper), 'EX', Math.max(1, ttlSec));
  } catch (e) {
    // ignore
  }
}

function createId() {
  return crypto.randomBytes(16).toString('hex');
}

function roundToTwo(value) {
  return Number(Number(value || 0).toFixed(2));
}

function toIndiaMidnight(date) {
  const dt = new Date(date);
  const indiaDate = dt.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return new Date(`${indiaDate}T00:00:00+05:30`);
}

function addIndiaDays(date, days) {
  const result = new Date(date);
  result.setTime(result.getTime() + days * 24 * 60 * 60 * 1000);
  return result;
}

function isIndiaWeekend(date) {
  const weekday = new Date(date).toLocaleString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' });
  return weekday === 'Sat' || weekday === 'Sun';
}

function getIndiaWeekStart(date = new Date()) {
  const indiaMidnight = toIndiaMidnight(date);
  const weekday = new Date(indiaMidnight).toLocaleString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' });
  const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
  const idx = map[weekday] ?? 1;
  const start = new Date(indiaMidnight);
  const diff = idx === 0 ? -6 : 1 - idx;
  start.setDate(start.getDate() + diff);
  return toIndiaMidnight(start);
}

function getIndiaWeekEnd(date = new Date()) {
  const start = getIndiaWeekStart(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return toIndiaMidnight(end);
}

function parseDurationDays(label) {
  if (!label) return 22;
  const normalized = label.toLowerCase();
  if (normalized.includes('month')) return 22;
  const match = label.match(/(\d+)\s*days?/i);
  return match ? Number(match[1]) : 22;
}

function buildPortfolioPlan(transaction, todayGain = 0) {
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
  const durationDays = Math.max(parseDurationDays(transaction.investmentDuration || details.durationLabel || '30 Days'), 1);
  const expiresAt = new Date(purchasedAt.getTime() + durationDays * 24 * 60 * 60 * 1000);
  const totalProfit = Number(transaction.totalProfit ?? details.totalProfit ?? Math.max(Number(transaction.expectedReturn || 0) - Number(transaction.amount || 0), 0));
  const workingDays = Number(transaction.workingDays || details.workingDays || 22);
  const dailyProfit = Number(transaction.dailyProfit ?? details.dailyProfit ?? (workingDays ? totalProfit / workingDays : 0));

  return {
    id: transaction.investmentPlanId || transaction.id,
    planName: transaction.investmentName || details.planName || 'Investment Plan',
    planType: details.planType || 'equity',
    amount: Number(transaction.amount || 0),
    amountLabel: details.amountLabel || `₹${Number(transaction.amount || 0).toLocaleString('en-IN')}`,
    returnLabel: details.returnLabel || 'Up to 0%',
    returnPercent: Number(details.returnPercent || 0),
    durationLabel: transaction.investmentDuration || details.durationLabel || '30 Days',
    totalReturn: Number(transaction.expectedReturn || 0),
    totalProfit,
    dailyProfit,
    premium: Boolean(details.premium),
    quantity: 1,
    purchasedAt: purchasedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    workingDays,
    creditedEarnings: Number(transaction.creditedEarnings || 0),
    todayGain: Number(todayGain || 0),
    portfolioEarnings: Number(transaction.creditedEarnings || 0),
    investmentStatus: transaction.investmentStatus,
    transactionId: transaction.transactionId,
  };
}

function buildWeeklyEarningsSummary(earnings, referenceDate = new Date()) {
  const weekStart = getIndiaWeekStart(referenceDate);
  const weekEnd = getIndiaWeekEnd(referenceDate);

  const allEarnings = Array.isArray(earnings) ? earnings : [];
  const unclaimed = allEarnings.filter((earning) => String(earning.status || '').toLowerCase() !== 'claimed');
  const totalUnclaimed = roundToTwo(unclaimed.reduce((sum, item) => sum + Number(item.amount || 0), 0));

  const lastClaimedAt = allEarnings
    .filter((earning) => String(earning.status || '').toLowerCase() === 'claimed' && earning.claimedAt)
    .reduce((latest, earning) => {
      const timestamp = new Date(earning.claimedAt).getTime();
      return latest === null || timestamp > latest ? timestamp : latest;
    }, null);

  const pendingAfterLastClaim = unclaimed.filter((earning) => {
    if (lastClaimedAt === null) return true;
    return new Date(earning.creditedAt).getTime() > lastClaimedAt;
  });

  const completedTradingDays = new Set(
    pendingAfterLastClaim.map((earning) => toIndiaMidnight(earning.creditedAt).getTime())
  ).size;

  const claimAllowed = completedTradingDays >= 5 && totalUnclaimed > 0;
  const alreadyClaimed = totalUnclaimed === 0;

  return {
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    totalUnclaimed,
    completedTradingDays,
    claimAllowed,
    alreadyClaimed,
  };
}

async function getHolidaysInRange(startDate, endDate) {
  const start = toIndiaMidnight(startDate);
  const end = toIndiaMidnight(endDate);
  const cacheKey = `holidays:${start.getTime()}:${end.getTime()}`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    return new Set(cached);
  }

  const holidays = await prisma.holiday.findMany({
    where: {
      date: {
        gte: start,
        lt: addIndiaDays(end, 1),
      },
    },
  });
  const result = new Set(holidays.map((holiday) => toIndiaMidnight(holiday.date).getTime()));
  await cacheSetIfNewer(cacheKey, Array.from(result), 60 * 60, Date.now()).catch(() => {}); // cache for 1 hour
  return result;
}

function isTradingDate(date, holidaySet) {
  if (isIndiaWeekend(date)) return false;
  return !holidaySet.has(date.getTime());
}

async function getTradingDates(startDate, endDate) {
  const dates = [];
  const current = toIndiaMidnight(startDate);
  const end = toIndiaMidnight(endDate);
  const holidaySet = await getHolidaysInRange(startDate, endDate);

  while (current <= end) {
    if (isTradingDate(current, holidaySet)) {
      dates.push(new Date(current));
    }
    current.setTime(current.getTime() + 24 * 60 * 60 * 1000);
  }

  return dates;
}

async function getTradingEndDateForWorkingDays(startDate, workingDays) {
  if (workingDays <= 0) {
    throw new Error('workingDays must be greater than zero');
  }

  const start = toIndiaMidnight(startDate);
  const maxWindowEnd = addIndiaDays(start, 90);
  const holidaySet = await getHolidaysInRange(start, maxWindowEnd);

  let current = new Date(start);
  let counted = 0;

  while (current <= maxWindowEnd) {
    if (isTradingDate(current, holidaySet)) {
      counted += 1;
    }

    if (counted === workingDays) {
      return new Date(current);
    }

    current = addIndiaDays(current, 1);
  }

  throw new Error(`Unable to find ${workingDays} trading days within the search window`);
}

function calculateTotalProfit(amount, returnPercent) {
  return roundToTwo(amount * (returnPercent / 100));
}

function calculateDailyProfit(totalProfit, workingDays) {
  if (!workingDays) return 0;
  return roundToTwo(totalProfit / workingDays);
}

function getIndiaMinutes(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}

async function isTradingDay(date) {
  const normalized = toIndiaMidnight(date);
  const holidaySet = await getHolidaysInRange(normalized, addIndiaDays(normalized, 1));
  return isTradingDate(normalized, holidaySet);
}

let earningsProcessorRunning = false;

async function acquireProcessingLock() {
  if (earningsProcessorRunning) return false;
  earningsProcessorRunning = true;
  return true;
}

async function releaseProcessingLock() {
  earningsProcessorRunning = false;
}

async function processDailyInvestmentEarnings() {
  const lockAcquired = await acquireProcessingLock(5);
  if (!lockAcquired) {
    console.log('[earnings] Another earnings processor is already running. Skipping.');
    return;
  }

  try {
    if (getIndiaMinutes() < 15 * 60) {
      return;
    }

    const todayIndia = toIndiaMidnight(new Date());

    const activeInvestments = await prisma.transaction.findMany({
      where: {
        type: 'investment',
        investmentStatus: 'Active',
      },
    });

    for (const investment of activeInvestments) {
      try {
        const startAt = investment.investmentStartAt ? toIndiaMidnight(investment.investmentStartAt) : toIndiaMidnight(investment.createdAt);
        const endAt = investment.investmentEndAt ? toIndiaMidnight(investment.investmentEndAt) : await getTradingEndDateForWorkingDays(startAt, investment.workingDays || 22);
        const tradingDates = await getTradingDates(startAt, endAt);
        const workingDays = tradingDates.length;
        let investmentDetails = investment.investmentDetails || {};
        if (typeof investmentDetails === 'string') {
          try {
            investmentDetails = JSON.parse(investmentDetails || '{}');
          } catch {
            investmentDetails = {};
          }
        }
        const totalProfit = calculateTotalProfit(Number(investment.amount || 0), Number(investment.returnPercent || investmentDetails.returnPercent || 0));
        if (!workingDays || totalProfit <= 0) {
          continue;
        }

        const dailyProfit = calculateDailyProfit(totalProfit, workingDays);
        const lastTradingDate = tradingDates[tradingDates.length - 1];
        const eligibleDates = tradingDates.filter((date) => date.getTime() <= todayIndia.getTime());
        if (!eligibleDates.length) continue;

        const existingEarnings = await prisma.investmentEarning.findMany({
          where: { investmentId: investment.id },
        });
        const existingDates = new Set(existingEarnings.map((earning) => toIndiaMidnight(earning.creditedAt).getTime()));
        const pendingDates = eligibleDates.filter((date) => !existingDates.has(date.getTime()));
        if (!pendingDates.length) continue;

        const earningsData = pendingDates.map((date) => {
          const isFinalProfitDate = date.getTime() === lastTradingDate.getTime();
          const amount = isFinalProfitDate
            ? roundToTwo(totalProfit - dailyProfit * (workingDays - 1))
            : dailyProfit;

          return {
            id: createId(),
            investmentId: investment.id,
            amount,
            creditedAt: date,
            status: 'unclaimed',
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        });

        await prisma.$transaction(async (tx) => {
          await tx.investmentEarning.createMany({
            data: earningsData,
            skipDuplicates: true,
          });

          const aggregate = await tx.investmentEarning.aggregate({
            where: { investmentId: investment.id },
            _sum: { amount: true },
          });

          const totalCredited = roundToTwo(aggregate._sum.amount || 0);
          const updateData = { creditedEarnings: totalCredited };
          if (totalCredited >= totalProfit) {
            updateData.investmentStatus = 'Completed';
            updateData.completedAt = new Date();
          }

          await tx.transaction.update({
            where: { id: investment.id },
            data: updateData,
          });
        });
      } catch (error) {
        console.error('[earnings] Failed to process investment', investment.id, error);
      }
    }
  } finally {
    await releaseProcessingLock();
  }
}

async function getPortfolioSummaryForUser({ userId, referenceDate = new Date() }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error('User not found');
  }

  const transactions = await prisma.transaction.findMany({
    where: { userId, type: 'investment' },
    orderBy: { createdAt: 'desc' },
  });

  const investmentIds = transactions.map((transaction) => transaction.id);
  let todayGainMap = new Map();
  let creditedEarningsMap = new Map();

  if (investmentIds.length) {
    const todayStart = toIndiaMidnight(referenceDate);
    const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    const todayEarnings = await prisma.investmentEarning.groupBy({
      by: ['investmentId'],
      _sum: { amount: true },
      where: {
        investmentId: { in: investmentIds },
        creditedAt: {
          gte: todayStart,
          lt: tomorrowStart,
        },
      },
    });

    todayGainMap = new Map(todayEarnings.map((item) => [item.investmentId, Number(item._sum.amount || 0)]));

    const creditedEarnings = await prisma.investmentEarning.groupBy({
      by: ['investmentId'],
      _sum: { amount: true },
      where: {
        investmentId: { in: investmentIds },
      },
    });

    creditedEarningsMap = new Map(creditedEarnings.map((item) => [item.investmentId, Number(item._sum.amount || 0)]));
  }

  const plans = transactions.map((transaction) => {
    const todayGain = todayGainMap.get(transaction.id) || 0;
    const creditedEarnings = Number(creditedEarningsMap.get(transaction.id) ?? transaction.creditedEarnings ?? 0);
    return {
      ...buildPortfolioPlan({ ...transaction, creditedEarnings }, todayGain),
    };
  });

  // Aggregate plans by plan id + amount into quantities
  const grouped = {};
  for (const p of plans) {
    const key = `${p.id}::${p.amount}`;
    if (!grouped[key]) {
      grouped[key] = { ...p, quantity: Number(p.quantity || 1) };
    } else {
      grouped[key].quantity += Number(p.quantity || 1);
      grouped[key].totalProfit = Number(grouped[key].totalProfit || 0) + Number(p.totalProfit || 0);
      grouped[key].creditedEarnings = Number(grouped[key].creditedEarnings || 0) + Number(p.creditedEarnings || 0);
      grouped[key].portfolioEarnings = Number(grouped[key].portfolioEarnings || 0) + Number(p.portfolioEarnings || 0);
      grouped[key].todayGain = Number(grouped[key].todayGain || 0) + Number(p.todayGain || 0);
      // keep earliest purchasedAt and latest expiresAt
      if (new Date(p.purchasedAt).getTime() < new Date(grouped[key].purchasedAt).getTime()) {
        grouped[key].purchasedAt = p.purchasedAt;
      }
      if (new Date(p.expiresAt).getTime() > new Date(grouped[key].expiresAt).getTime()) {
        grouped[key].expiresAt = p.expiresAt;
      }
    }
  }

  const aggregatedPlans = Object.values(grouped);

  const allEarnings = await prisma.investmentEarning.findMany({
    where: { transaction: { userId } },
    orderBy: { creditedAt: 'asc' },
  });

  return {
    balance: user.balance,
    plans: aggregatedPlans,
    totalInvested: aggregatedPlans.reduce((sum, plan) => sum + plan.amount * (plan.quantity || 1), 0),
    weeklyData: buildWeeklyEarningsSummary(allEarnings, referenceDate),
  };
}

async function claimPendingWeekEarnings({ userId, referenceDate = new Date() }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error('User not found');
  }

  const allUnclaimedEarnings = await prisma.investmentEarning.findMany({
    where: {
      transaction: { userId },
      status: 'unclaimed',
    },
    orderBy: { creditedAt: 'asc' },
  });

  if (!allUnclaimedEarnings.length) {
    const summary = buildWeeklyEarningsSummary([], referenceDate);
    return {
      claimedAmount: 0,
      balance: user.balance,
      weeklyData: summary,
    };
  }

  const lastClaimed = await prisma.investmentEarning.findFirst({
    where: { transaction: { userId }, status: 'claimed' },
    orderBy: { claimedAt: 'desc' },
  });

  const claimableEarnings = allUnclaimedEarnings.filter((earning) => {
    if (!lastClaimed || !lastClaimed.claimedAt) return true;
    return new Date(earning.creditedAt).getTime() > new Date(lastClaimed.claimedAt).getTime();
  });

  const completedTradingDays = new Set(
    claimableEarnings.map((earning) => new Date(earning.creditedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })),
  ).size;

  if (completedTradingDays < 5) {
    const err = new Error('You can claim only after 5 complete trading days since your last claim.');
    err.statusCode = 400;
    throw err;
  }

  const totalClaimable = claimableEarnings.reduce((sum, earning) => sum + Number(earning.amount || 0), 0);

  await prisma.$transaction(async (tx) => {
    await tx.investmentEarning.updateMany({
      where: { id: { in: claimableEarnings.map((earning) => earning.id) } },
      data: { status: 'claimed', claimedAt: new Date() },
    });

    await tx.user.update({
      where: { id: userId },
      data: { balance: { increment: totalClaimable } },
    });
  });

  const updatedUser = await prisma.user.findUnique({ where: { id: userId } });
  const allEarnings = await prisma.investmentEarning.findMany({
    where: { transaction: { userId } },
    orderBy: { creditedAt: 'asc' },
  });

  return {
    claimedAmount: totalClaimable,
    balance: updatedUser?.balance ?? user.balance,
    weeklyData: buildWeeklyEarningsSummary(allEarnings, referenceDate),
  };
}

module.exports = {
  createId,
  roundToTwo,
  toIndiaMidnight,
  addIndiaDays,
  isTradingDay,
  getTradingDates,
  getTradingEndDateForWorkingDays,
  calculateTotalProfit,
  calculateDailyProfit,
  getIndiaMinutes,
  processDailyInvestmentEarnings,
  buildWeeklyEarningsSummary,
  getPortfolioSummaryForUser,
  claimPendingWeekEarnings,
};

async function finalizeInvestment(investmentId) {
  const investment = await prisma.transaction.findUnique({ where: { id: investmentId } });
  if (!investment) throw new Error('Investment not found');

  const startAt = investment.investmentStartAt ? toIndiaMidnight(investment.investmentStartAt) : toIndiaMidnight(investment.createdAt);
  const workingDays = investment.investmentDurationDays || investment.workingDays || (investment.investmentDetails && investment.investmentDetails.workingDays) || 22;
  const endAt = await getTradingEndDateForWorkingDays(startAt, workingDays);
  const tradingDates = await getTradingDates(startAt, endAt);

  const detailsRaw = investment.investmentDetails || {};
  let details = detailsRaw;
  if (typeof detailsRaw === 'string') {
    try { details = JSON.parse(detailsRaw || '{}'); } catch { details = {}; }
  }

  const totalProfit = calculateTotalProfit(Number(investment.amount || 0), Number(investment.returnPercent || details.returnPercent || 0));
  const dailyProfit = calculateDailyProfit(totalProfit, tradingDates.length || workingDays);

  const earningsData = tradingDates.map((date, idx) => {
    const isFinal = idx === tradingDates.length - 1;
    const amount = isFinal ? roundToTwo(totalProfit - dailyProfit * (tradingDates.length - 1)) : dailyProfit;
    return {
      id: crypto.randomBytes(16).toString('hex'),
      investmentId: investment.id,
      amount,
      creditedAt: date,
      status: 'unclaimed',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  });

  await prisma.$transaction(async (tx) => {
    if (earningsData.length) {
      await tx.investmentEarning.createMany({ data: earningsData, skipDuplicates: true });
    }

    const aggregate = await tx.investmentEarning.aggregate({ where: { investmentId: investment.id }, _sum: { amount: true } });
    const totalCredited = roundToTwo(aggregate._sum.amount || 0);

    const updateData = { creditedEarnings: totalCredited, investmentEndAt: endAt, workingDays: tradingDates.length };
    if (totalCredited >= totalProfit) {
      updateData.investmentStatus = 'Completed';
      updateData.completedAt = new Date();
    }

    await tx.transaction.update({ where: { id: investment.id }, data: updateData });
  });
}

module.exports.finalizeInvestment = finalizeInvestment;

