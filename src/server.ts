import mongoose from 'mongoose';
import { createApp, logger } from './app.js';
import { env } from './env.js';

await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
logger.info('connected to MongoDB');

const server = createApp().listen(env.PORT, () => {
  logger.info(`listening on port ${env.PORT}`);
});

function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  // Stop accepting connections and let in-flight requests finish before closing the db pool.
  server.close(() => {
    void mongoose.disconnect().then(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
