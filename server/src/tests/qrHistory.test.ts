/**
 * A finished street ride (QR) leaves the Street Ride page and appears in the passenger's ride history,
 * next to their app rides, in one list sorted by when each trip ended (newest first).
 *
 * The trips below use the QR worked example (see qrRides.test.ts): Nusrat Uttara → Dhanmondi pays ৳365,
 * Rafiq Uttara → Mirpur pays ৳225, and the driver's bonus is ৳10 for the second passenger.
 */
import request from 'supertest';
import { app } from '../index';
import {
  sequelize,
  User,
  Vehicle,
  RideRequest,
  RideEvent,
  PoolCheckpoint,
  WalletTransaction,
  QRRideSession,
  QRRideParticipant,
  DriverBonus,
  DriverProfile,
} from '../models';
import { ensureOneActiveRideIndex, ensureOneOpenQRSessionIndex } from '../migrations';
import { closeStaleSessions } from '../services/qrRides';
import { asUser } from './helpers';

let jashim: any;
let nusrat: any;
let rafiq: any;
let shirin: any;
let bullet: any;
let profile: any;
let nid = 1000000100;

const UTTARA_TO_DHANMONDI = { pickupZone: 'Uttara', destinationZone: 'Dhanmondi' };
const UTTARA_TO_MIRPUR = { pickupZone: 'Uttara', destinationZone: 'Mirpur' };

const qrJoin = (who: any, body: Record<string, unknown>) =>
  request(app).post('/qr/join').set(asUser(who.id)).send({ vehicleCode: bullet.vehicleCode, ...body });
const qrArrived = (who: any, sessionId: string) => request(app).post(`/qr/sessions/${sessionId}/arrived`).set(asUser(who.id)).send({});
const mine = (who: any) => request(app).get('/qr/sessions/mine').set(asUser(who.id));
const history = (who: any) => request(app).get('/passenger/rides/history').set(asUser(who.id));

/** An app ride: request, driver accepts, arrives, starts, completes. Returns the ride id. */
async function appRide(who: any, trip = { pickupZone: 'Mohakhali', destinationZone: 'Badda' }) {
  const created = await request(app).post('/ride-requests').set(asUser(who.id)).send({ seatCount: 1, ...trip });
  expect(created.status).toBe(201);
  const id = created.body.rideRequest.id as string;
  await request(app).post(`/ride-requests/${id}/accept`).send({ driverId: jashim.id });
  for (const step of ['arrive', 'start', 'complete']) {
    expect((await request(app).patch(`/driver/rides/${id}/${step}`).send({ driverId: jashim.id })).status).toBe(200);
  }
  return id;
}

/** A street trip for `who` (Uttara → Dhanmondi) shared with Rafiq, finished by both. Returns the session id. */
async function streetTripWithRafiq(who: any) {
  const a = await qrJoin(who, UTTARA_TO_DHANMONDI);
  await qrJoin(rafiq, UTTARA_TO_MIRPUR);
  const id = a.body.session.id as string;
  await qrArrived(rafiq, id);
  await qrArrived(who, id);
  return id;
}

/** Pins the end time of a trip so the sort order does not depend on how fast the test runs. */
const endedAt = async (kind: 'APP' | 'QR', id: string, iso: string) => {
  // Sequelize's SQLite stores dates as "YYYY-MM-DD HH:MM:SS.SSS +00:00"
  const stored = iso.replace('T', ' ').replace('Z', ' +00:00');
  if (kind === 'APP') await sequelize.query('UPDATE `RideRequests` SET `updatedAt` = ? WHERE `id` = ?', { replacements: [stored, id] });
  else await sequelize.query('UPDATE `QRRideParticipants` SET `exitedAt` = ? WHERE `id` = ?', { replacements: [stored, id] });
};
const participantId = async (sessionId: string, who: any) =>
  (await QRRideParticipant.findOne({ where: { sessionId, passengerId: who.id } }))!.id;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  await ensureOneActiveRideIndex();
  await ensureOneOpenQRSessionIndex();
});
afterAll(async () => {
  await sequelize.close();
});

describe('street rides in the ride history', () => {
  beforeEach(async () => {
    const mk = async (name: string, role: 'DRIVER' | 'PASSENGER', n: number) =>
      (await User.create({ name: `${name} Test`, phone: `0171800000${n}`, email: `${name.toLowerCase()}-qh@test.com`, password: 'x', role })).toJSON();
    jashim = await mk('Jashim', 'DRIVER', 0);
    nusrat = await mk('Nusrat', 'PASSENGER', 1);
    rafiq = await mk('Rafiq', 'PASSENGER', 2);
    shirin = await mk('Shirin', 'PASSENGER', 3);
    profile = await DriverProfile.create({ userId: jashim.id, homeZone: 'Banani', nid: String(++nid) });
    bullet = (await Vehicle.create({ driverId: jashim.id, modelName: 'Bullet', seatCapacity: 3, licensePlate: profile.driverCode })).toJSON();
  });
  afterEach(async () => {
    await DriverBonus.destroy({ where: {} });
    await QRRideParticipant.destroy({ where: {} });
    await QRRideSession.destroy({ where: {} });
    await WalletTransaction.destroy({ where: {} });
    await PoolCheckpoint.destroy({ where: {} });
    await RideEvent.destroy({ where: {} });
    await RideRequest.destroy({ where: {} });
    await Vehicle.destroy({ where: {} });
    await DriverProfile.destroy({ where: {} });
    await User.destroy({ where: {} });
  });

  // ─────────────────────────── the Street Ride page resets ───────────────────────────
  describe('the Street Ride page', () => {
    it('shows a ride only while the passenger is on it, then goes back to "enter a code"', async () => {
      expect((await mine(nusrat)).body.session).toBeNull(); // nothing yet
      const a = await qrJoin(nusrat, UTTARA_TO_DHANMONDI);
      expect((await mine(nusrat)).body.session).toMatchObject({ id: a.body.session.id, status: 'OPEN', you: { status: 'RIDING' } });

      // Nusrat is alone: arriving closes the session, and the page has nothing left to show
      const done = await qrArrived(nusrat, a.body.session.id);
      expect(done.body.session.status).toBe('CLOSED'); // (the arrive call still returns it once, for the caller)
      expect((await mine(nusrat)).body.session).toBeNull();
    });

    it('resets as soon as the passenger’s OWN trip ends, even while others are still riding', async () => {
      const a = await qrJoin(nusrat, UTTARA_TO_DHANMONDI);
      await qrJoin(rafiq, UTTARA_TO_MIRPUR);
      const id = a.body.session.id;
      await qrArrived(rafiq, id);

      expect((await QRRideSession.findByPk(id))!.status).toBe('OPEN'); // Nusrat is still riding
      expect((await mine(rafiq)).body.session).toBeNull(); // Rafiq's page is back to "enter a code"
      expect((await mine(nusrat)).body.session).toMatchObject({ status: 'OPEN', you: { status: 'RIDING' } });
    });

    it('resets when the session is closed automatically after the time limit', async () => {
      const a = await qrJoin(nusrat, UTTARA_TO_DHANMONDI);
      await QRRideSession.update({ openedAt: new Date(Date.now() - 100 * 60_000) }, { where: { id: a.body.session.id } });
      expect((await mine(nusrat)).body.session).toBeNull();
      expect(await QRRideSession.findByPk(a.body.session.id)).toMatchObject({ status: 'CLOSED', closeReason: 'TIMEOUT' });
    });

    it('is ready for a new ride straight away', async () => {
      const first = await qrJoin(nusrat, UTTARA_TO_DHANMONDI);
      await qrArrived(nusrat, first.body.session.id);
      const second = await qrJoin(nusrat, UTTARA_TO_MIRPUR);
      expect(second.status).toBe(201);
      expect(second.body.session.id).not.toBe(first.body.session.id);
      expect((await mine(nusrat)).body.session.id).toBe(second.body.session.id);
    });

    it('a passenger who already finished in a still-open ride gets a clear message, not an error, if they scan it again', async () => {
      const a = await qrJoin(nusrat, UTTARA_TO_DHANMONDI);
      await qrJoin(rafiq, UTTARA_TO_MIRPUR);
      await qrArrived(rafiq, a.body.session.id);
      const again = await qrJoin(rafiq, UTTARA_TO_MIRPUR);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('ALREADY_IN_THIS_RIDE');
      expect(again.body.error).toMatch(/already finished/i);
      expect(await DriverBonus.count()).toBe(1); // no second bonus
    });
  });

  // ─────────────────────────── the history ───────────────────────────
  describe('the ride history', () => {
    it('a passenger with both app and street rides sees BOTH, in one list, newest first', async () => {
      const app1 = await appRide(nusrat);
      const qr1 = await streetTripWithRafiq(nusrat);
      const app2 = await appRide(nusrat, { pickupZone: 'Gulshan', destinationZone: 'Banani' });
      // a second street trip that nobody closed
      const a = await qrJoin(nusrat, UTTARA_TO_MIRPUR);
      const qr2 = a.body.session.id as string;
      await closeStaleSessions(new Date(Date.now() + 100 * 60_000));

      // Pin the end times: app1 Jan 1, street 1 Jan 2, app2 Jan 3, street 2 Jan 4
      await endedAt('APP', app1, '2025-01-01T10:00:00.000Z');
      await endedAt('QR', await participantId(qr1, nusrat), '2025-01-02T10:00:00.000Z');
      await endedAt('APP', app2, '2025-01-03T10:00:00.000Z');
      await endedAt('QR', await participantId(qr2, nusrat), '2025-01-04T10:00:00.000Z');

      const res = await history(nusrat);
      expect(res.status).toBe(200);
      expect(res.body.rides.map((r: any) => [r.source, r.id])).toEqual([
        ['QR', await participantId(qr2, nusrat)],
        ['APP', app2],
        ['QR', await participantId(qr1, nusrat)],
        ['APP', app1],
      ]);
      const dates = res.body.rides.map((r: any) => new Date(r.updatedAt).getTime());
      expect(dates).toEqual([...dates].sort((x: number, y: number) => y - x));
      // every row says which flow it came from, and only street rows carry `qr`
      for (const r of res.body.rides) expect(r.source === 'QR').toBe('qr' in r);
    });

    it('a street trip shows its zones, fare, payment status, driver bonus and timestamps', async () => {
      const id = await streetTripWithRafiq(nusrat);
      const row = (await history(nusrat)).body.rides[0];

      expect(row).toMatchObject({
        source: 'QR',
        status: 'COMPLETED',
        pickupZone: 'Uttara',
        destinationZone: 'Dhanmondi',
        seatCount: 1,
        baseFare: 420,
        estimatedFare: 365, // the final fare, like an app ride once it has ended
        poolDiscount: 55,
        fareFinal: true,
        paymentMethod: 'cash',
        paymentStatus: 'CASH_DUE',
        paymentAmount: 365,
        cancellationZone: null,
        qr: {
          sessionId: id,
          passengerNumber: 1,
          autoCompleted: false,
          driverBonus: 0, // Nusrat was the first passenger: her joining earned no bonus
          sessionStatus: 'CLOSED',
          sessionCloseReason: 'ALL_ARRIVED',
          vehicleCode: bullet.vehicleCode,
          vehicleNickname: 'Bullet',
        },
      });
      // timestamps: when she joined, when her own trip ended, and when the whole ride closed
      const p = (await QRRideParticipant.findOne({ where: { sessionId: id, passengerId: nusrat.id } }))!;
      expect(new Date(row.createdAt).getTime()).toBe(p.joinedAt.getTime());
      expect(new Date(row.updatedAt).getTime()).toBe(p.exitedAt!.getTime());
      expect(new Date(row.qr.joinedAt).getTime()).toBe(p.joinedAt.getTime());
      expect(new Date(row.qr.exitedAt).getTime()).toBe(p.exitedAt!.getTime());
      expect(row.qr.sessionClosedAt).toBeTruthy();
      expect(new Date(row.qr.sessionClosedAt).getTime()).toBeGreaterThanOrEqual(new Date(row.updatedAt).getTime());
    });

    it('the second passenger’s row records the driver bonus their joining earned', async () => {
      await streetTripWithRafiq(nusrat);
      const row = (await history(rafiq)).body.rides[0];
      expect(row).toMatchObject({ source: 'QR', estimatedFare: 225, poolDiscount: 55, paymentAmount: 225, qr: { passengerNumber: 2, driverBonus: 10 } });
    });

    it('a trip that timed out is flagged as ended automatically', async () => {
      const a = await qrJoin(nusrat, UTTARA_TO_DHANMONDI);
      await QRRideSession.update({ openedAt: new Date(Date.now() - 120 * 60_000) }, { where: { id: a.body.session.id } });
      const row = (await history(nusrat)).body.rides[0]; // reading the history closes the stale ride first
      expect(row).toMatchObject({ source: 'QR', estimatedFare: 420, paymentStatus: 'CASH_DUE', qr: { autoCompleted: true, sessionCloseReason: 'TIMEOUT' } });
    });

    it('a trip still in progress is not in the history yet', async () => {
      await qrJoin(nusrat, UTTARA_TO_DHANMONDI);
      expect((await history(nusrat)).body.rides).toEqual([]);
    });

    it('a trip appears as soon as the passenger’s OWN leg is done, even if the ride is still open for others', async () => {
      const a = await qrJoin(nusrat, UTTARA_TO_DHANMONDI);
      await qrJoin(rafiq, UTTARA_TO_MIRPUR);
      await qrArrived(rafiq, a.body.session.id);
      expect((await history(rafiq)).body.rides).toHaveLength(1);
      expect((await history(rafiq)).body.rides[0].qr.sessionStatus).toBe('OPEN');
      expect((await history(nusrat)).body.rides).toEqual([]); // still riding
    });

    it('app-only history is unchanged apart from the new source label', async () => {
      const id = await appRide(nusrat);
      const rows = (await history(nusrat)).body.rides;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source: 'APP', id, status: 'COMPLETED', estimatedFare: 180, fareFinal: true, paymentStatus: 'CASH_DUE' });
      expect(rows[0]).not.toHaveProperty('qr');
      expect(Array.isArray(rows[0].timeline)).toBe(true);
    });

    it('a passenger with no trips has an empty history, and never sees someone else’s trips', async () => {
      await streetTripWithRafiq(nusrat);
      expect((await history(shirin)).body.rides).toEqual([]);
      // Nusrat's row reveals nothing about Rafiq: no id, name, phone, zone or fare
      const text = JSON.stringify((await history(nusrat)).body);
      expect(text).not.toContain(rafiq.id);
      expect(text).not.toContain(rafiq.phone);
      expect(text).not.toContain('Rafiq');
      expect(text).not.toContain('Mirpur');
      expect(text).not.toContain('225');
    });

    it('needs a passenger login', async () => {
      expect((await request(app).get('/passenger/rides/history')).status).toBe(401);
      expect((await request(app).get('/passenger/rides/history').set(asUser(jashim.id, 'DRIVER'))).status).toBe(403);
    });

    it('does not change what the driver sees of app rides', async () => {
      await appRide(nusrat);
      await streetTripWithRafiq(nusrat);
      const driverHistory = await request(app).get(`/driver/rides/history?driverId=${jashim.id}`);
      expect(driverHistory.body.rides).toHaveLength(1); // only the app ride: street trips are not app rides
    });
  });
});
