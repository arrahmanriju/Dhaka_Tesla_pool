/**
 * A passenger leaves a ride AFTER it has started (CANCELLED_IN_TRANSIT). The fare is no longer a
 * separate pro-rata formula: the cancellation zone is one more checkpoint, and the passenger's
 * journey is priced by the same segment walk as everyone else's (segmentFares.test.ts has the
 * pure maths).
 *
 * Worked example (Jashim's Bullet, 3 seats). Zone distances: Uttara–Mirpur 9 km, Mirpur–Dhanmondi
 * 7 km, Mirpur–Mohammadpur 5 km, Mohammadpur–Dhanmondi 3 km. tripCost = 100 + 20 × journeyKm, spread over
 * the journey by distance; a shared segment costs its share / riders + ৳20 driver bonus (see fareCalculator.ts).
 *
 *   Nusrat rides Uttara → Dhanmondi and starts alone.   checkpoint (Uttara, 1)
 *   Rafiq boards at Mirpur, going to Dhanmondi.          checkpoint (Mirpur, 2)
 *   Nusrat asks to be dropped at Mohammadpur.            checkpoint (Mohammadpur, 1)
 *
 *   Nusrat:  journeyKm 9 + 5 = 14, tripCost 100 + 280 = ৳380
 *            Uttara → Mirpur        9/14 × 380 = 244.29   alone
 *            Mirpur → Mohammadpur   5/14 × 380 = 135.71, / 2 = 67.86, + 20 = 87.86
 *            exact total 332.14 → ৳332        (on track for ৳348 to Dhanmondi before she left)
 *   Rafiq, dropped at Dhanmondi:  journeyKm 5 + 3 = 8, tripCost 100 + 160 = ৳260
 *            Mirpur → Mohammadpur   5/8 × 260 = 162.5, / 2 = 81.25, + 20 = 101.25   2 on board
 *            Mohammadpur → Dhanmondi 3/8 × 260 = 97.5                                  alone again
 *            exact total 198.75 → ৳199
 */
import request from 'supertest';
import { app } from '../index';
import { sequelize, User, Vehicle, RideRequest, RideEvent, PoolCheckpoint } from '../models';
import { asUser } from './helpers';

let jashim: any;
let nusrat: any;
let rafiq: any;
let shirin: any;
let tania: any;
let bullet: any;

type Trip = { pickupZone: string; destinationZone: string; seatCount?: number };
const UTTARA_TO_DHANMONDI: Trip = { pickupZone: 'Uttara', destinationZone: 'Dhanmondi' };
const MIRPUR_TO_DHANMONDI: Trip = { pickupZone: 'Mirpur', destinationZone: 'Dhanmondi' };

const requestRide = (p: any, trip: Trip = UTTARA_TO_DHANMONDI) =>
  request(app).post('/ride-requests').set(asUser(p.id)).send({ seatCount: 1, allowSharing: true, ...trip });
const accept = (rideId: string) => request(app).post(`/ride-requests/${rideId}/accept`).send({ driverId: jashim.id });
const driverAction = (rideId: string, action: 'arrive' | 'start' | 'complete' | 'cancel') =>
  request(app).patch(`/driver/rides/${rideId}/${action}`).send({ driverId: jashim.id });
const leave = (rideId: string, who: any, cancellationZone?: unknown) =>
  request(app)
    .patch(`/passenger/rides/${rideId}/cancel-in-transit`)
    .set(asUser(who.id))
    .send(cancellationZone === undefined ? {} : { cancellationZone });
const view = (rideId: string, who: any) => request(app).get(`/passenger/rides/${rideId}`).set(asUser(who.id));
const pending = () => request(app).get(`/ride-requests/pending?driverId=${jashim.id}`);
const ride = async (id: string) => (await RideRequest.findByPk(id))!;
const occupied = async () => (await Vehicle.findByPk(bullet.id))!.occupiedSeats;
const checkpoints = async () =>
  (await PoolCheckpoint.findAll({ where: { vehicleId: bullet.id }, order: [['id', 'ASC']] })).map((c) => [c.zone, c.passengerCount, c.kind]);

async function joinPool(p: any, trip: Trip = UTTARA_TO_DHANMONDI): Promise<string> {
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

/** Nusrat starts alone at Uttara; Rafiq is accepted mid-trip and boards at Mirpur. */
async function nusratThenRafiq() {
  const nusratRide = await joinPool(nusrat);
  await startRide(nusratRide);
  const rafiqRide = await joinPool(rafiq, MIRPUR_TO_DHANMONDI);
  await startRide(rafiqRide);
  return { nusratRide, rafiqRide };
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});
afterAll(async () => {
  await sequelize.close();
});

describe('Mid-trip cancellation — CANCELLED_IN_TRANSIT priced from checkpoints', () => {
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
    await PoolCheckpoint.destroy({ where: {} });
    await RideEvent.destroy({ where: {} });
    await RideRequest.destroy({ where: {} });
    await Vehicle.destroy({ where: {} });
    await User.destroy({ where: {} });
  });

  // ─────────────────────────── the fare ───────────────────────────
  describe('the fare comes from the segments actually travelled', () => {
    it('worked example: Nusrat leaves at Mohammadpur and pays ৳332, not the ৳348 she was on track for', async () => {
      const { nusratRide } = await nusratThenRafiq();
      // Before she leaves: Uttara → Mirpur alone (236.25) + Mirpur → Dhanmondi with 2 on board (111.875) = 348.125 → ৳348
      expect((await ride(nusratRide)).estimatedFare).toBe(348);

      const res = await leave(nusratRide, nusrat, 'Mohammadpur');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'CANCELLED_IN_TRANSIT', cancellationZone: 'Mohammadpur' });
      expect(res.body.fare).toMatchObject({ soloFare: 380, poolDiscount: 48, fare: 332, fullTripEstimate: 348 });
      expect(res.body.fare.segments).toEqual([
        { distanceKm: 9, passengers: 1, driverBonus: 0, charge: 244 }, // 244.29
        { distanceKm: 5, passengers: 2, driverBonus: 20, charge: 88 }, // 87.86: the total 332.14 rounds to 332 = 244 + 88
      ]);
      expect(await ride(nusratRide)).toMatchObject({ status: 'CANCELLED_IN_TRANSIT', cancellationZone: 'Mohammadpur', estimatedFare: 332, poolDiscount: 48 });
      expect(await checkpoints()).toEqual([
        ['Uttara', 1, 'TRIP_STARTED'],
        ['Mirpur', 2, 'PASSENGER_JOINED'],
        ['Mohammadpur', 1, 'PASSENGER_LEFT'],
      ]);
    });

    it('the passengers who stay are priced only for their own segments: Rafiq pays ৳199', async () => {
      const { nusratRide, rafiqRide } = await nusratThenRafiq();
      await leave(nusratRide, nusrat, 'Mohammadpur');
      expect((await driverAction(rafiqRide, 'complete')).status).toBe(200);

      const final = await ride(rafiqRide);
      expect(final).toMatchObject({ status: 'COMPLETED', estimatedFare: 199 });
      const bill = (await view(rafiqRide, rafiq)).body.ride.fareBreakdown;
      expect(bill.segments).toEqual([
        { distanceKm: 5, passengers: 2, driverBonus: 20, charge: 101 }, // 101.25
        { distanceKm: 3, passengers: 1, driverBonus: 0, charge: 98 }, // 97.5: the total 198.75 rounds to 199 = 101 + 98
      ]);
      expect(bill).toMatchObject({ final: true, fare: 199 });
      // what the driver earns from the two of them: ৳332 + ৳199
      expect((await ride(nusratRide)).estimatedFare + final.estimatedFare).toBe(531);
    });

    it('a passenger riding alone pays the plain fare for the part travelled', async () => {
      const nusratRide = await joinPool(nusrat);
      await startRide(nusratRide);
      expect((await ride(nusratRide)).estimatedFare).toBe(420); // 100 + 16 × 20 to Dhanmondi, alone: the full trip cost

      const res = await leave(nusratRide, nusrat, 'Mirpur');
      // Uttara → Mirpur alone: 100 + 9 × 20 = ৳280
      expect(res.body.fare).toMatchObject({ fare: 280, poolDiscount: 0, fullTripEstimate: 420 });
      expect(res.body.fare.segments).toEqual([{ distanceKm: 9, passengers: 1, driverBonus: 0, charge: 280 }]);
    });

    it('leaving at the very zone where someone boards adds a 0 km stretch that costs nothing', async () => {
      const { nusratRide, rafiqRide } = await nusratThenRafiq();
      const res = await leave(nusratRide, nusrat, 'Mirpur');
      // Uttara → Mirpur alone (tripCost 100 + 180); Mirpur → Mirpur is 0 km: ৳280, no bonus and no pool discount earned
      expect(res.body.fare).toMatchObject({ fare: 280, poolDiscount: 0 });
      expect(res.body.fare.segments[1]).toMatchObject({ distanceKm: 0, charge: 0 });

      await driverAction(rafiqRide, 'complete');
      // Rafiq: the 0 km stretch with 2 on board costs nothing, then Mirpur → Dhanmondi alone: tripCost 100 + 140 = ৳240
      expect((await ride(rafiqRide)).estimatedFare).toBe(240);
    });

    it('is not a locked estimate: passengers still on board are re-estimated for who is left', async () => {
      const { nusratRide, rafiqRide } = await nusratThenRafiq();
      // Rafiq, on board with Nusrat: Mirpur → Dhanmondi with 2 on board: tripCost 240 / 2 + 20 = ৳140
      expect((await ride(rafiqRide)).estimatedFare).toBe(140);
      await leave(nusratRide, nusrat, 'Mohammadpur');
      // Now he is alone from Mohammadpur: 101.25 (Mirpur → Mohammadpur, shared) + 97.5 (alone) = 198.75 → ৳199 if he rides on to Dhanmondi
      const r = await ride(rafiqRide);
      expect(r.status).toBe('STARTED');
      expect(r.estimatedFare).toBe(199);
    });
  });

  // ─────────────────────────── status, other passengers, seat ───────────────────────────
  describe('what changes and what does not', () => {
    it('the freed seat shows in capacity and in the route-filtered pending list at once', async () => {
      const { nusratRide } = await nusratThenRafiq();
      await joinPool(shirin, MIRPUR_TO_DHANMONDI); // 3 of 3 seats
      expect(await occupied()).toBe(3);

      const late = await requestRide(tania, MIRPUR_TO_DHANMONDI);
      expect((await pending()).body.availableSeats).toBe(0);
      expect((await pending()).body.requests.map((r: any) => r.id)).not.toContain(late.body.rideRequest.id);

      await leave(nusratRide, nusrat, 'Mohammadpur');

      expect(await occupied()).toBe(2);
      const after = await pending();
      expect(after.body.availableSeats).toBe(1);
      expect(after.body.midTrip).toBe(true);
      expect(after.body.requests.map((r: any) => r.id)).toContain(late.body.rideRequest.id);
      expect((await accept(late.body.rideRequest.id)).status).toBe(200); // no re-match cycle
      expect(await occupied()).toBe(3);
    });

    it('the passenger can book again straight after leaving', async () => {
      const { nusratRide } = await nusratThenRafiq();
      await leave(nusratRide, nusrat, 'Mohammadpur');
      expect((await requestRide(nusrat)).status).toBe(201);
    });
  });

  // ─────────────────────────── who and when ───────────────────────────
  describe('who may cancel, and when', () => {
    it('a passenger cannot cancel someone else’s leg', async () => {
      const { nusratRide } = await nusratThenRafiq();

      expect((await leave(nusratRide, rafiq, 'Mohammadpur')).status).toBe(403);
      expect((await leave(nusratRide, shirin, 'Mohammadpur')).status).toBe(403);
      expect((await request(app).patch(`/passenger/rides/${nusratRide}/cancel-in-transit`).send({ cancellationZone: 'Mohammadpur' })).status).toBe(401);
      const asDriver = await request(app)
        .patch(`/passenger/rides/${nusratRide}/cancel-in-transit`)
        .set(asUser(jashim.id, 'DRIVER'))
        .send({ cancellationZone: 'Mohammadpur' });
      expect(asDriver.status).toBe(403);
      const forged = await request(app)
        .patch(`/passenger/rides/${nusratRide}/cancel-in-transit`)
        .set(asUser(rafiq.id))
        .send({ passengerId: nusrat.id, cancellationZone: 'Mohammadpur' });
      expect(forged.status).toBe(403);

      expect(await ride(nusratRide)).toMatchObject({ status: 'STARTED', cancellationZone: null });
      expect(await occupied()).toBe(2);
      expect(await checkpoints()).toHaveLength(2); // nothing was recorded
      expect((await leave('00000000-0000-4000-8000-000000000000', nusrat, 'Mohammadpur')).status).toBe(404);
    });

    it('is not reachable once the ride is COMPLETED, or before it has started', async () => {
      const { nusratRide } = await nusratThenRafiq();
      await driverAction(nusratRide, 'complete');
      const fareAtCompletion = (await ride(nusratRide)).estimatedFare;
      const res = await leave(nusratRide, nusrat, 'Mohammadpur');
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/completed/i);
      expect(await ride(nusratRide)).toMatchObject({ status: 'COMPLETED', estimatedFare: fareAtCompletion, cancellationZone: null });
      expect(await occupied()).toBe(1); // only the completion released Nusrat's seat, once

      const matched = await joinPool(shirin, MIRPUR_TO_DHANMONDI);
      expect((await leave(matched, shirin, 'Mohammadpur')).status).toBe(409);
      const requested = await requestRide(tania);
      expect((await leave(requested.body.rideRequest.id, tania, 'Mohammadpur')).status).toBe(409);
      expect((await ride(matched)).status).toBe('MATCHED');
    });

    it('cannot be done twice', async () => {
      const { nusratRide } = await nusratThenRafiq();
      expect((await leave(nusratRide, nusrat, 'Mohammadpur')).status).toBe(200);
      expect((await leave(nusratRide, nusrat, 'Mohammadpur')).status).toBe(409);
      expect(await occupied()).toBe(1); // released once
      expect((await checkpoints()).filter((c) => c[2] === 'PASSENGER_LEFT')).toHaveLength(1);
    });

    it('the driver completing at the same moment cannot double-release the seat or double-record the exit', async () => {
      const { nusratRide } = await nusratThenRafiq();
      const [a, b] = await Promise.all([leave(nusratRide, nusrat, 'Mohammadpur'), driverAction(nusratRide, 'complete')]);
      const final = (await ride(nusratRide)).status;
      expect(['COMPLETED', 'CANCELLED_IN_TRANSIT']).toContain(final);
      expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1); // exactly one won
      expect(await occupied()).toBe(1);
      const exits = (await checkpoints()).filter((c) => c[2] === 'PASSENGER_LEFT' || c[2] === 'PASSENGER_DROPPED_OFF');
      expect(exits).toHaveLength(1);
    });

    it('needs a valid cancellation zone that is neither the pickup nor the destination', async () => {
      const { nusratRide } = await nusratThenRafiq();
      for (const bad of [undefined, '', 'Narnia', 42, 'Uttara', 'Dhanmondi']) {
        const res = await leave(nusratRide, nusrat, bad);
        expect(res.status).toBe(400);
        expect(res.body.fields.cancellationZone).toBeTruthy();
      }
      expect(await ride(nusratRide)).toMatchObject({ status: 'STARTED' });
      expect(await occupied()).toBe(2);
      expect(await checkpoints()).toHaveLength(2);
    });
  });

  // ─────────────────────────── audit trail ───────────────────────────
  describe('audit trail', () => {
    it('the pool history shows who left, when, where and what they were charged, beside the others’ records', async () => {
      const { nusratRide, rafiqRide } = await nusratThenRafiq();
      await leave(nusratRide, nusrat, 'Mohammadpur');

      const res = await request(app).get('/driver/rides/timeline').set(asUser(jashim.id, 'DRIVER'));
      const events: any[] = res.body.events;
      const of = (id: string) => events.filter((e) => e.rideId === id);

      expect(of(nusratRide).map((e) => e.status)).toEqual(['REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED', 'CANCELLED_IN_TRANSIT']);
      const left = of(nusratRide).at(-1);
      expect(left).toMatchObject({
        passengerFirstName: 'Nusrat',
        status: 'CANCELLED_IN_TRANSIT',
        fromStatus: 'STARTED',
        cancellationZone: 'Mohammadpur',
        chargedFare: 332,
        fullTripEstimate: 348,
      });
      expect(left.at).toBeTruthy();
      expect(of(rafiqRide).map((e) => e.status)).toEqual(['REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED']);

      const stored = await RideEvent.findOne({ where: { rideRequestId: nusratRide, status: 'CANCELLED_IN_TRANSIT' } });
      expect(stored).toMatchObject({ actorId: nusrat.id, actorRole: 'PASSENGER', poolSize: 1, cancellationZone: 'Mohammadpur', chargedFare: 332, fullTripEstimate: 348 });
    });

    it('the cancelling passenger sees their own outcome; nobody else sees it, or the stretches where others boarded', async () => {
      const { nusratRide, rafiqRide } = await nusratThenRafiq();
      await leave(nusratRide, nusrat, 'Mohammadpur');

      expect((await request(app).get('/passenger/rides/active').set(asUser(nusrat.id))).body.rides).toHaveLength(0);
      const history = (await request(app).get('/passenger/rides/history').set(asUser(nusrat.id))).body.rides;
      expect(history[0]).toMatchObject({ status: 'CANCELLED_IN_TRANSIT', cancellationZone: 'Mohammadpur', estimatedFare: 332 });
      expect(history[0].timeline.at(-1)).toMatchObject({ status: 'CANCELLED_IN_TRANSIT', cancellationZone: 'Mohammadpur', chargedFare: 332, fullTripEstimate: 348 });

      // Her own breakdown has no zone names: the middle checkpoint is where ANOTHER passenger boarded
      const mine = (await view(nusratRide, nusrat)).body.ride;
      expect(mine.fareBreakdown).toMatchObject({ final: true, fare: 332 });
      expect(JSON.stringify(mine.fareBreakdown)).not.toMatch(/Mirpur|fromZone|toZone/);

      // Rafiq sees his own ride only: still on board, nothing of Nusrat's zone or charge
      const rafiqView = await view(rafiqRide, rafiq);
      const text = JSON.stringify(rafiqView.body);
      expect(rafiqView.body.ride).toMatchObject({ status: 'STARTED', canCancelInTransit: true });
      expect(rafiqView.body.ride.pool.otherPassengers).toEqual([]);
      expect(text).not.toContain('CANCELLED_IN_TRANSIT');
      expect(text).not.toContain('Mohammadpur');
      expect(text).not.toContain(nusrat.id);
    });

    it('the driver’s ride history lists the part-trip', async () => {
      const { nusratRide } = await nusratThenRafiq();
      await leave(nusratRide, nusrat, 'Mohammadpur');
      const res = await request(app).get(`/driver/rides/history?driverId=${jashim.id}`);
      const row = res.body.rides.find((r: any) => r.id === nusratRide);
      expect(row).toMatchObject({ status: 'CANCELLED_IN_TRANSIT', cancellationZone: 'Mohammadpur', estimatedFare: 332 });
    });
  });

  // ─────────────────────────── revenue ───────────────────────────
  describe('revenue reconciles', () => {
    it('every stretch is charged once per passenger on board: the segments account for every taka', async () => {
      const { nusratRide, rafiqRide } = await nusratThenRafiq();
      const shirinRide = await joinPool(shirin, MIRPUR_TO_DHANMONDI);
      await startRide(shirinRide); // 3 on board from Mirpur
      await leave(nusratRide, nusrat, 'Mohammadpur');
      await driverAction(rafiqRide, 'complete');
      await driverAction(shirinRide, 'complete');

      const rides = [nusratRide, rafiqRide, shirinRide];
      const bills = [];
      for (const [id, who] of [[nusratRide, nusrat], [rafiqRide, rafiq], [shirinRide, shirin]] as const) {
        const b = (await view(id, who)).body.ride.fareBreakdown;
        expect(b.final).toBe(true);
        bills.push(b);
      }

      // Nusrat: journeyKm 9 + 0 + 5 = 14, tripCost 380. Uttara → Mirpur alone 244.29; Mirpur → Mohammadpur with 3 on board
      //         5/14 × 380 = 135.71 / 3 + 20 = 65.24. Exact total 309.52 → ৳310.
      // Rafiq and Shirin: journeyKm 5 + 3 = 8, tripCost 260. Mirpur → Mohammadpur, 3 on board: 162.5 / 3 + 20 = 74.17;
      //         Mohammadpur → Dhanmondi, 2 left: 97.5 / 2 + 20 = 68.75. Exact total 142.92 → ৳143 each.
      const fares = await Promise.all(rides.map(async (id) => (await ride(id)).estimatedFare));
      expect(fares).toEqual([310, 143, 143]);

      // each bill's stretches add up to that passenger's fare: nothing dropped, nothing double-counted
      bills.forEach((b, i) => expect(b.segments.reduce((sum: number, x: any) => sum + x.charge, 0)).toBe(fares[i]));
      // what the driver earns for the whole run
      expect(fares.reduce((a, b) => a + b, 0)).toBe(596);
    });
  });
});
