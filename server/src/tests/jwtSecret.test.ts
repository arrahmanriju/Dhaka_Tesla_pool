/**
 * There is no built-in JWT secret. The secret signs every login token and the password-reset code hashes, so:
 *   - the server refuses to start without a strong JWT_SECRET (and says how to make one);
 *   - a token signed with the old public default ('super-secret-mvp-key') is worthless;
 *   - the password-reset HMAC uses the very same secret, so it has no separate weak default either.
 */
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../index';
import { sequelize, User, PasswordReset } from '../models';
import { KNOWN_INSECURE_SECRETS, MIN_JWT_SECRET_LENGTH, getJwtSecret, requireJwtSecret } from '../config/jwtSecret';

const OLD_DEFAULT = 'super-secret-mvp-key';
const STRONG = crypto.randomBytes(32).toString('base64'); // what `openssl rand -base64 32` makes

describe('requireJwtSecret', () => {
  it('returns a strong secret unchanged', () => {
    expect(requireJwtSecret({ JWT_SECRET: STRONG } as any)).toBe(STRONG);
    expect(STRONG.length).toBeGreaterThanOrEqual(MIN_JWT_SECRET_LENGTH);
  });

  it('refuses a missing, empty or blank secret, and says how to generate one', () => {
    for (const value of [undefined, '', '   ']) {
      expect(() => requireJwtSecret({ JWT_SECRET: value } as any)).toThrow(/JWT_SECRET is not set/);
    }
    expect(() => requireJwtSecret({} as any)).toThrow(/openssl rand -base64 32/);
  });

  it('refuses the old public default, wherever it comes from', () => {
    expect(KNOWN_INSECURE_SECRETS).toContain(OLD_DEFAULT);
    expect(() => requireJwtSecret({ JWT_SECRET: OLD_DEFAULT } as any)).toThrow(/public, known value/);
  });

  it('refuses a secret that is too short to resist guessing', () => {
    expect(() => requireJwtSecret({ JWT_SECRET: 'x'.repeat(MIN_JWT_SECRET_LENGTH - 1) } as any)).toThrow(/too short/);
    expect(requireJwtSecret({ JWT_SECRET: 'x'.repeat(MIN_JWT_SECRET_LENGTH) } as any)).toHaveLength(MIN_JWT_SECRET_LENGTH);
  });

  it('the suites run on a throwaway test secret, never the old default', () => {
    expect(getJwtSecret()).not.toBe(OLD_DEFAULT);
  });
});

describe('the server process', () => {
  const serverDir = path.resolve(__dirname, '..', '..');
  /** Starts the real server entry point with the given environment and returns how it ended. */
  const start = (env: Record<string, string | undefined>) => {
    const full: NodeJS.ProcessEnv = {
      ...process.env,
      // never let a developer's own server/.env supply the secret to the child process
      DOTENV_CONFIG_PATH: path.join(os.tmpdir(), 'no-such-dotenv-file'),
      DB_STORAGE_PATH: path.join(os.tmpdir(), `jwt-secret-test-${process.pid}.sqlite`),
      PORT: '3979',
      ...env,
    };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete full[k];
    return spawnSync('npx', ['tsx', 'src/index.ts'], { cwd: serverDir, env: full, encoding: 'utf8', shell: true, timeout: 60_000 });
  };

  it('refuses to start without JWT_SECRET: exits with an error, says why and how to fix it, never listens', () => {
    const result = start({ JWT_SECRET: undefined });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(1);
    expect(output).toContain('JWT_SECRET is not set');
    expect(output).toContain('openssl rand -base64 32');
    expect(output).not.toContain('Server is running');
  }, 90_000);

  it('refuses to start with the old public default', () => {
    const result = start({ JWT_SECRET: OLD_DEFAULT });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('public, known value');
  }, 90_000);
});

describe('tokens and password-reset codes', () => {
  beforeAll(async () => {
    await sequelize.sync({ force: true });
  });
  afterAll(async () => {
    await sequelize.close();
  });

  const PHONE = '01755500001';
  let userId: string;
  beforeEach(async () => {
    await PasswordReset.destroy({ where: {} });
    await User.destroy({ where: {} });
    const res = await request(app).post('/auth/signup').send({ name: 'Secret Tester', phone: PHONE, password: 'Password123', role: 'PASSENGER' });
    expect(res.status).toBe(201);
    userId = res.body.user.id;
  });

  it('a token signed with the old public default is rejected: it can no longer forge a login', async () => {
    const forged = jwt.sign({ id: userId, role: 'PASSENGER', name: 'Secret Tester' }, OLD_DEFAULT, { expiresIn: '1h' });
    const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).not.toBe(200);
    expect(res.body.user).toBeUndefined();

    // while a token signed with the real secret works
    const genuine = jwt.sign({ id: userId, role: 'PASSENGER', name: 'Secret Tester' }, getJwtSecret(), { expiresIn: '1h' });
    expect((await request(app).get('/auth/me').set('Authorization', `Bearer ${genuine}`)).status).toBe(200);
  });

  it('login tokens are signed with the configured secret, and only that one verifies them', async () => {
    const login = await request(app).post('/auth/login').send({ phone: PHONE, password: 'Password123' });
    expect(login.status).toBe(200);
    expect(() => jwt.verify(login.body.token, getJwtSecret())).not.toThrow();
    expect(() => jwt.verify(login.body.token, OLD_DEFAULT)).toThrow();
  });

  it('the password-reset code hash uses the SAME secret: an HMAC under the configured secret, not under the old default', async () => {
    const forgot = await request(app).post('/auth/forgot-password').send({ phone: PHONE });
    expect(forgot.status).toBe(200);
    const code = forgot.body.devCode as string; // non-production servers return the code so the flow can be tried
    expect(code).toMatch(/^\d{6}$/);

    const stored = await PasswordReset.findOne({ where: { userId } });
    const hmac = (secret: string) => crypto.createHmac('sha256', secret).update(code).digest('hex');
    expect(stored!.codeHash).toBe(hmac(getJwtSecret()));
    expect(stored!.codeHash).not.toBe(hmac(OLD_DEFAULT));
  });

  it('the reset flow still works end to end with the configured secret', async () => {
    const { body } = await request(app).post('/auth/forgot-password').send({ phone: PHONE });
    const reset = await request(app).post('/auth/reset-password').send({ phone: PHONE, code: body.devCode, newPassword: 'BrandNew12345' });
    expect(reset.status).toBe(200);
    expect((await request(app).post('/auth/login').send({ phone: PHONE, password: 'BrandNew12345' })).status).toBe(200);
  });
});
