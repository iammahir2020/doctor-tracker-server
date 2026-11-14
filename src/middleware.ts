import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from './env.js';
import { AppError } from './lib.js';

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

export const objectId = z
  .string()
  .refine((v) => mongoose.isValidObjectId(v) && /^[a-f\d]{24}$/i.test(v), 'Invalid id');

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
      ...(env.NODE_ENV !== 'production' && appError.status >= 500 && err instanceof Error
        ? { stack: err.stack }
        : {}),
    },
  });
};
