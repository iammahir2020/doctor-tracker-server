import type { CookieOptions } from 'express';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { z } from 'zod';
import { env } from './env.js';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// ---------- pagination + search ----------

export const MAX_PAGE_SIZE = 50;

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

export const idParams = z.object({ id: objectId });

/** Query params shared by every list endpoint. */
export const listQuery = z.object({
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
  order: z.enum(['asc', 'desc']).default('desc'),
  archived: z.stringbool().default(false),
});

/** `a,b,c` → validated array, for `$in` filters. */
export function csv<T extends z.ZodType>(item: T) {
  return z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v),
    z.array(item).max(50),
  );
}

/** Only admins can ask for archived records; for everyone else the flag is ignored. */
export function showArchived(user: Express.Request['user'], archived: boolean): boolean {
  return archived && user?.role === 'admin';
}

export function pageMeta(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Anchored, lowercased prefix match for the `*Lower` fields, so Mongo can use the index. */
export function prefixRegex(term: string): RegExp {
  return new RegExp(`^${escapeRegex(term.trim().toLowerCase())}`);
}

// ---------- auth token + cookie ----------

export const AUTH_COOKIE = 'dt_token';

export type Role = 'admin' | 'staff';
export type TokenPayload = { sub: string; role: Role };

export function signToken(payload: TokenPayload): { token: string; maxAgeMs: number } {
  const token = jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as NonNullable<SignOptions['expiresIn']>,
  });
  // Derive the cookie lifetime from the token itself so the two can never drift apart.
  const { exp } = jwt.decode(token) as { exp: number };
  return { token, maxAgeMs: exp * 1000 - Date.now() };
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (typeof decoded === 'object' && typeof decoded.sub === 'string') {
      const role: unknown = decoded.role;
      if (role === 'admin' || role === 'staff') return { sub: decoded.sub, role };
    }
    return null;
  } catch {
    return null;
  }
}

export function authCookieOptions(maxAgeMs?: number): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    ...(maxAgeMs === undefined ? {} : { maxAge: maxAgeMs }),
  };
}
