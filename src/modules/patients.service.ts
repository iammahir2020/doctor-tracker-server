import mongoose, { type ClientSession } from 'mongoose';
import { AppError } from '../lib.js';
import { ConditionModel, DoctorModel, GENDERS, PATIENT_STATUSES, PatientModel } from '../models.js';
import { assertActiveLookup } from './lookups.routes.js';

/**
 * Every patient write that can change a doctor's active-patient count runs here, inside one
 * transaction with the matching `$inc`, so doctor.patientCount never drifts from the real count.
 */

export type PatientInput = {
  name: string;
  dateOfBirth: Date;
  gender: (typeof GENDERS)[number];
  phone: string;
  email?: string | null | undefined;
  condition: string;
  status: (typeof PATIENT_STATUSES)[number];
  admissionDate: Date;
  notes?: string | undefined;
  doctorId: string;
};

async function assertActiveDoctor(doctorId: string, session: ClientSession) {
  const doctor = await DoctorModel.exists({ _id: doctorId, isArchived: false }).session(session);
  if (!doctor) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Unknown or archived doctor', [
      { location: 'body', path: 'doctorId', message: 'Choose an active doctor' },
    ]);
  }
}

function incDoctor(doctorId: unknown, by: 1 | -1, session: ClientSession) {
  return DoctorModel.updateOne({ _id: doctorId }, { $inc: { patientCount: by } }, { session });
}

export function createPatient(input: PatientInput) {
  return mongoose.connection.transaction(async (session) => {
    await assertActiveDoctor(input.doctorId, session);
    await assertActiveLookup(ConditionModel, input.condition, 'condition');
    const [patient] = await PatientModel.create([input], { session });
    await incDoctor(input.doctorId, 1, session);
    return patient;
  });
}

export function updatePatient(id: string, input: Partial<PatientInput>) {
  return mongoose.connection.transaction(async (session) => {
    const patient = await PatientModel.findById(id).session(session);
    if (!patient) throw new AppError(404, 'NOT_FOUND', 'Patient not found');
    if (patient.isArchived) {
      throw new AppError(409, 'CONFLICT', 'Restore this patient before editing it');
    }

    const oldDoctorId = String(patient.doctorId);
    const movingDoctor = input.doctorId !== undefined && input.doctorId !== oldDoctorId;
    if (movingDoctor) await assertActiveDoctor(input.doctorId as string, session);
    // An existing archived condition may stay on the record; only a change has to be active.
    if (input.condition !== undefined && input.condition !== String(patient.condition)) {
      await assertActiveLookup(ConditionModel, input.condition, 'condition');
    }

    patient.set(input);
    await patient.save({ session });
    if (movingDoctor) {
      await incDoctor(oldDoctorId, -1, session);
      await incDoctor(input.doctorId, 1, session);
    }
    return patient;
  });
}

/**
 * Archive or restore a patient. Restoring onto an archived doctor is refused unless `assignTo`
 * names an active doctor to restore them under instead.
 */
export function setPatientArchived(
  id: string,
  archive: boolean,
  userId: string | undefined,
  assignTo?: string,
) {
  return mongoose.connection.transaction(async (session) => {
    const patient = await PatientModel.findById(id).session(session);
    if (!patient) throw new AppError(404, 'NOT_FOUND', 'Patient not found');
    if (patient.isArchived === archive) return patient;

    if (!archive && assignTo) {
      await assertActiveDoctor(assignTo, session);
      patient.set('doctorId', assignTo);
    } else if (!archive) {
      const doctor = await DoctorModel.exists({ _id: patient.doctorId, isArchived: false }).session(
        session,
      );
      if (!doctor) {
        throw new AppError(
          409,
          'CONFLICT',
          "This patient's doctor is archived. Restore the doctor first.",
        );
      }
    }

    patient.isArchived = archive;
    patient.archivedAt = archive ? new Date() : null;
    patient.set('archivedBy', archive ? userId : null);
    await patient.save({ session });
    await incDoctor(patient.doctorId, archive ? -1 : 1, session);
    return patient;
  });
}

/**
 * Archives a doctor. A doctor with active patients can't be archived on their own; with
 * `reassignTo`, those patients move to that doctor first, in the same transaction, so there is
 * never a moment where patients point at an archived doctor or the counts disagree.
 */
export function archiveDoctor(id: string, userId: string | undefined, reassignTo?: string) {
  return mongoose.connection.transaction(async (session) => {
    const doctor = await DoctorModel.findById(id).session(session);
    if (!doctor) throw new AppError(404, 'NOT_FOUND', 'Doctor not found');
    if (doctor.isArchived) return { doctor, reassigned: 0 };

    // Count the real thing rather than trusting the denormalized counter for a blocking rule.
    const active = await PatientModel.countDocuments({ doctorId: id, isArchived: false }).session(
      session,
    );
    if (active > 0 && !reassignTo) {
      throw new AppError(
        409,
        'CONFLICT',
        `Reassign or archive their ${active} patient${active === 1 ? '' : 's'} first`,
        { activePatients: active },
      );
    }
    if (active > 0 && reassignTo) {
      if (reassignTo === id) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Choose a different doctor', [
          { location: 'body', path: 'reassignTo', message: 'Choose a different doctor' },
        ]);
      }
      await assertActiveDoctor(reassignTo, session);
      await PatientModel.updateMany(
        { doctorId: id, isArchived: false },
        { $set: { doctorId: reassignTo } },
        { session },
      );
      await DoctorModel.updateOne(
        { _id: reassignTo },
        { $inc: { patientCount: active } },
        { session },
      );
    }

    doctor.patientCount = 0;
    doctor.isArchived = true;
    doctor.archivedAt = new Date();
    doctor.set('archivedBy', userId);
    await doctor.save({ session });
    return { doctor, reassigned: active };
  });
}
