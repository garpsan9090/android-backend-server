const { prisma } = require('../prisma');
const { purchaseInvestment } = require('../services/investmentPurchaseService');
const crypto = require('crypto');

const POLL_INTERVAL_MS = Number(process.env.DB_QUEUE_POLL_INTERVAL_MS || 1000);
const MAX_ATTEMPTS = Number(process.env.DB_QUEUE_MAX_ATTEMPTS || 5);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function claimNext() {
  const now = new Date();
  const candidate = await prisma.queuedPurchase.findFirst({
    where: { status: 'pending', availableAt: { lte: now } },
    orderBy: { availableAt: 'asc' },
  });
  if (!candidate) return null;

  // try to atomically claim using updateMany
  const res = await prisma.queuedPurchase.updateMany({
    where: { id: candidate.id, status: 'pending' },
    data: { status: 'processing', lockedAt: new Date(), lockedBy: `dbWorker:${process.pid}` },
  });
  if (res.count === 0) return null; // someone else claimed

  // fetch fresh
  return await prisma.queuedPurchase.findUnique({ where: { id: candidate.id } });
}

async function processRecord(record) {
  const maxAttempts = MAX_ATTEMPTS;
  try {
    const payload = JSON.parse(record.payload || '{}');
    // Ensure payload has userId
    payload.userId = payload.userId || record.userId;

    await purchaseInvestment(payload);

    await prisma.queuedPurchase.update({ where: { id: record.id }, data: { status: 'completed', updatedAt: new Date() } });
    console.log('[dbPurchaseWorker] processed purchase', record.id);
  } catch (err) {
    console.error('[dbPurchaseWorker] processing error', err && err.message ? err.message : err);
    const attempts = (record.attempts || 0) + 1;
    const backoffMs = Math.min(5 * 60 * 1000, Math.pow(2, attempts) * 1000);
    const nextAvailable = new Date(Date.now() + backoffMs);

    const updateData = {
      attempts,
      status: attempts >= maxAttempts ? 'failed' : 'pending',
      availableAt: attempts >= maxAttempts ? undefined : nextAvailable,
      lockedAt: null,
      lockedBy: null,
      errorMessage: String(err && err.stack ? err.stack : err),
    };

    await prisma.queuedPurchase.update({ where: { id: record.id }, data: updateData });
    console.log('[dbPurchaseWorker] scheduled retry', record.id, 'attempts=', attempts);
  }
}

async function run() {
  console.log('[dbPurchaseWorker] started, poll interval', POLL_INTERVAL_MS, 'ms');
  while (true) {
    try {
      const record = await claimNext();
      if (!record) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      await processRecord(record);
    } catch (err) {
      console.error('[dbPurchaseWorker] loop error', err && err.message ? err.message : err);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

if (require.main === module) {
  run().catch((e) => {
    console.error('dbPurchaseWorker crashed', e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

module.exports = { run };
