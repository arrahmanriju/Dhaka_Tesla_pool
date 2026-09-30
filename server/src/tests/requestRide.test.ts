/**
 * Request Ride — server-side rules for the passenger "Request a ride" form.
 *
 * Uses the same passengers as the seed data:
 *   Nusrat: Banani → Mohakhali,  1 seat, sharing on
 *   Rafiq:  Banani → Gulshan 1,  1 seat, sharing on
 *
 * Fare arithmetic (base = 100 + km × 20 × seats; pooled = base × 70% with 2, × 55% with 3,
 * rounded to the nearest ৳5):
 *   Banani → Mohakhali  2 km → base ৳140 · with 2: ৳100 · with 3: ৳75
 *   Banani → Gulshan 1  3 km → base ৳160 · with 2: ৳110 · with 3: ৳90
 */
import request from 'supertest';
import { app } from '../index';
import { sequelize, User, Vehicle, RideRequest } from '../models';
import { ensureOneActiveRideIndex } from '../migrations';
import { asUser } from './helpers';

const NUSRAT_RIDE = { pickupZone: 'Banani', destinationZone: 'Mohakhali', seatCount: 1, allowSharing: true };
const RAFIQ_RIDE = { pickupZone: 'Banani', destinationZone: 'Gulshan 1', seatCount: 1, allowSharing: true };

let nusrat: any;
let rafiq: any;
let driver: any;

const requestRide = (user: any, body: Record<string, unknown>) =>
  request(app).post('/ride-requests').set(asUser(user.id)).send(body);

describe('Request ride', () => {
  beforeAll(async () => {
    await sequelize.sync({ force: true });
    await ensureOneActiveRideIndex();
  });

  afterAll(async () => {
    await sequelize.close();
  });

  beforeEach(async () => {
    nusrat = (await User.create({ name: 'Nusrat', phone: '01711000001', email: 'nusrat@test.com', password: 'x', role: 'PASSENGER' })).toJSON();
    rafiq = (await User.create({ name: 'Rafiq', phone: '01711000002', email: 'rafiq@test.com', password: 'x', role: 'PASSENGER' })).toJSON();
    driver = (await User.create({ name: 'Jashim', phone: '01711000000', email: 'jashim@test.com', password: 'x', role: 'DRIVER' })).toJSON();
    await Vehicle.create({ driverId: driver.id, modelName: 'Bullet', seatCapacity: 3, licensePlate: 'DTP-0001' });
  });

  afterEach(async () => {
    await RideRequest.destroy({ where: {} });
    await Vehicle.destroy({ where: {} });
    await User.destroy({ where: {} });
  });

  describe('seed scenarios', () => {
    it('Nusrat (Banani → Mohakhali, 1 seat, sharing on) gets a REQUESTED ride at the solo fare', async () => {
      const res = await requestRide(nusrat, NUSRAT_RIDE);
      expect(res.status).toBe(201);
      expect(res.body.rideRequest).toMatchObject({
        passengerId: nusrat.id,
        pickupZone: 'Banani',
        destinationZone: 'Mohakhali',
        seatCount: 1,
        allowSharing: true,
        status: 'REQUESTED',
        estimatedFare: 140,
        poolDiscount: 0,
      });
    });

    it('Rafiq (Banani → Gulshan 1, 1 seat, sharing on) gets a REQUESTED ride at the solo fare', async () => {
      const res = await requestRide(rafiq, RAFIQ_RIDE);
      expect(res.status).toBe(201);
      expect(res.body.rideRequest).toMatchObject({ status: 'REQUESTED', estimatedFare: 160, allowSharing: true });
    });

    it('both can be requested at the same time (one active ride each)', async () => {
      expect((await requestRide(nusrat, NUSRAT_RIDE)).status).toBe(201);
      expect((await requestRide(rafiq, RAFIQ_RIDE)).status).toBe(201);
    });
  });

  describe('fare estimate', () => {
    const estimate = (user: any, q: Record<string, string | number | boolean>) =>
      request(app).get('/ride-requests/estimate').set(asUser(user.id)).query(q);

    it('matches the fare that is stored when the ride is created', async () => {
      const est = await estimate(nusrat, NUSRAT_RIDE);
      expect(est.status).toBe(200);
      const created = await requestRide(nusrat, NUSRAT_RIDE);
      expect(est.body.fare).toBe(created.body.rideRequest.estimatedFare);
      expect(est.body).toMatchObject({
        baseFare: 140,
        fare: 140,
        poolFare: 100,
        tiers: [
          { passengers: 2, ratePercent: 70, fare: 100 },
          { passengers: 3, ratePercent: 55, fare: 75 },
        ],
      });
    });

    it('a private ride has no pool fare and no tiers (it always costs the full fare)', async () => {
      const est = await estimate(rafiq, { ...RAFIQ_RIDE, allowSharing: false });
      expect(est.body).toMatchObject({ fare: 160, poolFare: null, tiers: [] });
    });

    it('changes with zones and seats', async () => {
      // 100 + 2 km × 20 × 3 seats = ৳220. Three seats fill the whole car, so nobody can join: no tiers.
      const est = await estimate(nusrat, { ...NUSRAT_RIDE, seatCount: 3 });
      expect(est.body.fare).toBe(220);
      expect(est.body).toMatchObject({ poolFare: null, tiers: [] });
    });

    it('sharing defaults to on when omitted', async () => {
      const est = await estimate(nusrat, { pickupZone: 'Banani', destinationZone: 'Mohakhali', seatCount: 1 });
      expect(est.body.poolFare).toBe(100);
    });

    it('rejects the same invalid input as the create endpoint', async () => {
      expect((await estimate(nusrat, { ...NUSRAT_RIDE, destinationZone: 'Banani' })).status).toBe(400);
      expect((await estimate(nusrat, { ...NUSRAT_RIDE, seatCount: 4 })).status).toBe(400);
      expect((await estimate(nusrat, { ...NUSRAT_RIDE, seatCount: 'abc' })).status).toBe(400);
    });

    it('requires login', async () => {
      const res = await request(app).get('/ride-requests/estimate').query(NUSRAT_RIDE);
      expect(res.status).toBe(401);
    });

    it('does not create a ride', async () => {
      await estimate(nusrat, NUSRAT_RIDE);
      expect(await RideRequest.count()).toBe(0);
    });
  });

  describe('zones', () => {
    it('lists the zones the server accepts, including Mohakhali and Gulshan 1', async () => {
      const res = await request(app).get('/ride-requests/zones').set(asUser(nusrat.id));
      expect(res.status).toBe(200);
      expect(res.body.zones).toEqual(expect.arrayContaining(['Banani', 'Mohakhali', 'Gulshan 1']));
      expect(res.body).toMatchObject({ minSeats: 1, maxSeats: 3 });
    });
  });

  describe('validation', () => {
    const expectRejected = async (body: Record<string, unknown>, field: string) => {
      const res = await requestRide(nusrat, body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION');
      expect(res.body.fields).toHaveProperty(field);
      expect(await RideRequest.count()).toBe(0);
    };

    it('requires a pickup zone', () => expectRejected({ ...NUSRAT_RIDE, pickupZone: undefined }, 'pickupZone'));
    it('requires a destination zone', () => expectRejected({ ...NUSRAT_RIDE, destinationZone: undefined }, 'destinationZone'));
    it('rejects a zone that is not in the list', () => expectRejected({ ...NUSRAT_RIDE, pickupZone: 'Atlantis' }, 'pickupZone'));
    it('rejects pickup = destination', () => expectRejected({ ...NUSRAT_RIDE, destinationZone: 'Banani' }, 'destinationZone'));
    it('rejects 0 seats', () => expectRejected({ ...NUSRAT_RIDE, seatCount: 0 }, 'seatCount'));
    it('rejects 4 seats (more than the maximum of 3)', () => expectRejected({ ...NUSRAT_RIDE, seatCount: 4 }, 'seatCount'));
    it('rejects a fractional seat count', () => expectRejected({ ...NUSRAT_RIDE, seatCount: 1.5 }, 'seatCount'));
    it('rejects seats sent as text', () => expectRejected({ ...NUSRAT_RIDE, seatCount: '2' }, 'seatCount'));
    it('rejects a missing seat count', () => expectRejected({ ...NUSRAT_RIDE, seatCount: undefined }, 'seatCount'));
    it('rejects allowSharing that is not a boolean', () => expectRejected({ ...NUSRAT_RIDE, allowSharing: 'yes' }, 'allowSharing'));

    it('accepts 1, 2 and 3 seats', async () => {
      for (const [i, seatCount] of [1, 2, 3].entries()) {
        const p = (await User.create({ name: `P${i}`, phone: `0172000000${i}`, email: `p${i}@test.com`, password: 'x', role: 'PASSENGER' })).toJSON() as any;
        expect((await requestRide(p, { ...NUSRAT_RIDE, seatCount })).status).toBe(201);
      }
    });

    it('sharing is ON when allowSharing is omitted', async () => {
      const res = await requestRide(nusrat, { pickupZone: 'Banani', destinationZone: 'Mohakhali', seatCount: 1 });
      expect(res.status).toBe(201);
      expect(res.body.rideRequest.allowSharing).toBe(true);
    });

    it('stores allowSharing: false as a private ride', async () => {
      const res = await requestRide(nusrat, { ...NUSRAT_RIDE, allowSharing: false });
      expect(res.body.rideRequest.allowSharing).toBe(false);
      expect((await RideRequest.findByPk(res.body.rideRequest.id))!.allowSharing).toBe(false);
    });
  });

  describe('who is asking', () => {
    it('requires login', async () => {
      const res = await request(app).post('/ride-requests').send({ passengerId: nusrat.id, ...NUSRAT_RIDE });
      expect(res.status).toBe(401);
      expect(await RideRequest.count()).toBe(0);
    });

    it('ignores a passengerId in the body: the ride belongs to the logged-in passenger', async () => {
      const res = await request(app)
        .post('/ride-requests')
        .set(asUser(nusrat.id))
        .send({ ...NUSRAT_RIDE, passengerId: rafiq.id });
      expect(res.status).toBe(201);
      expect(res.body.rideRequest.passengerId).toBe(nusrat.id);
    });

    it('rejects a driver', async () => {
      const res = await request(app).post('/ride-requests').set(asUser(driver.id, 'DRIVER')).send(NUSRAT_RIDE);
      expect(res.status).toBe(403);
    });

    it('rejects a token for a user that no longer exists', async () => {
      const res = await request(app).post('/ride-requests').set(asUser('00000000-0000-4000-8000-000000000000')).send(NUSRAT_RIDE);
      expect(res.status).toBe(401);
    });
  });

  describe('one active ride at a time', () => {
    it('rejects a second request while one is REQUESTED', async () => {
      await requestRide(nusrat, NUSRAT_RIDE);
      const second = await requestRide(nusrat, RAFIQ_RIDE);
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('ACTIVE_RIDE_EXISTS');
      expect(await RideRequest.count({ where: { passengerId: nusrat.id } })).toBe(1);
    });

    it.each(['MATCHED', 'DRIVER_ARRIVED', 'STARTED'])('rejects a second request while one is %s', async (status) => {
      const first = await requestRide(nusrat, NUSRAT_RIDE);
      await RideRequest.update({ status }, { where: { id: first.body.rideRequest.id } });
      expect((await requestRide(nusrat, RAFIQ_RIDE)).status).toBe(409);
    });

    it.each(['COMPLETED', 'CANCELLED'])('allows a new request once the last one is %s', async (status) => {
      const first = await requestRide(nusrat, NUSRAT_RIDE);
      await RideRequest.update({ status }, { where: { id: first.body.rideRequest.id } });
      expect((await requestRide(nusrat, RAFIQ_RIDE)).status).toBe(201);
    });

    it('allows a new request after the passenger cancels through the API', async () => {
      const first = await requestRide(nusrat, NUSRAT_RIDE);
      const cancel = await request(app)
        .patch(`/passenger/rides/${first.body.rideRequest.id}/cancel`).set(asUser(nusrat.id))
        .send({ passengerId: nusrat.id });
      expect(cancel.status).toBe(200);
      expect((await requestRide(nusrat, NUSRAT_RIDE)).status).toBe(201);
    });

    it("does not block a different passenger", async () => {
      await requestRide(nusrat, NUSRAT_RIDE);
      expect((await requestRide(rafiq, NUSRAT_RIDE)).status).toBe(201);
    });

    it('a double submit creates exactly one ride', async () => {
      const results = await Promise.all([requestRide(nusrat, NUSRAT_RIDE), requestRide(nusrat, NUSRAT_RIDE)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await RideRequest.count({ where: { passengerId: nusrat.id } })).toBe(1);
    });

    it('the database itself refuses a second active ride (index backstop)', async () => {
      await requestRide(nusrat, NUSRAT_RIDE);
      await expect(
        RideRequest.create({ passengerId: nusrat.id, pickupZone: 'Banani', destinationZone: 'Gulshan', seatCount: 1 }),
      ).rejects.toThrow();
    });
  });

  describe('private rides are never pooled', () => {
    const accept = (rideId: string) =>
      request(app).post(`/ride-requests/${rideId}/accept`).send({ driverId: driver.id });
    const pending = () => request(app).get(`/ride-requests/pending?driverId=${driver.id}`);

    it('shared rides on the same route still pool and split the fare', async () => {
      const a = await requestRide(nusrat, NUSRAT_RIDE);
      const b = await requestRide(rafiq, { ...NUSRAT_RIDE });
      expect((await accept(a.body.rideRequest.id)).status).toBe(200);
      expect((await accept(b.body.rideRequest.id)).status).toBe(200);
      expect((await RideRequest.findByPk(a.body.rideRequest.id))!.estimatedFare).toBe(100); // 70% of ৳140
    });

    it('a private request cannot join a vehicle that already has a passenger', async () => {
      const shared = await requestRide(nusrat, NUSRAT_RIDE);
      const priv = await requestRide(rafiq, { ...NUSRAT_RIDE, allowSharing: false });
      expect((await accept(shared.body.rideRequest.id)).status).toBe(200);

      const res = await accept(priv.body.rideRequest.id);
      expect(res.status).toBe(409);
      expect((await RideRequest.findByPk(priv.body.rideRequest.id))!.status).toBe('REQUESTED');
    });

    it('a vehicle carrying a private ride takes nobody else', async () => {
      const priv = await requestRide(nusrat, { ...NUSRAT_RIDE, allowSharing: false });
      const shared = await requestRide(rafiq, NUSRAT_RIDE);
      expect((await accept(priv.body.rideRequest.id)).status).toBe(200);

      expect((await accept(shared.body.rideRequest.id)).status).toBe(409);
      expect((await pending()).body.requests).toEqual([]);
    });

    it('a private request is offered to a driver whose vehicle is empty', async () => {
      await requestRide(nusrat, { ...NUSRAT_RIDE, allowSharing: false });
      const res = await pending();
      expect(res.body.requests).toHaveLength(1);
      expect(res.body.requests[0].allowSharing).toBe(false);
    });

    it('pending hides private requests from a driver who already has a pool', async () => {
      const shared = await requestRide(nusrat, NUSRAT_RIDE);
      await requestRide(rafiq, { ...NUSRAT_RIDE, allowSharing: false });
      await accept(shared.body.rideRequest.id);
      expect((await pending()).body.requests).toEqual([]);
    });

    it('a private ride never gets a pool discount', async () => {
      const res = await requestRide(nusrat, { ...NUSRAT_RIDE, allowSharing: false });
      await accept(res.body.rideRequest.id);
      const ride = await RideRequest.findByPk(res.body.rideRequest.id);
      expect(ride!.estimatedFare).toBe(140);
      expect(ride!.poolDiscount).toBe(0);
    });
  });

  describe('the ride shows up on the passenger status endpoints', () => {
    it('is returned by the active-rides endpoint with allowSharing', async () => {
      const created = await requestRide(nusrat, { ...NUSRAT_RIDE, allowSharing: false });
      const res = await request(app).get('/passenger/rides/active').set(asUser(nusrat.id));
      expect(res.status).toBe(200);
      expect(res.body.rides).toHaveLength(1);
      expect(res.body.rides[0]).toMatchObject({ id: created.body.rideRequest.id, status: 'REQUESTED', allowSharing: false });
    });
  });
});
