import type { CookieOptions } from 'express';
import jwt, { type SignOptions } from 'jsonwebtoken';
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
