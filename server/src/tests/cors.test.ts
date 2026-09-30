/**
 * CORS: in production the API answers browsers only from the configured frontend address(es) (CORS_ORIGIN).
 * With nothing configured (local development) every origin is allowed.
 */
import request from 'supertest';

/** Loads a fresh copy of the app with CORS_ORIGIN set to `value` (undefined = not set). */
function appWith(value: string | undefined) {
  const previous = process.env.CORS_ORIGIN;
  if (value === undefined) delete process.env.CORS_ORIGIN;
  else process.env.CORS_ORIGIN = value;
  let loaded: any;
  jest.isolateModules(() => {
    loaded = require('../index').app;
  });
  if (previous === undefined) delete process.env.CORS_ORIGIN;
  else process.env.CORS_ORIGIN = previous;
  return loaded;
}

const allowOrigin = async (app: any, origin: string) =>
  (await request(app).get('/health').set('Origin', origin)).headers['access-control-allow-origin'];

describe('CORS_ORIGIN', () => {
  it('allows only the configured frontend origin', async () => {
    const app = appWith('https://tesla-pool.vercel.app');
    expect(await allowOrigin(app, 'https://tesla-pool.vercel.app')).toBe('https://tesla-pool.vercel.app');
    expect(await allowOrigin(app, 'https://evil.example')).toBeUndefined();
  });

  it('accepts several origins, and ignores spaces and a trailing slash', async () => {
    const app = appWith(' https://a.example/ , https://b.example ');
    expect(await allowOrigin(app, 'https://a.example')).toBe('https://a.example');
    expect(await allowOrigin(app, 'https://b.example')).toBe('https://b.example');
    expect(await allowOrigin(app, 'https://c.example')).toBeUndefined();
  });

  it('answers a browser preflight only for the allowed origin', async () => {
    const app = appWith('https://tesla-pool.vercel.app');
    const ok = await request(app).options('/ride-requests').set('Origin', 'https://tesla-pool.vercel.app').set('Access-Control-Request-Method', 'POST');
    expect(ok.headers['access-control-allow-origin']).toBe('https://tesla-pool.vercel.app');
    const bad = await request(app).options('/ride-requests').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows every origin when it is not set (local development)', async () => {
    const app = appWith(undefined);
    expect(await allowOrigin(app, 'http://localhost:3000')).toBe('*');
  });

  it('treats an empty value as not set', async () => {
    const app = appWith('  ');
    expect(await allowOrigin(app, 'http://localhost:3000')).toBe('*');
  });
});
