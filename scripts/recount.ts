/**
 * Rebuilds every doctor's patientCount from the patients collection. The counter is kept in
 * sync transactionally, so this is a safety net (e.g. after editing data by hand).
 *
 *   npm run recount
 */
import mongoose from 'mongoose';
import { env } from '../src/env.js';
import { DoctorModel, PatientModel } from '../src/models.js';

await mongoose.connect(env.MONGODB_URI);

const counts = await PatientModel.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
  { $match: { isArchived: false } },
  { $group: { _id: '$doctorId', count: { $sum: 1 } } },
]);
const byDoctor = new Map(counts.map((c) => [String(c._id), c.count]));

const doctors = await DoctorModel.find({}, { patientCount: 1 }).lean();
const fixes = doctors
  .map((d) => ({ id: d._id, was: d.patientCount, now: byDoctor.get(String(d._id)) ?? 0 }))
  .filter((d) => d.was !== d.now);

if (fixes.length > 0) {
  await DoctorModel.bulkWrite(
    fixes.map((f) => ({
      updateOne: { filter: { _id: f.id }, update: { $set: { patientCount: f.now } } },
    })),
  );
}
console.log(`Checked ${doctors.length} doctors, fixed ${fixes.length}`);
for (const f of fixes) console.log(`  ${String(f.id)}: ${f.was} -> ${f.now}`);

await mongoose.disconnect();
