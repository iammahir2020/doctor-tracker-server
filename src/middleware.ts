import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from './env.js';
import { AppError, archivedError, AUTH_COOKIE, verifyToken, type Role } from './lib.js';
import { UserModel } from './models.js';

type Schemas = { body?: z.ZodType; query?: z.ZodType; params?: z.ZodType };

/** Validates and replaces req.body / req.query / req.params with the parsed (coerced, stripped) values. */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    const issues: { location: string; path: string; message: string }[] = [];

    for (const location of ['body', 'query', 'params'] as const) {
      const schema = schemas[location];
      if (!schema) continue;
      const result = schema.safeParse(req[location]);
      if (!result.success) {
        for (const issue of result.error.issues) {
          issues.push({ location, path: issue.path.join('.'), message: issue.message });
        }
      } else if (location === 'query') {
        // Express 5 exposes req.query as a getter, so it has to be redefined rather than assigned.
        Object.defineProperty(req, 'query', { value: result.data, writable: true });
      } else {
        req[location] = result.data as never;
      }
    }

    if (issues.length > 0) {
      next(new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', issues));
      return;
    }
    next();
  };
}

export const notFound: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));
};

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof mongoose.Error.CastError) {
    return new AppError(400, 'VALIDATION_ERROR', `Invalid value for ${err.path}`);
  }
  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.values(err.errors).map((e) => ({ path: e.path, message: e.message }));
    return new AppError(400, 'VALIDATION_ERROR', 'Validation failed', details);
  }
  if (typeof err === 'object' && err !== null && 'code' in err && err.code === 11000) {
    const keyValue = 'keyValue' in err ? err.keyValue : undefined;
    return new AppError(409, 'CONFLICT', 'A record with that value already exists', keyValue);
  }
  // Malformed JSON body from express.json(), or a payload over the size limit.
  if (typeof err === 'object' && err !== null && 'type' in err) {
    if (err.type === 'entity.parse.failed') {
      return new AppError(400, 'VALIDATION_ERROR', 'Malformed JSON body');
    }
    if (err.type === 'entity.too.large') {
      return new AppError(413, 'VALIDATION_ERROR', 'Request body too large');
    }
  }
  return new AppError(500, 'INTERNAL_ERROR', 'Something went wrong');
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const appError = toAppError(err);
  if (appError.status >= 500) {
    req.log.error({ err }, 'unhandled error');
  }
  res.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      details: appError.details ?? null,
      ...(env.NODE_ENV === 'development' && appError.status >= 500 && err instanceof Error
        ? { stack: err.stack }
        : {}),
    },
  });
};

/** Verifies the session cookie and reloads the user, so role changes and archiving apply immediately. */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const token = (req.cookies as Record<string, unknown>)[AUTH_COOKIE];
  const payload = typeof token === 'string' ? verifyToken(token) : null;
  if (!payload) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in');

  const user = await UserModel.findById(payload.sub, {
    name: 1,
    email: 1,
    role: 1,
    isArchived: 1,
    tokenVersion: 1,
  })
    .lean()
    .catch(() => null);
  // A version mismatch means the password changed after this token was issued.
  if (!user || (user.tokenVersion ?? 0) !== payload.ver) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in');
  }
  // A valid session for an account archived since sign-in: say why, so the client can explain.
  if (user.isArchived) throw archivedError();

  req.user = { id: String(user._id), name: user.name, email: user.email, role: user.role };
  next();
};

export function requireRole(role: Role): RequestHandler {
  return (req, _res, next) => {
    if (req.user?.role !== role) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have permission to do that');
    }
    next();
  };
}

// Keyed by IP + email: all traffic arrives through the same proxies, and keying by IP alone would
// let one person's typos lock out everyone behind the same NAT.
export const loginLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  // Only failed attempts count, so signing in successfully never uses up the allowance.
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '')}:${loginEmail(req)}`,
  handler: (_req, _res, next) => {
    next(new AppError(429, 'RATE_LIMITED', 'Too many sign-in attempts. Try again in a minute.'));
  },
});

// Keyed by email alone, so rotating IPs (or a spoofed X-Forwarded-For) can't reset the count.
// Looser than the per-IP limit, so typos never reach it; only sustained guessing does.
export const loginEmailLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `email:${loginEmail(req)}`,
  handler: (_req, _res, next) => {
    next(
      new AppError(
        429,
        'RATE_LIMITED',
        'Too many sign-in attempts for this account. Try again in 15 minutes.',
      ),
    );
  },
});

function loginEmail(req: Parameters<RequestHandler>[0]): string {
  const body: unknown = req.body;
  return typeof body === 'object' &&
    body !== null &&
    'email' in body &&
    typeof body.email === 'string'
    ? body.email.trim().toLowerCase()
    : '';
}
