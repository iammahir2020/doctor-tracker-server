/**
 * Seeds lookups, the demo admin + staff users, ~50 doctors and ~3,000 patients over 12 months.
 * Names, phone numbers and hospitals are Bangladeshi, to match where the app is used.
 *
 *   npm run seed            safe to re-run: users and lookups are upserted, demo doctors and
 *                           patients are only added when there are none yet
 *   npm run seed -- --reset empties every collection (users, lookups, doctors, patients) first,
 *                           then re-creates everything
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
  'General Medicine',
  'Cardiology',
  'Gynecology',
  'Pediatrics',
  'Orthopedics',
  'Gastroenterology',
  'Neurology',
  'Nephrology',
  'Dermatology',
  'ENT',
  'Pulmonology',
  'Oncology',
  'Psychiatry',
];
// Ordered roughly by how common they are; weightedPick favours the front of the list.
const CONDITIONS = [
  'Hypertension',
  'Diabetes',
  'Dengue Fever',
  'Gastritis',
  'Asthma',
  'Typhoid',
  'Heart Disease',
  'Arthritis',
  'COPD',
  'Chronic Kidney Disease',
  'Migraine',
  'Fracture',
  'Infection',
  'Flu',
  'Other',
];
const HOSPITALS = [
  'Dhaka Medical College Hospital',
  'Square Hospital',
  'Evercare Hospital Dhaka',
  'United Hospital',
  'Labaid Specialized Hospital',
  'Ibn Sina Hospital',
  'BIRDEM General Hospital',
  'Popular Medical College Hospital',
  'National Heart Foundation Hospital',
  'Green Life Medical College Hospital',
  'Holy Family Red Crescent Medical College Hospital',
  'Chattogram Medical College Hospital',
  'Rajshahi Medical College Hospital',
  'Sylhet MAG Osmani Medical College Hospital',
  'Khulna Medical College Hospital',
];

// Most Bangladeshi names follow one of two patterns, so the pools are split that way.
// prettier-ignore
const NAMES = {
  muslim: {
    male: [
      'Rafiqul', 'Shafiqul', 'Aminul', 'Mizanur', 'Habibur', 'Kamrul', 'Ashraful', 'Tanvir',
      'Imran', 'Sakib', 'Fahim', 'Nafis', 'Arif', 'Mahmud', 'Rakib', 'Shahriar', 'Tahsin',
      'Rashed', 'Jahid', 'Nayeem', 'Sabbir', 'Mehedi', 'Faisal', 'Riyad', 'Ashik', 'Zubair',
      'Tariq', 'Sohel', 'Shamim', 'Masud', 'Anisur', 'Mahbub', 'Saiful', 'Rezaul', 'Nazmul',
      'Shakil', 'Abrar', 'Ehsan', 'Mushfiq', 'Towhid',
    ],
    female: [
      'Nusrat', 'Farzana', 'Sadia', 'Tahmina', 'Ayesha', 'Sharmin', 'Nasrin', 'Rumana',
      'Jannatul', 'Sumaiya', 'Tanjila', 'Mithila', 'Shirin', 'Mahmuda', 'Fatema', 'Nazia',
      'Sabrina', 'Afroza', 'Rokeya', 'Taslima', 'Lamia', 'Raisa', 'Anika', 'Tasnim', 'Maliha',
      'Samia', 'Ishrat', 'Sanjida', 'Nabila', 'Shamima',
    ],
    maleSurnames: [
      'Rahman', 'Hossain', 'Islam', 'Ahmed', 'Chowdhury', 'Khan', 'Uddin', 'Haque', 'Kabir',
      'Alam', 'Siddique', 'Bhuiyan', 'Mollah', 'Sheikh', 'Talukder', 'Sarkar', 'Karim',
      'Hasan', 'Mahmud', 'Miah',
    ],
    femaleSurnames: [
      'Akter', 'Begum', 'Khatun', 'Sultana', 'Jahan', 'Rahman', 'Islam', 'Chowdhury',
      'Hossain', 'Haque', 'Ahmed', 'Khan',
    ],
  },
  hindu: {
    male: [
      'Partha', 'Sourav', 'Debashish', 'Pritom', 'Anik', 'Rajib', 'Subrata', 'Amit', 'Biplob',
      'Shuvo', 'Tapas', 'Uttam', 'Prosenjit', 'Arup', 'Dipankar',
    ],
    female: [
      'Puja', 'Ananya', 'Moumita', 'Rupa', 'Priyanka', 'Shreya', 'Mousumi', 'Tanushree',
      'Sharmila', 'Dipa', 'Rina', 'Joya',
    ],
    maleSurnames: [
      'Das', 'Roy', 'Saha', 'Paul', 'Ghosh', 'Dey', 'Chakraborty', 'Majumder', 'Sen', 'Bose',
      'Biswas', 'Kundu', 'Datta',
    ],
    femaleSurnames: [
      'Das', 'Roy', 'Saha', 'Paul', 'Ghosh', 'Dey', 'Chakraborty', 'Majumder', 'Sen', 'Biswas',
    ],
  },
};
const EMAIL_PROVIDERS = ['gmail.com', 'gmail.com', 'gmail.com', 'yahoo.com', 'outlook.com'];
// Bangladeshi mobile operator prefixes (013-019).
const MOBILE_PREFIXES = ['13', '14', '15', '16', '17', '18', '19'];
const NOTES = [
  'Follow-up in two weeks.',
  'Advised a low-salt diet and a daily walk.',
  'Fasting blood sugar to be checked at the next visit.',
  'Referred for an ECG and echocardiogram.',
  'Platelet count being monitored daily.',
  'Advised plenty of oral fluids and rest.',
  'X-ray done; cast applied, review in four weeks.',
  'Family history of diabetes and hypertension.',
  'Son is the main contact for appointments.',
  'Discharged with medication for seven days.',
  'Uses a nebuliser at night.',
  'Allergic to penicillin.',
  'Blood pressure stable on current medication.',
  'Needs a kidney function test before the next dose change.',
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

function personName(gender: 'male' | 'female') {
  const pool = faker.datatype.boolean(0.88) ? NAMES.muslim : NAMES.hindu;
  const first = faker.helpers.arrayElement(gender === 'male' ? pool.male : pool.female);
  const last = faker.helpers.arrayElement(
    gender === 'male' ? pool.maleSurnames : pool.femaleSurnames,
  );
  return { first, last };
}

function mobileNumber() {
  return `+880 ${faker.helpers.arrayElement(MOBILE_PREFIXES)}${faker.string.numeric(2)}-${faker.string.numeric(6)}`;
}

function personalEmail(first: string, last: string) {
  const separator = faker.helpers.arrayElement(['.', '_', '']);
  const suffix = faker.datatype.boolean(0.6)
    ? faker.string.numeric({ length: { min: 2, max: 4 } })
    : '';
  const provider = faker.helpers.arrayElement(EMAIL_PROVIDERS);
  return `${first}${separator}${last}${suffix}@${provider}`.toLowerCase();
}

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

if (reset) {
  await Promise.all([
    UserModel.deleteMany({}),
    SpecializationModel.deleteMany({}),
    ConditionModel.deleteMany({}),
    DoctorModel.deleteMany({}),
    PatientModel.deleteMany({}),
  ]);
  console.log('Reset: emptied users, lookups, doctors and patients');
}

await Promise.all([
  UserModel.syncIndexes(),
  SpecializationModel.syncIndexes(),
  ConditionModel.syncIndexes(),
  DoctorModel.syncIndexes(),
  PatientModel.syncIndexes(),
]);

console.log('Users');
await upsertUser('Farhana Rahman', seedEnv.SEED_ADMIN_EMAIL, seedEnv.SEED_ADMIN_PASSWORD, 'admin');
await upsertUser('Tanvir Ahmed', seedEnv.SEED_STAFF_EMAIL, seedEnv.SEED_STAFF_PASSWORD, 'staff');

const specializations = await upsertLookups(SpecializationModel, SPECIALIZATIONS);
const conditions = await upsertLookups(ConditionModel, CONDITIONS);
console.log(`Lookups: ${specializations.length} specializations, ${conditions.length} conditions`);

if ((await DoctorModel.estimatedDocumentCount()) > 0) {
  console.log('Doctors already exist, skipping demo data (use --reset to re-create it)');
} else {
  const now = new Date();
  const yearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());

  // Doctor names and emails are kept unique: the name pools are small enough to repeat.
  const usedNames = new Set<string>();
  const doctors = Array.from({ length: DOCTOR_COUNT }, () => {
    let first: string;
    let last: string;
    do {
      ({ first, last } = personName(faker.datatype.boolean(0.6) ? 'male' : 'female'));
    } while (usedNames.has(`${first} ${last}`));
    usedNames.add(`${first} ${last}`);

    const name = `Dr. ${first} ${last}`;
    const email = `${first}.${last}@doctortracker.dev`.toLowerCase();
    const hospital = weightedPick(HOSPITALS);
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
      phone: mobileNumber(),
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
    const { first, last } = personName(gender);
    const name = `${first} ${last}`;
    const doctor = weightedPick(doctorsWithPatients);
    // Admissions grow towards the present, which makes the monthly chart more realistic.
    const admissionDate = new Date(
      yearAgo.getTime() +
        Math.pow(faker.number.float({ min: 0, max: 1 }), 0.8) * (now.getTime() - yearAgo.getTime()),
    );
    // Fewer patients than doctors have an email address.
    const email = faker.datatype.boolean(0.55) ? personalEmail(first, last) : null;
    const isArchived = faker.datatype.boolean(0.04);
    if (!isArchived) doctor.patientCount += 1;
    return {
      name,
      nameLower: name.toLowerCase(),
      dateOfBirth: faker.date.birthdate({ mode: 'age', min: 1, max: 92 }),
      gender: faker.datatype.boolean(0.02) ? 'other' : gender,
      phone: mobileNumber(),
      email,
      emailLower: email,
      condition: weightedPick(conditions)._id,
      status: faker.helpers.weightedArrayElement([
        { value: 'active', weight: 55 },
        { value: 'recovered', weight: 35 },
        { value: 'critical', weight: 10 },
      ]),
      admissionDate,
      notes: faker.datatype.boolean(0.35) ? faker.helpers.arrayElement(NOTES) : '',
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
