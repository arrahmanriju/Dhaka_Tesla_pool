/**
 * A passenger leaves a ride AFTER it has started (CANCELLED_IN_TRANSIT).
 *
 * THE RULE (a deliberate, customer-friendly leniency policy, not a price): the passenger who leaves pays
 * HALF OF THE FARE THEY WERE QUOTED when they boarded (RideRequest.quotedFare), rounded to the nearest
 * taka, halves up. It is not pro-rated by distance and does not walk the checkpoints. The cancellation
 * zone is still recorded as a checkpoint (passengers on board − 1), so everyone who STAYS is priced by the
 * ordinary segment walk (segmentFares.test.ts has the pure maths), with no special adjustment.
 *
 * Worked example, end to end (Jashim's Bullet, 3 seats). Uttara–Mirpur 9 km, Mirpur–Dhanmondi 7 km,
 * Uttara–Dhanmondi 16 km (so the zones add up exactly).
 *   Nusrat and Rafiq both ride Uttara → Dhanmondi. tripCost 100 + 16 × 20 = ৳420; pooled for the whole
 *   trip they are each quoted 420 / 2 + 20 = ৳230. Both board at Uttara. Rafiq leaves at Mirpur.
 *   Rafiq pays 230 / 2 = ৳115.
 *   Nusrat: Uttara → Mirpur with 2 on board: 9/16 × 420 = 236.25, / 2 = 118.125, + 20 = 138.125;
 *           Mirpur → Dhanmondi alone: 7/16 × 420 = 183.75.  Exact total 321.875 → ৳322.
 *   The driver earns 115 + 322 = ৳437 (the two were quoted ৳460 together).
 * (The same rule on a route with an exact midpoint is worked in cancellationPricing.test.ts: 85 / 245 / 330.)
 *
 * Second scenario, used below: Nusrat rides Uttara → Dhanmondi and starts alone (quoted ৳420); Rafiq
 * boards at Mirpur going to Dhanmondi (quoted 240 / 2 + 20 = ৳140); Nusrat asks to be dropped at Mohammadpur.
 *   Nusrat pays 420 / 2 = ৳210 (she was on track for ৳348 to Dhanmondi).
 *   Rafiq, dropped at Dhanmondi, is priced by the walk: journeyKm 5 + 3 = 8, tripCost ৳260;
 *           Mirpur → Mohammadpur, 2 on board: 162.5 / 2 + 20 = 101.25; Mohammadpur → Dhanmondi alone: 97.5.
 *           Exact total 198.75 → ৳199.
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

describe('Mid-trip cancellation — CANCELLED_IN_TRANSIT pays half of the quoted fare', () => {
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
  describe('the leaving passenger pays half of the fare they were quoted; everyone else is priced as usual', () => {
    it('worked example: both pooled at ৳230, Rafiq leaves at Mirpur and pays ৳115; Nusrat pays ৳322; the driver earns ৳437', async () => {
      const nusratRide = await joinPool(nusrat);
      const rafiqRide = await joinPool(rafiq);
      expect((await ride(nusratRide)).estimatedFare).toBe(230); // 420 / 2 + 20, quoted for the whole trip
      await startRide(nusratRide);
      await startRide(rafiqRide);
      expect((await ride(rafiqRide)).quotedFare).toBe(230); // frozen when he boarded

      const res = await leave(rafiqRide, rafiq, 'Mirpur');

      expect(res.status).toBe(200);
      expect(res.body.fare).toMatchObject({ fare: 115, fullTripEstimate: 230, final: true, cancellation: { rule: 'HALF_OF_QUOTED_FARE', quotedFare: 230 } });
      expect(await ride(rafiqRide)).toMatchObject({ status: 'CANCELLED_IN_TRANSIT', quotedFare: 230, estimatedFare: 115, poolDiscount: 0, paymentAmount: 115 });
      expect(await checkpoints()).toEqual([
        ['Uttara', 1, 'TRIP_STARTED'],
        ['Uttara', 2, 'PASSENGER_JOINED'],
        ['Mirpur', 1, 'PASSENGER_LEFT'], // still a checkpoint: the count on board drops
      ]);

      // Nusrat rides on alone and is priced by the walk over her real checkpoints: 138.125 + 183.75 = 321.875
      expect((await driverAction(nusratRide, 'complete')).status).toBe(200);
      const bill = (await view(nusratRide, nusrat)).body.ride.fareBreakdown;
      expect(bill.segments).toEqual([
        { distanceKm: 0, passengers: 1, driverBonus: 0, charge: 0 },
        { distanceKm: 9, passengers: 2, driverBonus: 20, charge: 138 }, // 138.125
        { distanceKm: 7, passengers: 1, driverBonus: 0, charge: 184 }, // 183.75: 321.875 rounds to 322 = 138 + 184
      ]);
      expect(await ride(nusratRide)).toMatchObject({ status: 'COMPLETED', estimatedFare: 322 });
      expect((await ride(rafiqRide)).estimatedFare + (await ride(nusratRide)).estimatedFare).toBe(437);
    });

    it('a passenger who boarded alone is quoted the solo fare: Nusrat leaves at Mohammadpur and pays ৳210, not the ৳348 she was on track for', async () => {
      const { nusratRide } = await nusratThenRafiq();
      // Before she leaves: Uttara → Mirpur alone (236.25) + Mirpur → Dhanmondi with 2 on board (111.875) = 348.125 → ৳348
      expect((await ride(nusratRide)).estimatedFare).toBe(348);
      expect((await ride(nusratRide)).quotedFare).toBe(420); // what she was quoted when she boarded, alone

      const res = await leave(nusratRide, nusrat, 'Mohammadpur');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'CANCELLED_IN_TRANSIT', cancellationZone: 'Mohammadpur' });
      // No stretches: the fare is not worked out from them. Half of 420; the on-track estimate stays in the history.
      expect(res.body.fare).toMatchObject({ fare: 210, poolDiscount: 0, fullTripEstimate: 348, cancellation: { rule: 'HALF_OF_QUOTED_FARE', quotedFare: 420 } });
      expect(res.body.fare.segments).toEqual([]);
      expect(await ride(nusratRide)).toMatchObject({ status: 'CANCELLED_IN_TRANSIT', cancellationZone: 'Mohammadpur', estimatedFare: 210, poolDiscount: 0 });
      expect(await checkpoints()).toEqual([
        ['Uttara', 1, 'TRIP_STARTED'],
        ['Mirpur', 2, 'PASSENGER_JOINED'],
        ['Mohammadpur', 1, 'PASSENGER_LEFT'],
      ]);
    });

    it('how far they got makes no difference: the same passenger pays the same half wherever they leave', async () => {
      const first = await nusratThenRafiq();
      const early = await leave(first.nusratRide, nusrat, 'Mirpur');
      expect(early.body.fare.fare).toBe(210);

      await driverAction(first.rafiqRide, 'complete');
      const nusratAgain = await joinPool(nusrat);
      await startRide(nusratAgain);
      const late = await leave(nusratAgain, nusrat, 'Mohammadpur'); // much further along the road
      expect(late.body.fare.fare).toBe(210);
    });

    it('the passengers who stay are priced only by the segment walk: Rafiq pays ৳199, as if nobody had a special rule', async () => {
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
      // what the driver earns from the two of them: ৳210 + ৳199
      expect((await ride(nusratRide)).estimatedFare + final.estimatedFare).toBe(409);
    });

    it('a passenger riding alone who leaves pays half of the solo fare', async () => {
      const nusratRide = await joinPool(nusrat);
      await startRide(nusratRide);
      expect((await ride(nusratRide)).estimatedFare).toBe(420); // 100 + 16 × 20 to Dhanmondi, alone: the full trip cost

      const res = await leave(nusratRide, nusrat, 'Mirpur');
      expect(res.body.fare).toMatchObject({ fare: 210, poolDiscount: 0, fullTripEstimate: 420 });
      expect(res.body.fare.segments).toEqual([]);
    });

    it('leaving at the very zone where someone boards changes nothing about the rule', async () => {
      const { nusratRide, rafiqRide } = await nusratThenRafiq();
      const res = await leave(nusratRide, nusrat, 'Mirpur');
      expect(res.body.fare).toMatchObject({ fare: 210, poolDiscount: 0 });

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
      expect(r.quotedFare).toBe(140); // his own quote is frozen: it is only used if HE leaves
    });

    it('a passenger who leaves later is charged half of THEIR quote, not of anyone else’s', async () => {
      const { nusratRide, rafiqRide } = await nusratThenRafiq();
      await leave(nusratRide, nusrat, 'Mohammadpur');
      const res = await leave(rafiqRide, rafiq, 'Mohammadpur');
      expect(res.status).toBe(200);
      expect(res.body.fare).toMatchObject({ fare: 70, cancellation: { quotedFare: 140 } }); // 140 / 2, not 420 / 2 or 210 / 2
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
        chargedFare: 210,
        fullTripEstimate: 348,
      });
      expect(left.at).toBeTruthy();
      expect(of(rafiqRide).map((e) => e.status)).toEqual(['REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED']);

      const stored = await RideEvent.findOne({ where: { rideRequestId: nusratRide, status: 'CANCELLED_IN_TRANSIT' } });
      expect(stored).toMatchObject({ actorId: nusrat.id, actorRole: 'PASSENGER', poolSize: 1, cancellationZone: 'Mohammadpur', chargedFare: 210, fullTripEstimate: 348 });
    });

    it('the cancelling passenger sees their own outcome; nobody else sees it, or the stretches where others boarded', async () => {
      const { nusratRide, rafiqRide } = await nusratThenRafiq();
      await leave(nusratRide, nusrat, 'Mohammadpur');

      expect((await request(app).get('/passenger/rides/active').set(asUser(nusrat.id))).body.rides).toHaveLength(0);
      const history = (await request(app).get('/passenger/rides/history').set(asUser(nusrat.id))).body.rides;
      expect(history[0]).toMatchObject({ status: 'CANCELLED_IN_TRANSIT', cancellationZone: 'Mohammadpur', estimatedFare: 210 });
      expect(history[0].timeline.at(-1)).toMatchObject({ status: 'CANCELLED_IN_TRANSIT', cancellationZone: 'Mohammadpur', chargedFare: 210, fullTripEstimate: 348 });

      // Her own breakdown has no zone names: the middle checkpoint is where ANOTHER passenger boarded
      const mine = (await view(nusratRide, nusrat)).body.ride;
      expect(mine.fareBreakdown).toMatchObject({ final: true, fare: 210, cancellation: { quotedFare: 420 } });
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
      expect(row).toMatchObject({ status: 'CANCELLED_IN_TRANSIT', cancellationZone: 'Mohammadpur', estimatedFare: 210 });
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

      // Nusrat leaves at Mohammadpur: she was quoted ৳420 alone when she boarded, so she pays 420 / 2 = ৳210.
      // Rafiq and Shirin are priced by the walk. journeyKm 5 + 3 = 8, tripCost 260. Mirpur → Mohammadpur, 3 on board:
      //         162.5 / 3 + 20 = 74.17; Mohammadpur → Dhanmondi, 2 left: 97.5 / 2 + 20 = 68.75. Exact total 142.92 → ৳143 each.
      const fares = await Promise.all(rides.map(async (id) => (await ride(id)).estimatedFare));
      expect(fares).toEqual([210, 143, 143]);

      // the stayers' bills add up to their fares: nothing dropped, nothing double-counted. The leaver's has no stretches.
      expect(bills[0].segments).toEqual([]);
      [1, 2].forEach((i) => expect(bills[i].segments.reduce((sum: number, x: any) => sum + x.charge, 0)).toBe(fares[i]));
      // what the driver earns for the whole run
      expect(fares.reduce((a, b) => a + b, 0)).toBe(496);
    });
  });
});
