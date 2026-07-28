const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const config = require('../config');
const logger = require('../utils/logger');
const { summarize } = require('./deepseek');

const connection = new IORedis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null,
});

// ioredis/BullMQ will not swallow connection errors on your behalf — every
// client (including the ones Queue/Worker duplicate internally for blocking
// commands) needs its own 'error' listener, or a down Redis floods the
// console with unhandled errors. Redis being down only degrades background
// jobs, not the bot's on-demand commands, so just log it once until it recovers.
let redisDown = false;
function logRedisError(source, err) {
  if (redisDown) return;
  redisDown = true;
  logger.error(`Redis connection unavailable (${source}) — background job queue is degraded`, {
    error: err.message,
  });
}
function logRedisRecovered() {
  if (redisDown) logger.info('Redis connection restored');
  redisDown = false;
}
connection.on('error', (err) => logRedisError('connection', err));
connection.on('ready', logRedisRecovered);

const QUEUE_NAME = 'digest-jobs';

const digestQueue = new Queue(QUEUE_NAME, { connection });
digestQueue.on('error', (err) => logRedisError('queue', err));

function startWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === 'summarize') {
        return summarize(job.data.text, { language: job.data.language });
      }
      logger.warn(`Unknown job type: ${job.name}`);
      return null;
    },
    { connection }
  );

  worker.on('error', (err) => logRedisError('worker', err));
  worker.on('completed', (job) => logger.info(`Job ${job.id} (${job.name}) completed`));
  worker.on('failed', (job, err) => logger.error(`Job ${job && job.id} failed`, { error: err.message }));

  return worker;
}

async function enqueueSummary(text, options = {}) {
  return digestQueue.add('summarize', { text, ...options });
}

module.exports = { digestQueue, startWorker, enqueueSummary, connection, logRedisError, logRedisRecovered };
