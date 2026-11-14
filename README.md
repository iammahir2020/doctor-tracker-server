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
npm run seed      # Bangladeshi demo data: 2 users, lookups, 50 doctors, 3,000 patients
                  # (--reset empties the database first)
npm run dev       # http://localhost:4000
```

`npm test` runs 46 API tests (Vitest + Supertest, in-memory replica set). `npm run recount` rebuilds
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
`search` matches any part of the name or email, ignoring case.

Errors always look like `{ "error": { "code", "message", "details" } }`, with codes
`VALIDATION_ERROR` (400), `UNAUTHENTICATED` / `ACCOUNT_ARCHIVED` (401), `FORBIDDEN` (403),
`NOT_FOUND` (404), `CONFLICT` (409) and `RATE_LIMITED` (429).

Business rules: nothing is deleted, only archived. A doctor with active patients can't be archived
unless `{ reassignTo }` moves them first (one transaction). A patient of an archived doctor can be
restored under another doctor with `{ doctorId }`. The last admin can't be demoted or archived.

## Security

- **Sessions:** a JWT in an httpOnly, SameSite=Lax cookie. Every request reloads the user, so role
  changes and archived accounts apply at once. Changing the password ends every session for that
  user, the current one included.
- **Login:** 5 failed attempts per minute per IP + email, and 10 per 15 minutes per email whatever
  the IP. Only Render's proxy hop is trusted, so a client can't fake its IP with `X-Forwarded-For`.
  Unknown emails and wrong passwords take the same time and give the same error.
- **Input:** every body, query and URL parameter goes through Zod, which also drops unknown fields.
  Names, hospitals and lookup names can't contain `<` or `>`; notes are free text and the client
  renders everything as text. Search terms are escaped before they become a regex.
- **Headers:** helmet on the API, CORS limited to the client's origin.

## Indexes

Every list index starts with `isArchived` and ends with `_id`, because list sorts use `_id` as a
tie-breaker; without it Mongo would sort in memory. Measured with `explain()` on the seed data, each
list page reads only the 20 documents it returns:

| Query (first page of 20)          | Index                                             | Docs examined / returned |
| --------------------------------- | ------------------------------------------------- | ------------------------ |
| Patients, newest admissions first | `isArchived_1_admissionDate_-1__id_-1`            | 20 / 20                  |
| One doctor's patients             | `isArchived_1_doctorId_1_admissionDate_-1__id_-1` | 20 / 20                  |
| Patients by status                | `isArchived_1_status_1_admissionDate_-1__id_-1`   | 20 / 20                  |
| Patients by age range, by age     | `isArchived_1_dateOfBirth_1__id_-1`               | 20 / 20                  |
| Doctors by patient count          | `isArchived_1_patientCount_-1__id_-1`             | 20 / 20                  |

Search is a "contains" match, which can't use an index range: Mongo walks the sort index until it
has a page of matches (476 documents for "akter"; all ~2,900 active patients for a rare term, about
60 ms locally). That's fine at this size; with much more data I'd move search to Atlas Search.

All indexes are defined in `src/models.ts`.
