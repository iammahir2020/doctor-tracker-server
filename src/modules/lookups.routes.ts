import { Router } from 'express';
import { z } from 'zod';
import { AppError, objectId } from '../lib.js';
import { requireAuth, requireRole, validate } from '../middleware.js';
import { ConditionModel, SpecializationModel } from '../models.js';

const MODELS = {
  specializations: SpecializationModel,
  conditions: ConditionModel,
} as const;

type LookupType = keyof typeof MODELS;

const typeParams = z.object({ type: z.enum(['specializations', 'conditions']) });
const typeIdParams = typeParams.extend({ id: objectId });
const nameBody = z.object({ name: z.string().trim().min(1, 'Name is required').max(60) });

const PROJECTION = { name: 1, isArchived: 1 } as const;

/**
 * Used by doctor and patient writes: records may only point at a lookup that exists and is not
 * archived. Records that already reference an archived lookup keep it until they are edited.
 */
export async function assertActiveLookup(
  // Both lookup models come from the same schema factory, so they share one type.
  model: typeof SpecializationModel,
  id: string,
  field: string,
) {
  const found = await model.exists({ _id: id, isArchived: false });
  if (!found) {
    throw new AppError(400, 'VALIDATION_ERROR', `Unknown or archived ${field}`, [
      { location: 'body', path: field, message: `Choose an active ${field}` },
    ]);
  }
}

export const lookupsRouter = Router();
lookupsRouter.use(requireAuth);

// Everything, archived included (flagged): lists are short, and existing records may still
// reference an archived entry, so the client needs its name.
lookupsRouter.get('/', async (_req, res) => {
  const [specializations, conditions] = await Promise.all([
    SpecializationModel.find({}, PROJECTION).sort({ nameLower: 1 }).lean(),
    ConditionModel.find({}, PROJECTION).sort({ nameLower: 1 }).lean(),
  ]);
  res.json({ specializations, conditions });
});

lookupsRouter.post(
  '/:type',
  requireRole('admin'),
  validate({ params: typeParams, body: nameBody }),
  async (req, res) => {
    const { type } = req.params as { type: LookupType };
    const doc = await MODELS[type].create(req.body as z.infer<typeof nameBody>);
    res.status(201).json(doc);
  },
);

lookupsRouter.patch(
  '/:type/:id',
  requireRole('admin'),
  validate({ params: typeIdParams, body: nameBody }),
  async (req, res) => {
    const { type, id } = req.params as z.infer<typeof typeIdParams>;
    const doc = await MODELS[type].findById(id);
    if (!doc) throw new AppError(404, 'NOT_FOUND', 'Not found');
    doc.name = (req.body as z.infer<typeof nameBody>).name;
    await doc.save();
    res.json(doc);
  },
);

for (const action of ['archive', 'restore'] as const) {
  lookupsRouter.post(
    `/:type/:id/${action}`,
    requireRole('admin'),
    validate({ params: typeIdParams }),
    async (req, res) => {
      const { type, id } = req.params as z.infer<typeof typeIdParams>;
      const archive = action === 'archive';
      const doc = await MODELS[type].findByIdAndUpdate(
        id,
        {
          isArchived: archive,
          archivedAt: archive ? new Date() : null,
          archivedBy: archive ? req.user?.id : null,
        },
        { new: true },
      );
      if (!doc) throw new AppError(404, 'NOT_FOUND', 'Not found');
      res.json(doc);
    },
  );
}
