import bcrypt from 'bcryptjs';
import { Router } from 'express';
import type { QueryFilter } from 'mongoose';
import { z } from 'zod';
import {
  AppError,
  containsRegex,
  idParams,
  listQuery,
  pageMeta,
  plainText,
  showArchived,
} from '../lib.js';
import { requireAuth, requireRole, validate } from '../middleware.js';
import { UserModel } from '../models.js';
import { BCRYPT_COST, passwordSchema } from './auth.routes.js';

const ROLES = ['admin', 'staff'] as const;

const createBody = z.object({
  name: plainText('Name', 2, 100),
  email: z.email().max(254),
  password: passwordSchema,
  role: z.enum(ROLES),
});

const updateBody = z
  .object({ name: createBody.shape.name, role: z.enum(ROLES) })
  .partial()
  .refine((b) => b.name !== undefined || b.role !== undefined, 'Nothing to update');

const listUsersQuery = listQuery.extend({
  role: z.enum(ROLES).optional(),
  sort: z.enum(['name', 'createdAt']).default('createdAt'),
});

const LIST_FIELDS = { name: 1, email: 1, role: 1, isArchived: 1, createdAt: 1 } as const;

async function assertNotLastAdmin(userId: string, message: string) {
  const otherAdmins = await UserModel.countDocuments({
    _id: { $ne: userId },
    role: 'admin',
    isArchived: false,
  });
  if (otherAdmins === 0) throw new AppError(409, 'CONFLICT', message);
}

export const usersRouter = Router();
usersRouter.use(requireAuth, requireRole('admin'));

usersRouter.get('/', validate({ query: listUsersQuery }), async (req, res) => {
  const q = req.query as unknown as z.infer<typeof listUsersQuery>;
  const filter: QueryFilter<typeof UserModel> = { isArchived: showArchived(req.user, q.archived) };
  if (q.search) {
    const rx = containsRegex(q.search);
    filter.$or = [{ nameLower: rx }, { emailLower: rx }];
  }
  if (q.role) filter.role = q.role;

  const dir = q.order === 'asc' ? 1 : -1;
  const [data, total] = await Promise.all([
    UserModel.find(filter, LIST_FIELDS)
      .sort({ [q.sort === 'name' ? 'nameLower' : 'createdAt']: dir, _id: dir })
      .skip((q.page - 1) * q.pageSize)
      .limit(q.pageSize)
      .lean(),
    UserModel.countDocuments(filter),
  ]);
  res.json({ data, meta: pageMeta(q.page, q.pageSize, total) });
});

usersRouter.post('/', validate({ body: createBody }), async (req, res) => {
  const { password, ...rest } = req.body as z.infer<typeof createBody>;
  const user = await UserModel.create({
    ...rest,
    passwordHash: await bcrypt.hash(password, BCRYPT_COST),
  });
  res.status(201).json(user);
});

usersRouter.patch('/:id', validate({ params: idParams, body: updateBody }), async (req, res) => {
  const body = req.body as z.infer<typeof updateBody>;
  const user = await UserModel.findById(req.params.id);
  if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');
  if (body.role === 'staff' && user.role === 'admin' && !user.isArchived) {
    await assertNotLastAdmin(String(user._id), 'There must be at least one active admin');
  }
  user.set(body);
  await user.save();
  res.json(user);
});

usersRouter.post('/:id/archive', validate({ params: idParams }), async (req, res) => {
  const id = req.params.id as string;
  if (id === req.user?.id) throw new AppError(409, 'CONFLICT', 'You cannot archive yourself');
  const user = await UserModel.findById(id);
  if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');
  if (user.role === 'admin') {
    await assertNotLastAdmin(id, 'There must be at least one active admin');
  }
  user.isArchived = true;
  user.archivedAt = new Date();
  user.set('archivedBy', req.user?.id);
  await user.save();
  res.json(user);
});

usersRouter.post('/:id/restore', validate({ params: idParams }), async (req, res) => {
  const user = await UserModel.findByIdAndUpdate(
    req.params.id,
    { isArchived: false, archivedAt: null, archivedBy: null },
    { returnDocument: 'after' },
  );
  if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');
  res.json(user);
});
