/**
 * REGRESSION: nobody but the passenger themselves ever learns who a passenger is.
 *
 * One rule for the whole app, the same as the QR street rides: a driver and the other people in the car see a
 * passenger only as "Passenger 1", "Passenger 2", ... (their number in the car, in the order they were
 * accepted). Never a name (not even a first name), never a phone number or email, never an internal user id.
 *
 * The app flow used to leak first names through the driver's pool timeline and the co-passenger list, and the
 * passenger's user id through the driver's active-ride list, the pending list and the accept response. This
 * test exercises every driver-facing and co-passenger-facing response through a whole pooled trip (request,
 * accept, arrive, start, mid-trip join, leave, complete, history) and scans every response body for any of
 * the passengers' identifying strings, so a new field or a new view that carries one fails here.
 */
import request from 'supertest';
import { app } from '../index';
import { sequelize, User, Vehicle, RideRequest, RideEvent, PoolCheckpoint } from '../models';
import { asUser } from './helpers';

// Distinctive names, phones and emails, so any leak is unmistakable (and none is a substring of another)
const PEOPLE = {
  zubayer: { name: 'Zubayer Chowdhury', phone: '01712340001', email: 'zubayer.chowdhury@leaktest.example' },
  tahmina: { name: 'Tahmina Akter', phone: '01712340002', email: 'tahmina.akter@leaktest.example' },
  ishrat: { name: 'Ishrat Jahan', phone: '01712340003', email: 'ishrat.jahan@leaktest.example' },
  farhan: { name: 'Farhan Mahbub', phone: '01712340004', email: 'farhan.mahbub@leaktest.example' },
} as const;
type Key = keyof typeof PEOPLE;
const KEYS = Object.keys(PEOPLE) as Key[];

let driver: any;
let u: Record<Key, any>;

const trip = { pickupZone: 'Mohakhali', destinationZone: 'Badda', seatCount: 1, allowSharing: true };
const requestRide = async (who: Key) => (await request(app).post('/ride-requests').set(asUser(u[who].id)).send(trip)).body.rideRequest.id as string;
const accept = (rideId: string) => request(app).post(`/ride-requests/${rideId}/accept`).send({ driverId: driver.id });
const act = (rideId: string, a: 'arrive' | 'start' | 'complete' | 'cancel') =>
  request(app).patch(`/driver/rides/${rideId}/${a}`).send({ driverId: driver.id });
const leave = (rideId: string, who: Key, cancellationZone = 'Gulshan') =>
  request(app).patch(`/passenger/rides/${rideId}/cancel-in-transit`).set(asUser(u[who].id)).send({ cancellationZone });
const startTrip = async (rideId: string) => { await act(rideId, 'arrive'); await act(rideId, 'start'); };

/** Everything that identifies a person. Names are checked case-insensitively, one word at a time. */
const identifiers = (k: Key) => {
  const p = PEOPLE[k];
  return [...p.name.split(' '), p.name, p.phone, p.email, u[k].id as string];
};

/** Fails if any identifying string of any of `who` appears anywhere in `body`. */
function expectNoIdentity(where: string, body: unknown, who: Key[] = KEYS) {
  const text = JSON.stringify(body ?? null).toLowerCase();
  for (const k of who) {
    for (const s of identifiers(k)) {
      if (text.includes(s.toLowerCase())) throw new Error(`LEAK in ${where}: the response contains "${s}" (${k})`);
    }
  }
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});
afterAll(async () => {
  await sequelize.close();
});

describe('a passenger is only ever "Passenger N" to a driver and to the others in the car', () => {
  beforeEach(async () => {
    driver = (await User.create({ name: 'Rahim Uddin', phone: '01712349999', email: 'rahim@leaktest.example', password: 'x', role: 'DRIVER' })).toJSON();
    u = {} as Record<Key, any>;
    for (const k of KEYS) u[k] = (await User.create({ ...PEOPLE[k], password: 'x', role: 'PASSENGER' })).toJSON();
    await Vehicle.create({ driverId: driver.id, modelName: 'Bullet', seatCapacity: 3, licensePlate: 'DTP-9001' });
  });
  afterEach(async () => {
    await PoolCheckpoint.destroy({ where: {} });
    await RideEvent.destroy({ where: {} });
    await RideRequest.destroy({ where: {} });
    await Vehicle.destroy({ where: {} });
    await User.destroy({ where: {} });
  });

  /** Every driver-facing response, read at this moment. */
  async function driverViews() {
    const driverAuth = asUser(driver.id, 'DRIVER');
    return {
      'GET /driver/rides/active': (await request(app).get(`/driver/rides/active?driverId=${driver.id}`)).body,
      'GET /driver/rides/history': (await request(app).get(`/driver/rides/history?driverId=${driver.id}`)).body,
      'GET /driver/rides/timeline': (await request(app).get('/driver/rides/timeline').set(driverAuth)).body,
      'GET /ride-requests/pending': (await request(app).get(`/ride-requests/pending?driverId=${driver.id}`)).body,
    };
  }
  /** Every response a passenger gets that could mention the others in the car. */
  async function passengerViews(who: Key, rideId: string) {
    const auth = asUser(u[who].id);
    return {
      'GET /passenger/rides/active': (await request(app).get('/passenger/rides/active').set(auth)).body,
      'GET /passenger/rides/:id': (await request(app).get(`/passenger/rides/${rideId}`).set(auth)).body,
      'GET /passenger/rides/history': (await request(app).get('/passenger/rides/history').set(auth)).body,
      'GET /ride-requests/me': (await request(app).get('/ride-requests/me').set(auth)).body,
      'GET /ride-requests/:id/pool-info': (await request(app).get(`/ride-requests/${rideId}/pool-info`).set(auth)).body,
    };
  }

  it('no driver-facing response, at any point of a pooled trip, carries a name, phone, email or user id', async () => {
    const scanned = new Set<string>();
    const scanDriver = async (moment: string) => {
      for (const [name, body] of Object.entries(await driverViews())) {
        expectNoIdentity(`${name} (${moment})`, body);
        scanned.add(name);
      }
    };

    // requested, not yet accepted: the pending list
    const zubayer = await requestRide('zubayer');
    const tahmina = await requestRide('tahmina');
    await scanDriver('two requests waiting');

    // accepted: the accept response is driver-facing too
    for (const id of [zubayer, tahmina]) {
      const res = await accept(id);
      expect(res.status).toBe(200);
      expectNoIdentity('POST /ride-requests/:id/accept', res.body);
    }
    await scanDriver('both accepted');

    // the trip runs: every action response
    for (const id of [zubayer, tahmina]) {
      for (const a of ['arrive', 'start'] as const) expectNoIdentity(`PATCH /driver/rides/:id/${a}`, (await act(id, a)).body);
    }
    await scanDriver('both on board');

    // a third joins mid-trip, then leaves part-way
    const ishrat = await requestRide('ishrat');
    await scanDriver('a third is waiting mid-trip');
    expectNoIdentity('POST /ride-requests/:id/accept (mid-trip)', (await accept(ishrat)).body);
    for (const a of ['arrive', 'start'] as const) expectNoIdentity(`PATCH /driver/rides/:id/${a}`, (await act(ishrat, a)).body);
    await scanDriver('three on board');
    const left = await leave(ishrat, 'ishrat');
    expect(left.status).toBe(200);
    await scanDriver('one left mid-trip');

    // the rest complete: history
    for (const id of [zubayer, tahmina]) expectNoIdentity('PATCH /driver/rides/:id/complete', (await act(id, 'complete')).body);
    await scanDriver('everyone finished (history)');

    // a request the driver cancels
    const farhan = await requestRide('farhan');
    await accept(farhan);
    expectNoIdentity('PATCH /driver/rides/:id/cancel', (await act(farhan, 'cancel')).body);
    await scanDriver('a cancelled ride');

    expect(scanned.size).toBe(4); // all four driver views were scanned, at every stage
  });

  it('no co-passenger sees another passenger’s name, phone, email or user id (nor any user id at all)', async () => {
    const zubayer = await requestRide('zubayer');
    const tahmina = await requestRide('tahmina');
    await accept(zubayer);
    await accept(tahmina);
    await startTrip(zubayer);
    await startTrip(tahmina);
    const ishrat = await requestRide('ishrat');
    await accept(ishrat);

    for (const [who, rideId] of [['zubayer', zubayer], ['tahmina', tahmina], ['ishrat', ishrat]] as const) {
      for (const [name, body] of Object.entries(await passengerViews(who, rideId))) {
        // nobody else's identity in any of them...
        expectNoIdentity(`${who}: ${name}`, body, KEYS.filter((k) => k !== who));
        // ...and no user id at all, not even the passenger's own: these responses do not need one
        expect(JSON.stringify(body)).not.toContain(u[who].id);
      }
    }
  });

  it('the labels are Passenger 1, 2, 3 in the order the driver accepted them, in the pool, the timeline and the lists', async () => {
    const ids: Record<string, string> = {};
    for (const k of ['zubayer', 'tahmina', 'ishrat'] as const) ids[k] = await requestRide(k);

    // accepted in a different order from requested
    const order = ['tahmina', 'ishrat', 'zubayer'] as const;
    for (const k of order) {
      const res = await accept(ids[k]!);
      expect(res.body.rideRequest.passengerLabel).toBe(`Passenger ${order.indexOf(k) + 1}`);
    }

    // the driver's active list
    const active = (await request(app).get(`/driver/rides/active?driverId=${driver.id}`)).body.rides as any[];
    const labelByRide = Object.fromEntries(active.map((r) => [r.id, r.passengerLabel]));
    expect(labelByRide).toEqual({ [ids.tahmina!]: 'Passenger 1', [ids.ishrat!]: 'Passenger 2', [ids.zubayer!]: 'Passenger 3' });

    // the timeline names the same passengers the same way, for every event of a ride
    const events = (await request(app).get('/driver/rides/timeline').set(asUser(driver.id, 'DRIVER'))).body.events as any[];
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.passengerLabel).toBe(labelByRide[e.rideId]);
    expect(events.every((e) => !('passengerFirstName' in e) && !('passengerId' in e))).toBe(true);

    // a co-passenger: Zubayer is Passenger 3; the others are the other two, in order
    const view = (await request(app).get(`/passenger/rides/${ids.zubayer}`).set(asUser(u.zubayer.id))).body.ride;
    expect(view.pool.yourNumber).toBe(3);
    expect(view.pool.otherPassengers).toEqual([{ label: 'Passenger 1', number: 1 }, { label: 'Passenger 2', number: 2 }]);
  });

  it('a number never changes for a passenger, and is sequential per pool: it starts again at 1 when the car is empty', async () => {
    const a = await requestRide('zubayer');
    const b = await requestRide('tahmina');
    await accept(a);
    await accept(b);
    await startTrip(a);
    await startTrip(b);
    await act(a, 'complete'); // Passenger 1 leaves the car; Passenger 2 stays and is STILL Passenger 2

    const c = await requestRide('ishrat');
    expect((await accept(c)).body.rideRequest.passengerLabel).toBe('Passenger 3'); // the next number after the highest still in the car
    const active = (await request(app).get(`/driver/rides/active?driverId=${driver.id}`)).body.rides as any[];
    expect(active.find((r) => r.id === b).passengerLabel).toBe('Passenger 2');

    // everybody finishes, the car empties, and the next pool starts again at Passenger 1
    for (const id of [b, c]) {
      await startTrip(id);
      await act(id, 'complete');
    }
    const d = await requestRide('farhan');
    expect((await accept(d)).body.rideRequest.passengerLabel).toBe('Passenger 1');
  });

  it('the source of the leak is gone: no ride response carries a passengerId, and an accepted ride has a label', async () => {
    const created = (await request(app).post('/ride-requests').set(asUser(u.zubayer.id)).send(trip)).body.rideRequest;
    expect(created).not.toHaveProperty('passengerId');
    const accepted = (await accept(created.id)).body.rideRequest;
    expect(accepted).not.toHaveProperty('passengerId');
    expect(accepted.passengerLabel).toBe('Passenger 1');
    const other = await requestRide('tahmina');
    const pending = (await request(app).get(`/ride-requests/pending?driverId=${driver.id}`)).body.requests as any[];
    expect(pending.map((r) => r.id)).toContain(other);
    for (const r of pending) expect(r).not.toHaveProperty('passengerId');
  });

  it('the leak checker itself works: it flags a name, phone, email and id when one is present', () => {
    // (so a passing scan above means something)
    u = { zubayer: { id: 'id-1' }, tahmina: { id: 'id-2' }, ishrat: { id: 'id-3' }, farhan: { id: 'id-4' } } as any;
    for (const leaked of ['Zubayer', 'chowdhury', '01712340001', 'zubayer.chowdhury@leaktest.example', 'id-1']) {
      expect(() => expectNoIdentity('demo', { events: [{ note: `x ${leaked} y` }] })).toThrow(/LEAK/);
    }
    expect(() => expectNoIdentity('demo', { label: 'Passenger 1', poolNumber: 1 })).not.toThrow();
  });
});
