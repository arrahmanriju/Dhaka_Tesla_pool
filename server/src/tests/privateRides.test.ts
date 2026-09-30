/**
 * Private rides ("Allow sharing" switched OFF on the request form). Sharing is ON by default.
 *
 *   1. A private ride always pays the flat price of its route (Gulshan → Dhanmondi = ৳300), whatever the
 *      pool: no segments, no split, no ৳20 bonus, no rounding.
 *   2. It is never a pooling opportunity: it is not offered to a driver who already has passengers, it
 *      cannot join a vehicle that has any, and a vehicle carrying it (matched or started) takes nobody.
 *      (It IS offered to a driver with an empty vehicle: that is how it gets a driver at all.)
 *   3. Its only capacity rule is the normal one: the vehicle must have the seats it asked for.
 *   4. `allowSharing` is fixed when the ride is requested.
 */
import request from 'supertest';
import { app } from '../index';
import { sequelize, User, Vehicle, RideRequest, RideEvent, PoolCheckpoint } from '../models';
import { asUser } from './helpers';
import { recalculatePoolFares } from '../utils/poolFares';
import { pooledFare, estimateFare } from '../utils/fareCalculator';

let jashim: any; // driver with a 3-seat Bullet
let karim: any; // driver with a 2-seat car
let nusrat: any;
let rafiq: any;
let shirin: any;
let bullet: any;
let mini: any;

type Trip = { pickupZone: string; destinationZone: string; seatCount?: number; allowSharing?: boolean };
const GULSHAN_TO_DHANMONDI: Trip = { pickupZone: 'Gulshan', destinationZone: 'Dhanmondi' };
const PRIVATE: Trip = { ...GULSHAN_TO_DHANMONDI, allowSharing: false };

const requestRide = (p: any, trip: Trip = GULSHAN_TO_DHANMONDI) =>
  request(app).post('/ride-requests').set(asUser(p.id)).send({ seatCount: 1, ...trip });
const accept = (id: string, driver: any = jashim, extra: Record<string, unknown> = {}) =>
  request(app).post(`/ride-requests/${id}/accept`).send({ driverId: driver.id, ...extra });
const driverAction = (id: string, action: 'arrive' | 'start' | 'complete', driver: any = jashim) =>
  request(app).patch(`/driver/rides/${id}/${action}`).send({ driverId: driver.id });
const pending = async (driver: any) =>
  ((await request(app).get(`/ride-requests/pending?driverId=${driver.id}`)).body.requests as any[]).map((r) => r.id as string);
const ride = async (id: string) => (await RideRequest.findByPk(id))!;
const view = (id: string, who: any) => request(app).get(`/passenger/rides/${id}`).set(asUser(who.id));
const idOf = (res: request.Response) => res.body.rideRequest.id as string;

beforeAll(async () => {
  await sequelize.sync({ force: true });
});
afterAll(async () => {
  await sequelize.close();
});

describe('Private rides (Allow sharing OFF)', () => {
  beforeEach(async () => {
    const mk = async (name: string, role: 'DRIVER' | 'PASSENGER', n: number) =>
      (await User.create({ name: `${name} Test`, phone: `0171600000${n}`, email: `${name.toLowerCase()}-pr@test.com`, password: 'x', role })).toJSON();
    jashim = await mk('Jashim', 'DRIVER', 0);
    karim = await mk('Karim', 'DRIVER', 4);
    nusrat = await mk('Nusrat', 'PASSENGER', 1);
    rafiq = await mk('Rafiq', 'PASSENGER', 2);
    shirin = await mk('Shirin', 'PASSENGER', 3);
    bullet = (await Vehicle.create({ driverId: jashim.id, modelName: 'Bullet', seatCapacity: 3, licensePlate: 'DTP-0001' })).toJSON();
    mini = (await Vehicle.create({ driverId: karim.id, modelName: 'Mini', seatCapacity: 2, licensePlate: 'DTP-0002' })).toJSON();
  });
  afterEach(async () => {
    await PoolCheckpoint.destroy({ where: {} });
    await RideEvent.destroy({ where: {} });
    await RideRequest.destroy({ where: {} });
    await Vehicle.destroy({ where: {} });
    await User.destroy({ where: {} });
  });

  // ───────────────────────────── the default ─────────────────────────────
  it('sharing is ON when the request does not say: pooling is unchanged', async () => {
    const created = await requestRide(nusrat);
    expect(created.status).toBe(201);
    expect(created.body.rideRequest.allowSharing).toBe(true);
    const other = await requestRide(rafiq);
    expect((await accept(idOf(created))).status).toBe(200);
    expect((await accept(idOf(other))).status).toBe(200); // both share the Bullet
    expect((await ride(idOf(created))).estimatedFare).toBe(170); // 300 / 2 + 20
  });

  // ───────────────────────────── 1. the flat price ─────────────────────────────
  describe('the fare is always the flat price of the route', () => {
    it('the estimate: Gulshan → Dhanmondi is exactly ৳300, with no pool fare and no tiers', async () => {
      const est = await request(app)
        .get('/ride-requests/estimate?pickupZone=Gulshan&destinationZone=Dhanmondi&seatCount=1&allowSharing=false')
        .set(asUser(nusrat.id));
      expect(est.status).toBe(200);
      expect(est.body).toMatchObject({ baseFare: 300, fare: 300, poolFare: null, tiers: [] });
      expect(estimateFare('Gulshan', 'Dhanmondi', 1, false)).toMatchObject({ fare: 300, poolFare: null, tiers: [] });
    });

    it('the request is stored at ৳300 with no pool discount, and stays ৳300 through matching, the trip and completion', async () => {
      const created = await requestRide(nusrat, PRIVATE);
      expect(created.status).toBe(201);
      const id = idOf(created);
      expect(created.body.rideRequest).toMatchObject({ allowSharing: false, baseFare: 300, estimatedFare: 300, poolDiscount: 0 });

      expect((await accept(id)).status).toBe(200);
      expect(await ride(id)).toMatchObject({ status: 'MATCHED', estimatedFare: 300, poolDiscount: 0 });
      expect((await driverAction(id, 'arrive')).status).toBe(200);
      expect((await driverAction(id, 'start')).status).toBe(200);
      expect(await ride(id)).toMatchObject({ status: 'STARTED', estimatedFare: 300, poolDiscount: 0 });

      expect((await driverAction(id, 'complete')).status).toBe(200);
      const done = await ride(id);
      expect(done).toMatchObject({ status: 'COMPLETED', baseFare: 300, estimatedFare: 300, poolDiscount: 0, paymentAmount: 300 });
      // exactly the flat price: no segments, no split, no ৳20 bonus
      const bill = (await view(id, nusrat)).body.ride.fareBreakdown;
      expect(bill).toMatchObject({ final: true, fare: 300, soloFare: 300, poolDiscount: 0 });
      expect(bill.segments).toEqual([]);
    });

    it('a seat count scales the flat price like any route: 2 seats = 100 + 10 × 20 × 2 = ৳500', async () => {
      const created = await requestRide(nusrat, { ...PRIVATE, seatCount: 2 });
      expect(created.body.rideRequest).toMatchObject({ baseFare: 500, estimatedFare: 500 });
    });

    it('the segment / split logic is not used at all: whatever the pool size, the price does not move', () => {
      for (const poolSize of [1, 2, 3, 4, 7, 50]) expect(pooledFare('Gulshan', 'Dhanmondi', 1, poolSize, false)).toBe(300);
      // ...while a sharing ride splits: 300 / 2 + 20 = 170
      expect(pooledFare('Gulshan', 'Dhanmondi', 1, 2, true)).toBe(170);
    });

    it('recalculating a pool never touches a private ride, even if the vehicle record holds more rides', async () => {
      const privateRide = await RideRequest.create({
        passengerId: nusrat.id, driverId: jashim.id, vehicleId: bullet.id, pickupZone: 'Gulshan', destinationZone: 'Dhanmondi',
        seatCount: 1, allowSharing: false, baseFare: 300, estimatedFare: 300, poolDiscount: 0, status: 'MATCHED',
      });
      const sharedRide = await RideRequest.create({
        passengerId: rafiq.id, driverId: jashim.id, vehicleId: bullet.id, pickupZone: 'Gulshan', destinationZone: 'Dhanmondi',
        seatCount: 1, allowSharing: true, baseFare: 300, estimatedFare: 300, poolDiscount: 0, status: 'MATCHED',
      });
      await recalculatePoolFares(bullet.id);
      expect(await privateRide.reload()).toMatchObject({ estimatedFare: 300, poolDiscount: 0 });
      expect((await sharedRide.reload()).estimatedFare).toBe(170);
    });
  });

  // ───────────────────────────── 2. never poolable ─────────────────────────────
  describe('it is never a pooling opportunity', () => {
    it('another passenger’s own lists never contain it, and it does not join their pool', async () => {
      const sharedId = idOf(await requestRide(nusrat));
      await accept(sharedId);
      const privateId = idOf(await requestRide(rafiq, PRIVATE));

      const active = await request(app).get('/passenger/rides/active').set(asUser(nusrat.id));
      expect(JSON.stringify(active.body)).not.toContain(privateId);
      expect(JSON.stringify(active.body)).not.toContain(rafiq.id);
      expect(active.body.rides[0].pool.otherPassengers).toEqual([]);
      const mine = await request(app).get('/ride-requests/me').set(asUser(nusrat.id));
      expect(JSON.stringify(mine.body)).not.toContain(privateId);
      expect((await view(privateId, nusrat)).status).toBe(403); // not hers to see
    });

    it('a driver who already has a passenger is never offered it, and cannot accept it (before the trip)', async () => {
      await accept(idOf(await requestRide(nusrat)));
      const privateId = idOf(await requestRide(rafiq, PRIVATE));

      expect(await pending(jashim)).not.toContain(privateId);
      const res = await accept(privateId);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CANDIDATE_IS_PRIVATE');
      expect((await ride(privateId)).status).toBe('REQUESTED');
    });

    it('...and not once that passenger’s trip has STARTED either (the mid-trip route filter)', async () => {
      const sharedId = idOf(await requestRide(nusrat));
      await accept(sharedId);
      await driverAction(sharedId, 'arrive');
      await driverAction(sharedId, 'start');
      const privateId = idOf(await requestRide(rafiq, PRIVATE));

      expect(await pending(jashim)).not.toContain(privateId);
      expect((await accept(privateId)).status).toBe(409);
    });

    it('a driver with an EMPTY vehicle is offered it: that is how a private ride gets its driver', async () => {
      const privateId = idOf(await requestRide(rafiq, PRIVATE));
      expect(await pending(jashim)).toContain(privateId);
      expect(await pending(karim)).toContain(privateId);
    });

    it('once it is MATCHED, nobody can be added: not offered, and accepting is refused', async () => {
      const privateId = idOf(await requestRide(nusrat, PRIVATE));
      await accept(privateId);
      const sharer = idOf(await requestRide(rafiq)); // the same route, sharing on

      expect(await pending(jashim)).not.toContain(sharer);
      const res = await accept(sharer);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('VEHICLE_IS_PRIVATE');
      expect(await pending(karim)).toContain(sharer); // an empty vehicle elsewhere can still take them
    });

    it('...and not once the private ride has STARTED, even on the very same road', async () => {
      const privateId = idOf(await requestRide(nusrat, PRIVATE));
      await accept(privateId);
      await driverAction(privateId, 'arrive');
      await driverAction(privateId, 'start');
      const sharer = idOf(await requestRide(rafiq));

      expect(await pending(jashim)).not.toContain(sharer);
      const res = await accept(sharer);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('VEHICLE_IS_PRIVATE');
      expect(await ride(privateId)).toMatchObject({ status: 'STARTED', estimatedFare: 300 }); // untouched
    });

    it('two private requests never share a vehicle either', async () => {
      const a = idOf(await requestRide(nusrat, PRIVATE));
      const b = idOf(await requestRide(rafiq, PRIVATE));
      expect((await accept(a)).status).toBe(200);
      expect(await pending(jashim)).not.toContain(b);
      expect((await accept(b)).status).toBe(409);
    });
  });

  // ───────────────────────────── 3. capacity baseline ─────────────────────────────
  describe('it still respects the vehicle’s capacity', () => {
    it('a private ride asking for more seats than the vehicle has is not offered and cannot be accepted', async () => {
      const big = idOf(await requestRide(nusrat, { ...PRIVATE, seatCount: 3 })); // Karim's Mini has 2 seats
      expect(await pending(karim)).not.toContain(big);
      const res = await accept(big, karim);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/seats/i);
      expect((await Vehicle.findByPk(mini.id))!.occupiedSeats).toBe(0);
    });

    it('a private ride that fits takes exactly its seats: 2 seats on the 2-seat Mini', async () => {
      const two = idOf(await requestRide(nusrat, { ...PRIVATE, seatCount: 2 }));
      expect((await accept(two, karim)).status).toBe(200);
      expect((await Vehicle.findByPk(mini.id))!.occupiedSeats).toBe(2);
    });

    it('a vehicle with no free seat cannot take a private ride, though no pooling logic is involved', async () => {
      await Vehicle.update({ occupiedSeats: 3 }, { where: { id: bullet.id } }); // full, with no ride records
      const privateId = idOf(await requestRide(nusrat, PRIVATE));
      expect(await pending(jashim)).not.toContain(privateId);
      expect((await accept(privateId)).status).toBe(409);
      expect((await Vehicle.findByPk(bullet.id))!.occupiedSeats).toBe(3); // never overbooked
    });

    it('two private requests accepted at the same moment: exactly one wins, and the seats never go past capacity', async () => {
      const a = idOf(await requestRide(nusrat, PRIVATE));
      const b = idOf(await requestRide(rafiq, PRIVATE));
      const results = await Promise.all([accept(a), accept(b)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const v = await Vehicle.findByPk(bullet.id);
      expect(v!.occupiedSeats).toBe(1);
      expect(v!.occupiedSeats).toBeLessThanOrEqual(v!.seatCapacity);
    });

    it('a private ride frees its seat on completion like any other', async () => {
      const id = idOf(await requestRide(nusrat, PRIVATE));
      await accept(id);
      await driverAction(id, 'arrive');
      await driverAction(id, 'start');
      await driverAction(id, 'complete');
      expect((await Vehicle.findByPk(bullet.id))!.occupiedSeats).toBe(0);
    });
  });

  // ───────────────────────────── 4. fixed for the ride's lifetime ─────────────────────────────
  describe('the flag is fixed once the ride is requested', () => {
    it('there is no way to change it through the API: no route accepts it, and a body value is ignored', async () => {
      const privateId = idOf(await requestRide(nusrat, PRIVATE));
      const sharedId = idOf(await requestRide(rafiq));
      // Even sent along with real actions, it changes nothing
      expect((await accept(privateId, jashim, { allowSharing: true })).status).toBe(200);
      expect((await ride(privateId)).allowSharing).toBe(false);
      await driverAction(privateId, 'arrive');
      expect((await request(app).patch(`/driver/rides/${privateId}/start`).send({ driverId: jashim.id, allowSharing: true })).status).toBe(200);
      expect((await ride(privateId)).allowSharing).toBe(false);

      expect((await accept(sharedId, karim, { allowSharing: false })).status).toBe(200);
      expect((await ride(sharedId)).allowSharing).toBe(true);

      // and there is simply no route for editing a ride
      for (const [method, url] of [
        ['patch', `/ride-requests/${privateId}`],
        ['put', `/ride-requests/${privateId}`],
        ['patch', `/passenger/rides/${privateId}`],
        ['patch', `/passenger/rides/${privateId}/sharing`],
      ] as const) {
        const res = await request(app)[method](url).set(asUser(nusrat.id)).send({ allowSharing: true });
        expect(res.status).toBe(404);
      }
      expect((await ride(privateId)).allowSharing).toBe(false);
    });

    it('a direct update is refused too, for a REQUESTED, MATCHED or STARTED ride, one at a time or in bulk', async () => {
      const id = idOf(await requestRide(nusrat, PRIVATE));
      const message = /allowSharing is fixed/;

      // REQUESTED
      await expect(RideRequest.update({ allowSharing: true } as any, { where: { id } })).rejects.toThrow(message);
      const row = await ride(id);
      row.allowSharing = true;
      await expect(row.save()).rejects.toThrow(message);

      // MATCHED
      await accept(id);
      await expect(RideRequest.update({ allowSharing: true } as any, { where: { id } })).rejects.toThrow(message);

      // STARTED
      await driverAction(id, 'arrive');
      await driverAction(id, 'start');
      await expect(RideRequest.update({ allowSharing: true } as any, { where: { id } })).rejects.toThrow(message);

      expect(await ride(id)).toMatchObject({ allowSharing: false, status: 'STARTED', estimatedFare: 300 });
    });

    it('other updates to the same ride still work (only the sharing flag is locked)', async () => {
      const id = idOf(await requestRide(nusrat, PRIVATE));
      await accept(id);
      await driverAction(id, 'arrive');
      await driverAction(id, 'start');
      await driverAction(id, 'complete');
      expect((await ride(id)).status).toBe('COMPLETED');
    });

    it('a shared ride cannot be turned private either: it keeps pooling', async () => {
      const a = idOf(await requestRide(nusrat));
      await accept(a);
      await expect(RideRequest.update({ allowSharing: false } as any, { where: { id: a } })).rejects.toThrow(/allowSharing is fixed/);
      const b = idOf(await requestRide(rafiq));
      expect((await accept(b)).status).toBe(200); // still poolable
    });
  });

  // ───────────────────────────── validation ─────────────────────────────
  it('allowSharing must be true or false when it is sent', async () => {
    const res = await requestRide(nusrat, { ...GULSHAN_TO_DHANMONDI, allowSharing: 'no' as any });
    expect(res.status).toBe(400);
    expect(res.body.fields.allowSharing).toBeTruthy();
  });
});
