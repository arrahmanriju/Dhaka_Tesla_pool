/**
 * Every failure the API can return is JSON with a human-readable `error` (and, for validation, `fields`),
 * never an HTML page or a stack trace. The client shows that text, or a friendly fallback chosen by the
 * status when it is missing (client/src/lib/errors.ts), so the text has to be there and has to be safe.
 */
import request from 'supertest';
import { app } from '../index';
import { sequelize, User, Vehicle, RideRequest, RideEvent, PoolCheckpoint, WalletTransaction } from '../models';
import { asUser } from './helpers';

let driver: any;
let nusrat: any;
let rafiq: any;

beforeAll(async () => {
  await sequelize.sync({ force: true });
});
afterAll(async () => {
  await sequelize.close();
});
beforeEach(async () => {
  const mk = async (name: string, role: 'DRIVER' | 'PASSENGER', n: number) =>
    (await User.create({ name, phone: `0171600000${n}`, email: `${name.toLowerCase()}-err@test.com`, password: 'x', role })).toJSON();
  driver = await mk('Jashim', 'DRIVER', 0);
  nusrat = await mk('Nusrat', 'PASSENGER', 1);
  rafiq = await mk('Rafiq', 'PASSENGER', 2);
  await Vehicle.create({ driverId: driver.id, modelName: 'Bullet', seatCapacity: 3, licensePlate: 'DTP-0001' });
});
afterEach(async () => {
  await WalletTransaction.destroy({ where: {} });
  await PoolCheckpoint.destroy({ where: {} });
  await RideEvent.destroy({ where: {} });
  await RideRequest.destroy({ where: {} });
  await Vehicle.destroy({ where: {} });
  await User.destroy({ where: {} });
});

const MISSING = '00000000-0000-4000-8000-000000000000';

/** The shape the client relies on: JSON, a non-empty string `error`, and nothing that looks like a stack or SQL. */
function expectFriendlyJson(res: request.Response, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/application\/json/);
  expect(typeof res.body.error).toBe('string');
  expect(res.body.error.trim().length).toBeGreaterThan(3);
  expect(res.body.error).not.toMatch(/^HTTP \d+$/); // that placeholder is for a MISSING message
  expect(JSON.stringify(res.body)).not.toMatch(/SQLITE|Sequelize|\bat .*\.ts|node_modules|stack/i);
}

describe('error responses are JSON with a message the client can show', () => {
  it('401: no login', async () => {
    expectFriendlyJson(await request(app).get('/passenger/rides/active'), 401);
    expectFriendlyJson(await request(app).get('/passenger/wallet'), 401);
    expectFriendlyJson(await request(app).post('/ride-requests').send({}), 401);
  });

  it('403: wrong role, or someone else’s ride', async () => {
    expectFriendlyJson(await request(app).get('/passenger/wallet').set(asUser(driver.id, 'DRIVER')), 403);
    const created = await request(app).post('/ride-requests').set(asUser(nusrat.id)).send({ pickupZone: 'Mohakhali', destinationZone: 'Badda', seatCount: 1 });
    expectFriendlyJson(await request(app).get(`/passenger/rides/${created.body.rideRequest.id}`).set(asUser(rafiq.id)), 403);
  });

  it('404: a ride that does not exist', async () => {
    expectFriendlyJson(await request(app).get(`/passenger/rides/${MISSING}`).set(asUser(nusrat.id)), 404);
    expectFriendlyJson(await request(app).post(`/ride-requests/${MISSING}/decline`).set(asUser(driver.id, 'DRIVER')).send({}), 404);
    expectFriendlyJson(await request(app).patch(`/driver/rides/${MISSING}/complete`).send({ driverId: driver.id }), 404);
  });

  it('409: a state that no longer allows the action', async () => {
    const created = await request(app).post('/ride-requests').set(asUser(nusrat.id)).send({ pickupZone: 'Mohakhali', destinationZone: 'Badda', seatCount: 1 });
    const id = created.body.rideRequest.id;
    expectFriendlyJson(await request(app).post('/ride-requests').set(asUser(nusrat.id)).send({ pickupZone: 'Mohakhali', destinationZone: 'Badda', seatCount: 1 }), 409); // one active ride
    await request(app).post(`/ride-requests/${id}/accept`).send({ driverId: driver.id });
    expectFriendlyJson(await request(app).patch(`/driver/rides/${id}/complete`).send({ driverId: driver.id }), 409); // not started
    expectFriendlyJson(await request(app).patch(`/passenger/rides/${id}/cancel-in-transit`).set(asUser(nusrat.id)).send({ cancellationZone: 'Banani' }), 409);
  });

  it('400: invalid input names the field', async () => {
    const res = await request(app).post('/ride-requests').set(asUser(nusrat.id)).send({ pickupZone: 'Narnia', destinationZone: 'Badda', seatCount: 9, paymentMethod: 'gold' });
    expectFriendlyJson(res, 400);
    expect(Object.keys(res.body.fields)).toEqual(expect.arrayContaining(['pickupZone', 'seatCount', 'paymentMethod']));
    for (const message of Object.values(res.body.fields)) expect(typeof message).toBe('string');
  });

  it('400: a driver is required to accept', async () => {
    expectFriendlyJson(await request(app).post(`/ride-requests/${MISSING}/accept`).send({}), 400);
  });

  it('404: an unknown address is JSON, not an HTML page', async () => {
    const res = await request(app).get('/definitely/not/a/route');
    expectFriendlyJson(res, 404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('400: a request body that is not valid JSON is JSON, not an HTML page', async () => {
    const res = await request(app).post('/auth/login').set('Content-Type', 'application/json').send('{bad json');
    expectFriendlyJson(res, 400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('413: an oversized body says the upload is too large, so the client can tell the user', async () => {
    const res = await request(app).post('/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ blob: 'x'.repeat(200_000) }));
    expectFriendlyJson(res, 413);
    expect(res.body.code).toBe('TOO_LARGE');
  });
});
