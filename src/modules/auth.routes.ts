import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { AppError, archivedError, AUTH_COOKIE, authCookieOptions, signToken } from '../lib.js';
import { loginEmailLimiter, loginLimiter, requireAuth, validate } from '../middleware.js';
import { UserModel } from '../models.js';

export const BCRYPT_COST = 10;

// bcrypt only uses the first 72 bytes, so longer passwords would silently be truncated.
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters');

const loginBody = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(200),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

// Compared against when the email is unknown, so a miss takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

export const authRouter = Router();

authRouter.post(
  '/login',
  loginLimiter,
  loginEmailLimiter,
  validate({ body: loginBody }),
  async (req, res) => {
    const { email, password } = req.body as z.infer<typeof loginBody>;
    const user = await UserModel.findOne(
      { emailLower: email.toLowerCase() },
      { name: 1, email: 1, role: 1, isArchived: 1, tokenVersion: 1, passwordHash: 1 },
    )
      .select('+passwordHash')
      .lean();

    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid email or password');
    }
    // Only revealed after a correct password, so it can't be used to probe which accounts exist.
    if (user.isArchived) throw archivedError();

    const { token, maxAgeMs } = signToken({
      sub: String(user._id),
      role: user.role,
      ver: user.tokenVersion ?? 0,
    });
    res.cookie(AUTH_COOKIE, token, authCookieOptions(maxAgeMs));
    res.json({
      user: { id: String(user._id), name: user.name, email: user.email, role: user.role },
    });
  },
);

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(AUTH_COOKIE, authCookieOptions());
  res.status(204).end();
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

authRouter.patch(
  '/me/password',
  requireAuth,
  validate({ body: changePasswordBody }),
  async (req, res) => {
    const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordBody>;
    const user = await UserModel.findById(req.user?.id).select('+passwordHash');
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in');

    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Current password is incorrect', [
        { location: 'body', path: 'currentPassword', message: 'Current password is incorrect' },
      ]);
    }
    user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    // Ends every other session, e.g. one using a stolen cookie; this one gets a fresh token below.
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    await user.save();

    const { token, maxAgeMs } = signToken({
      sub: String(user._id),
      role: user.role,
      ver: user.tokenVersion,
    });
    res.cookie(AUTH_COOKIE, token, authCookieOptions(maxAgeMs));
    res.status(204).end();
  },
);
