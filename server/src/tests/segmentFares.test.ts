/**
 * Checkpoint-based segment fares.
 *
 *   tripCost(journey) = ৳100 + 20 × seats × journeyKm     journeyKm = the sum of the segment distances
 *   a segment of segKm gets  segKm / journeyKm  of the trip cost (so the ৳100 base is spread by distance)
 *   1 on board:   segmentFare = that share
 *   n ≥ 2 on board: segmentFare = share / n + ৳20 driver bonus
 *   a shared split is rounded UP to the next whole taka (for every passenger on the segment); the solo
 *   segments of a journey are rounded together to the nearest taka. fare = Σ segmentFare
 *
 * Worked example (numbers you can check by hand). Zone distances: Uttara–Mirpur 9 km, Mirpur–Dhanmondi 7 km.
 *   Nusrat rides Uttara → Dhanmondi and starts alone         checkpoint (Uttara, 1)
 *   Rafiq boards at Mirpur, also going to Dhanmondi          checkpoint (Mirpur, 2)
 *   Nusrat is dropped at Dhanmondi                            checkpoint (Dhanmondi, 1)
 *   Rafiq is dropped at Dhanmondi                             checkpoint (Dhanmondi, 0)
 *
 *   Nusrat  journeyKm 9 + 7 = 16, tripCost 100 + 20 × 16 = ৳420
 *           Uttara → Mirpur     9/16 × 420 = 236.25            alone                     236.25
 *           Mirpur → Dhanmondi  7/16 × 420 = 183.75, / 2 = 91.875, rounded UP to 92, + 20 = 112
 *           fare = 236 + 112 = ৳348   (alone all the way it would be ৳420, pooling saved ৳72)
 *   Rafiq   journeyKm 7, tripCost 100 + 140 = ৳240;  240 / 2 + 20 = ৳140     (alone: ৳240, saved ৳100)
 *   The driver earns ৳488.
 *
 * Cancelling mid-trip is covered in midTripCancellation.test.ts (the exit is just one more checkpoint).
 * The Gulshan → Dhanmondi ৳300 / ৳170 / ৳120 example is in pricingModel.test.ts.
 */
import request from 'supertest';
import { app } from '../index';
import { sequelize, User, Vehicle, RideRequest, RideEvent, PoolCheckpoint } from '../models';
import { asUser } from './helpers';
import { segmentDistanceKm, segmentFare } from '../utils/fareCalculator';

// ───────────────────────────── pure maths ─────────────────────────────
describe('segmentFare (pure)', () => {
  it('worked example: Nusrat solo Uttara → Mirpur, then pooled with Rafiq Mirpur → Dhanmondi = ৳348', () => {
    const nusrat = segmentFare({
      points: [
        { zone: 'Uttara', passengerCount: 1 },
        { zone: 'Mirpur', passengerCount: 2 },
        { zone: 'Dhanmondi', passengerCount: 1 }, // her own exit checkpoint
      ],
      seatCount: 1,
    });
    expect(nusrat.segments).toEqual([
      { fromZone: 'Uttara', toZone: 'Mirpur', distanceKm: 9, passengers: 1, driverBonus: 0, charge: 236 }, // 236.25
      { fromZone: 'Mirpur', toZone: 'Dhanmondi', distanceKm: 7, passengers: 2, driverBonus: 20, charge: 112 }, // 183.75 / 2 = 91.875 → 92, + 20
    ]);
    expect(nusrat).toMatchObject({ soloFare: 420, fare: 348, poolDiscount: 72 });
  });

  it('Rafiq, pooled the whole way from Mirpur = ৳140', () => {
    const rafiq = segmentFare({
      points: [
        { zone: 'Mirpur', passengerCount: 2 },
        { zone: 'Dhanmondi', passengerCount: 1 },
      ],
      seatCount: 1,
    });
    expect(rafiq).toMatchObject({ soloFare: 240, fare: 140, poolDiscount: 100 }); // 240 / 2 + 20
  });

  it('the split applies only to segments with more than one passenger', () => {
    const alone = segmentFare({ points: [{ zone: 'Uttara', passengerCount: 1 }], exitZone: 'Mirpur', seatCount: 1 });
    expect(alone.fare).toBe(280); // 100 + 9 × 20, no split, no bonus
    const shared = segmentFare({ points: [{ zone: 'Uttara', passengerCount: 2 }], exitZone: 'Mirpur', seatCount: 1 });
    expect(shared.fare).toBe(160); // 280 / 2 + 20
  });

  it('three on board: tripCost / 3 rounded UP, + 20', () => {
    // 280 / 3 = 93.33 → 94 (up, not 93), + 20 = ৳114
    expect(segmentFare({ points: [{ zone: 'Uttara', passengerCount: 3 }], exitZone: 'Mirpur', seatCount: 1 }).fare).toBe(114);
  });

  it('a private ride is charged the full trip cost of every segment, whatever the count', () => {
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
    expect(r.segments.map((s) => s.charge)).toEqual([0, 110]); // the 0 km hop is free and earns no bonus
    expect(r.segments.map((s) => s.driverBonus)).toEqual([0, 20]);
    expect(r.fare).toBe(110); // tripCost 180 / 2 + 20
  });

  it('the trip cost scales with seats: the distance part is per seat, the ৳100 is not', () => {
    // 2 seats, Mohakhali → Badda alone: 100 + 4 × 20 × 2 = 260
    expect(segmentFare({ points: [{ zone: 'Mohakhali', passengerCount: 1 }], exitZone: 'Badda', seatCount: 2 }).fare).toBe(260);
  });

  it('riding alone the whole way costs exactly the trip cost, however the journey is cut', () => {
    const viaMirpur = segmentFare({
      points: [
        { zone: 'Uttara', passengerCount: 1 },
        { zone: 'Mirpur', passengerCount: 1 },
      ],
      exitZone: 'Dhanmondi',
      seatCount: 1,
    });
    // journeyKm 9 + 7 = 16 (the direct Uttara–Dhanmondi distance is also 16): 100 + 16 × 20 = 420
    expect(viaMirpur.fare).toBe(420);
    expect(viaMirpur.segments.map((s) => s.charge)).toEqual([236, 184]); // 236.25 and 183.75: they add up to 420 exactly
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
    it('Nusrat pays the full cost of the solo stretch and a shared cost plus the bonus for the shared one', async () => {
      const nusratRide = await join(nusrat, { pickupZone: 'Uttara', destinationZone: 'Dhanmondi' });
      await start(nusratRide);
      const rafiqRide = await join(rafiq, { pickupZone: 'Mirpur', destinationZone: 'Dhanmondi' });
      await start(rafiqRide);
      await driverAction(nusratRide, 'complete');
      await driverAction(rafiqRide, 'complete');

      const bill = (await view(nusratRide, nusrat)).body.ride.fareBreakdown;
      expect(bill.segments).toEqual([
        { distanceKm: 9, passengers: 1, driverBonus: 0, charge: 236 }, // solo: her share of the trip cost, 236.25
        { distanceKm: 7, passengers: 2, driverBonus: 20, charge: 112 }, // shared: split two ways (91.875 → 92) + 20
      ]);
      expect(bill).toMatchObject({ final: true, soloFare: 420, poolDiscount: 72, fare: 348 });
      expect(await ride(nusratRide)).toMatchObject({ status: 'COMPLETED', estimatedFare: 348, poolDiscount: 72 });
      // Rafiq only ever shared: 240 / 2 + 20
      expect(await ride(rafiqRide)).toMatchObject({ status: 'COMPLETED', estimatedFare: 140, poolDiscount: 100 });
    });

    it('the fare is not fixed at the start: the running estimate follows the car, the final fare is settled at the end', async () => {
      const nusratRide = await join(nusrat, { pickupZone: 'Uttara', destinationZone: 'Dhanmondi' });
      await start(nusratRide);
      expect((await ride(nusratRide)).estimatedFare).toBe(420); // alone so far
      const rafiqRide = await join(rafiq, { pickupZone: 'Mirpur', destinationZone: 'Dhanmondi' });
      expect((await ride(nusratRide)).estimatedFare).toBe(420); // Rafiq is matched, not on board
      await start(rafiqRide);
      expect((await ride(nusratRide)).estimatedFare).toBe(348); // now 2 on board from Mirpur
      expect((await view(nusratRide, nusrat)).body.ride).toMatchObject({ fareFinal: false, status: 'STARTED' });
      await driverAction(nusratRide, 'complete');
      expect((await view(nusratRide, nusrat)).body.ride).toMatchObject({ fareFinal: true, estimatedFare: 348 });
    });
  });

  describe('a passenger who was pooled from the start', () => {
    it('shares the whole trip: Nusrat and Rafiq both board at Mohakhali → Badda', async () => {
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
        expect(shared).toEqual([{ distanceKm: 4, passengers: 2, driverBonus: 20, charge: 110 }]);
        expect(bill).toMatchObject({ soloFare: 180, fare: 110, poolDiscount: 70 }); // 180 / 2 + 20
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
    it('three passengers boarding at different zones: every segment is charged, and the bills add up to the fares', async () => {
      const a = await join(nusrat, { pickupZone: 'Uttara', destinationZone: 'Dhanmondi' });
      await start(a);
      const b = await join(rafiq, { pickupZone: 'Mirpur', destinationZone: 'Dhanmondi' });
      await start(b);
      const c = await join(shirin, { pickupZone: 'Mirpur', destinationZone: 'Dhanmondi' });
      await start(c);
      for (const id of [a, b, c]) await driverAction(id, 'complete');

      // Nusrat: journeyKm 16, tripCost 420. Uttara → Mirpur alone 9/16 × 420 = 236.25 → 236;
      //         Mirpur → Dhanmondi 3 on board 7/16 × 420 = 183.75 / 3 = 61.25 → rounded UP to 62, + 20 = 82.  Fare 236 + 82 = ৳318
      // Rafiq and Shirin: journeyKm 7, tripCost 240; 3 on board over the whole 7 km: 240 / 3 + 20 = ৳100 each
      const fares = await Promise.all([a, b, c].map(async (id) => (await ride(id)).estimatedFare));
      expect(fares).toEqual([318, 100, 100]);

      // each bill's stretches add up to that passenger's fare: nothing dropped, nothing double-counted
      let fromBills = 0;
      for (const [id, who, fare] of [[a, nusrat, 318], [b, rafiq, 100], [c, shirin, 100]] as const) {
        const bill = (await view(id, who)).body.ride.fareBreakdown;
        const sum = bill.segments.reduce((s: number, x: any) => s + x.charge, 0);
        expect(sum).toBe(fare);
        fromBills += sum;
      }
      expect(fromBills).toBe(518); // what the driver earns: 318 + 100 + 100
      // the stretch Nusrat travelled alone was 236 of her 318; the other 82 was the shared stretch (61.25 → 62, + 20)
      const nusratBill = (await view(a, nusrat)).body.ride.fareBreakdown;
      expect(nusratBill.segments.map((x: any) => x.charge)).toEqual([236, 0, 82]);
    });
  });
});
