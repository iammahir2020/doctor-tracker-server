/**
 * Seeds lookups, the demo admin + staff users, ~50 doctors and ~3,000 patients over 12 months.
 *
 *   npm run seed            safe to re-run: users and lookups are upserted, demo doctors and
 *                           patients are only added when there are none yet
 *   npm run seed -- --reset deletes all doctors and patients first, then re-creates them
 */
import { faker } from '@faker-js/faker';
import bcrypt from 'bcryptjs';
import mongoose, { Types } from 'mongoose';
import { z } from 'zod';
import { env } from '../src/env.js';
import {
  ConditionModel,
  DoctorModel,
  PatientModel,
  SpecializationModel,
  UserModel,
} from '../src/models.js';
import { BCRYPT_COST } from '../src/modules/auth.routes.js';

const SPECIALIZATIONS = [
  'Cardiology',
  'Neurology',
  'Orthopedics',
  'Pediatrics',
  'Dermatology',
  'Oncology',
  'General Medicine',
  'Psychiatry',
  'ENT',
  'Gynecology',
  'Gastroenterology',
  'Pulmonology',
];
const CONDITIONS = [
  'Hypertension',
  'Diabetes',
  'Asthma',
  'Fracture',
  'Migraine',
  'Flu',
  'Heart Disease',
  'Arthritis',
  'Infection',
  'Other',
];
const HOSPITALS = [
  'Square Hospital',
  'Evercare Hospital',
  'United Hospital',
  'Labaid Specialized Hospital',
  'Ibn Sina Hospital',
  'Popular Medical College Hospital',
  'BIRDEM General Hospital',
  'Dhaka Medical College Hospital',
];
const DOCTOR_COUNT = 50;
const PATIENT_COUNT = 3000;

const seedEnv = z
  .object({
    SEED_ADMIN_EMAIL: z.email(),
    SEED_ADMIN_PASSWORD: z.string().min(8),
    SEED_STAFF_EMAIL: z.email(),
    SEED_STAFF_PASSWORD: z.string().min(8),
  })
  .parse(process.env);

const reset = process.argv.includes('--reset');
faker.seed(20261114); // same demo data on every machine

async function upsertUser(name: string, email: string, password: string, role: 'admin' | 'staff') {
  await UserModel.updateOne(
    { emailLower: email.toLowerCase() },
    {
      $set: {
        name,
        nameLower: name.toLowerCase(),
        email,
        emailLower: email.toLowerCase(),
        passwordHash: await bcrypt.hash(password, BCRYPT_COST),
        role,
        isArchived: false,
        archivedAt: null,
        archivedBy: null,
      },
    },
    { upsert: true },
  );
  console.log(`  ${role}: ${email}`);
}

async function upsertLookups(model: typeof SpecializationModel, names: string[]) {
  await model.bulkWrite(
    names.map((name) => ({
      updateOne: {
        filter: { nameLower: name.toLowerCase() },
        update: { $setOnInsert: { name, nameLower: name.toLowerCase(), isArchived: false } },
        upsert: true,
      },
    })),
  );
  return model.find({ isArchived: false }, { _id: 1, name: 1 }).lean();
}

/** Skews picks towards the front of the list so the charts aren't flat. */
function weightedPick<T>(items: readonly T[]): T {
  const i = Math.floor(items.length * Math.pow(faker.number.float({ min: 0, max: 1 }), 1.6));
  return items[Math.min(i, items.length - 1)] as T;
}

await mongoose.connect(env.MONGODB_URI);
await Promise.all([
  UserModel.syncIndexes(),
  SpecializationModel.syncIndexes(),
  ConditionModel.syncIndexes(),
  DoctorModel.syncIndexes(),
  PatientModel.syncIndexes(),
]);

console.log('Users');
await upsertUser('Admin User', seedEnv.SEED_ADMIN_EMAIL, seedEnv.SEED_ADMIN_PASSWORD, 'admin');
await upsertUser('Staff User', seedEnv.SEED_STAFF_EMAIL, seedEnv.SEED_STAFF_PASSWORD, 'staff');

const specializations = await upsertLookups(SpecializationModel, SPECIALIZATIONS);
const conditions = await upsertLookups(ConditionModel, CONDITIONS);
console.log(`Lookups: ${specializations.length} specializations, ${conditions.length} conditions`);

if (reset) {
  await Promise.all([DoctorModel.deleteMany({}), PatientModel.deleteMany({})]);
  console.log('Reset: removed existing doctors and patients');
}

if ((await DoctorModel.estimatedDocumentCount()) > 0) {
  console.log('Doctors already exist, skipping demo data (use --reset to re-create it)');
} else {
  const now = new Date();
  const yearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());

  const doctors = Array.from({ length: DOCTOR_COUNT }, () => {
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    const name = `Dr. ${firstName} ${lastName}`;
    const email = faker.internet
      .email({ firstName, lastName, provider: 'doctortracker.dev' })
      .toLowerCase();
    const hospital = faker.helpers.arrayElement(HOSPITALS);
    const createdAt = faker.date.between({
      from: new Date(now.getFullYear() - 2, 0, 1),
      to: yearAgo,
    });
    return {
      _id: new Types.ObjectId(),
      name,
      nameLower: name.toLowerCase(),
      specialization: weightedPick(specializations)._id,
      hospital,
      hospitalLower: hospital.toLowerCase(),
      phone: faker.phone.number({ style: 'international' }),
      email,
      emailLower: email,
      patientCount: 0,
      isArchived: false,
      createdAt,
      updatedAt: createdAt,
    };
  });
  // A few doctors get no patients, so the "0 patients" bucket and archiving have examples.
  const doctorsWithPatients = doctors.slice(0, DOCTOR_COUNT - 4);

  const patients = Array.from({ length: PATIENT_COUNT }, () => {
    const gender = faker.helpers.arrayElement(['male', 'female'] as const);
    const name = faker.person.fullName({ sex: gender });
    const doctor = weightedPick(doctorsWithPatients);
    // Admissions grow towards the present, which makes the monthly chart more realistic.
    const admissionDate = new Date(
      yearAgo.getTime() +
        Math.pow(faker.number.float({ min: 0, max: 1 }), 0.8) * (now.getTime() - yearAgo.getTime()),
    );
    const email = faker.datatype.boolean(0.7)
      ? faker.internet.email({ firstName: name.split(' ')[0] }).toLowerCase()
      : null;
    const isArchived = faker.datatype.boolean(0.04);
    if (!isArchived) doctor.patientCount += 1;
    return {
      name,
      nameLower: name.toLowerCase(),
      dateOfBirth: faker.date.birthdate({ mode: 'age', min: 1, max: 92 }),
      gender: faker.datatype.boolean(0.02) ? 'other' : gender,
      phone: faker.phone.number({ style: 'international' }),
      email,
      emailLower: email,
      condition: weightedPick(conditions)._id,
      status: faker.helpers.weightedArrayElement([
        { value: 'active', weight: 55 },
        { value: 'recovered', weight: 35 },
        { value: 'critical', weight: 10 },
      ]),
      admissionDate,
      notes: faker.datatype.boolean(0.3) ? faker.lorem.sentence() : '',
      doctorId: doctor._id,
      isArchived,
      archivedAt: isArchived ? faker.date.between({ from: admissionDate, to: now }) : null,
      createdAt: admissionDate,
      updatedAt: admissionDate,
    };
  });

  // Archive two of the patient-less doctors so "Show archived" has something to show.
  for (const doctor of doctors.slice(-2)) {
    Object.assign(doctor, { isArchived: true, archivedAt: now });
  }

  // Raw inserts: the lower-cased fields are filled in above, and createdAt must be kept as is.
  await DoctorModel.collection.insertMany(doctors);
  await PatientModel.collection.insertMany(patients);
  console.log(`Doctors: ${doctors.length}, patients: ${patients.length}`);
}

await mongoose.disconnect();
