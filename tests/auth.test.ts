import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { UserModel } from '../src/models.js';
import { app, createUser, PASSWORD, signedIn } from './setup.js';

describe('auth', () => {
  it('logs in with a case-insensitive email and sets an httpOnly cookie', async () => {
    await createUser('staff', 'Staff@Test.dev');
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'staff@test.DEV', password: PASSWORD })
      .expect(200);

    expect(res.body.user).toMatchObject({ email: 'Staff@Test.dev', role: 'staff' });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/dt_token=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  it('gives the same error for an unknown email and a wrong password', async () => {
    await createUser('staff');
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@test.dev', password: PASSWORD })
      .expect(401);
    const wrong = await request(app)
      .post('/api/auth/login')
      .send({ email: 'staff@test.dev', password: 'wrong-password' })
      .expect(401);
    expect(unknown.body.error).toEqual(wrong.body.error);
    expect(wrong.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('validates the login body', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'nope' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual([
      'email',
      'password',
    ]);
  });

  it('returns the current user, and 401 without a session', async () => {
    await request(app).get('/api/auth/me').expect(401);
    const { agent } = await signedIn('admin');
    const res = await agent.get('/api/auth/me').expect(200);
    expect(res.body.user.role).toBe('admin');
  });

  it('logs out by clearing the cookie', async () => {
    const { agent } = await signedIn('staff');
    await agent.post('/api/auth/logout').expect(204);
    await agent.get('/api/auth/me').expect(401);
  });

  it('rejects a forged token', async () => {
    await request(app).get('/api/auth/me').set('Cookie', 'dt_token=abc.def.ghi').expect(401);
  });

  it('tells an archived user why, but only after the right password', async () => {
    const user = await createUser('staff');
    await UserModel.updateOne({ _id: user._id }, { isArchived: true });

    const right = await request(app)
      .post('/api/auth/login')
      .send({ email: 'staff@test.dev', password: PASSWORD })
      .expect(401);
    expect(right.body.error.code).toBe('ACCOUNT_ARCHIVED');

    const wrong = await request(app)
      .post('/api/auth/login')
      .send({ email: 'staff@test.dev', password: 'wrong-password' })
      .expect(401);
    expect(wrong.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('ends an existing session as soon as the user is archived', async () => {
    const { agent, user } = await signedIn('staff');
    await UserModel.updateOne({ _id: user._id }, { isArchived: true });
    const res = await agent.get('/api/auth/me').expect(401);
    expect(res.body.error.code).toBe('ACCOUNT_ARCHIVED');
  });

  it('changes the password only with the current one', async () => {
    const { agent } = await signedIn('staff');
    const bad = await agent
      .patch('/api/auth/me/password')
      .send({ currentPassword: 'wrong-password', newPassword: 'NewPassw0rd!' })
      .expect(400);
    expect(bad.body.error.details[0].path).toBe('currentPassword');

    await agent
      .patch('/api/auth/me/password')
      .send({ currentPassword: PASSWORD, newPassword: 'NewPassw0rd!' })
      .expect(204);
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'staff@test.dev', password: 'NewPassw0rd!' })
      .expect(200);
  });

  it('rate-limits failed logins per IP and email', async () => {
    // Its own email: the limiter's counts live in memory for the whole test file.
    await createUser('staff', 'limited@test.dev');
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/auth/login')
        .send({ email: 'limited@test.dev', password: 'wrong-password' })
        .expect(401);
    }
    const limited = await request(app)
      .post('/api/auth/login')
      .send({ email: 'limited@test.dev', password: 'wrong-password' })
      .expect(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');

    // A different email from the same IP is not locked out.
    await createUser('admin');
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.dev', password: PASSWORD })
      .expect(200);
  });
});

describe('role-based access', () => {
  it('blocks staff from admin-only actions', async () => {
    const { agent } = await signedIn('staff');
    await agent.get('/api/users').expect(403);
    await agent.post('/api/doctors').send({}).expect(403);
    await agent.post('/api/lookups/conditions').send({ name: 'Flu' }).expect(403);
    const res = await agent.post('/api/patients/000000000000000000000000/archive').expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('lets staff read everything and admins manage users', async () => {
    const staff = await signedIn('staff');
    await staff.agent.get('/api/doctors').expect(200);
    await staff.agent.get('/api/patients').expect(200);
    await staff.agent.get('/api/stats').expect(200);

    const admin = await signedIn('admin');
    await admin.agent.get('/api/users').expect(200);
  });

  it('ignores ?archived=true for staff', async () => {
    const { agent } = await signedIn('staff');
    const res = await agent.get('/api/users?archived=true');
    expect(res.status).toBe(403);
    const doctors = await agent.get('/api/doctors?archived=true').expect(200);
    expect(doctors.body.meta.total).toBe(0);
  });

  it('protects the last active admin and self-archiving', async () => {
    const { agent, user } = await signedIn('admin');
    const self = await agent.post(`/api/users/${String(user._id)}/archive`).expect(409);
    expect(self.body.error.message).toMatch(/yourself/);
    const demote = await agent
      .patch(`/api/users/${String(user._id)}`)
      .send({ role: 'staff' })
      .expect(409);
    expect(demote.body.error.message).toMatch(/at least one active admin/);
  });
});
