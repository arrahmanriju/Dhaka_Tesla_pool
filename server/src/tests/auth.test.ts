import request from 'supertest';
import { app } from '../index';
import { sequelize, User, PasswordReset } from '../models';
import { normalizePhone } from '../utils/validation';

describe('Auth: phone required, email optional', () => {
  beforeAll(async () => {
    await sequelize.sync({ force: true });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  afterEach(async () => {
    await User.destroy({ where: {} });
  });

  const signup = (body: Record<string, unknown>) =>
    request(app).post('/auth/signup').send({ name: 'Nusrat', password: 'secret123', role: 'PASSENGER', ...body });

  describe('normalizePhone', () => {
    it.each([
      ['01712345678', '01712345678'],
      ['+8801712345678', '01712345678'],
      ['8801712345678', '01712345678'],
      ['017-1234 5678', '01712345678'],
      ['০১৭১২৩৪৫৬৭৮', '01712345678'], // Bangla digits
    ])('accepts %s', (input, expected) => {
      expect(normalizePhone(input)).toBe(expected);
    });

    it.each(['', 'abc', '0171234567', '017123456789', '01212345678', '02712345678'])('rejects %s', (input) => {
      expect(normalizePhone(input)).toBeNull();
    });
  });

  describe('POST /auth/signup', () => {
    it('creates an account with phone and NO email', async () => {
      const res = await signup({ phone: '01712345678' });
      expect(res.status).toBe(201);
      expect(res.body.user.phone).toBe('01712345678');
      expect(res.body.user.email).toBeNull();
      expect(res.body.token).toBeTruthy();
    });

    it('stores an optional email lower-cased when provided', async () => {
      const res = await signup({ phone: '01712345678', email: ' Nusrat@Test.COM ' });
      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe('nusrat@test.com');
    });

    it('treats a blank email as not provided', async () => {
      const res = await signup({ phone: '01712345678', email: '   ' });
      expect(res.status).toBe(201);
      expect(res.body.user.email).toBeNull();
    });

    it('allows many accounts without an email (no UNIQUE collision on NULL)', async () => {
      expect((await signup({ phone: '01711111111' })).status).toBe(201);
      expect((await signup({ phone: '01722222222' })).status).toBe(201);
    });

    it('requires a phone number', async () => {
      const res = await signup({ email: 'a@test.com' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/phone/i);
    });

    it('rejects an invalid phone number', async () => {
      const res = await signup({ phone: '12345' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/phone/i);
    });

    it('rejects a malformed email when one is given', async () => {
      const res = await signup({ phone: '01712345678', email: 'not-an-email' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/email/i);
    });

    it('rejects a duplicate phone number, however it is written', async () => {
      await signup({ phone: '01712345678' });
      const res = await signup({ phone: '+880 1712-345678' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/phone/i);
    });

    it('rejects a duplicate email', async () => {
      await signup({ phone: '01711111111', email: 'dup@test.com' });
      const res = await signup({ phone: '01722222222', email: 'dup@test.com' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/email/i);
    });
  });

  describe('POST /auth/login', () => {
    it('logs in with phone + password, in any accepted phone format', async () => {
      await signup({ phone: '01712345678' });
      for (const phone of ['01712345678', '+8801712345678', '০১৭১২৩৪৫৬৭৮']) {
        const res = await request(app).post('/auth/login').send({ phone, password: 'secret123' });
        expect(res.status).toBe(200);
        expect(res.body.user.phone).toBe('01712345678');
      }
    });

    it('rejects a wrong password and an unknown phone with the same 401', async () => {
      await signup({ phone: '01712345678' });
      const wrongPw = await request(app).post('/auth/login').send({ phone: '01712345678', password: 'nope12345' });
      const unknown = await request(app).post('/auth/login').send({ phone: '01799999999', password: 'secret123' });
      expect(wrongPw.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrongPw.body.error).toBe(unknown.body.error);
    });

    it('rejects an invalid phone number', async () => {
      const res = await request(app).post('/auth/login').send({ phone: 'abc', password: 'secret123' });
      expect(res.status).toBe(400);
    });

    it('requires phone (or legacy email) and password', async () => {
      expect((await request(app).post('/auth/login').send({ password: 'secret123' })).status).toBe(400);
      expect((await request(app).post('/auth/login').send({ phone: '01712345678' })).status).toBe(400);
    });

    it('still lets a legacy account (email, no phone) sign in with its email', async () => {
      const bcrypt = await import('bcryptjs');
      await User.create({
        name: 'Legacy',
        email: 'legacy@test.com',
        password: await bcrypt.hash('secret123', 4),
        role: 'PASSENGER',
      });
      const res = await request(app).post('/auth/login').send({ email: 'legacy@test.com', password: 'secret123' });
      expect(res.status).toBe(200);
      expect(res.body.user.phone).toBeNull();
    });
  });

  describe('Forgot / reset password', () => {
    const PHONE = '01712345678';
    const forgot = (phone: string) => request(app).post('/auth/forgot-password').send({ phone });
    const reset = (body: Record<string, unknown>) =>
      request(app).post('/auth/reset-password').send({ phone: PHONE, newPassword: 'brandnew123', ...body });
    const login = (password: string) => request(app).post('/auth/login').send({ phone: PHONE, password });

    beforeEach(async () => {
      await PasswordReset.destroy({ where: {} });
      await signup({ phone: PHONE });
    });

    it('resets the password with the emailed/SMS code, then the new password works and the old one does not', async () => {
      const { body } = await forgot(PHONE);
      expect(body.devCode).toMatch(/^\d{6}$/); // non-production returns the code

      const res = await reset({ code: body.devCode });
      expect(res.status).toBe(200);
      expect((await login('brandnew123')).status).toBe(200);
      expect((await login('secret123')).status).toBe(401);
    });

    it('accepts the phone in another format and the code in Bangla digits', async () => {
      const { body } = await forgot('+8801712345678');
      const banglaCode = body.devCode.replace(/\d/g, (d: string) => '০১২৩৪৫৬৭৮৯'[Number(d)]);
      const res = await reset({ phone: '০১৭১২৩৪৫৬৭৮', code: banglaCode });
      expect(res.status).toBe(200);
    });

    it('stores only a hash of the code', async () => {
      const { body } = await forgot(PHONE);
      const row = await PasswordReset.findOne();
      expect(row!.codeHash).not.toContain(body.devCode);
      expect(row!.codeHash).toHaveLength(64);
    });

    it('does not reveal whether an account exists', async () => {
      const known = await forgot(PHONE);
      const unknown = await forgot('01899999999');
      expect(unknown.status).toBe(200);
      expect(unknown.body.message).toBe(known.body.message);
      expect(unknown.body.devCode).toBeUndefined();
    });

    it('rejects a malformed phone number', async () => {
      expect((await forgot('123')).status).toBe(400);
    });

    it('a code can only be used once', async () => {
      const { body } = await forgot(PHONE);
      expect((await reset({ code: body.devCode })).status).toBe(200);
      expect((await reset({ code: body.devCode, newPassword: 'another123' })).status).toBe(400);
    });

    it('rejects a wrong code, and burns the code after 5 wrong guesses', async () => {
      const { body } = await forgot(PHONE);
      const wrong = body.devCode === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) expect((await reset({ code: wrong })).status).toBe(400);
      // even the correct code no longer works
      const res = await reset({ code: body.devCode });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid or expired code.');
      expect((await login('secret123')).status).toBe(200); // password unchanged
    });

    it('rejects an expired code', async () => {
      const { body } = await forgot(PHONE);
      await PasswordReset.update({ expiresAt: new Date(Date.now() - 1000) }, { where: {} });
      expect((await reset({ code: body.devCode })).status).toBe(400);
    });

    it('a weak new password is rejected without consuming the code', async () => {
      const { body } = await forgot(PHONE);
      expect((await reset({ code: body.devCode, newPassword: 'short' })).status).toBe(400);
      expect((await reset({ code: body.devCode })).status).toBe(200);
    });

    it('requesting again within the cooldown keeps the first code; a later request replaces it', async () => {
      const first = await forgot(PHONE);
      const again = await forgot(PHONE);
      expect(again.status).toBe(200);
      expect(again.body.devCode).toBeUndefined(); // cooldown: no new code issued
      expect(await PasswordReset.count()).toBe(1);

      // after the cooldown a new request replaces the old code
      await PasswordReset.update({ createdAt: new Date(Date.now() - 2 * 60 * 1000) }, { where: {}, silent: true });
      const later = await forgot(PHONE);
      expect(later.body.devCode).toMatch(/^\d{6}$/);
      expect(await PasswordReset.count()).toBe(1);
      if (later.body.devCode !== first.body.devCode) {
        expect((await reset({ code: first.body.devCode })).status).toBe(400);
      }
      expect((await reset({ code: later.body.devCode })).status).toBe(200);
    });

    it('never returns the code in production', async () => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      jest.resetModules();
      try {
        const { app: prodApp } = await import('../index');
        const res = await request(prodApp).post('/auth/forgot-password').send({ phone: PHONE });
        expect(res.status).toBe(200);
        expect(res.body.devCode).toBeUndefined();
      } finally {
        process.env.NODE_ENV = prev;
      }
    });
  });
});
