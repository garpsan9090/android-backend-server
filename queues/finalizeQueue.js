const { Queue, QueueScheduler } = require('bullmq');
const IORedis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || process.env.REDIS || null;
const hasRedis = Boolean(REDIS_URL);

const queueName = 'finalizeInvestment';

let finalizeQueue = null;
if (hasRedis) {
  const connection = new IORedis(REDIS_URL);
  finalizeQueue = new Queue(queueName, { connection });
  // ensure delayed/retry jobs are scheduled reliably
  new QueueScheduler(queueName, { connection });
} else {
  // fallback: provide a no-op queue so the rest of the codebase can call enqueueFinalize safely
  // Logs warn in runtime when trying to enqueue
  // finalizeQueue remains null when Redis is not configured
}

async function enqueueFinalize(transactionId, opts = {}) {
  if (!hasRedis || !finalizeQueue) {
    console.warn('[finalizeQueue] Redis not configured; skipping enqueue for', transactionId);
    return Promise.resolve(null);
  }

  return finalizeQueue.add('finalize', { transactionId }, Object.assign({ attempts: 5, backoff: { type: 'exponential', delay: 5000 } }, opts));
}

module.exports = {
  enqueueFinalize,
  _queue: finalizeQueue,
};
