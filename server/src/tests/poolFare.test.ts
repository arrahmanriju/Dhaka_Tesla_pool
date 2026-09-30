/**
 * Pool fares — the QUOTE model (before and while a ride runs). Final fares, settled from the pool's
 * checkpoints when a journey ends, are covered in segmentFares.test.ts.
 *
 *   fare = ৳100 base fare + distanceCharge × share rate, rounded to the nearest ৳5
 *   distanceCharge = distanceKm × ৳20 × seats        share rate: 1 passenger 100% · 2 → 70% · 3 → 55%
 *   the driver earns the SUM of what the passengers pay
 *
 * The story cast is the seed data: Jashim (driver, "Bullet", 3 seats) and passengers Nusrat, Rafiq
 * and Shirin, all wanting Mohakhali → Badda. That route is 4 km: distance charge ৳80, so
 *   ৳180 alone · 100 + 80 × 70% = 156 → ৳155 with 2 · 100 + 80 × 55% = 144 → ৳145 with 3.
 */
import request from 'supertest';
import { app } from '../index';
import { sequelize, User, Vehicle, RideRequest } from '../models';
import { ensureOneActiveRideIndex, migrateFaresToTaka, FARES_IN_TAKA_VERSION } from '../migrations';
import { asUser } from './helpers';
import {
  calculateBaseFare,
  calculateFareForPassenger,
  estimateFare,
  pooledFare,
  roundToNearest5,
  shareRatePercent,
} from '../utils/fareCalculator';
import { recalculatePoolFares } from '../utils/poolFares';

// One database connection for the whole file (the describes below share it).
beforeAll(async () => {
  await sequelize.sync({ force: true });
  await ensureOneActiveRideIndex();
});
afterAll(async () => {
  await sequelize.close();
});

// ───────────────────────────── pure fare math ─────────────────────────────
describe('fare math', () => {
  describe('share rate', () => {
    it('is 100% alone, 70% with two passengers, 55% with three', () => {
      expect(shareRatePercent(1)).toBe(100);
      expect(shareRatePercent(2)).toBe(70);
      expect(shareRatePercent(3)).toBe(55);
    });

    it('keeps the 3-passenger rate for a bigger pool, and never goes above 100%', () => {
      expect(shareRatePercent(4)).toBe(55);
      expect(shareRatePercent(7)).toBe(55);
      expect(shareRatePercent(0)).toBe(100);
    });

    it('is always 100% for a private ride, whatever the pool size', () => {
      for (const size of [1, 2, 3, 4]) expect(shareRatePercent(size, false)).toBe(100);
    });
  });

  describe('the story: a 5 km route (Mirpur → Mohammadpur): distance charge ৳100', () => {
    it('1 passenger pays ৳200 and the driver earns ৳200', () => {
      expect(pooledFare('Mirpur', 'Mohammadpur', 1, 1)).toBe(200);
    });

    it('2 passengers pay 100 + 70 = ৳170 each and the driver earns ৳340', () => {
      const fare = pooledFare('Mirpur', 'Mohammadpur', 1, 2);
      expect(fare).toBe(170);
      expect(fare * 2).toBe(340);
    });

    it('3 passengers pay 100 + 55 = ৳155 each and the driver earns ৳465', () => {
      const fare = pooledFare('Mirpur', 'Mohammadpur', 1, 3);
      expect(fare).toBe(155);
      expect(fare * 3).toBe(465);
    });
  });

  describe('base fare and rounding to the nearest ৳5', () => {
    it('Mohakhali → Badda (4 km, 1 seat) has a solo fare of ৳180', () => {
      expect(calculateBaseFare('Mohakhali', 'Badda', 1)).toBe(180);
    });

    it.each([
      // route, km, alone, with 2 (70% of the distance charge), with 3 (55%)
      ['Mohakhali', 'Badda', 4, 180, 155, 145], // 156 → 155, 144 → 145
      ['Mohakhali', 'Gulshan', 3, 160, 140, 135], // 142 → 140, 133 → 135
      ['Mohakhali', 'Banani', 2, 140, 130, 120], // 128 → 130, 122 → 120
      ['Gulshan', 'Gulshan 1', 1, 120, 115, 110], // 114 → 115, 111 → 110
      ['Mirpur', 'Mohammadpur', 5, 200, 170, 155], // exact
    ])('%s → %s (%i km): alone ৳%i · with 2 ৳%i · with 3 ৳%i', (from, to, _km, alone, two, three) => {
      expect(pooledFare(from, to, 1, 1)).toBe(alone);
      expect(pooledFare(from, to, 1, 2)).toBe(two);
      expect(pooledFare(from, to, 1, 3)).toBe(three);
    });

    it('rounds halves up (17.5 → 20)', () => {
      expect(roundToNearest5(17.5)).toBe(20);
      expect(roundToNearest5(12.4)).toBe(10);
    });

    it('always returns whole taka in multiples of ৳5, never above the solo fare, and falls as more join', () => {
      const routes: [string, string][] = [['Gulshan', 'Gulshan 1'], ['Mohakhali', 'Badda'], ['Uttara', 'Motijheel'], ['Mirpur', 'Dhanmondi']];
      for (const [from, to] of routes) {
        for (const seats of [1, 2, 3]) {
          const solo = calculateBaseFare(from, to, seats);
          const fares = [1, 2, 3].map((n) => pooledFare(from, to, seats, n));
          fares.forEach((f) => {
            expect(Number.isInteger(f)).toBe(true);
            expect(f % 5).toBe(0);
            expect(f).toBeLessThanOrEqual(solo);
          });
          expect(fares[0]).toBe(solo);
          expect(fares[1]!).toBeLessThanOrEqual(fares[0]!);
          expect(fares[2]!).toBeLessThanOrEqual(fares[1]!);
        }
      }
    });

    it('the ৳100 base fare is never discounted: even a huge pool only discounts the distance part', () => {
      expect(pooledFare('Mohakhali', 'Badda', 1, 3)).toBeGreaterThanOrEqual(100);
      expect(pooledFare('Mohakhali', 'Badda', 1, 50)).toBe(pooledFare('Mohakhali', 'Badda', 1, 3)); // 3+ share one rate
    });
  });

  describe('each passenger pays for their OWN route', () => {
    it('two passengers with different destinations get different fares', () => {
      // Nusrat Mohakhali → Badda (4 km, charge ৳80): 100 + 56 = 156 → 155.  Rafiq Mohakhali → Gulshan (3 km, ৳60): 100 + 42 = 142 → 140.
      const nusrat = calculateFareForPassenger('Mohakhali', 'Badda', 1, 2);
      const rafiq = calculateFareForPassenger('Mohakhali', 'Gulshan', 1, 2);
      expect(nusrat).toBe(155);
      expect(rafiq).toBe(140);
      expect(nusrat + rafiq).toBe(295); // what the driver earns
    });

    it('a private ride always costs its full solo fare', () => {
      expect(calculateFareForPassenger('Mohakhali', 'Badda', 1, 3, false)).toBe(180);
    });
  });

  describe('estimate shown on the Request Ride page', () => {
    it('shows the price alone and how it drops as others join', () => {
      expect(estimateFare('Mohakhali', 'Badda', 1, true)).toEqual({
        baseFare: 180,
        fare: 180,
        poolFare: 155,
        tiers: [
          { passengers: 2, ratePercent: 70, fare: 155 },
          { passengers: 3, ratePercent: 55, fare: 145 },
        ],
      });
    });

    it('offers no drop for a private ride, or for a booking that fills the car', () => {
      expect(estimateFare('Mohakhali', 'Badda', 1, false)).toMatchObject({ fare: 180, poolFare: null, tiers: [] });
      expect(estimateFare('Mohakhali', 'Badda', 3, true).tiers).toEqual([]);
    });

    it('a 2-seat booking can only ever be joined by one more passenger', () => {
      expect(estimateFare('Mohakhali', 'Badda', 2, true).tiers.map((t) => t.passengers)).toEqual([2]);
    });
  });
});

// ───────────────────────────── the story, end to end ─────────────────────────────
let jashim: any;
let nusrat: any;
let rafiq: any;
let shirin: any;
let bullet: any;

const MOHAKHALI_TO_BADDA = { pickupZone: 'Mohakhali', destinationZone: 'Badda', seatCount: 1, allowSharing: true };

const requestRide = (passenger: any, body: Record<string, unknown> = MOHAKHALI_TO_BADDA) =>
  request(app).post('/ride-requests').set(asUser(passenger.id)).send(body);
const accept = (rideId: string) => request(app).post(`/ride-requests/${rideId}/accept`).send({ driverId: jashim.id });
const driverAction = (rideId: string, action: 'arrive' | 'start' | 'complete' | 'cancel') =>
  request(app).patch(`/driver/rides/${rideId}/${action}`).send({ driverId: jashim.id });
const passengerCancel = (rideId: string, passenger: any) =>
  request(app).patch(`/passenger/rides/${rideId}/cancel`).set(asUser(passenger.id)).send({ passengerId: passenger.id });
const driverActive = () => request(app).get(`/driver/rides/active?driverId=${jashim.id}`);
const passengerActive = (passenger: any) => request(app).get('/passenger/rides/active').set(asUser(passenger.id));
const fareOf = async (rideId: string) => (await RideRequest.findByPk(rideId))!.estimatedFare;

/** Requests a ride for `passenger` and has Jashim accept it. Returns the ride id. */
async function joinPool(passenger: any, body: Record<string, unknown> = MOHAKHALI_TO_BADDA): Promise<string> {
  const created = await requestRide(passenger, body);
  expect(created.status).toBe(201);
  const id = created.body.rideRequest.id as string;
  expect((await accept(id)).status).toBe(200);
  return id;
}

describe('Pool fare split — Nusrat, Rafiq, Shirin and Jashim (Bullet)', () => {
  beforeEach(async () => {
    const mk = async (name: string, role: 'DRIVER' | 'PASSENGER', n: number) =>
      (await User.create({ name, phone: `0171100000${n}`, email: `${name.toLowerCase()}@test.com`, password: 'x', role })).toJSON();
    jashim = await mk('Jashim', 'DRIVER', 0);
    nusrat = await mk('Nusrat', 'PASSENGER', 1);
    rafiq = await mk('Rafiq', 'PASSENGER', 2);
    shirin = await mk('Shirin', 'PASSENGER', 3);
    bullet = (await Vehicle.create({ driverId: jashim.id, modelName: 'Bullet', seatCapacity: 3, licensePlate: 'DTP-0001' })).toJSON();
  });
  afterEach(async () => {
    await RideRequest.destroy({ where: {} });
    await Vehicle.destroy({ where: {} });
    await User.destroy({ where: {} });
  });

  describe('1, 2 and 3 passengers', () => {
    it('1 passenger: Nusrat pays ৳180 (her solo fare); the driver earns ৳180', async () => {
      const nusratRide = await joinPool(nusrat);

      expect(await fareOf(nusratRide)).toBe(180);
      const mine = (await passengerActive(nusrat)).body.rides[0];
      expect(mine).toMatchObject({ baseFare: 180, estimatedFare: 180, poolDiscount: 0, poolSize: 1, shareRatePercent: 100, fareFinal: false });
      expect((await driverActive()).body).toMatchObject({ poolSize: 1, totalEarnings: 180 });
    });

    it('2 passengers: Nusrat and Rafiq each pay 100 + 56 = ৳155; the driver earns ৳310', async () => {
      const nusratRide = await joinPool(nusrat);
      const rafiqRide = await joinPool(rafiq);

      expect(await fareOf(nusratRide)).toBe(155); // Nusrat's fare was re-estimated when Rafiq joined
      expect(await fareOf(rafiqRide)).toBe(155);
      const mine = (await passengerActive(nusrat)).body.rides[0];
      expect(mine).toMatchObject({ baseFare: 180, estimatedFare: 155, poolDiscount: 25, poolSize: 2, shareRatePercent: 70, isSharedRide: true });
      expect((await driverActive()).body).toMatchObject({ poolSize: 2, totalEarnings: 310 });
    });

    it('3 passengers: Nusrat, Rafiq and Shirin each pay 100 + 44 = ৳145; the driver earns ৳435', async () => {
      const nusratRide = await joinPool(nusrat);
      const rafiqRide = await joinPool(rafiq);
      const shirinRide = await joinPool(shirin);

      for (const id of [nusratRide, rafiqRide, shirinRide]) expect(await fareOf(id)).toBe(145);
      const mine = (await passengerActive(shirin)).body.rides[0];
      expect(mine).toMatchObject({ baseFare: 180, estimatedFare: 145, poolDiscount: 35, poolSize: 3, shareRatePercent: 55, coPassengers: 2 });
      expect((await driverActive()).body).toMatchObject({ poolSize: 3, totalEarnings: 435, vehicle: { modelName: 'Bullet', occupiedSeats: 3 } });
    });

    it('a passenger only ever sees their own fare, never a co-passenger\'s', async () => {
      await joinPool(nusrat);
      await joinPool(rafiq);
      const body = JSON.stringify((await passengerActive(nusrat)).body);
      // Only the co-passenger's FIRST NAME is shown (see rideStatus.test.ts): no id, phone or fare of theirs.
      expect(body).not.toContain(rafiq.id);
      expect(body).not.toContain(rafiq.phone);
      expect((await passengerActive(nusrat)).body.rides[0].pool.otherPassengers).toEqual([{ firstName: 'Rafiq' }]);
    });
  });

  describe('recalculation when a passenger leaves before the trip', () => {
    it('Shirin cancels → Nusrat and Rafiq go from ৳145 back up to ৳155; the driver earns ৳310', async () => {
      const nusratRide = await joinPool(nusrat);
      const rafiqRide = await joinPool(rafiq);
      const shirinRide = await joinPool(shirin);
      expect(await fareOf(nusratRide)).toBe(145);

      expect((await passengerCancel(shirinRide, shirin)).status).toBe(200);

      expect(await fareOf(nusratRide)).toBe(155);
      expect(await fareOf(rafiqRide)).toBe(155);
      expect(await fareOf(shirinRide)).toBe(145); // the cancelled ride is not re-priced
      expect((await driverActive()).body).toMatchObject({ poolSize: 2, totalEarnings: 310 });
    });

    it('a second passenger cancels → the last one is back to the full ৳180', async () => {
      const nusratRide = await joinPool(nusrat);
      const rafiqRide = await joinPool(rafiq);
      expect(await fareOf(nusratRide)).toBe(155);

      await passengerCancel(rafiqRide, rafiq);

      expect(await fareOf(nusratRide)).toBe(180);
      expect((await passengerActive(nusrat)).body.rides[0]).toMatchObject({ estimatedFare: 180, poolDiscount: 0, poolSize: 1 });
    });

    it('the driver cancelling a passenger also re-prices the others', async () => {
      const nusratRide = await joinPool(nusrat);
      const rafiqRide = await joinPool(rafiq);
      const shirinRide = await joinPool(shirin);

      expect((await driverAction(shirinRide, 'cancel')).status).toBe(200);
      expect(await fareOf(nusratRide)).toBe(155);
      expect(await fareOf(rafiqRide)).toBe(155);

      expect((await driverAction(rafiqRide, 'cancel')).status).toBe(200);
      expect(await fareOf(nusratRide)).toBe(180);
    });

    it('someone joining again brings the fare back down', async () => {
      const nusratRide = await joinPool(nusrat);
      const rafiqRide = await joinPool(rafiq);
      await passengerCancel(rafiqRide, rafiq);
      expect(await fareOf(nusratRide)).toBe(180);

      await joinPool(shirin);
      expect(await fareOf(nusratRide)).toBe(155);
    });
  });

  describe('once the ride has STARTED the fare follows who is actually on board (no lock)', () => {
    it('a started passenger is priced by the passengers on board, not by who is merely matched', async () => {
      const nusratRide = await joinPool(nusrat);
      const rafiqRide = await joinPool(rafiq);
      await driverAction(nusratRide, 'arrive');
      await driverAction(rafiqRide, 'arrive');
      expect(await fareOf(nusratRide)).toBe(155); // both matched: quoted for a pool of 2

      // Nusrat boards first and is alone in the car: her estimate is the solo fare...
      expect((await driverAction(nusratRide, 'start')).status).toBe(200);
      expect(await fareOf(nusratRide)).toBe(180);
      // ...and Rafiq boarding makes it 2 on board, so the estimate falls again: nothing was locked.
      expect((await driverAction(rafiqRide, 'start')).status).toBe(200);
      expect(await fareOf(nusratRide)).toBe(155);
      expect(await fareOf(rafiqRide)).toBe(155);
      const mine = (await passengerActive(nusrat)).body.rides[0];
      expect(mine).toMatchObject({ status: 'STARTED', estimatedFare: 155, fareFinal: false });
    });

    it('someone who joins after the trip has started: the started passenger is not repriced until they board', async () => {
      const nusratRide = await joinPool(nusrat);
      await driverAction(nusratRide, 'arrive');
      await driverAction(nusratRide, 'start');

      const late = await requestRide(rafiq);
      const res = await accept(late.body.rideRequest.id);
      expect(res.status).toBe(200);
      // Rafiq is matched (pool of 2 → quoted 155) but not on board; Nusrat is still alone in the car.
      expect(await fareOf(nusratRide)).toBe(180);
      expect(await fareOf(late.body.rideRequest.id)).toBe(155);

      await driverAction(late.body.rideRequest.id, 'arrive');
      await driverAction(late.body.rideRequest.id, 'start');
      expect(await fareOf(nusratRide)).toBe(155);
    });

    it('a direct recalculation does not disturb a fare that is already final', async () => {
      const nusratRide = await joinPool(nusrat);
      await driverAction(nusratRide, 'arrive');
      await driverAction(nusratRide, 'start');
      await driverAction(nusratRide, 'complete');
      const final = await fareOf(nusratRide);
      expect(final).toBe(180);

      await recalculatePoolFares(bullet.id);
      expect(await fareOf(nusratRide)).toBe(final);
    });

    it('finishing the trip settles the fare, and history shows the settled amount', async () => {
      const nusratRide = await joinPool(nusrat);
      const rafiqRide = await joinPool(rafiq);
      for (const id of [nusratRide, rafiqRide]) {
        await driverAction(id, 'arrive');
        await driverAction(id, 'start');
      }
      await driverAction(rafiqRide, 'complete');
      await driverAction(nusratRide, 'complete');

      // Both were on board together for the whole 4 km: 100 + 80 × 70% = 156 → ৳155 each
      expect(await fareOf(nusratRide)).toBe(155);
      expect(await fareOf(rafiqRide)).toBe(155);
      const history = await request(app).get(`/driver/rides/history?driverId=${jashim.id}`);
      expect(history.body.rides.map((r: any) => r.estimatedFare)).toEqual([155, 155]);
    });
  });

  describe('private rides', () => {
    it('always pay 100%, and nobody can be pooled with them', async () => {
      const privateRide = await joinPool(nusrat, { ...MOHAKHALI_TO_BADDA, allowSharing: false });
      expect(await fareOf(privateRide)).toBe(180);

      const other = await requestRide(rafiq);
      expect((await accept(other.body.rideRequest.id)).status).toBe(409);
      expect(await fareOf(privateRide)).toBe(180);
      expect((await passengerActive(nusrat)).body.rides[0]).toMatchObject({ allowSharing: false, estimatedFare: 180, poolDiscount: 0, shareRatePercent: 100 });
    });

    it('stay at 100% even if a pool is somehow larger (recalculation ignores the pool for them)', async () => {
      const privateRide = await RideRequest.create({
        passengerId: nusrat.id, driverId: jashim.id, vehicleId: bullet.id, pickupZone: 'Mohakhali', destinationZone: 'Badda',
        seatCount: 1, allowSharing: false, baseFare: 180, estimatedFare: 180, poolDiscount: 0, status: 'MATCHED',
      });
      const sharedRide = await RideRequest.create({
        passengerId: rafiq.id, driverId: jashim.id, vehicleId: bullet.id, pickupZone: 'Mohakhali', destinationZone: 'Badda',
        seatCount: 1, allowSharing: true, baseFare: 180, estimatedFare: 180, poolDiscount: 0, status: 'MATCHED',
      });
      await recalculatePoolFares(bullet.id);
      expect((await privateRide.reload()).estimatedFare).toBe(180);
      expect((await sharedRide.reload()).estimatedFare).toBe(155);
    });
  });

  describe('each passenger is priced from their own route', () => {
    const seatPool = async (rides: Array<{ passenger: any; to: string; base: number }>) => {
      const created = [];
      for (const { passenger, to, base } of rides) {
        created.push(
          await RideRequest.create({
            passengerId: passenger.id, driverId: jashim.id, vehicleId: bullet.id, pickupZone: 'Mohakhali', destinationZone: to,
            seatCount: 1, allowSharing: true, baseFare: base, estimatedFare: base, poolDiscount: 0, status: 'MATCHED',
          }),
        );
      }
      await recalculatePoolFares(bullet.id);
      return Promise.all(created.map((r) => r.reload()));
    };

    it('different destinations → different fares, and the driver earns their sum', async () => {
      const [a, b] = await seatPool([
        { passenger: nusrat, to: 'Badda', base: 180 }, // 4 km: 100 + 56 = 156 → 155
        { passenger: rafiq, to: 'Gulshan', base: 160 }, // 3 km: 100 + 42 = 142 → 140
      ]);
      expect([a!.estimatedFare, b!.estimatedFare]).toEqual([155, 140]);
      expect([a!.poolDiscount, b!.poolDiscount]).toEqual([25, 20]);
      expect((await driverActive()).body.totalEarnings).toBe(295);
    });

    it('with three passengers on different routes: 55% of each own distance charge', async () => {
      const rides = await seatPool([
        { passenger: nusrat, to: 'Badda', base: 180 }, // 100 + 44 = 144 → 145
        { passenger: rafiq, to: 'Gulshan', base: 160 }, // 100 + 33 = 133 → 135
        { passenger: shirin, to: 'Banani', base: 140 }, // 100 + 22 = 122 → 120
      ]);
      expect(rides.map((r) => r.estimatedFare)).toEqual([145, 135, 120]);
      expect((await driverActive()).body.totalEarnings).toBe(400);
    });

    it('the literal story: a 5 km route pays ৳200 → ৳170 each → ৳155 each, driver ৳200 → ৳340 → ৳465', async () => {
      const total = async () => (await RideRequest.sum('estimatedFare', { where: { vehicleId: bullet.id } })) ?? 0;
      const make = (passenger: any) =>
        RideRequest.create({
          passengerId: passenger.id, driverId: jashim.id, vehicleId: bullet.id, pickupZone: 'Mirpur', destinationZone: 'Mohammadpur',
          seatCount: 1, allowSharing: true, baseFare: 200, estimatedFare: 200, poolDiscount: 0, status: 'MATCHED',
        });

      const r1 = await make(nusrat);
      await recalculatePoolFares(bullet.id);
      expect([(await r1.reload()).estimatedFare, await total()]).toEqual([200, 200]);

      const r2 = await make(rafiq);
      await recalculatePoolFares(bullet.id);
      expect([(await r1.reload()).estimatedFare, (await r2.reload()).estimatedFare, await total()]).toEqual([170, 170, 340]);

      const r3 = await make(shirin);
      await recalculatePoolFares(bullet.id);
      expect([(await r1.reload()).estimatedFare, (await r2.reload()).estimatedFare, (await r3.reload()).estimatedFare, await total()]).toEqual([155, 155, 155, 465]);
    });
  });

  describe('stored money is whole taka', () => {
    it('fares, base fares and savings are integers in multiples of ৳5 at every pool size', async () => {
      const ids = [await joinPool(nusrat), await joinPool(rafiq), await joinPool(shirin)];
      for (const id of ids) {
        const r = (await RideRequest.findByPk(id))!;
        for (const value of [r.baseFare, r.estimatedFare, r.poolDiscount]) {
          expect(Number.isInteger(value)).toBe(true);
          expect(value % 5).toBe(0);
        }
      }
    });
  });
});

// ───────────────────────────── existing databases (paisa → taka) ─────────────────────────────
describe('migrating stored fares from paisa to whole taka', () => {
  afterEach(async () => {
    await RideRequest.destroy({ where: {} });
    await Vehicle.destroy({ where: {} });
    await User.destroy({ where: {} });
  });

  const setVersion = (v: number) => sequelize.query(`PRAGMA user_version = ${v}`);
  const version = async () => ((await sequelize.query('PRAGMA user_version'))[0] as any[])[0].user_version as number;

  it('converts paisa to taka once, re-prices open pools, and never runs twice', async () => {
    const driver = (await User.create({ name: 'Jashim', email: 'j@test.com', password: 'x', role: 'DRIVER' })).toJSON() as any;
    const a = (await User.create({ name: 'Nusrat', email: 'n@test.com', password: 'x', role: 'PASSENGER' })).toJSON() as any;
    const b = (await User.create({ name: 'Rafiq', email: 'r@test.com', password: 'x', role: 'PASSENGER' })).toJSON() as any;
    const c = (await User.create({ name: 'Shirin', email: 's@test.com', password: 'x', role: 'PASSENGER' })).toJSON() as any;
    const vehicle = (await Vehicle.create({ driverId: driver.id, modelName: 'Bullet', seatCapacity: 3, licensePlate: 'DTP-0001' })).toJSON() as any;

    // What an old (paisa, flat ৳30 discount) database looks like. Base ৳180 = 18000 paisa.
    const old = (passengerId: string, status: string, estimatedFare: number, poolDiscount: number, vehicleId: string | null) =>
      RideRequest.create({
        passengerId, driverId: vehicleId ? driver.id : null, vehicleId, pickupZone: 'Mohakhali', destinationZone: 'Badda',
        seatCount: 1, baseFare: 18000, estimatedFare, poolDiscount, status,
      } as any);
    const open1 = await old(a.id, 'MATCHED', 15000, 3000, vehicle.id);
    const open2 = await old(b.id, 'MATCHED', 15000, 3000, vehicle.id);
    const finished = await old(c.id, 'COMPLETED', 15000, 3000, null);
    await setVersion(0);

    await migrateFaresToTaka();

    // Past ride: converted and rounded (15000 paisa = ৳150; discount ৳30)
    await finished.reload();
    expect([finished.baseFare, finished.estimatedFare, finished.poolDiscount]).toEqual([180, 150, 30]);
    // Open pool of two: re-priced with the current model (100 + 80 × 70% = 156 → ৳155, saving ৳25)
    await open1.reload();
    await open2.reload();
    expect([open1.baseFare, open1.estimatedFare, open1.poolDiscount]).toEqual([180, 155, 25]);
    expect([open2.baseFare, open2.estimatedFare, open2.poolDiscount]).toEqual([180, 155, 25]);
    expect(await version()).toBe(FARES_IN_TAKA_VERSION);

    // Second start: nothing is converted again
    await migrateFaresToTaka();
    await finished.reload();
    expect(finished.estimatedFare).toBe(150);
  });

  it('leaves a STARTED ride with no checkpoints at its converted fare', async () => {
    const driver = (await User.create({ name: 'Jashim', email: 'j@test.com', password: 'x', role: 'DRIVER' })).toJSON() as any;
    const a = (await User.create({ name: 'Nusrat', email: 'n@test.com', password: 'x', role: 'PASSENGER' })).toJSON() as any;
    const vehicle = (await Vehicle.create({ driverId: driver.id, modelName: 'Bullet', seatCapacity: 3, licensePlate: 'DTP-0001' })).toJSON() as any;
    const started = await RideRequest.create({
      passengerId: a.id, driverId: driver.id, vehicleId: vehicle.id, pickupZone: 'Mohakhali', destinationZone: 'Badda',
      seatCount: 1, baseFare: 18000, estimatedFare: 15000, poolDiscount: 3000, status: 'STARTED',
    } as any);
    await setVersion(0);

    await migrateFaresToTaka();

    await started.reload();
    // It started before checkpoints existed, so there is no journey to walk: the converted fare stays.
    expect(started.estimatedFare).toBe(150);
  });
});
