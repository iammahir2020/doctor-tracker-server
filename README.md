# Doctor Tracker API

REST API for [Doctor Tracker](https://github.com/iammahir2020/doctor-tracker-client). Express 5,
TypeScript, Mongoose 9 / MongoDB 8, Zod validation, JWT in an httpOnly cookie.

Live: https://doctor-tracker-server-50kq.onrender.com/api/health (free tier, may take a minute to
wake up).

## Run locally

Node 24 and Docker. MongoDB must be a replica set (patient writes use transactions); the compose
file starts one.

```bash
cp .env.example .env
docker compose up -d
npm install
npm run seed      # users, lookups, 50 doctors, 3,000 patients (--reset to re-create)
npm run dev       # http://localhost:4000
```

`npm test` runs 40 API tests (Vitest + Supertest, in-memory replica set). `npm run recount` rebuilds
every doctor's patient count.

## API

All routes are under `/api` and need the session cookie, except login and health. Admin-only routes
are marked.

| Area     | Routes                                                                                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth     | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `PATCH /auth/me/password`                                                                   |
| Doctors  | `GET /doctors`, `GET /doctors/:id`, `POST` · `PATCH` (admin), `POST /doctors/:id/archive` · `/restore` (admin), `GET` · `POST /doctors/:id/patients` |
| Patients | `GET /patients`, `GET /patients/:id`, `POST`, `PATCH`, `POST /patients/:id/archive` · `/restore` (admin)                                             |
| Users    | `GET` · `POST /users`, `PATCH /users/:id`, `POST /users/:id/archive` · `/restore` (all admin)                                                        |
| Lookups  | `GET /lookups`; `POST /lookups/:type`, `PATCH /lookups/:type/:id`, archive · restore (admin)                                                         |
| Stats    | `GET /stats?from&to`                                                                                                                                 |
| Health   | `GET /health`                                                                                                                                        |

Lists take `search`, filters (e.g. `specialization`, `status`, `minAge`, `admittedFrom`), `sort`,
`order`, `page`, `pageSize` (max 50), and return `{ data, meta: { page, pageSize, total, totalPages } }`.

Errors always look like `{ "error": { "code", "message", "details" } }`, with codes
`VALIDATION_ERROR` (400), `UNAUTHENTICATED` / `ACCOUNT_ARCHIVED` (401), `FORBIDDEN` (403),
`NOT_FOUND` (404), `CONFLICT` (409) and `RATE_LIMITED` (429).

Business rules: nothing is deleted, only archived. A doctor with active patients can't be archived
unless `{ reassignTo }` moves them first (one transaction). A patient of an archived doctor can be
restored under another doctor with `{ doctorId }`. The last admin can't be demoted or archived.
Login is limited to 5 failed attempts per minute per IP + email.

## Indexes

Every list index starts with `isArchived`. On the seed data, the main queries all use an index scan
and read only the documents they return:

| Query                    | Index                                      | Docs examined / returned |
| ------------------------ | ------------------------------------------ | ------------------------ |
| Doctors by name search   | `isArchived_1_nameLower_1`                 | 3 / 3                    |
| Doctors by patient count | `isArchived_1_patientCount_-1`             | 20 / 20                  |
| One doctor's patients    | `isArchived_1_doctorId_1_admissionDate_-1` | 20 / 20                  |
| Patients by status       | `isArchived_1_status_1_admissionDate_-1`   | 20 / 20                  |
| Patients by age range    | `isArchived_1_dateOfBirth_1`               | 20 / 20                  |

All indexes are defined in `src/models.ts`.
