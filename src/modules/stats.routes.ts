import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { dateTo } from '../lib.js';
import { requireAuth, validate } from '../middleware.js';
import { DoctorModel, PatientModel } from '../models.js';

const statsQuery = z
  .object({ from: z.coerce.date().optional(), to: dateTo.optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, '`from` must be before `to`');

// ---------- tiny TTL cache ----------
// Dashboard numbers are read far more often than data changes, and the aggregations scan whole
// collections. Any successful write clears the cache, so the TTL only bounds staleness from
// other server instances.

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: unknown }>();

/** Mounted app-wide: after any successful non-GET request, drop cached stats. */
export const clearStatsOnWrite: RequestHandler = (req, res, next) => {
  if (req.method !== 'GET') {
    res.on('finish', () => {
      if (res.statusCode < 400) cache.clear();
    });
  }
  next();
};

// ---------- aggregations ----------

const YEAR_MS = 365.2425 * 24 * 3600 * 1000;
const AGE_BOUNDARIES = [0, 18, 35, 50, 65, 200];
const AGE_LABELS = ['0-17', '18-34', '35-49', '50-64', '65+'];

function defaultRange() {
  // End of today, so the default range (and its cache key) is stable for the whole day.
  const now = new Date();
  const to = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999),
  );
  const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 11, 1));
  return { from, to };
}

function monthKeys(from: Date, to: Date) {
  const keys: string[] = [];
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (d <= to && keys.length < 120) {
    keys.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return keys;
}

type Count = { _id: string | null; count: number };

async function computeStats(from: Date, to: Date) {
  const inRange = { $match: { admissionDate: { $gte: from, $lte: to } } };
  const countBy = (field: string) => ({ $group: { _id: `$${field}`, count: { $sum: 1 } } });
  // Age in whole years today (birthdays counted exactly enough for grouping and averages).
  const ageYears = { $divide: [{ $subtract: ['$$NOW', '$dateOfBirth'] }, YEAR_MS] };

  const [patientFacets, doctorFacets] = await Promise.all([
    PatientModel.aggregate<{
      current: Count[];
      currentAge: { avg: number }[];
      admissionsByMonth: { _id: { month: string; gender: string }; count: number }[];
      byAge: { _id: number | string; count: number }[];
      byGender: Count[];
      byCondition: Count[];
      byStatus: Count[];
      admissionsInRange: { count: number }[];
    }>([
      { $match: { isArchived: false } },
      {
        $facet: {
          current: [countBy('status')],
          currentAge: [{ $group: { _id: null, avg: { $avg: ageYears } } }],
          admissionsByMonth: [
            inRange,
            {
              $group: {
                _id: {
                  month: { $dateToString: { format: '%Y-%m', date: '$admissionDate' } },
                  gender: '$gender',
                },
                count: { $sum: 1 },
              },
            },
          ],
          byAge: [
            inRange,
            {
              $bucket: {
                groupBy: { $floor: ageYears },
                boundaries: AGE_BOUNDARIES,
                default: 'other',
                output: { count: { $sum: 1 } },
              },
            },
          ],
          byGender: [inRange, countBy('gender')],
          byCondition: [inRange, countBy('condition'), { $sort: { count: -1 } }],
          byStatus: [inRange, countBy('status')],
          admissionsInRange: [inRange, { $count: 'count' }],
        },
      },
    ]),
    DoctorModel.aggregate<{
      totals: { count: number; avgPatients: number }[];
      bySpecialization: Count[];
      topDoctors: { _id: string; name: string; specialization: string; patientCount: number }[];
      distribution: { _id: number; count: number }[];
    }>([
      { $match: { isArchived: false } },
      {
        $facet: {
          totals: [
            { $group: { _id: null, count: { $sum: 1 }, avgPatients: { $avg: '$patientCount' } } },
          ],
          bySpecialization: [countBy('specialization'), { $sort: { count: -1 } }],
          topDoctors: [
            { $sort: { patientCount: -1, _id: 1 } },
            { $limit: 10 },
            { $project: { name: 1, specialization: 1, patientCount: 1 } },
          ],
          distribution: [
            {
              $bucket: {
                groupBy: '$patientCount',
                boundaries: [0, 1, 26, 51, 101, Number.MAX_SAFE_INTEGER],
                default: 'other',
                output: { count: { $sum: 1 } },
              },
            },
          ],
        },
      },
    ]),
  ]);

  const p = patientFacets[0];
  const d = doctorFacets[0];
  const current = new Map(p?.current.map((c) => [c._id, c.count]));
  // month -> { male, female, other }
  const byMonth = new Map<string, Record<string, number>>();
  for (const m of p?.admissionsByMonth ?? []) {
    const row = byMonth.get(m._id.month) ?? {};
    row[m._id.gender] = (row[m._id.gender] ?? 0) + m.count;
    byMonth.set(m._id.month, row);
  }
  const ages = new Map(p?.byAge.map((b) => [b._id, b.count]));
  const genders = new Map(p?.byGender.map((g) => [g._id, g.count]));
  const buckets = new Map(d?.distribution.map((b) => [b._id, b.count]));
  const totals = d?.totals[0];

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    current: {
      totalDoctors: totals?.count ?? 0,
      activePatients: [...current.values()].reduce((a, b) => a + b, 0),
      criticalPatients: current.get('critical') ?? 0,
      avgPatientsPerDoctor: Math.round((totals?.avgPatients ?? 0) * 10) / 10,
      avgPatientAge: Math.round((p?.currentAge[0]?.avg ?? 0) * 10) / 10,
      patientsByStatus: (['active', 'recovered', 'critical'] as const).map((status) => ({
        status,
        count: current.get(status) ?? 0,
      })),
      doctorsBySpecialization: (d?.bySpecialization ?? []).map((s) => ({
        specialization: s._id,
        count: s.count,
      })),
      topDoctors: d?.topDoctors ?? [],
      patientsPerDoctor: [
        { label: '0', count: buckets.get(0) ?? 0 },
        { label: '1–25', count: buckets.get(1) ?? 0 },
        { label: '26–50', count: buckets.get(26) ?? 0 },
        { label: '51–100', count: buckets.get(51) ?? 0 },
        { label: '101+', count: buckets.get(101) ?? 0 },
      ],
    },
    inRange: {
      admissions: p?.admissionsInRange[0]?.count ?? 0,
      // Months with no admissions are filled with 0 so the chart has no gaps.
      admissionsByMonth: monthKeys(from, to).map((month) => {
        const row = byMonth.get(month) ?? {};
        const male = row.male ?? 0;
        const female = row.female ?? 0;
        const other = row.other ?? 0;
        return { month, count: male + female + other, male, female, other };
      }),
      byAge: AGE_BOUNDARIES.slice(0, -1).map((lower, i) => ({
        label: AGE_LABELS[i] as string,
        count: ages.get(lower) ?? 0,
      })),
      byGender: (['female', 'male', 'other'] as const).map((gender) => ({
        gender,
        count: genders.get(gender) ?? 0,
      })),
      byCondition: (p?.byCondition ?? []).map((c) => ({ condition: c._id, count: c.count })),
      byStatus: (p?.byStatus ?? []).map((s) => ({ status: s._id, count: s.count })),
    },
  };
}

export const statsRouter = Router();
statsRouter.use(requireAuth);

statsRouter.get('/', validate({ query: statsQuery }), async (req, res) => {
  const q = req.query as z.infer<typeof statsQuery>;
  const fallback = defaultRange();
  const from = q.from ?? fallback.from;
  const to = q.to ?? fallback.to;

  const key = `${from.toISOString()}|${to.toISOString()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    res.json(hit.value);
    return;
  }
  const value = await computeStats(from, to);
  if (cache.size > 100) cache.clear();
  cache.set(key, { at: Date.now(), value });
  res.json(value);
});
