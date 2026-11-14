import { Router, type Request } from 'express';
import type { QueryFilter } from 'mongoose';
import { z } from 'zod';
import {
  AppError,
  csv,
  dateTo,
  idParams,
  listQuery,
  objectId,
  pageMeta,
  prefixRegex,
  showArchived,
} from '../lib.js';
import { requireAuth, requireRole, validate } from '../middleware.js';
import { DoctorModel, GENDERS, HIDDEN_FIELDS, PATIENT_STATUSES, PatientModel } from '../models.js';
import { createPatient, setPatientArchived, updatePatient } from './patients.service.js';

const MAX_AGE = 130;

const patientBody = z.object({
  name: z.string().trim().min(2, 'Name is required').max(100),
  dateOfBirth: z.coerce
    .date()
    .refine((d) => d <= new Date(), 'Date of birth cannot be in the future')
    .refine((d) => d.getFullYear() >= new Date().getFullYear() - MAX_AGE, 'Check the year'),
  gender: z.enum(GENDERS),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[\d\s()-]{6,20}$/, 'Enter a valid phone number'),
  email: z
    .union([z.email().max(254), z.literal('')])
    .optional()
    .nullable()
    .transform((v) => v || null),
  condition: objectId,
  status: z.enum(PATIENT_STATUSES),
  admissionDate: z.coerce
    .date()
    .refine((d) => d <= new Date(Date.now() + 24 * 3600_000), 'Admission date is in the future'),
  notes: z.string().trim().max(1000).optional(),
  doctorId: objectId,
});

const listPatientsQuery = listQuery.extend({
  condition: csv(objectId).optional(),
  status: csv(z.enum(PATIENT_STATUSES)).optional(),
  doctorId: objectId.optional(),
  gender: z.enum(GENDERS).optional(),
  admittedFrom: z.coerce.date().optional(),
  admittedTo: dateTo.optional(),
  minAge: z.coerce.number().int().min(0).max(MAX_AGE).optional(),
  maxAge: z.coerce.number().int().min(0).max(MAX_AGE).optional(),
  sort: z.enum(['name', 'admissionDate', 'age']).default('admissionDate'),
});

type ListPatientsQuery = z.infer<typeof listPatientsQuery>;

function yearsAgo(years: number) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d;
}

const LIST_FIELDS = {
  name: 1,
  dateOfBirth: 1,
  gender: 1,
  phone: 1,
  email: 1,
  condition: 1,
  status: 1,
  admissionDate: 1,
  doctorId: 1,
  isArchived: 1,
  createdAt: 1,
} as const;

async function listPatients(req: Request, q: ListPatientsQuery) {
  const filter: QueryFilter<typeof PatientModel> = {
    isArchived: showArchived(req.user, q.archived),
  };

  if (q.search) {
    const rx = prefixRegex(q.search);
    filter.$or = [{ nameLower: rx }, { emailLower: rx }];
  }
  if (q.condition?.length) filter.condition = { $in: q.condition };
  if (q.status?.length) filter.status = { $in: q.status };
  if (q.doctorId) filter.doctorId = q.doctorId;
  if (q.gender) filter.gender = q.gender;
  if (q.admittedFrom || q.admittedTo) {
    filter.admissionDate = {
      ...(q.admittedFrom && { $gte: q.admittedFrom }),
      ...(q.admittedTo && { $lte: q.admittedTo }),
    };
  }
  // Age is derived, so an age range becomes a date-of-birth range the index can serve.
  if (q.minAge !== undefined || q.maxAge !== undefined) {
    filter.dateOfBirth = {
      ...(q.minAge !== undefined && { $lte: yearsAgo(q.minAge) }),
      ...(q.maxAge !== undefined && { $gt: yearsAgo(q.maxAge + 1) }),
    };
  }

  const dir = q.order === 'asc' ? 1 : -1;
  const sortField =
    q.sort === 'name' ? 'nameLower' : q.sort === 'age' ? 'dateOfBirth' : 'admissionDate';
  // Older people have earlier birth dates, so "age ascending" is "date of birth descending".
  const sortDir = q.sort === 'age' ? (-dir as 1 | -1) : dir;

  const [rows, total] = await Promise.all([
    PatientModel.find(filter, LIST_FIELDS)
      .sort({ [sortField]: sortDir, _id: dir })
      .skip((q.page - 1) * q.pageSize)
      .limit(q.pageSize)
      .lean(),
    PatientModel.countDocuments(filter),
  ]);

  // The table links each row to its doctor, so attach names for this page only (≤ 50 ids).
  const doctorIds = [...new Set(rows.map((r) => String(r.doctorId)))];
  const doctors = await DoctorModel.find({ _id: { $in: doctorIds } }, { name: 1 }).lean();
  const names = new Map(doctors.map((d) => [String(d._id), d.name]));
  const data = rows.map((r) => ({ ...r, doctorName: names.get(String(r.doctorId)) ?? null }));

  return { data, meta: pageMeta(q.page, q.pageSize, total) };
}

export const patientsRouter = Router();
patientsRouter.use(requireAuth);

patientsRouter.get('/', validate({ query: listPatientsQuery }), async (req, res) => {
  res.json(await listPatients(req, req.query as unknown as ListPatientsQuery));
});

patientsRouter.get('/:id', validate({ params: idParams }), async (req, res) => {
  const patient = await PatientModel.findById(req.params.id, HIDDEN_FIELDS).lean();
  if (!patient) throw new AppError(404, 'NOT_FOUND', 'Patient not found');
  const doctor = await DoctorModel.findById(patient.doctorId, { name: 1 }).lean();
  res.json({ ...patient, doctorName: doctor?.name ?? null });
});

patientsRouter.post('/', validate({ body: patientBody }), async (req, res) => {
  res.status(201).json(await createPatient(req.body as z.infer<typeof patientBody>));
});

patientsRouter.patch(
  '/:id',
  validate({ params: idParams, body: patientBody.partial() }),
  async (req, res) => {
    const body = req.body as Partial<z.infer<typeof patientBody>>;
    res.json(await updatePatient(req.params.id as string, body));
  },
);

for (const action of ['archive', 'restore'] as const) {
  patientsRouter.post(
    `/:id/${action}`,
    requireRole('admin'),
    validate({ params: idParams }),
    async (req, res) => {
      res.json(
        await setPatientArchived(req.params.id as string, action === 'archive', req.user?.id),
      );
    },
  );
}

// ---------- nested under a doctor: /api/doctors/:id/patients ----------

export const doctorPatientsRouter = Router({ mergeParams: true });
doctorPatientsRouter.use(requireAuth);

doctorPatientsRouter.get(
  '/',
  validate({ params: idParams, query: listPatientsQuery.omit({ doctorId: true }) }),
  async (req, res) => {
    const q = req.query as unknown as ListPatientsQuery;
    res.json(await listPatients(req, { ...q, doctorId: req.params.id as string }));
  },
);

doctorPatientsRouter.post(
  '/',
  validate({ params: idParams, body: patientBody.omit({ doctorId: true }) }),
  async (req, res) => {
    const body = req.body as Omit<z.infer<typeof patientBody>, 'doctorId'>;
    res.status(201).json(await createPatient({ ...body, doctorId: req.params.id as string }));
  },
);
