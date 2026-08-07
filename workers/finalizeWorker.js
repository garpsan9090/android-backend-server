const { Worker, Queue, QueueScheduler } = require('bullmq');
const IORedis = require('ioredis');
const axios = require('axios');
const winston = require('winston');
const promClient = require('prom-client');
const { finalizeInvestment } = require('../services/investmentEarnings');

const REDIS_URL = process.env.REDIS_URL || process.env.REDIS || null;
const hasRedis = Boolean(REDIS_URL);

const queueName = 'finalizeInvestment';
let connection = null;
let poisonQueue = null;
let worker = null;

if (!hasRedis) {
  const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    transports: [new winston.transports.Console()],
  });

  logger.warn('Redis is not configured. Finalize worker will not start. Set REDIS_URL to enable job processing.');
  process.exit(0);
}

connection = new IORedis(REDIS_URL);
new QueueScheduler(queueName, { connection });

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

// metrics
promClient.collectDefaultMetrics({ timeout: 5000 });
const finalizeDuration = new promClient.Histogram({ name: 'finalize_job_duration_seconds', help: 'Duration of finalize job in seconds', buckets: [0.1, 0.5, 1, 2, 5, 10] });
const finalizeSuccess = new promClient.Counter({ name: 'finalize_jobs_success_total', help: 'Finalize jobs succeeded' });
const finalizeFailed = new promClient.Counter({ name: 'finalize_jobs_failed_total', help: 'Finalize jobs failed' });

const poisonQueueName = `${queueName}:poison`;
const poisonQueue = new Queue(poisonQueueName, { connection });

const worker = new Worker(queueName, async (job) => {
  const endTimer = finalizeDuration.startTimer();
  logger.info('[worker] processing job', { id: job.id, name: job.name, data: job.data });
  try {
    await finalizeInvestment(job.data.transactionId);
    finalizeSuccess.inc();
    logger.info('[worker] job complete', { id: job.id });
    endTimer();
    return { ok: true };
  } catch (err) {
    finalizeFailed.inc();
    logger.error('[worker] job error', { id: job.id, error: err && err.stack ? err.stack : String(err) });
    // capture in Sentry if available
    try {
      const Sentry = require('@sentry/node');
      if (process.env.SENTRY_DSN) {
        Sentry.captureException(err);
      }
    } catch (sentryErr) {
      logger.warn('[worker] sentry capture failed', { error: sentryErr && sentryErr.message ? sentryErr.message : String(sentryErr) });
    }
    endTimer();
    throw err;
  }
}, { connection, concurrency: Number(process.env.WORKER_CONCURRENCY || 2) });

worker.on('failed', async (job, err) => {
  logger.warn('[worker] job failed', { id: job.id, attemptsMade: job.attemptsMade, failedReason: err && err.message ? err.message : String(err) });
  // If job exhausted attempts, move to poison queue for inspection
  if (job.attemptsMade >= (job.opts.attempts || 0)) {
    try {
      await poisonQueue.add('poison', { originalJob: job }, { removeOnComplete: false });
      logger.error('[worker] moved job to poison queue', { id: job.id });
    } catch (e) {
      logger.error('[worker] failed to move job to poison queue', { id: job.id, error: e && e.message ? e.message : String(e) });
    }

    // alerting webhook if configured (Slack/Teams incoming webhook)
    const webhook = process.env.ALERT_WEBHOOK;
    if (webhook) {
      try {
        const payload = {
          text: `Finalize job ${job.id} moved to poison queue\nError: ${err && err.message ? err.message : String(err)}\nData: ${JSON.stringify(job.data)}`,
        };
        await axios.post(webhook, payload, { headers: { 'Content-Type': 'application/json' } });
        logger.info('[worker] alert webhook sent', { webhook });
      } catch (e) {
        logger.error('[worker] failed to send alert webhook', { error: e && e.message ? e.message : String(e) });
      }
    }
  }
});

worker.on('completed', (job) => {
  logger.info('[worker] job completed', { id: job.id });
});

process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { error: err && err.stack ? err.stack : String(err) });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: reason && reason.stack ? reason.stack : String(reason) });
});

logger.info('Finalize worker started');

// optional: expose metrics endpoint when run directly
if (require.main === module) {
  const express = require('express');
  const app = express();
  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', promClient.register.contentType);
    res.end(await promClient.register.metrics());
  });
  const port = process.env.METRICS_PORT || 9400;
  app.listen(port, () => logger.info('Worker metrics listening', { port }));
}
