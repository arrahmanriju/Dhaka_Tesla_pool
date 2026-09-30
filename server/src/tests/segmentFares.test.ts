/**
 * Checkpoint-based segment fares.
 *
 *   fare = ৳100 base fare + Σ over the journey's segments of (distanceCharge × share rate), to the nearest ৳5
 *   distanceCharge = distanceKm(zoneA → zoneB) × ৳20 × seats
 *   share rate     = 100% with 1 passenger on board, 70% with 2, 55% with 3   (discount only when > 1)
 *
 * Worked example (numbers you can check by hand). Zone distances: Uttara–Mirpur 9 km, Mirpur–Dhanmondi 7 km.
 *   Nusrat rides Uttara → Dhanmondi and starts alone         checkpoint (Uttara, 1)
 *   Rafiq boards at Mirpur, also going to Dhanmondi          checkpoint (Mirpur, 2)
 *   Nusrat is dropped at Dhanmondi                            checkpoint (Dhanmondi, 1)
 *   Rafiq is dropped at Dhanmondi                             checkpoint (Dhanmondi, 0)
 *
 *   Nusrat  Uttara → Mirpur     9 km × 20 = ৳180  alone (100%)     ৳180
 *           Mirpur → Dhanmondi  7 km × 20 = ৳140  2 on board (70%)  ৳98
 *           fare = 100 + 180 + 98 = 378 → ৳380      (alone all the way: 100 + 320 = ৳420, so pooling saved ৳40)
 *   Rafiq   Mirpur → Dhanmondi  ৳140 × 70% = ৳98;  fare = 100 + 98 = 198 → ৳200      (alone: ৳240, saved ৳40)
 *   The driver earns ৳580.
 *
 * Cancelling mid-trip is covered in midTripCancellation.test.ts (the exit is just one more checkpoint).
 */
import request from 'supertest';
import { app } from '../index';
import { sequelize, User, Vehicle, RideRequest, RideEvent, PoolCheckpoint } from '../models';
import { asUser } from './helpers';
import { segmentDistanceKm, segmentFare, shareRatePercent } from '../utils/fareCalculator';

// ───────────────────────────── pure maths ─────────────────────────────
describe('segmentFare (pure)', () => {
  it('worked example: Nusrat solo Uttara → Mirpur, then pooled with Rafiq Mirpur → Dhanmondi = ৳380', () => {
    const nusrat = segmentFare({
      points: [
        { zone: 'Uttara', passengerCount: 1 },
        { zone: 'Mirpur', passengerCount: 2 },
        { zone: 'Dhanmondi', passengerCount: 1 }, // her own exit checkpoint
      ],
      seatCount: 1,
    });
    expect(nusrat.segments).toEqual([
      { fromZone: 'Uttara', toZone: 'Mirpur', distanceKm: 9, distanceCharge: 180, passengers: 1, ratePercent: 100, charge: 180 },
      { fromZone: 'Mirpur', toZone: 'Dhanmondi', distanceKm: 7, distanceCharge: 140, passengers: 2, ratePercent: 70, charge: 98 },
    ]);
    expect(nusrat).toMatchObject({ baseCharge: 100, distanceTotal: 320, soloFare: 420, fare: 380, poolDiscount: 40 });
  });

  it('Rafiq, pooled the whole way from Mirpur = ৳200', () => {
    const rafiq = segmentFare({
      points: [
        { zone: 'Mirpur', passengerCount: 2 },
        { zone: 'Dhanmondi', passengerCount: 1 },
      ],
      seatCount: 1,
    });
    expect(rafiq).toMatchObject({ distanceTotal: 140, soloFare: 240, fare: 200, poolDiscount: 40 });
  });

  it('the discount applies only to segments with more than one passenger; the base fare is never discounted', () => {
    const alone = segmentFare({ points: [{ zone: 'Uttara', passengerCount: 1 }], exitZone: 'Mirpur', seatCount: 1 });
    expect(alone.fare).toBe(280); // 100 + 180
    const shared = segmentFare({ points: [{ zone: 'Uttara', passengerCount: 2 }], exitZone: 'Mirpur', seatCount: 1 });
    expect(shared.fare).toBe(225); // 100 + 180 × 70% = 100 + 126 = 226 → nearest ৳5 = 225 (the ৳100 is not discounted)
  });

  it('three on board pay 55% of the distance charge', () => {
    // 100 + 180 × 55% = 100 + 99 = 199 → ৳200
    expect(segmentFare({ points: [{ zone: 'Uttara', passengerCount: 3 }], exitZone: 'Mirpur', seatCount: 1 }).fare).toBe(200);
  });

  it('a private ride is charged 100% of every segment, whatever the count', () => {
    const r = segmentFare({ points: [{ zone: 'Uttara', passengerCount: 3 }], exitZone: 'Mirpur', seatCount: 1, allowSharing: false });
    expect(r).toMatchObject({ fare: 280, poolDiscount: 0 });
  });

  it('two checkpoints in the same zone are 0 km apart and cost nothing', () => {
    expect(segmentDistanceKm('Mirpur', 'Mirpur')).toBe(0);
    const r = segmentFare({
      points: [
        { zone: 'Mohakhali', passengerCount: 1 },
        { zone: 'Mohakhali', passengerCount: 2 },
      ],
      exitZone: 'Badda',
      seatCount: 1,
    });
    expect(r.segments.map((s) => s.charge)).toEqual([0, 56]); // 4 km × 20 = 80 × 70%
    expect(r.fare).toBe(155); // 100 + 56 = 156 → 155
  });

  it('the distance charge scales with seats; the base fare does not', () => {
    // 2 seats, Mohakhali → Badda alone: 100 + 4 × 20 × 2 = 260
    expect(segmentFare({ points: [{ zone: 'Mohakhali', passengerCount: 1 }], exitZone: 'Badda', seatCount: 2 }).fare).toBe(260);
  });

  it('stretches add up: hopping via a zone costs the sum of the hops', () => {
    const viaMirpur = segmentFare({
      points: [
        { zone: 'Uttara', passengerCount: 1 },
        { zone: 'Mirpur', passengerCount: 1 },
      ],
      exitZone: 'Dhanmondi',
      seatCount: 1,
    });
    expect(viaMirpur.fare).toBe(420); // 100 + (9 + 7) × 20, the same as going direct (Uttara–Dhanmondi is 16 km)
  });

  it('a journey needs a boarding checkpoint', () => {
    expect(() => segmentFare({ points: [], seatCount: 1 })).toThrow();
  });
});

// ───────────────────────────── end to end ─────────────────────────────
let jashim: any;
let nusrat: any;
let rafiq: any;
let shirin: any;
let bullet: any;

type Trip = { pickupZone: string; destinationZone: string; seatCount?: number };
const requestRide = (p: any, trip: Trip) =>
  request(app).post('/ride-requests').set(asUser(p.id)).send({ seatCount: 1, allowSharing: true, ...trip });
const accept = (id: string) => request(app).post(`/ride-requests/${id}/accept`).send({ driverId: jashim.id });
const driverAction = (id: string, action: 'arrive' | 'start' | 'complete') =>
  request(app).patch(`/driver/rides/${id}/${action}`).send({ driverId: jashim.id });
const ride = async (id: string) => (await RideRequest.findByPk(id))!;
const view = (id: string, who: any) => request(app).get(`/passenger/rides/${id}`).set(asUser(who.id));
const checkpoints = async () =>
  (await PoolCheckpoint.findAll({ where: { vehicleId: bullet.id }, order: [['id', 'ASC']] })).map((c) => [c.zone, c.passengerCount, c.kind]);

async function join(p: any, trip: Trip) {
  const created = await requestRide(p, trip);
  expect(created.status).toBe(201);
  const id = created.body.rideRequest.id as string;
  expect((await accept(id)).status).toBe(200);
  return id;
}
async function start(id: string) {
  expect((await driverAction(id, 'arrive')).status).toBe(200);
  expect((await driverAction(id, 'start')).status).toBe(200);
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});
afterAll(async () => {
  await sequelize.close();
});

describe('Segment fares end to end — Jashim (Bullet), Nusrat, Rafiq, Shirin', () => {
  beforeEach(async () => {
    const mk = async (name: string, role: 'DRIVER' | 'PASSENGER', n: number) =>
      (await User.create({ name: `${name} Test`, phone: `0171400000${n}`, email: `${name.toLowerCase()}-sf@test.com`, password: 'x', role })).toJSON();
    jashim = await mk('Jashim', 'DRIVER', 0);
    nusrat = await mk('Nusrat', 'PASSENGER', 1);
    rafiq = await mk('Rafiq', 'PASSENGER', 2);
    shirin = await mk('Shirin', 'PASSENGER', 3);
    bullet = (await Vehicle.create({ driverId: jashim.id, modelName: 'Bullet', seatCapacity: 3, licensePlate: 'DTP-0001' })).toJSON();
  });
  afterEach(async () => {
    await PoolCheckpoint.destroy({ where: {} });
    await RideEvent.destroy({ where: {} });
    await RideRequest.destroy({ where: {} });
    await Vehicle.destroy({ where: {} });
    await User.destroy({ where: {} });
  });

  it('checkpoints follow the rules: trip start (count 1), a mid-trip join (+1), drop-offs (−1)', async () => {
    const nusratRide = await join(nusrat, { pickupZone: 'Uttara', destinationZone: 'Dhanmondi' });
    expect(await checkpoints()).toEqual([]); // matched, nobody is on board yet
    await start(nusratRide);
    const rafiqRide = await join(rafiq, { pickupZone: 'Mirpur', destinationZone: 'Dhanmondi' });
    expect(await checkpoints()).toHaveLength(1); // matched mid-trip is not boarded yet
    await start(rafiqRide);
    await driverAction(nusratRide, 'complete');
    await driverAction(rafiqRide, 'complete');

    expect(await checkpoints()).toEqual([
      ['Uttara', 1, 'TRIP_STARTED'],
      ['Mirpur', 2, 'PASSENGER_JOINED'],
      ['Dhanmondi', 1, 'PASSENGER_DROPPED_OFF'],
      ['Dhanmondi', 0, 'PASSENGER_DROPPED_OFF'],
    ]);
    const rows = await PoolCheckpoint.findAll({ where: { vehicleId: bullet.id } });
    expect(new Set(rows.map((r) => r.runId)).size).toBe(1); // one continuous run
    expect(rows.map((r) => r.createdAt).every(Boolean)).toBe(true); // timestamped
  });

  describe('a passenger who is solo, then pooled', () => {
    it('Nusrat pays full price for the solo stretch and the discounted price for the shared one', async () => {
      const nusratRide = await join(nusrat, { pickupZone: 'Uttara', destinationZone: 'Dhanmondi' });
      await start(nusratRide);
      const rafiqRide = await join(rafiq, { pickupZone: 'Mirpur', destinationZone: 'Dhanmondi' });
      await start(rafiqRide);
      await driverAction(nusratRide, 'complete');
      await driverAction(rafiqRide, 'complete');

      const bill = (await view(nusratRide, nusrat)).body.ride.fareBreakdown;
      expect(bill.segments).toEqual([
        { distanceKm: 9, distanceCharge: 180, passengers: 1, ratePercent: 100, charge: 180 }, // solo: full price
        { distanceKm: 7, distanceCharge: 140, passengers: 2, ratePercent: 70, charge: 98 }, // shared: 30% off
      ]);
      expect(bill).toMatchObject({ final: true, baseCharge: 100, soloFare: 420, poolDiscount: 40, fare: 380 });
      expect(await ride(nusratRide)).toMatchObject({ status: 'COMPLETED', estimatedFare: 380, poolDiscount: 40 });
      // Rafiq only ever shared
      expect(await ride(rafiqRide)).toMatchObject({ status: 'COMPLETED', estimatedFare: 200, poolDiscount: 40 });
    });

    it('the fare is not fixed at the start: the running estimate follows the car, the final fare is settled at the end', async () => {
      const nusratRide = await join(nusrat, { pickupZone: 'Uttara', destinationZone: 'Dhanmondi' });
      await start(nusratRide);
      expect((await ride(nusratRide)).estimatedFare).toBe(420); // alone so far
      const rafiqRide = await join(rafiq, { pickupZone: 'Mirpur', destinationZone: 'Dhanmondi' });
      expect((await ride(nusratRide)).estimatedFare).toBe(420); // Rafiq is matched, not on board
      await start(rafiqRide);
      expect((await ride(nusratRide)).estimatedFare).toBe(380); // now 2 on board from Mirpur
      expect((await view(nusratRide, nusrat)).body.ride).toMatchObject({ fareFinal: false, status: 'STARTED' });
      await driverAction(nusratRide, 'complete');
      expect((await view(nusratRide, nusrat)).body.ride).toMatchObject({ fareFinal: true, estimatedFare: 380 });
    });
  });

  describe('a passenger who was pooled from the start', () => {
    it('gets the discount for the entire trip: Nusrat and Rafiq both board at Mohakhali → Badda', async () => {
      const nusratRide = await join(nusrat, { pickupZone: 'Mohakhali', destinationZone: 'Badda' });
      const rafiqRide = await join(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Badda' });
      await start(nusratRide);
      await start(rafiqRide);
      await driverAction(nusratRide, 'complete');
      await driverAction(rafiqRide, 'complete');

      expect(await checkpoints()).toEqual([
        ['Mohakhali', 1, 'TRIP_STARTED'],
        ['Mohakhali', 2, 'PASSENGER_JOINED'],
        ['Badda', 1, 'PASSENGER_DROPPED_OFF'],
        ['Badda', 0, 'PASSENGER_DROPPED_OFF'],
      ]);
      // Nusrat boards first (alone for a 0 km moment), then the whole 4 km is shared
      for (const [id, who] of [[nusratRide, nusrat], [rafiqRide, rafiq]] as const) {
        const bill = (await view(id, who)).body.ride.fareBreakdown;
        const shared = bill.segments.filter((s: any) => s.distanceKm > 0);
        expect(shared).toEqual([{ distanceKm: 4, distanceCharge: 80, passengers: 2, ratePercent: 70, charge: 56 }]);
        expect(bill).toMatchObject({ soloFare: 180, fare: 155, poolDiscount: 25 }); // 100 + 56 = 156 → 155
      }
    });
  });

  describe('a new trip after the vehicle empties', () => {
    it('starts a new run and never counts the earlier trip', async () => {
      const first = await join(nusrat, { pickupZone: 'Mohakhali', destinationZone: 'Badda' });
      await start(first);
      await driverAction(first, 'complete');
      const second = await join(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Badda' });
      await start(second);
      await driverAction(second, 'complete');

      const rows = await PoolCheckpoint.findAll({ where: { vehicleId: bullet.id }, order: [['id', 'ASC']] });
      expect(rows.map((r) => r.passengerCount)).toEqual([1, 0, 1, 0]);
      expect(new Set(rows.map((r) => r.runId)).size).toBe(2);
      expect((await ride(first)).estimatedFare).toBe(180);
      expect((await ride(second)).estimatedFare).toBe(180); // solo: the first trip's passenger is long gone
    });
  });

  describe('revenue reconciles', () => {
    it('three passengers boarding at different zones: every segment charged once per passenger on it', async () => {
      const a = await join(nusrat, { pickupZone: 'Uttara', destinationZone: 'Dhanmondi' });
      await start(a);
      const b = await join(rafiq, { pickupZone: 'Mirpur', destinationZone: 'Dhanmondi' });
      await start(b);
      const c = await join(shirin, { pickupZone: 'Mirpur', destinationZone: 'Dhanmondi' });
      await start(c);
      for (const id of [a, b, c]) await driverAction(id, 'complete');

      // Nusrat: 100 + 180 (alone) + 140 × 55% = 77 → 357 → ৳355;  Rafiq and Shirin: 100 + 77 = 177 → ৳175 each
      const fares = await Promise.all([a, b, c].map(async (id) => (await ride(id)).estimatedFare));
      expect(fares).toEqual([355, 175, 175]);

      // Rebuild what the road earned from the checkpoints alone: km × ৳20 × rate × people on board, per stretch
      const cps = await PoolCheckpoint.findAll({ where: { vehicleId: bullet.id }, order: [['id', 'ASC']] });
      let fromCheckpoints = 0;
      for (let i = 0; i + 1 < cps.length; i++) {
        const cp = cps[i]!;
        fromCheckpoints += (segmentDistanceKm(cp.zone, cps[i + 1]!.zone) * 20 * shareRatePercent(cp.passengerCount) * cp.passengerCount) / 100;
      }
      expect(fromCheckpoints).toBe(180 + 3 * 77); // 411: the solo stretch once, the shared stretch three times

      // what the passengers' own bills add up to is the same number: nothing dropped, nothing double-counted
      let fromBills = 0;
      for (const [id, who] of [[a, nusrat], [b, rafiq], [c, shirin]] as const) {
        const bill = (await view(id, who)).body.ride.fareBreakdown;
        fromBills += bill.segments.reduce((s: number, x: any) => s + x.charge, 0);
      }
      expect(fromBills).toBe(fromCheckpoints);

      // fares = that + three base fares, each rounded to the nearest ৳5 (three roundings of at most ৳2.5)
      const total = fares.reduce((x, y) => x + y, 0);
      expect(Math.abs(total - (3 * 100 + fromCheckpoints))).toBeLessThanOrEqual(7.5);
      expect(total).toBe(705); // 300 + 411 = 711, rounded down 2 + 2 + 2
    });
  });
});
