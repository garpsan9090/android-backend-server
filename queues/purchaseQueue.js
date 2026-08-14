const { prisma } = require('../prisma');

async function enqueuePurchase(payload, opts = {}) {
  try {
    const record = await prisma.queuedPurchase.create({
      data: {
        userId: String(payload.userId || ''),
        payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
        status: 'pending',
        attempts: 0,
      },
    });
    return record;
  } catch (err) {
    console.warn('[purchaseQueue] DB enqueue failed', err?.message || err);
    return null;
  }
}

module.exports = { enqueuePurchase, _queue: null };
