import { Router } from 'express';
import type { QueryFilter } from 'mongoose';
import { z } from 'zod';
import {
  AppError,
  csv,
  idParams,
  listQuery,
  objectId,
  pageMeta,
  prefixRegex,
  showArchived,
} from '../lib.js';
import { requireAuth, requireRole, validate } from '../middleware.js';
import { DoctorModel, HIDDEN_FIELDS, PatientModel, SpecializationModel } from '../models.js';
import { assertActiveLookup } from './lookups.routes.js';
import { doctorPatientsRouter } from './patients.routes.js';

const doctorBody = z.object({
  name: z.string().trim().min(2, 'Name is required').max(100),
  specialization: objectId,
  hospital: z.string().trim().min(2, 'Hospital is required').max(120),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[\d\s()-]{6,20}$/, 'Enter a valid phone number'),
  email: z.email().max(254),
});

const listDoctorsQuery = listQuery.extend({
  specialization: csv(objectId).optional(),
  hospital: z.string().trim().max(120).optional(),
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
  minPatients: z.coerce.number().int().min(0).optional(),
  maxPatients: z.coerce.number().int().min(0).optional(),
  sort: z.enum(['name', 'createdAt', 'patientCount']).default('createdAt'),
});

const SORT_FIELD = {
  name: 'nameLower',
  createdAt: 'createdAt',
  patientCount: 'patientCount',
} as const;

const LIST_FIELDS = {
  name: 1,
  specialization: 1,
  hospital: 1,
  phone: 1,
  email: 1,
  patientCount: 1,
  isArchived: 1,
  createdAt: 1,
} as const;

export const doctorsRouter = Router();
doctorsRouter.use('/:id/patients', doctorPatientsRouter);
doctorsRouter.use(requireAuth);

doctorsRouter.get('/', validate({ query: listDoctorsQuery }), async (req, res) => {
  const q = req.query as unknown as z.infer<typeof listDoctorsQuery>;
  const filter: QueryFilter<typeof DoctorModel> = {
    isArchived: showArchived(req.user, q.archived),
  };

  if (q.search) {
    const rx = prefixRegex(q.search);
    filter.$or = [{ nameLower: rx }, { emailLower: rx }];
  }
  if (q.specialization?.length) filter.specialization = { $in: q.specialization };
  if (q.hospital) filter.hospitalLower = prefixRegex(q.hospital);
  if (q.createdFrom || q.createdTo) {
    filter.createdAt = {
      ...(q.createdFrom && { $gte: q.createdFrom }),
      ...(q.createdTo && { $lte: q.createdTo }),
    };
  }
  if (q.minPatients !== undefined || q.maxPatients !== undefined) {
    filter.patientCount = {
      ...(q.minPatients !== undefined && { $gte: q.minPatients }),
      ...(q.maxPatients !== undefined && { $lte: q.maxPatients }),
    };
  }

  const dir = q.order === 'asc' ? 1 : -1;
  const [data, total] = await Promise.all([
    DoctorModel.find(filter, LIST_FIELDS)
      .sort({ [SORT_FIELD[q.sort]]: dir, _id: dir })
      .skip((q.page - 1) * q.pageSize)
      .limit(q.pageSize)
      .lean(),
    DoctorModel.countDocuments(filter),
  ]);
  res.json({ data, meta: pageMeta(q.page, q.pageSize, total) });
});

doctorsRouter.get('/:id', validate({ params: idParams }), async (req, res) => {
  const doctor = await DoctorModel.findById(req.params.id, HIDDEN_FIELDS).lean();
  if (!doctor) throw new AppError(404, 'NOT_FOUND', 'Doctor not found');
  res.json(doctor);
});

doctorsRouter.post('/', requireRole('admin'), validate({ body: doctorBody }), async (req, res) => {
  const body = req.body as z.infer<typeof doctorBody>;
  await assertActiveLookup(SpecializationModel, body.specialization, 'specialization');
  res.status(201).json(await DoctorModel.create(body));
});

doctorsRouter.patch(
  '/:id',
  requireRole('admin'),
  validate({ params: idParams, body: doctorBody.partial() }),
  async (req, res) => {
    const body = req.body as Partial<z.infer<typeof doctorBody>>;
    const doctor = await DoctorModel.findById(req.params.id);
    if (!doctor) throw new AppError(404, 'NOT_FOUND', 'Doctor not found');
    if (doctor.isArchived)
      throw new AppError(409, 'CONFLICT', 'Restore this doctor before editing');
    // An existing archived specialization may stay; only a change has to be active.
    if (body.specialization && body.specialization !== String(doctor.specialization)) {
      await assertActiveLookup(SpecializationModel, body.specialization, 'specialization');
    }
    doctor.set(body);
    await doctor.save();
    res.json(doctor);
  },
);

doctorsRouter.post(
  '/:id/archive',
  requireRole('admin'),
  validate({ params: idParams }),
  async (req, res) => {
    const doctor = await DoctorModel.findById(req.params.id);
    if (!doctor) throw new AppError(404, 'NOT_FOUND', 'Doctor not found');
    // Count the real thing rather than trusting the denormalized counter for a blocking rule.
    const active = await PatientModel.countDocuments({ doctorId: doctor._id, isArchived: false });
    if (active > 0) {
      throw new AppError(
        409,
        'CONFLICT',
        `Reassign or archive their ${active} patient${active === 1 ? '' : 's'} first`,
        { activePatients: active },
      );
    }
    doctor.isArchived = true;
    doctor.archivedAt = new Date();
    doctor.set('archivedBy', req.user?.id);
    await doctor.save();
    res.json(doctor);
  },
);

doctorsRouter.post(
  '/:id/restore',
  requireRole('admin'),
  validate({ params: idParams }),
  async (req, res) => {
    const doctor = await DoctorModel.findByIdAndUpdate(
      req.params.id,
      { isArchived: false, archivedAt: null, archivedBy: null },
      { new: true },
    );
    if (!doctor) throw new AppError(404, 'NOT_FOUND', 'Doctor not found');
    res.json(doctor);
  },
);
