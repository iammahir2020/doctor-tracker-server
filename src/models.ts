import { Schema, model } from 'mongoose';

// Shared by every collection: nothing is hard-deleted, records are archived instead.
const archiveFields = {
  isArchived: { type: Boolean, default: false },
  archivedAt: { type: Date, default: null },
  archivedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
};

const schemaOptions = { timestamps: true, versionKey: false } as const;

// The *Lower fields exist only for indexed, case-insensitive search; keep them out of responses.
function hideInternalFields(schema: Schema) {
  schema.set('toJSON', {
    transform: (_doc: unknown, ret: Record<string, unknown>) => {
      delete ret.nameLower;
      delete ret.emailLower;
      delete ret.hospitalLower;
      delete ret.passwordHash;
      delete ret.tokenVersion;
      return ret;
    },
  });
}

/** Projection for lean reads that mirrors the toJSON transform above. */
export const HIDDEN_FIELDS = { nameLower: 0, emailLower: 0, hospitalLower: 0 } as const;

// ---------- User ----------

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, trim: true, maxlength: 254 },
    emailLower: { type: String, required: true },
    nameLower: { type: String, required: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['admin', 'staff'], required: true, default: 'staff' },
    // Missing means 0: users created before this field existed never got it.
    tokenVersion: { type: Number },
    ...archiveFields,
  },
  schemaOptions,
);

userSchema.index({ emailLower: 1 }, { unique: true });
userSchema.index({ isArchived: 1, nameLower: 1 });

userSchema.pre('validate', function () {
  this.emailLower = this.email.toLowerCase();
  this.nameLower = this.name.toLowerCase();
});

hideInternalFields(userSchema);
export const UserModel = model('User', userSchema);

// ---------- Lookups (specializations, conditions) ----------

function lookupSchema() {
  const schema = new Schema(
    {
      name: { type: String, required: true, trim: true, maxlength: 60 },
      nameLower: { type: String, required: true },
      ...archiveFields,
    },
    schemaOptions,
  );
  schema.index({ nameLower: 1 }, { unique: true });
  schema.pre('validate', function () {
    this.nameLower = this.name.toLowerCase();
  });
  hideInternalFields(schema);
  return schema;
}

export const SpecializationModel = model('Specialization', lookupSchema());
export const ConditionModel = model('Condition', lookupSchema());

// ---------- Doctor ----------

const doctorSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    nameLower: { type: String, required: true },
    specialization: { type: Schema.Types.ObjectId, ref: 'Specialization', required: true },
    hospital: { type: String, required: true, trim: true, maxlength: 120 },
    hospitalLower: { type: String, required: true },
    phone: { type: String, required: true, trim: true, maxlength: 30 },
    email: { type: String, required: true, trim: true, maxlength: 254 },
    emailLower: { type: String, required: true },
    // Denormalized count of non-archived patients, kept in sync by patients.service.ts.
    patientCount: { type: Number, default: 0, min: 0 },
    ...archiveFields,
  },
  schemaOptions,
);

doctorSchema.index({ emailLower: 1 }, { unique: true });
doctorSchema.index({ isArchived: 1, nameLower: 1 });
doctorSchema.index({ isArchived: 1, createdAt: -1 });
doctorSchema.index({ isArchived: 1, specialization: 1, createdAt: -1 });
doctorSchema.index({ isArchived: 1, hospitalLower: 1 });
doctorSchema.index({ isArchived: 1, patientCount: -1 });

doctorSchema.pre('validate', function () {
  this.nameLower = this.name.toLowerCase();
  this.hospitalLower = this.hospital.toLowerCase();
  this.emailLower = this.email.toLowerCase();
});

hideInternalFields(doctorSchema);
export const DoctorModel = model('Doctor', doctorSchema);

// ---------- Patient ----------

export const GENDERS = ['male', 'female', 'other'] as const;
export const PATIENT_STATUSES = ['active', 'recovered', 'critical'] as const;

const patientSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    nameLower: { type: String, required: true },
    dateOfBirth: { type: Date, required: true },
    gender: { type: String, enum: GENDERS, required: true },
    phone: { type: String, required: true, trim: true, maxlength: 30 },
    email: { type: String, trim: true, maxlength: 254, default: null },
    emailLower: { type: String, default: null },
    condition: { type: Schema.Types.ObjectId, ref: 'Condition', required: true },
    status: { type: String, enum: PATIENT_STATUSES, required: true, default: 'active' },
    admissionDate: { type: Date, required: true },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
    doctorId: { type: Schema.Types.ObjectId, ref: 'Doctor', required: true },
    ...archiveFields,
  },
  schemaOptions,
);

patientSchema.index({ isArchived: 1, doctorId: 1, admissionDate: -1 });
patientSchema.index({ isArchived: 1, admissionDate: -1 });
patientSchema.index({ isArchived: 1, nameLower: 1 });
patientSchema.index({ isArchived: 1, emailLower: 1 });
patientSchema.index({ isArchived: 1, condition: 1, admissionDate: -1 });
patientSchema.index({ isArchived: 1, status: 1, admissionDate: -1 });
patientSchema.index({ isArchived: 1, dateOfBirth: 1 });

patientSchema.pre('validate', function () {
  this.nameLower = this.name.toLowerCase();
  this.emailLower = this.email ? this.email.toLowerCase() : null;
});

hideInternalFields(patientSchema);
export const PatientModel = model('Patient', patientSchema);
