/**
 * A passenger leaves a ride AFTER it has started (CANCELLED_IN_TRANSIT).
 *
 * Worked example (Jashim's Bullet, 3 seats). Nusrat and Rafiq both ride Uttara → Motijheel (18 km):
 *   solo fare        100 + 18 × 20              = ৳460
 *   pool of 2 (70%)  460 × 70% = 322 → nearest 5 = ৳320 each, so the pool discount is 460 − 320 = ৳140
 * Nusrat asks to be dropped at Mirpur (9 km from Uttara) and is charged:
 *   100 + 9 × 20 − 140 = 100 + 180 − 140 = ৳140
 * Rafiq, still on board, keeps his locked ৳320.
 */
import request from 'supertest';
import { app } from '../index';
import { sequelize, User, Vehicle, RideRequest, RideEvent } from '../models';
import { asUser } from './helpers';

let jashim: any;
let nusrat: any;
let rafiq: any;
let shirin: any;
let tania: any;
let bullet: any;

type Trip = { pickupZone: string; destinationZone: string; seatCount?: number };
const UTTARA_TO_MOTIJHEEL: Trip = { pickupZone: 'Uttara', destinationZone: 'Motijheel' };

const requestRide = (p: any, trip: Trip = UTTARA_TO_MOTIJHEEL) =>
  request(app).post('/ride-requests').set(asUser(p.id)).send({ seatCount: 1, allowSharing: true, ...trip });
const accept = (rideId: string) => request(app).post(`/ride-requests/${rideId}/accept`).send({ driverId: jashim.id });
const driverAction = (rideId: string, action: 'arrive' | 'start' | 'complete' | 'cancel') =>
  request(app).patch(`/driver/rides/${rideId}/${action}`).send({ driverId: jashim.id });
const leave = (rideId: string, who: any, cancellationZone?: unknown) =>
  request(app)
    .patch(`/passenger/rides/${rideId}/cancel-in-transit`)
    .set(asUser(who.id))
    .send(cancellationZone === undefined ? {} : { cancellationZone });
const pending = () => request(app).get(`/ride-requests/pending?driverId=${jashim.id}`);
const pendingIds = async () => (await pending()).body.requests.map((r: any) => r.id as string);
const ride = async (id: string) => (await RideRequest.findByPk(id))!;
const occupied = async () => (await Vehicle.findByPk(bullet.id))!.occupiedSeats;

async function joinPool(p: any, trip: Trip = UTTARA_TO_MOTIJHEEL): Promise<string> {
  const created = await requestRide(p, trip);
  expect(created.status).toBe(201);
  const id = created.body.rideRequest.id as string;
  expect((await accept(id)).status).toBe(200);
  return id;
}
async function startRide(id: string) {
  expect((await driverAction(id, 'arrive')).status).toBe(200);
  expect((await driverAction(id, 'start')).status).toBe(200);
}

/** Nusrat and Rafiq are both on board (STARTED, fares locked at ৳320 each). */
async function twoOnBoard() {
  const nusratRide = await joinPool(nusrat);
  const rafiqRide = await joinPool(rafiq);
  await startRide(nusratRide);
  await startRide(rafiqRide);
  return { nusratRide, rafiqRide };
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});
afterAll(async () => {
  await sequelize.close();
});

describe('Mid-trip cancellation — CANCELLED_IN_TRANSIT', () => {
  beforeEach(async () => {
    const mk = async (name: string, role: 'DRIVER' | 'PASSENGER', n: number) =>
      (await User.create({ name: `${name} Test`, phone: `0171300000${n}`, email: `${name.toLowerCase()}-ct@test.com`, password: 'x', role })).toJSON();
    jashim = await mk('Jashim', 'DRIVER', 0);
    nusrat = await mk('Nusrat', 'PASSENGER', 1);
    rafiq = await mk('Rafiq', 'PASSENGER', 2);
    shirin = await mk('Shirin', 'PASSENGER', 3);
    tania = await mk('Tania', 'PASSENGER', 4);
    bullet = (await Vehicle.create({ driverId: jashim.id, modelName: 'Bullet', seatCapacity: 3, licensePlate: 'DTP-0001' })).toJSON();
  });
  afterEach(async () => {
    await RideEvent.destroy({ where: {} });
    await RideRequest.destroy({ where: {} });
    await Vehicle.destroy({ where: {} });
    await User.destroy({ where: {} });
  });

  // ─────────────────────────── the fare ───────────────────────────
  describe('the pro-rated fare', () => {
    it('worked example: Nusrat leaves at Mirpur and is charged ৳140 (100 + 9×20 − 140)', async () => {
      const { nusratRide } = await twoOnBoard();
      expect((await ride(nusratRide)).estimatedFare).toBe(320);
      expect((await ride(nusratRide)).poolDiscount).toBe(140);

      const res = await leave(nusratRide, nusrat, 'Mirpur');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CANCELLED_IN_TRANSIT');
      expect(res.body.cancellationZone).toBe('Mirpur');
      expect(res.body.fare).toEqual({
        baseCharge: 100,
        distanceKm: 9,
        distanceCharge: 180,
        grossFare: 280,
        poolDiscount: 140,
        fare: 140,
        limited: false,
        lockedFare: 320,
      });
      const saved = await ride(nusratRide);
      expect(saved).toMatchObject({ status: 'CANCELLED_IN_TRANSIT', cancellationZone: 'Mirpur', estimatedFare: 140, poolDiscount: 140, baseFare: 460 });
    });

    it('a passenger riding alone (no discount) pays the plain fare for the part travelled', async () => {
      const nusratRide = await joinPool(nusrat);
      await startRide(nusratRide); // alone: locked ৳460, discount 0
      const res = await leave(nusratRide, nusrat, 'Mirpur');
      expect(res.body.fare).toMatchObject({ grossFare: 280, poolDiscount: 0, fare: 280, lockedFare: 460 });
    });

    it('the fare cannot exceed what was locked for the whole trip', async () => {
      // Mohakhali → Badda (৳180 locked); Uttara is 11 km from Mohakhali (৳320), but the charge is capped at ৳180.
      const id = await joinPool(nusrat, { pickupZone: 'Mohakhali', destinationZone: 'Badda' });
      await startRide(id);
      const res = await leave(id, nusrat, 'Uttara');
      expect(res.body.fare).toMatchObject({ grossFare: 320, fare: 180, limited: true });
    });
  });

  // ─────────────────────────── status, other passengers, seat ───────────────────────────
  describe('what changes and what does not', () => {
    it('Nusrat becomes CANCELLED_IN_TRANSIT; Rafiq and a co-passenger who has not started keep their fares', async () => {
      const { nusratRide, rafiqRide } = await twoOnBoard();
      // Shirin joins mid-trip (pool of 3 → 55% of ৳460 = 253 → ৳255) and has not started yet
      const shirinRide = await joinPool(shirin);
      expect((await ride(shirinRide)).estimatedFare).toBe(255);
      expect((await ride(rafiqRide)).estimatedFare).toBe(320); // locked

      expect((await leave(nusratRide, nusrat, 'Mirpur')).status).toBe(200);

      expect((await ride(nusratRide)).status).toBe('CANCELLED_IN_TRANSIT');
      const rafiqAfter = await ride(rafiqRide);
      expect(rafiqAfter).toMatchObject({ status: 'STARTED', estimatedFare: 320, poolDiscount: 140 });
      // Not re-priced to the pool-of-2 rate: a co-passenger leaving mid-route never changes what others owe.
      const shirinAfter = await ride(shirinRide);
      expect(shirinAfter).toMatchObject({ status: 'MATCHED', estimatedFare: 255 });
    });

    it('the seat is released at once: capacity goes up and a request that did not fit now shows in the pending filter', async () => {
      const { nusratRide } = await twoOnBoard();
      await joinPool(shirin); // 3 of 3 seats
      expect(await occupied()).toBe(3);

      const late = await requestRide(tania);
      expect((await pending()).body.availableSeats).toBe(0);
      expect(await pendingIds()).not.toContain(late.body.rideRequest.id);

      await leave(nusratRide, nusrat, 'Mirpur');

      expect(await occupied()).toBe(2);
      const after = await pending();
      expect(after.body.availableSeats).toBe(1);
      expect(after.body.midTrip).toBe(true);
      expect(after.body.requests.map((r: any) => r.id)).toContain(late.body.rideRequest.id);
      // ...and it can be accepted straight away, with no re-match cycle
      expect((await accept(late.body.rideRequest.id)).status).toBe(200);
      expect(await occupied()).toBe(3);
    });

    it('the vehicle stays subject to the route filter after the seat is freed', async () => {
      const { nusratRide } = await twoOnBoard();
      const fits = await requestRide(tania); // Uttara → Motijheel, the way Rafiq is still riding
      const opposite = await requestRide(shirin, { pickupZone: 'Motijheel', destinationZone: 'Uttara' }); // wrong way
      await leave(nusratRide, nusrat, 'Mirpur');
      const after = await pending();
      expect(after.body.midTrip).toBe(true); // Rafiq is still on board, so the strict trip-under-way rule applies
      const ids = after.body.requests.map((r: any) => r.id);
      expect(ids).toContain(fits.body.rideRequest.id);
      expect(ids).not.toContain(opposite.body.rideRequest.id);
    });

    it('the passenger can book again straight after leaving', async () => {
      const { nusratRide } = await twoOnBoard();
      await leave(nusratRide, nusrat, 'Mirpur');
      expect((await requestRide(nusrat)).status).toBe(201);
    });
  });

  // ─────────────────────────── who and when ───────────────────────────
  describe('who may cancel, and when', () => {
    it('a passenger cannot cancel someone else’s leg', async () => {
      const { nusratRide } = await twoOnBoard();

      expect((await leave(nusratRide, rafiq, 'Mirpur')).status).toBe(403);
      expect((await leave(nusratRide, shirin, 'Mirpur')).status).toBe(403);
      expect((await request(app).patch(`/passenger/rides/${nusratRide}/cancel-in-transit`).send({ cancellationZone: 'Mirpur' })).status).toBe(401);
      // a driver's login is refused
      const asDriver = await request(app)
        .patch(`/passenger/rides/${nusratRide}/cancel-in-transit`)
        .set(asUser(jashim.id, 'DRIVER'))
        .send({ cancellationZone: 'Mirpur' });
      expect(asDriver.status).toBe(403);
      // a forged passengerId is refused too
      const forged = await request(app)
        .patch(`/passenger/rides/${nusratRide}/cancel-in-transit`)
        .set(asUser(rafiq.id))
        .send({ passengerId: nusrat.id, cancellationZone: 'Mirpur' });
      expect(forged.status).toBe(403);

      expect(await ride(nusratRide)).toMatchObject({ status: 'STARTED', estimatedFare: 320, cancellationZone: null });
      expect(await occupied()).toBe(2);
      expect((await leave('00000000-0000-4000-8000-000000000000', nusrat, 'Mirpur')).status).toBe(404);
    });

    it('is not reachable once the ride is COMPLETED, or before it has started', async () => {
      const { nusratRide } = await twoOnBoard();
      await driverAction(nusratRide, 'complete');
      const res = await leave(nusratRide, nusrat, 'Mirpur');
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/completed/i);
      expect(await ride(nusratRide)).toMatchObject({ status: 'COMPLETED', estimatedFare: 320, cancellationZone: null });
      expect(await occupied()).toBe(1); // only the completion released Nusrat's seat, once

      // before the start: MATCHED and REQUESTED rides use the ordinary cancel, not this path
      const matched = await joinPool(shirin);
      expect((await leave(matched, shirin, 'Mirpur')).status).toBe(409);
      const requested = await requestRide(tania);
      expect((await leave(requested.body.rideRequest.id, tania, 'Mirpur')).status).toBe(409);
      expect((await ride(matched)).status).toBe('MATCHED');
    });

    it('cannot be done twice', async () => {
      const { nusratRide } = await twoOnBoard();
      expect((await leave(nusratRide, nusrat, 'Mirpur')).status).toBe(200);
      expect((await leave(nusratRide, nusrat, 'Mirpur')).status).toBe(409);
      expect(await occupied()).toBe(1); // released once
    });

    it('the driver completing at the same moment cannot double-release the seat', async () => {
      const { nusratRide } = await twoOnBoard();
      const [a, b] = await Promise.all([leave(nusratRide, nusrat, 'Mirpur'), driverAction(nusratRide, 'complete')]);
      const final = (await ride(nusratRide)).status;
      expect(['COMPLETED', 'CANCELLED_IN_TRANSIT']).toContain(final);
      expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1); // exactly one won
      expect(await occupied()).toBe(1);
    });

    it('needs a valid cancellation zone that is neither the pickup nor the destination', async () => {
      const { nusratRide } = await twoOnBoard();
      for (const bad of [undefined, '', 'Narnia', 42, 'Uttara', 'Motijheel']) {
        const res = await leave(nusratRide, nusrat, bad);
        expect(res.status).toBe(400);
        expect(res.body.fields.cancellationZone).toBeTruthy();
      }
      expect(await ride(nusratRide)).toMatchObject({ status: 'STARTED', estimatedFare: 320 });
      expect(await occupied()).toBe(2);
    });
  });

  // ─────────────────────────── audit trail ───────────────────────────
  describe('audit trail', () => {
    it('the pool history shows who left, when, where and what they were charged, beside the others’ records', async () => {
      const { nusratRide, rafiqRide } = await twoOnBoard();
      await leave(nusratRide, nusrat, 'Mirpur');

      const res = await request(app).get('/driver/rides/timeline').set(asUser(jashim.id, 'DRIVER'));
      const events: any[] = res.body.events;
      const of = (id: string) => events.filter((e) => e.rideId === id);

      expect(of(nusratRide).map((e) => e.status)).toEqual(['REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED', 'CANCELLED_IN_TRANSIT']);
      const left = of(nusratRide).at(-1);
      expect(left).toMatchObject({
        passengerFirstName: 'Nusrat',
        status: 'CANCELLED_IN_TRANSIT',
        fromStatus: 'STARTED',
        cancellationZone: 'Mirpur',
        chargedFare: 140,
        lockedFare: 320,
      });
      expect(left.at).toBeTruthy();
      // Rafiq's record is untouched
      expect(of(rafiqRide).map((e) => e.status)).toEqual(['REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED']);

      // who cancelled: stored on the event
      const stored = await RideEvent.findOne({ where: { rideRequestId: nusratRide, status: 'CANCELLED_IN_TRANSIT' } });
      expect(stored).toMatchObject({ actorId: nusrat.id, actorRole: 'PASSENGER', poolSize: 1, cancellationZone: 'Mirpur', chargedFare: 140 });
    });

    it('the cancelling passenger sees the outcome in their own history, and nobody else sees it', async () => {
      const { nusratRide, rafiqRide } = await twoOnBoard();
      await leave(nusratRide, nusrat, 'Mirpur');

      expect((await request(app).get('/passenger/rides/active').set(asUser(nusrat.id))).body.rides).toHaveLength(0);
      const history = (await request(app).get('/passenger/rides/history').set(asUser(nusrat.id))).body.rides;
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ status: 'CANCELLED_IN_TRANSIT', cancellationZone: 'Mirpur', estimatedFare: 140 });
      expect(history[0].timeline.at(-1)).toMatchObject({ status: 'CANCELLED_IN_TRANSIT', cancellationZone: 'Mirpur', chargedFare: 140, lockedFare: 320 });

      // Rafiq sees his own ride only: still STARTED at ৳320, nothing of Nusrat's zone or charge
      const rafiqView = await request(app).get(`/passenger/rides/${rafiqRide}`).set(asUser(rafiq.id));
      expect(rafiqView.body.ride).toMatchObject({ status: 'STARTED', estimatedFare: 320, fareLocked: true, canCancelInTransit: true });
      expect(rafiqView.body.ride.pool.otherPassengers).toEqual([]);
      const text = JSON.stringify(rafiqView.body);
      expect(text).not.toContain('Mirpur');
      expect(text).not.toContain('CANCELLED_IN_TRANSIT');
      expect(text).not.toContain(nusrat.id);
    });

    it('the driver’s ride history lists the part-trip', async () => {
      const { nusratRide } = await twoOnBoard();
      await leave(nusratRide, nusrat, 'Mirpur');
      const res = await request(app).get(`/driver/rides/history?driverId=${jashim.id}`);
      const row = res.body.rides.find((r: any) => r.id === nusratRide);
      expect(row).toMatchObject({ status: 'CANCELLED_IN_TRANSIT', cancellationZone: 'Mirpur', estimatedFare: 140 });
    });
  });
});
