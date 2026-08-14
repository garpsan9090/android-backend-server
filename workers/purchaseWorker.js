const { Worker, Queue, QueueScheduler } = require('bullmq');
const IORedis = require('ioredis');
const winston = require('winston');
const promClient = require('prom-client');

const { purchaseInvestment } = require('../services/investmentPurchaseService');

const REDIS_URL = process.env.REDIS_URL || process.env.REDIS || null;
const hasRedis = Boolean(REDIS_URL);

const queueName = 'purchaseInvestment';
if (!hasRedis) {
  const logger = winston.createLogger({ transports: [new winston.transports.Console()] });
  logger.warn('Redis is not configured. Purchase worker will not start. Set REDIS_URL to enable job processing.');
  process.exit(0);
}

const connection = new IORedis(REDIS_URL);
new QueueScheduler(queueName, { connection });

const logger = winston.createLogger({ transports: [new winston.transports.Console()] });

promClient.collectDefaultMetrics({ timeout: 5000 });
const purchaseDuration = new promClient.Histogram({ name: 'purchase_job_duration_seconds', help: 'Duration of purchase job in seconds', buckets: [0.1, 0.5, 1, 2, 5, 10] });
const purchaseSuccess = new promClient.Counter({ name: 'purchase_jobs_success_total', help: 'Purchase jobs succeeded' });
const purchaseFailed = new promClient.Counter({ name: 'purchase_jobs_failed_total', help: 'Purchase jobs failed' });

const worker = new Worker(queueName, async (job) => {
  const endTimer = purchaseDuration.startTimer();
  logger.info('[purchaseWorker] processing job', { id: job.id, data: job.data });
  try {
    // job.data should contain { userId, planId, planName, planType, amount, ... }
    await purchaseInvestment(job.data);
    purchaseSuccess.inc();
    logger.info('[purchaseWorker] job complete', { id: job.id });
    endTimer();
    return { ok: true };
  } catch (err) {
    purchaseFailed.inc();
    logger.error('[purchaseWorker] job error', { id: job.id, error: err && err.stack ? err.stack : String(err) });
    endTimer();
    throw err;
  }
}, { connection, concurrency: Number(process.env.WORKER_CONCURRENCY || 2) });

worker.on('failed', (job, err) => {
  logger.warn('[purchaseWorker] job failed', { id: job.id, error: err && err.message ? err.message : String(err) });
});

worker.on('completed', (job) => {
  logger.info('[purchaseWorker] job completed', { id: job.id });
});

process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { error: err && err.stack ? err.stack : String(err) });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: reason && reason.stack ? reason.stack : String(reason) });
});

logger.info('Purchase worker started');

// optional metrics endpoint
if (require.main === module) {
  const express = require('express');
  const app = express();
  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', promClient.register.contentType);
    res.end(await promClient.register.metrics());
  });
  const port = process.env.METRICS_PORT || 9401;
  app.listen(port, () => logger.info('Purchase worker metrics listening', { port }));
}
