import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import { env } from './env.js';
import { errorHandler, notFound } from './middleware.js';
import { authRouter } from './modules/auth.routes.js';
import { doctorsRouter } from './modules/doctors.routes.js';
import { lookupsRouter } from './modules/lookups.routes.js';
import { patientsRouter } from './modules/patients.routes.js';
import { clearStatsOnWrite, statsRouter } from './modules/stats.routes.js';
import { usersRouter } from './modules/users.routes.js';

export const logger = pino({ level: env.NODE_ENV === 'test' ? 'silent' : 'info' });

export function createApp() {
  const app = express();

  // Trust only Render's own proxy hop. Trusting the whole chain would let a client pick its
  // req.ip by sending its own X-Forwarded-For, and the login rate limiter keys on req.ip.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' } }));

  app.get('/', (_req, res) => {
    res.json({
      name: 'Doctor Tracker API',
      version: process.env.npm_package_version ?? '0.1.0',
      docs: 'https://github.com/iammahir2020/doctor-tracker-server#readme',
      health: '/api/health',
    });
  });

  app.get('/api/health', async (_req, res) => {
    let db: 'up' | 'down' = 'down';
    try {
      await mongoose.connection.db?.admin().ping();
      db = 'up';
    } catch {
      // Reported as down below; health must never throw.
    }
    res.status(db === 'up' ? 200 : 503).json({
      status: db === 'up' ? 'ok' : 'degraded',
      db,
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  app.use('/api', clearStatsOnWrite);
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/lookups', lookupsRouter);
  app.use('/api/doctors', doctorsRouter);
  app.use('/api/patients', patientsRouter);
  app.use('/api/stats', statsRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
