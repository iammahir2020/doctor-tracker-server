import bcrypt from 'bcryptjs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { createApp } from '../src/app.js';
import { ConditionModel, SpecializationModel, UserModel } from '../src/models.js';

// A replica set, not a standalone server: patient writes run in transactions.
let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
});

afterEach(async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

export const app = createApp();

export const PASSWORD = 'Passw0rd!';

export async function createUser(role: 'admin' | 'staff', email = `${role}@test.dev`) {
  return UserModel.create({
    name: `${role} user`,
    email,
    passwordHash: await bcrypt.hash(PASSWORD, 4),
    role,
  });
}

/** A supertest agent that keeps the session cookie, signed in as a new user of `role`. */
export async function signedIn(role: 'admin' | 'staff', email?: string) {
  const user = await createUser(role, email);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email: user.email, password: PASSWORD }).expect(200);
  return { agent, user };
}

export async function createLookups() {
  const [specialization, archivedSpecialization, condition] = await Promise.all([
    SpecializationModel.create({ name: 'Cardiology' }),
    SpecializationModel.create({ name: 'Old Specialty', isArchived: true }),
    ConditionModel.create({ name: 'Hypertension' }),
  ]);
  return {
    specializationId: String(specialization._id),
    archivedSpecializationId: String(archivedSpecialization._id),
    conditionId: String(condition._id),
  };
}
