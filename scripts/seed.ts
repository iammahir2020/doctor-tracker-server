import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../src/env.js';
import { UserModel } from '../src/models.js';
import { BCRYPT_COST } from '../src/modules/auth.routes.js';

const seedEnv = z
  .object({
    SEED_ADMIN_EMAIL: z.email(),
    SEED_ADMIN_PASSWORD: z.string().min(8),
    SEED_STAFF_EMAIL: z.email(),
    SEED_STAFF_PASSWORD: z.string().min(8),
  })
  .parse(process.env);

async function upsertUser(name: string, email: string, password: string, role: 'admin' | 'staff') {
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  await UserModel.updateOne(
    { emailLower: email.toLowerCase() },
    {
      $set: { name, email, emailLower: email.toLowerCase(), passwordHash, role, isArchived: false },
    },
    { upsert: true },
  );
  console.log(`  ${role}: ${email}`);
}

await mongoose.connect(env.MONGODB_URI);
await UserModel.syncIndexes();

console.log('Users');
await upsertUser('Admin User', seedEnv.SEED_ADMIN_EMAIL, seedEnv.SEED_ADMIN_PASSWORD, 'admin');
await upsertUser('Staff User', seedEnv.SEED_STAFF_EMAIL, seedEnv.SEED_STAFF_PASSWORD, 'staff');

await mongoose.disconnect();
