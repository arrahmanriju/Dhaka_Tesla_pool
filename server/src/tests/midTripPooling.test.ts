/**
 * Mid-trip pooling — a ride that has already STARTED keeps taking passengers whose route runs the
 * same way, as long as there is a free seat.
 *
 * The story: Jashim drives "Bullet" (3 seats). Nusrat's ride (Mohakhali → Badda) has STARTED.
 *   - Rafiq asks for a ride along the same road → the driver can accept him mid-trip.
 *   - Shirin asks for a ride the same way but to a different place (further ahead than Rafiq's).
 *   - Someone heading somewhere unrelated, or asking for more seats than are left, is turned away.
 *
 * Fares follow the segment model in the README: a passenger is priced by who is actually on board,
 * and the fare is final only when their own journey ends.
 * The direction rule itself is unit-tested by hand-checkable numbers in routeDirection.test.ts.
 */
import request from 'supertest';
import { app } from '../index';
import { sequelize, User, Vehicle, RideRequest, RideEvent, RideDecline } from '../models';
import { asUser } from './helpers';

let jashim: any;
let nusrat: any;
let rafiq: any;
let shirin: any;
let tania: any;
let bullet: any;

type Trip = { pickupZone: string; destinationZone: string; seatCount?: number; allowSharing?: boolean };
const MOHAKHALI_TO_BADDA: Trip = { pickupZone: 'Mohakhali', destinationZone: 'Badda' };

const requestRide = (passenger: any, trip: Trip = MOHAKHALI_TO_BADDA) =>
  request(app)
    .post('/ride-requests')
    .set(asUser(passenger.id))
    .send({ seatCount: 1, allowSharing: true, ...trip });
const accept = (rideId: string, driver = jashim) =>
  request(app).post(`/ride-requests/${rideId}/accept`).send({ driverId: driver.id });
const driverAction = (rideId: string, action: 'arrive' | 'start' | 'complete' | 'cancel') =>
  request(app).patch(`/driver/rides/${rideId}/${action}`).send({ driverId: jashim.id });
const pending = (driver = jashim) => request(app).get(`/ride-requests/pending?driverId=${driver.id}`);
const pendingIds = async (driver = jashim) => (await pending(driver)).body.requests.map((r: any) => r.id as string);
const passengerActive = (p: any) => request(app).get('/passenger/rides/active').set(asUser(p.id));
const fareOf = async (rideId: string) => (await RideRequest.findByPk(rideId))!.estimatedFare;
const statusOf = async (rideId: string) => (await RideRequest.findByPk(rideId))!.status;
const occupied = async () => (await Vehicle.findByPk(bullet.id))!.occupiedSeats;

/** Requests a ride and has Jashim accept it, so the passenger is on Bullet (MATCHED). */
async function joinPool(passenger: any, trip: Trip = MOHAKHALI_TO_BADDA): Promise<string> {
  const created = await requestRide(passenger, trip);
  expect(created.status).toBe(201);
  const id = created.body.rideRequest.id as string;
  expect((await accept(id)).status).toBe(200);
  return id;
}

/** Moves a ride MATCHED → DRIVER_ARRIVED → STARTED. */
async function startRide(rideId: string) {
  expect((await driverAction(rideId, 'arrive')).status).toBe(200);
  expect((await driverAction(rideId, 'start')).status).toBe(200);
}

/** Nusrat is on Bullet and her trip has STARTED (alone on board, so her running fare is the solo ৳180). */
async function nusratIsTravelling(trip: Trip = MOHAKHALI_TO_BADDA): Promise<string> {
  const id = await joinPool(nusrat, trip);
  await startRide(id);
  return id;
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});
afterAll(async () => {
  await sequelize.close();
});

describe('Mid-trip pooling — Jashim (Bullet, 3 seats), Nusrat, Rafiq, Shirin', () => {
  beforeEach(async () => {
    const mk = async (name: string, role: 'DRIVER' | 'PASSENGER', n: number) =>
      (await User.create({ name: `${name} Test`, phone: `0171200000${n}`, email: `${name.toLowerCase()}-mt@test.com`, password: 'x', role })).toJSON();
    jashim = await mk('Jashim', 'DRIVER', 0);
    nusrat = await mk('Nusrat', 'PASSENGER', 1);
    rafiq = await mk('Rafiq', 'PASSENGER', 2);
    shirin = await mk('Shirin', 'PASSENGER', 3);
    tania = await mk('Tania', 'PASSENGER', 4);
    bullet = (await Vehicle.create({ driverId: jashim.id, modelName: 'Bullet', seatCapacity: 3, licensePlate: 'DTP-0001' })).toJSON();
  });
  afterEach(async () => {
    await RideDecline.destroy({ where: {} });
    await RideEvent.destroy({ where: {} });
    await RideRequest.destroy({ where: {} });
    await Vehicle.destroy({ where: {} });
    await User.destroy({ where: {} });
  });

  // ─────────────────────────── the driver is offered compatible requests ───────────────────────────
  describe('what the driver is offered while a ride is STARTED', () => {
    it('lists a compatible request, flags the trip as mid-trip, and hides an unrelated one', async () => {
      await nusratIsTravelling();
      const rafiqReq = await requestRide(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Gulshan 1' });
      const lost = await requestRide(shirin, { pickupZone: 'Mohakhali', destinationZone: 'Dhanmondi' });

      const res = await pending();
      expect(res.status).toBe(200);
      expect(res.body.midTrip).toBe(true);
      expect(res.body.availableSeats).toBe(2);
      const ids = res.body.requests.map((r: any) => r.id);
      expect(ids).toContain(rafiqReq.body.rideRequest.id);
      expect(ids).not.toContain(lost.body.rideRequest.id);
      expect(res.body.requests.find((r: any) => r.id === rafiqReq.body.rideRequest.id).joinsMidTrip).toBe(true);
    });

    it('polling: a request made while the trip is under way appears on the next poll; an incompatible one never does', async () => {
      await nusratIsTravelling();
      const first = await pending();
      expect(first.body).toMatchObject({ midTrip: true, requests: [] });

      const unrelated = await requestRide(shirin, { pickupZone: 'Mohakhali', destinationZone: 'Dhanmondi' });
      expect((await pending()).body.requests).toEqual([]); // the server never sends it

      const fits = await requestRide(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Gulshan 1' });
      const next = await pending();
      expect(next.body.requests.map((r: any) => r.id)).toEqual([fits.body.rideRequest.id]);
      expect(JSON.stringify(next.body)).not.toContain(unrelated.body.rideRequest.id);
    });

    it('is not mid-trip before anyone has started', async () => {
      await joinPool(nusrat);
      await requestRide(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Gulshan 1' });
      const res = await pending();
      expect(res.body.midTrip).toBe(false);
      expect(res.body.requests).toHaveLength(1);
    });

    it('before the trip starts, a different destination the same way already pools (not only identical routes)', async () => {
      await joinPool(nusrat); // MATCHED, Mohakhali → Badda
      const rafiqRide = await joinPool(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Gulshan 1' });
      expect(await statusOf(rafiqRide)).toBe('MATCHED');
      expect(await occupied()).toBe(2);
    });
  });

  // ─────────────────────────── Person 2 joins a started ride ───────────────────────────
  describe('Person 2 joins Nusrat’s started ride', () => {
    it('Rafiq (Mohakhali → Gulshan 1) is accepted mid-trip; Nusrat is unchanged until he boards', async () => {
      const nusratRide = await nusratIsTravelling();
      expect(await fareOf(nusratRide)).toBe(180);

      const created = await requestRide(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Gulshan 1' });
      const res = await accept(created.body.rideRequest.id);

      expect(res.status).toBe(200);
      expect(res.body.rideRequest.status).toBe('MATCHED');
      expect(await statusOf(nusratRide)).toBe('STARTED');
      expect(await occupied()).toBe(2);
      // Nusrat is still alone on board (৳180). Rafiq is matched into a pool of 2: tripCost 100 + 4 × 20 = 180, 180 / 2 + 20 = ৳110.
      expect(await fareOf(nusratRide)).toBe(180);
      expect(await fareOf(created.body.rideRequest.id)).toBe(110);
    });

    it('Rafiq then goes through his own lifecycle while Nusrat is still riding', async () => {
      const nusratRide = await nusratIsTravelling();
      const rafiqRide = await joinPool(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Gulshan 1' });

      await startRide(rafiqRide);
      expect(await statusOf(rafiqRide)).toBe('STARTED');
      expect(await statusOf(nusratRide)).toBe('STARTED');

      // Rafiq is dropped first; his seat is freed, Nusrat rides on.
      expect((await driverAction(rafiqRide, 'complete')).status).toBe(200);
      expect(await occupied()).toBe(1);
      expect(await statusOf(nusratRide)).toBe('STARTED');
    });

    it('a request that runs the opposite way is rejected and stays REQUESTED', async () => {
      await nusratIsTravelling();
      const created = await requestRide(shirin, { pickupZone: 'Mohakhali', destinationZone: 'Dhanmondi' });
      const res = await accept(created.body.rideRequest.id);

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/incompatible/i);
      expect(await statusOf(created.body.rideRequest.id)).toBe('REQUESTED');
      expect(await occupied()).toBe(1);
    });

    it('a passenger picked up behind a started trip’s start is rejected (the car cannot go back)', async () => {
      await nusratIsTravelling({ pickupZone: 'Gulshan 1', destinationZone: 'Badda' });
      const created = await requestRide(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Badda' });

      expect((await accept(created.body.rideRequest.id)).status).toBe(409);
      expect(await pendingIds()).not.toContain(created.body.rideRequest.id);
    });

    it('a private ride is never mixed in, and a started private ride takes nobody', async () => {
      // A private request cannot join a car that has a passenger
      await nusratIsTravelling();
      const priv = await requestRide(rafiq, { ...MOHAKHALI_TO_BADDA, allowSharing: false });
      expect((await accept(priv.body.rideRequest.id)).status).toBe(409);
      await RideRequest.update({ status: 'CANCELLED' }, { where: { id: priv.body.rideRequest.id } });

      // ...and a started private ride refuses a sharing passenger on the same road
      await RideRequest.update({ allowSharing: false }, { where: { passengerId: nusrat.id } });
      const sharer = await requestRide(shirin, MOHAKHALI_TO_BADDA);
      const res = await accept(sharer.body.rideRequest.id);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/private/i);
    });
  });

  // ─────────────────────────── Person 3: same direction, different destination ───────────────────────────
  describe('Person 3 goes the same way, but further ahead', () => {
    it('Shirin (Mohakhali → Badda) is offered and accepted after Rafiq (Mohakhali → Gulshan 1) joined', async () => {
      const nusratRide = await nusratIsTravelling();
      const rafiqRide = await joinPool(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Gulshan 1' });

      // Not identical to Rafiq's destination — but the same direction along the same road
      const shirinReq = await requestRide(shirin, MOHAKHALI_TO_BADDA);
      expect(await pendingIds()).toContain(shirinReq.body.rideRequest.id);

      const res = await accept(shirinReq.body.rideRequest.id);
      expect(res.status).toBe(200);
      expect(await occupied()).toBe(3);
      // Pool of 3: 180 / 3 + 20 = ৳80 for Shirin, and Rafiq (matched, not on board; his trip is 4 km too) is re-priced to ৳80. Nusrat is alone on board: ৳180.
      expect(await fareOf(shirinReq.body.rideRequest.id)).toBe(80);
      expect(await fareOf(rafiqRide)).toBe(80);
      expect(await fareOf(nusratRide)).toBe(180);
    });

    it('a shorter trip the same way (behind Rafiq’s destination) is compatible too', async () => {
      await nusratIsTravelling();
      await joinPool(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Badda' });
      const shirinReq = await requestRide(shirin, { pickupZone: 'Mohakhali', destinationZone: 'Gulshan 1' });
      expect((await accept(shirinReq.body.rideRequest.id)).status).toBe(200);
    });

    it('a genuinely unrelated route is not offered and cannot be accepted, even with a seat free', async () => {
      await nusratIsTravelling();
      await joinPool(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Gulshan 1' });
      expect(await occupied()).toBe(2);

      // Mohakhali → Uttara heads north-west; Mohakhali → Motijheel heads south. Neither runs Nusrat's way.
      for (const destinationZone of ['Uttara', 'Motijheel', 'Dhanmondi']) {
        const created = await requestRide(destinationZone === 'Uttara' ? shirin : tania, { pickupZone: 'Mohakhali', destinationZone });
        expect(await pendingIds()).not.toContain(created.body.rideRequest.id);
        const res = await accept(created.body.rideRequest.id);
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/incompatible/i);
        expect(await statusOf(created.body.rideRequest.id)).toBe('REQUESTED');
        await RideRequest.update({ status: 'CANCELLED' }, { where: { id: created.body.rideRequest.id } });
      }
      expect(await occupied()).toBe(2);
    });
  });

  // ─────────────────────────── the stricter filter for a trip under way ───────────────────────────
  describe('a started trip only shows requests on its road ahead (filter, not sort)', () => {
    const BANANI_TO_GULSHAN: Trip = { pickupZone: 'Banani', destinationZone: 'Gulshan' };

    it('a pickup off the road is hidden and refused once the trip has started, but fine before it starts', async () => {
      // Before the start: Banani → Gulshan is a parallel road 1.5 km away, which the ordinary rule allows.
      const nusratRide = await joinPool(nusrat);
      const early = await requestRide(rafiq, BANANI_TO_GULSHAN);
      expect(await pendingIds()).toContain(early.body.rideRequest.id);

      // After the start the same request needs a detour, so it disappears from the list...
      await startRide(nusratRide);
      expect(await pendingIds()).not.toContain(early.body.rideRequest.id);
      // ...and accepting it is refused.
      const res = await accept(early.body.rideRequest.id);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/incompatible.*not on the vehicle/i);
      expect(await statusOf(early.body.rideRequest.id)).toBe('REQUESTED');
      expect(await occupied()).toBe(1);
    });

    it('every request in the pending list can actually be accepted, and nothing else can', async () => {
      await nusratIsTravelling();
      const trips: Trip[] = [
        { pickupZone: 'Mohakhali', destinationZone: 'Gulshan 1' }, // yes
        { pickupZone: 'Gulshan 1', destinationZone: 'Badda' }, // yes
        BANANI_TO_GULSHAN, // off the road
        { pickupZone: 'Mohakhali', destinationZone: 'Dhanmondi' }, // opposite way
        { pickupZone: 'Badda', destinationZone: 'Gulshan 1' }, // reverse
      ];
      const passengers = [rafiq, shirin, tania];
      const extra = (await User.create({ name: 'Omar Test', phone: '01712000008', email: 'omar-mt@test.com', password: 'x', role: 'PASSENGER' })).toJSON() as any;
      const extra2 = (await User.create({ name: 'Lima Test', phone: '01712000009', email: 'lima-mt@test.com', password: 'x', role: 'PASSENGER' })).toJSON() as any;
      const ids: string[] = [];
      for (const [i, trip] of trips.entries()) {
        ids.push((await requestRide([...passengers, extra, extra2][i]!, trip)).body.rideRequest.id);
      }

      const offered = await pendingIds();
      expect(offered.sort()).toEqual([ids[0]!, ids[1]!].sort());
      for (const id of ids.slice(2)) expect((await accept(id)).status).toBe(409);
      // The list is a live view: accepting the first changes what the second needs (Gulshan 1 → Badda would
      // start where Rafiq's trip ends), so the list is re-read after each accept and anything it shows works.
      let accepted = 0;
      for (let ids = await pendingIds(); ids.length > 0; ids = await pendingIds()) {
        expect((await accept(ids[0]!)).status).toBe(200);
        accepted++;
      }
      expect(accepted).toBe(1);
    });

    it('the car’s position moves on: once a later pickup has started, requests behind it are hidden', async () => {
      await nusratIsTravelling();
      const rafiqRide = await joinPool(rafiq, { pickupZone: 'Gulshan 1', destinationZone: 'Badda' });
      const behind = await requestRide(shirin, MOHAKHALI_TO_BADDA); // pickup Mohakhali
      const ahead = await requestRide(tania, { pickupZone: 'Gulshan 1', destinationZone: 'Badda' });

      // Rafiq is not on board yet: the car is still taken to be at Mohakhali, so both are offered.
      expect(await pendingIds()).toEqual(expect.arrayContaining([behind.body.rideRequest.id, ahead.body.rideRequest.id]));

      // Rafiq gets in at Gulshan 1: the car is now at least there, so Mohakhali is behind it.
      await startRide(rafiqRide);
      const ids = await pendingIds();
      expect(ids).toContain(ahead.body.rideRequest.id);
      expect(ids).not.toContain(behind.body.rideRequest.id);
      const res = await accept(behind.body.rideRequest.id);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/behind/i);
    });

    it('a destination that leaves the road is hidden even if it starts on it', async () => {
      await nusratIsTravelling({ pickupZone: 'Mohakhali', destinationZone: 'Banani' });
      const far = await requestRide(shirin, { pickupZone: 'Mohakhali', destinationZone: 'Uttara' });
      const near = await requestRide(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Banani' });

      const ids = await pendingIds();
      expect(ids).toContain(near.body.rideRequest.id);
      expect(ids).not.toContain(far.body.rideRequest.id);
      expect((await accept(far.body.rideRequest.id)).body.error).toMatch(/destination/i);
    });
  });

  // ─────────────────────────── capacity ───────────────────────────
  describe('capacity', () => {
    it('a mid-trip request for more seats than are left is not offered and is rejected', async () => {
      await nusratIsTravelling(); // 1 of 3 seats taken, 2 free
      const big = await requestRide(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Gulshan 1', seatCount: 3 });

      expect(await pendingIds()).not.toContain(big.body.rideRequest.id);
      const res = await accept(big.body.rideRequest.id);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/seat/i);
      expect(await occupied()).toBe(1);
      expect(await statusOf(big.body.rideRequest.id)).toBe('REQUESTED');
    });

    it('a compatible request is rejected once the car is full', async () => {
      await nusratIsTravelling();
      await joinPool(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Gulshan 1', seatCount: 2 }); // 3 of 3
      expect(await occupied()).toBe(3);

      const late = await requestRide(shirin, MOHAKHALI_TO_BADDA);
      expect((await pending()).body.availableSeats).toBe(0);
      expect(await pendingIds()).not.toContain(late.body.rideRequest.id);
      const res = await accept(late.body.rideRequest.id);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/seat/i);
      expect(await occupied()).toBe(3);
    });

    it('two mid-trip requests racing for the last seat: exactly one wins', async () => {
      await nusratIsTravelling();
      await joinPool(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Gulshan 1' }); // 2 of 3, one seat left
      const a = await requestRide(shirin, MOHAKHALI_TO_BADDA);
      const b = await requestRide(tania, MOHAKHALI_TO_BADDA);

      const results = await Promise.all([accept(a.body.rideRequest.id), accept(b.body.rideRequest.id)]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect(loser.body.error).toMatch(/seat/i);
      expect(await occupied()).toBe(3); // never 4
      const statuses = [await statusOf(a.body.rideRequest.id), await statusOf(b.body.rideRequest.id)].sort();
      expect(statuses).toEqual(['MATCHED', 'REQUESTED']);
      // and the seat count matches the rides actually on the car
      const onCar = await RideRequest.count({ where: { vehicleId: bullet.id, status: ['MATCHED', 'DRIVER_ARRIVED', 'STARTED'] } });
      expect(onCar).toBe(3);
    });

    it('two mid-trip requests each wanting the 2 free seats: exactly one wins', async () => {
      await nusratIsTravelling(); // 2 seats free
      const a = await requestRide(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Gulshan 1', seatCount: 2 });
      const b = await requestRide(shirin, { pickupZone: 'Mohakhali', destinationZone: 'Badda', seatCount: 2 });

      const results = await Promise.all([accept(a.body.rideRequest.id), accept(b.body.rideRequest.id)]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await occupied()).toBe(3);
    });

    it('the seat is released when a mid-trip passenger completes, and the next request can take it', async () => {
      await nusratIsTravelling();
      const rafiqRide = await joinPool(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Gulshan 1', seatCount: 2 });
      expect(await occupied()).toBe(3);

      await startRide(rafiqRide);
      await driverAction(rafiqRide, 'complete');
      expect(await occupied()).toBe(1);

      const next = await requestRide(shirin, MOHAKHALI_TO_BADDA);
      expect((await accept(next.body.rideRequest.id)).status).toBe(200);
      expect(await occupied()).toBe(2);
    });
  });

  // ─────────────────────────── each passenger sees only their own data ───────────────────────────
  describe('privacy between passengers who join at different points', () => {
    async function threeOnBullet() {
      const nusratRide = await nusratIsTravelling();
      const rafiqRide = await joinPool(rafiq, { pickupZone: 'Gulshan 1', destinationZone: 'Badda' }); // base ৳160
      const shirinRide = await joinPool(shirin, MOHAKHALI_TO_BADDA); // base ৳180
      return { nusratRide, rafiqRide, shirinRide };
    }

    it('fares are per passenger: Nusrat ৳180 (alone on board), Rafiq ৳74, Shirin ৳80', async () => {
      const { nusratRide, rafiqRide, shirinRide } = await threeOnBullet();
      expect(await fareOf(nusratRide)).toBe(180);
      expect(await fareOf(rafiqRide)).toBe(74); // tripCost 100 + 3 × 20 = 160; 160 / 3 = 53.33 → rounded UP to 54, + 20
      expect(await fareOf(shirinRide)).toBe(80); // 180 / 3 + 20
    });

    it('nobody’s response carries another passenger’s fare, route, phone or id', async () => {
      await threeOnBullet();
      const [n, r, s] = [nusrat, rafiq, shirin];
      const bodies = {
        nusrat: JSON.stringify((await passengerActive(n)).body),
        rafiq: JSON.stringify((await passengerActive(r)).body),
        shirin: JSON.stringify((await passengerActive(s)).body),
      };

      // Own fare only
      expect((await passengerActive(r)).body.rides[0]).toMatchObject({ estimatedFare: 74 });
      expect((await passengerActive(n)).body.rides[0]).toMatchObject({ estimatedFare: 180, fareFinal: false });
      expect(bodies.rafiq).not.toMatch(/"estimatedFare":(180|80)\b/);
      expect(bodies.nusrat).not.toMatch(/"estimatedFare":(74|80)\b/);
      expect(bodies.shirin).not.toMatch(/"estimatedFare":(180|74)\b/);

      // No ids or phone numbers of the others
      for (const [me, others] of [[n, [r, s]], [r, [n, s]], [s, [n, r]]] as const) {
        const text = bodies[me === n ? 'nusrat' : me === r ? 'rafiq' : 'shirin'];
        for (const other of others) {
          expect(text).not.toContain(other.id);
          expect(text).not.toContain(other.phone);
        }
      }
      // Rafiq's Gulshan 1 pickup is not visible to Nusrat; Nusrat's Mohakhali pickup is not visible to Rafiq
      expect(bodies.nusrat).not.toContain('Gulshan 1');
      expect(bodies.rafiq).not.toContain('Mohakhali');
      // ...only first names of the others
      expect((await passengerActive(r)).body.rides[0].pool.otherPassengers).toEqual([{ firstName: 'Nusrat' }, { firstName: 'Shirin' }]);
    });

    it('a passenger cannot open, cancel or list another passenger’s ride', async () => {
      const { nusratRide } = await threeOnBullet();
      expect((await request(app).get(`/passenger/rides/${nusratRide}`).set(asUser(rafiq.id))).status).toBe(403);
      expect((await request(app).patch(`/passenger/rides/${nusratRide}/cancel`).set(asUser(shirin.id))).status).toBe(403);
      expect((await request(app).get(`/ride-requests/me?passengerId=${nusrat.id}`).set(asUser(rafiq.id))).status).toBe(403);
      expect((await request(app).get(`/ride-requests/${nusratRide}/pool-info`).set(asUser(rafiq.id))).status).toBe(404);
      expect((await request(app).get(`/ride-requests/me?passengerId=${nusrat.id}`)).status).toBe(401);
    });

    it('the passenger ride history endpoints only ever return the caller’s own timeline', async () => {
      const { nusratRide, rafiqRide } = await threeOnBullet();
      const mine = await request(app).get(`/passenger/rides/${rafiqRide}`).set(asUser(rafiq.id));
      const text = JSON.stringify(mine.body);
      expect(text).not.toContain(nusratRide);
      expect(mine.body.ride.timeline.map((e: any) => e.status)).toEqual(['REQUESTED', 'MATCHED']);
    });

    it('a passenger cannot use the driver endpoints for the pool’s history', async () => {
      await threeOnBullet();
      expect((await request(app).get('/driver/rides/timeline').set(asUser(rafiq.id))).status).toBe(403);
      expect((await request(app).get('/driver/rides/timeline')).status).toBe(401);
      expect((await request(app).post('/ride-requests/x/decline').set(asUser(rafiq.id)).send({})).status).toBe(403);
    });
  });

  // ─────────────────────────── history: who joined, and when ───────────────────────────
  describe('lifecycle history', () => {
    it('records who joined when: Nusrat before the trip, Rafiq and Shirin mid-trip', async () => {
      const nusratRide = await nusratIsTravelling();
      const rafiqRide = await joinPool(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Gulshan 1' });
      const shirinRide = await joinPool(shirin, MOHAKHALI_TO_BADDA);
      await startRide(rafiqRide);
      await driverAction(nusratRide, 'complete');

      const res = await request(app).get('/driver/rides/timeline').set(asUser(jashim.id, 'DRIVER'));
      expect(res.status).toBe(200);
      const events: any[] = res.body.events;

      const of = (rideId: string) => events.filter((e) => e.rideId === rideId);
      expect(of(nusratRide).map((e) => e.status)).toEqual(['REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED', 'COMPLETED']);
      expect(of(rafiqRide).map((e) => e.status)).toEqual(['REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED']);
      expect(of(shirinRide).map((e) => e.status)).toEqual(['REQUESTED', 'MATCHED']);

      // Nusrat matched into an empty car; Rafiq and Shirin were matched while Nusrat was already travelling
      const matched = (rideId: string) => of(rideId).find((e) => e.status === 'MATCHED');
      expect(matched(nusratRide)).toMatchObject({ joinedMidTrip: false, ridersOnboard: 0, poolSize: 1, passengerFirstName: 'Nusrat' });
      expect(matched(rafiqRide)).toMatchObject({ joinedMidTrip: true, ridersOnboard: 1, poolSize: 2, passengerFirstName: 'Rafiq' });
      expect(matched(shirinRide)).toMatchObject({ joinedMidTrip: true, ridersOnboard: 1, poolSize: 3, passengerFirstName: 'Shirin' });

      // Oldest first, in the order things happened
      const ids = events.map((e) => e.id);
      expect(ids).toEqual([...ids].sort((x, y) => x - y));
      // Only first names, never phone numbers or passenger ids
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(nusrat.phone);
      expect(text).not.toContain(nusrat.id);
    });

    it('each passenger sees their own history, including that they joined mid-trip', async () => {
      const nusratRide = await nusratIsTravelling();
      const rafiqRide = await joinPool(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Gulshan 1' });

      const nusratView = (await request(app).get(`/passenger/rides/${nusratRide}`).set(asUser(nusrat.id))).body.ride;
      const rafiqView = (await request(app).get(`/passenger/rides/${rafiqRide}`).set(asUser(rafiq.id))).body.ride;

      expect(nusratView.timeline.map((e: any) => e.status)).toEqual(['REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED']);
      expect(nusratView.joinedMidTrip).toBe(false);
      expect(rafiqView.timeline.map((e: any) => e.status)).toEqual(['REQUESTED', 'MATCHED']);
      expect(rafiqView.joinedMidTrip).toBe(true);
      expect(rafiqView.timeline[1]).toMatchObject({ status: 'MATCHED', joinedMidTrip: true, ridersOnboard: 1 });
    });

    it('cancellations and completions stay in the history', async () => {
      await nusratIsTravelling();
      const rafiqRide = await joinPool(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Gulshan 1' });
      expect((await request(app).patch(`/passenger/rides/${rafiqRide}/cancel`).set(asUser(rafiq.id))).status).toBe(200);

      const events = await RideEvent.findAll({ where: { rideRequestId: rafiqRide }, order: [['id', 'ASC']] });
      expect(events.map((e) => e.status)).toEqual(['REQUESTED', 'MATCHED', 'CANCELLED']);
      expect(events[2]).toMatchObject({ fromStatus: 'MATCHED', actorRole: 'PASSENGER', actorId: rafiq.id });
      expect(await occupied()).toBe(1);
    });
  });

  // ─────────────────────────── accept / decline from the driver's side ───────────────────────────
  describe('declining', () => {
    it('a declined request stops showing for that driver but stays open for others', async () => {
      await nusratIsTravelling();
      const created = await requestRide(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Gulshan 1' });
      const id = created.body.rideRequest.id;
      expect(await pendingIds()).toContain(id);

      const res = await request(app).post(`/ride-requests/${id}/decline`).set(asUser(jashim.id, 'DRIVER')).send({});
      expect(res.status).toBe(200);
      expect(await pendingIds()).not.toContain(id);
      expect(await statusOf(id)).toBe('REQUESTED');

      // declining again is harmless
      expect((await request(app).post(`/ride-requests/${id}/decline`).set(asUser(jashim.id, 'DRIVER')).send({})).status).toBe(200);
      expect(await RideDecline.count({ where: { rideRequestId: id } })).toBe(1);

      // another driver still sees it
      const kamal = (await User.create({ name: 'Kamal', phone: '01712000099', email: 'kamal-mt@test.com', password: 'x', role: 'DRIVER' })).toJSON() as any;
      await Vehicle.create({ driverId: kamal.id, modelName: 'Rocket', seatCapacity: 3, licensePlate: 'DTP-0002' });
      expect(await pendingIds(kamal)).toContain(id);
    });

    it('cannot decline a request that is no longer waiting, or a missing one', async () => {
      const id = await joinPool(nusrat);
      expect((await request(app).post(`/ride-requests/${id}/decline`).set(asUser(jashim.id, 'DRIVER')).send({})).status).toBe(409);
      const missing = '00000000-0000-4000-8000-000000000000';
      expect((await request(app).post(`/ride-requests/${missing}/decline`).set(asUser(jashim.id, 'DRIVER')).send({})).status).toBe(404);
    });

    it('cannot decline on behalf of another driver', async () => {
      const created = await requestRide(rafiq);
      const res = await request(app)
        .post(`/ride-requests/${created.body.rideRequest.id}/decline`)
        .set(asUser(jashim.id, 'DRIVER'))
        .send({ driverId: '00000000-0000-4000-8000-000000000001' });
      expect(res.status).toBe(403);
    });
  });
});
