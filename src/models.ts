import { Schema, model, type InferSchemaType } from 'mongoose';

// Shared by every collection: nothing is hard-deleted, records are archived instead.
const archiveFields = {
  isArchived: { type: Boolean, default: false },
  archivedAt: { type: Date, default: null },
  archivedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
};

// ---------- User ----------

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, trim: true, maxlength: 254 },
    emailLower: { type: String, required: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['admin', 'staff'], required: true, default: 'staff' },
    ...archiveFields,
  },
  { timestamps: true },
);

userSchema.index({ emailLower: 1 }, { unique: true });

userSchema.pre('validate', function () {
  this.emailLower = this.email.toLowerCase();
});

export type User = InferSchemaType<typeof userSchema>;
export const UserModel = model('User', userSchema);
