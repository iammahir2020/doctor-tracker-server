import type { Agent } from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { DoctorModel, PatientModel } from '../src/models.js';
import { createLookups, signedIn } from './setup.js';

let admin: Agent;
let staff: Agent;
let ids: Awaited<ReturnType<typeof createLookups>>;

beforeEach(async () => {
  ids = await createLookups();
  admin = (await signedIn('admin')).agent;
  staff = (await signedIn('staff')).agent;
});

function doctorBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Dr. Ada Lovelace',
    specialization: ids.specializationId,
    hospital: 'Square Hospital',
    phone: '+880 1711 000000',
    email: `ada.${Math.random().toString(36).slice(2, 8)}@test.dev`,
    ...overrides,
  };
}

function patientBody(doctorId: string, overrides: Record<string, unknown> = {}) {
  return {
    name: 'Grace Hopper',
    dateOfBirth: '1990-05-01',
    gender: 'female',
    phone: '+880 1711 111111',
    email: '',
    condition: ids.conditionId,
    status: 'active',
    admissionDate: '2026-10-01',
    doctorId,
    ...overrides,
  };
}

async function createDoctor(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await admin.post('/api/doctors').send(doctorBody(overrides)).expect(201);
  return res.body._id as string;
}

async function createPatient(doctorId: string, overrides: Record<string, unknown> = {}) {
  const res = await staff.post('/api/patients').send(patientBody(doctorId, overrides)).expect(201);
  return res.body._id as string;
}

async function patientCount(doctorId: string) {
  const doctor = await DoctorModel.findById(doctorId).lean();
  return doctor?.patientCount;
}

describe('validation', () => {
  it('returns every field problem in one 400', async () => {
    const res = await admin
      .post('/api/doctors')
      .send(doctorBody({ email: 'not-an-email', phone: 'x', name: '' }))
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const paths = res.body.error.details.map((d: { path: string }) => d.path).sort();
    expect(paths).toEqual(['email', 'name', 'phone']);
  });

  it('rejects malformed ids and unknown records', async () => {
    await staff.get('/api/doctors/123').expect(400);
    await staff.get('/api/doctors/000000000000000000000000').expect(404);
  });

  it('rejects a future date of birth and an invalid gender', async () => {
    const doctorId = await createDoctor();
    const res = await staff
      .post('/api/patients')
      .send(patientBody(doctorId, { dateOfBirth: '2999-01-01', gender: 'x' }))
      .expect(400);
    const paths = res.body.error.details.map((d: { path: string }) => d.path).sort();
    expect(paths).toEqual(['dateOfBirth', 'gender']);
  });

  it('rejects duplicate doctor emails regardless of case', async () => {
    await createDoctor({ email: 'same@test.dev' });
    const res = await admin
      .post('/api/doctors')
      .send(doctorBody({ email: 'SAME@test.dev' }))
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('caps the page size', async () => {
    await staff.get('/api/doctors?pageSize=500').expect(400);
  });

  it('does not leak internal search fields', async () => {
    const id = await createDoctor();
    const res = await staff.get(`/api/doctors/${id}`).expect(200);
    expect(res.body).not.toHaveProperty('nameLower');
    expect(res.body).not.toHaveProperty('emailLower');
  });
});

describe('lookups', () => {
  it('only allows active lookups on new records', async () => {
    const res = await admin
      .post('/api/doctors')
      .send(doctorBody({ specialization: ids.archivedSpecializationId }))
      .expect(400);
    expect(res.body.error.details[0].path).toBe('specialization');
  });

  it('keeps an archived lookup on a record that already has it', async () => {
    const id = await createDoctor();
    await admin.post(`/api/lookups/specializations/${ids.specializationId}/archive`).expect(200);
    // Editing another field is still fine.
    await admin.patch(`/api/doctors/${id}`).send({ hospital: 'United Hospital' }).expect(200);
  });

  it('treats names case-insensitively as unique', async () => {
    await admin.post('/api/lookups/conditions').send({ name: 'hypertension' }).expect(409);
  });
});

describe('patientCount', () => {
  it('follows create, reassign, archive and restore', async () => {
    const a = await createDoctor();
    const b = await createDoctor();
    const patientId = await createPatient(a);
    await createPatient(a);
    expect(await patientCount(a)).toBe(2);

    await staff.patch(`/api/patients/${patientId}`).send({ doctorId: b }).expect(200);
    expect(await patientCount(a)).toBe(1);
    expect(await patientCount(b)).toBe(1);

    await admin.post(`/api/patients/${patientId}/archive`).expect(200);
    expect(await patientCount(b)).toBe(0);
    // Archiving twice must not decrement twice.
    await admin.post(`/api/patients/${patientId}/archive`).expect(200);
    expect(await patientCount(b)).toBe(0);

    await admin.post(`/api/patients/${patientId}/restore`).expect(200);
    expect(await patientCount(b)).toBe(1);
  });

  it('rolls back the whole write when part of it fails', async () => {
    const doctorId = await createDoctor();
    // An archived condition fails validation inside the transaction, after the doctor check.
    await admin.post(`/api/lookups/conditions/${ids.conditionId}/archive`).expect(200);
    await staff.post('/api/patients').send(patientBody(doctorId)).expect(400);
    expect(await patientCount(doctorId)).toBe(0);
    expect(await PatientModel.countDocuments()).toBe(0);
  });

  it('uses the doctor from the URL on the nested route', async () => {
    const doctorId = await createDoctor();
    const res = await staff
      .post(`/api/doctors/${doctorId}/patients`)
      .send(patientBody('000000000000000000000000'))
      .expect(201);
    expect(res.body.doctorId).toBe(doctorId);
    expect(await patientCount(doctorId)).toBe(1);
  });
});

describe('archiving rules', () => {
  it('blocks archiving a doctor who still has active patients', async () => {
    const doctorId = await createDoctor();
    await createPatient(doctorId);
    await createPatient(doctorId);
    const res = await admin.post(`/api/doctors/${doctorId}/archive`).expect(409);
    expect(res.body.error.message).toBe('Reassign or archive their 2 patients first');
  });

  it('reassigns active patients and archives the doctor in one step', async () => {
    const leaving = await createDoctor();
    const staying = await createDoctor();
    await createPatient(leaving);
    await createPatient(leaving);
    const archivedPatient = await createPatient(leaving);
    await admin.post(`/api/patients/${archivedPatient}/archive`).expect(200);

    const res = await admin
      .post(`/api/doctors/${leaving}/archive`)
      .send({ reassignTo: staying })
      .expect(200);
    expect(res.body).toMatchObject({ isArchived: true, patientCount: 0, reassigned: 2 });
    expect(await patientCount(staying)).toBe(2);
    expect(await PatientModel.countDocuments({ doctorId: staying, isArchived: false })).toBe(2);
    // Archived patients keep their original doctor (their record is history).
    expect(await PatientModel.countDocuments({ doctorId: leaving })).toBe(1);
  });

  it('refuses to reassign to the same doctor or an archived one', async () => {
    const doctorId = await createDoctor();
    const archivedDoctor = await createDoctor();
    await admin.post(`/api/doctors/${archivedDoctor}/archive`).expect(200);
    await createPatient(doctorId);

    await admin.post(`/api/doctors/${doctorId}/archive`).send({ reassignTo: doctorId }).expect(400);
    await admin
      .post(`/api/doctors/${doctorId}/archive`)
      .send({ reassignTo: archivedDoctor })
      .expect(400);
    expect(await patientCount(doctorId)).toBe(1);
  });

  it('archives an empty doctor and hides them from lists', async () => {
    const doctorId = await createDoctor();
    await admin.post(`/api/doctors/${doctorId}/archive`).expect(200);
    const active = await staff.get('/api/doctors').expect(200);
    expect(active.body.meta.total).toBe(0);
    const archived = await admin.get('/api/doctors?archived=true').expect(200);
    expect(archived.body.data[0]._id).toBe(doctorId);
  });

  it('refuses new patients for an archived doctor and restoring onto one', async () => {
    const doctorId = await createDoctor();
    const patientId = await createPatient(doctorId);
    await admin.post(`/api/patients/${patientId}/archive`).expect(200);
    await admin.post(`/api/doctors/${doctorId}/archive`).expect(200);

    await staff.post('/api/patients').send(patientBody(doctorId)).expect(400);
    const restore = await admin.post(`/api/patients/${patientId}/restore`).expect(409);
    expect(restore.body.error.message).toMatch(/doctor is archived/);
  });

  it('restores a patient under another doctor when theirs is archived', async () => {
    const oldDoctor = await createDoctor();
    const newDoctor = await createDoctor();
    const patientId = await createPatient(oldDoctor);
    await admin.post(`/api/patients/${patientId}/archive`).expect(200);
    await admin.post(`/api/doctors/${oldDoctor}/archive`).expect(200);

    const res = await admin
      .post(`/api/patients/${patientId}/restore`)
      .send({ doctorId: newDoctor })
      .expect(200);
    expect(res.body).toMatchObject({ isArchived: false, doctorId: newDoctor });
    expect(await patientCount(newDoctor)).toBe(1);
    expect(await patientCount(oldDoctor)).toBe(0);
  });

  it('refuses to edit an archived patient', async () => {
    const doctorId = await createDoctor();
    const patientId = await createPatient(doctorId);
    await admin.post(`/api/patients/${patientId}/archive`).expect(200);
    await staff.patch(`/api/patients/${patientId}`).send({ name: 'New Name' }).expect(409);
  });
});

describe('list queries', () => {
  beforeEach(async () => {
    const cardio = await createDoctor({ name: 'Dr. Alice Smith', hospital: 'Square Hospital' });
    const other = await createDoctor({ name: 'Dr. Bob Jones', hospital: 'United Hospital' });
    await createPatient(cardio, { name: 'Young Patient', dateOfBirth: '2010-01-01' });
    await createPatient(cardio, {
      name: 'Middle Patient',
      dateOfBirth: '1985-06-15',
      status: 'critical',
    });
    await createPatient(other, {
      name: 'Old Patient',
      dateOfBirth: '1950-03-03',
      admissionDate: '2026-01-10',
    });
  });

  it('paginates with total and page count', async () => {
    const res = await staff.get('/api/patients?pageSize=2&page=2&sort=name&order=asc').expect(200);
    expect(res.body.meta).toEqual({ page: 2, pageSize: 2, total: 3, totalPages: 2 });
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Young Patient');
  });

  it('searches by name prefix, case-insensitively, without regex injection', async () => {
    const res = await staff.get('/api/doctors?search=dr.%20ALI').expect(200);
    expect(res.body.data.map((d: { name: string }) => d.name)).toEqual(['Dr. Alice Smith']);
    const injected = await staff.get('/api/doctors?search=.*').expect(200);
    expect(injected.body.meta.total).toBe(0);
  });

  it('filters doctors by hospital prefix and patient count range', async () => {
    const res = await staff.get('/api/doctors?hospital=squ&minPatients=2').expect(200);
    expect(res.body.data.map((d: { name: string }) => d.name)).toEqual(['Dr. Alice Smith']);
  });

  it('filters patients by status, age range and admission dates', async () => {
    const critical = await staff.get('/api/patients?status=critical,recovered').expect(200);
    expect(critical.body.data.map((p: { name: string }) => p.name)).toEqual(['Middle Patient']);

    const adults = await staff.get('/api/patients?minAge=30&maxAge=60').expect(200);
    expect(adults.body.data.map((p: { name: string }) => p.name)).toEqual(['Middle Patient']);

    // A date-only end includes that whole day.
    const january = await staff
      .get('/api/patients?admittedFrom=2026-01-01&admittedTo=2026-01-10')
      .expect(200);
    expect(january.body.data.map((p: { name: string }) => p.name)).toEqual(['Old Patient']);
  });

  it('sorts patients by age', async () => {
    const res = await staff.get('/api/patients?sort=age&order=desc').expect(200);
    expect(res.body.data.map((p: { name: string }) => p.name)).toEqual([
      'Old Patient',
      'Middle Patient',
      'Young Patient',
    ]);
  });

  it('adds the doctor name to each patient row', async () => {
    const res = await staff.get('/api/patients?search=old').expect(200);
    expect(res.body.data[0].doctorName).toBe('Dr. Bob Jones');
    expect(res.body.data[0].doctorArchived).toBe(false);
  });

  it('reports dashboard stats from current data', async () => {
    const res = await staff.get('/api/stats?from=2026-01-01&to=2026-12-31').expect(200);
    expect(res.body.current).toMatchObject({
      totalDoctors: 2,
      activePatients: 3,
      criticalPatients: 1,
      avgPatientsPerDoctor: 1.5,
    });
    expect(res.body.inRange.admissions).toBe(3);
    expect(res.body.inRange.admissionsByMonth).toHaveLength(12);
    // Breakdowns add up: by age group, by gender, and each month's gender split.
    const sum = (rows: { count: number }[]) => rows.reduce((t, r) => t + r.count, 0);
    expect(sum(res.body.inRange.byAge)).toBe(3);
    expect(sum(res.body.inRange.byGender)).toBe(3);
    const months = res.body.inRange.admissionsByMonth as {
      count: number;
      male: number;
      female: number;
      other: number;
    }[];
    for (const m of months) expect(m.male + m.female + m.other).toBe(m.count);
    // Ages in the fixture: ~16, ~41, ~76 -> one each in 0-17, 35-49, 65+.
    const byAge = Object.fromEntries(
      res.body.inRange.byAge.map((b: { label: string; count: number }) => [b.label, b.count]),
    );
    expect(byAge).toMatchObject({ '0-17': 1, '35-49': 1, '65+': 1 });
    expect(res.body.current.avgPatientAge).toBeGreaterThan(40);
  });
});
