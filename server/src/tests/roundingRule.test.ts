/**
 * The rounding rule for uneven splits. Money is whole taka (never paisa), and when a shared segment's
 * tripCost does not divide evenly by the number of passengers on it, the split is ROUNDED UP to the next
 * whole taka, for EVERY passenger sharing that segment. The driver keeps the extra fraction as additional
 * profit.
 *
 *   segmentFare = tripCost                      when 1 is on board (solo: nothing is split)
 *   segmentFare = ceil(tripCost / n) + ৳20      when n ≥ 2 are on board
 *
 * The worked scenario (a route Gulshan → midpoint → Dhanmondi):
 *   Person 1 rides alone to the midpoint          tripCost 40                      → pays 40
 *   Person 2 joins at the midpoint, both share the remaining leg, tripCost 260, 2 on board
 *                                                 260 / 2 + 20                     → each pays 150
 *   Person 1's total                              40 + 150                         = 190
 *   Person 3 joins the same leg, 3 on board       260 / 3 = 86.67 → 87, + 20       → each of the three pays 107
 *   Revenue                                       40 + 107 × 3 = 361               (360 if it were not rounded;
 *                                                 the extra ৳1 is the driver's rounding remainder)
 *
 * Segment trip costs of 40 and 260 are given directly here, because the zone table cannot produce a
 * first leg of ৳40 (every trip costs at least the ৳100 base). The second half of this file runs the real
 * zones, Gulshan → Mohakhali → Dhanmondi, through the API: Mohakhali → Dhanmondi (8 km) really does cost
 * 100 + 8 × 20 = ৳260, so persons 2 and 3 pay exactly 150 and 107 there too.
 */
import request from 'supertest';
import { app } from '../index';
import { sequelize, User, Vehicle, RideRequest, RideEvent, PoolCheckpoint } from '../models';
import { asUser } from './helpers';
import { calculateSplit, segmentFareFor } from '../utils/fareCalculator';

describe('the worked scenario (segment trip costs 40 and 260)', () => {
  it('person 1 rides solo to the midpoint: tripCost 40, no split, pays 40', () => {
    expect(segmentFareFor(40, 1)).toBe(40);
  });

  it('person 2 joins at the midpoint: 260 / 2 + 20 = ৳150 each, exactly', () => {
    expect(260 / 2).toBe(130); // divides evenly: nothing to round
    expect(segmentFareFor(260, 2)).toBe(150);
  });

  it('person 1’s total across the two segments is exactly 40 + 150 = ৳190', () => {
    expect(segmentFareFor(40, 1) + segmentFareFor(260, 2)).toBe(190);
  });

  it('person 3 joins the same leg: each of the three pays ceil(260 / 3) + 20 = 87 + 20 = ৳107 (not 106.67)', () => {
    expect(260 / 3).toBeCloseTo(86.6667, 4); // 86.67, the un-rounded split
    expect(segmentFareFor(260, 3)).toBe(107);
    expect(calculateSplit(260, 1, 3)).toBe(107);
    expect(Number.isInteger(segmentFareFor(260, 3))).toBe(true);
  });

  it('all three pay the same, so nobody is singled out for the rounding', () => {
    const fares = [1, 2, 3].map(() => segmentFareFor(260, 3));
    expect(new Set(fares).size).toBe(1);
  });

  it('total revenue is 40 + 107 × 3 = ৳361, one taka more than the un-rounded ৳360: the driver keeps the remainder', () => {
    const revenue = segmentFareFor(40, 1) + 3 * segmentFareFor(260, 3);
    expect(revenue).toBe(361);
    const unrounded = 40 + 260 + 3 * 20; // the leg's cost plus the three bonuses
    expect(unrounded).toBe(360);
    expect(revenue - unrounded).toBe(1);
    expect(Number.isInteger(revenue)).toBe(true);
  });

  it('the same passengers, person by person, once person 3 has joined', () => {
    const person1 = segmentFareFor(40, 1) + segmentFareFor(260, 3); // solo leg, then the 3-way leg
    const person2 = segmentFareFor(260, 3);
    const person3 = segmentFareFor(260, 3);
    expect([person1, person2, person3]).toEqual([147, 107, 107]);
    expect(person1 + person2 + person3).toBe(361);
  });

  it('the total collected always reconciles to a whole number, with no float drift', () => {
    for (let tripCost = 0; tripCost <= 600; tripCost++) {
      for (let n = 2; n <= 8; n++) {
        const each = segmentFareFor(tripCost, n);
        expect(Number.isInteger(each)).toBe(true);
        const collected = each * n;
        expect(Number.isSafeInteger(collected)).toBe(true);
        // exactly the cost plus the bonuses plus a remainder of less than one taka per passenger, never a fraction
        const remainder = collected - (tripCost + 20 * n);
        expect(remainder).toBeGreaterThanOrEqual(0);
        expect(remainder).toBeLessThan(n);
        expect(remainder).toBe((n - (tripCost % n)) % n); // the driver's remainder, computed another way
      }
    }
  });

  it('a split of an even amount has no remainder; the driver only ever gains from an uneven one', () => {
    expect(segmentFareFor(260, 2) * 2 - (260 + 40)).toBe(0);
    expect(segmentFareFor(260, 4) * 4 - (260 + 80)).toBe(0); // 260 / 4 = 65 exactly
    expect(segmentFareFor(260, 3) * 3 - (260 + 60)).toBe(1);
    expect(segmentFareFor(260, 5) * 5 - (260 + 100)).toBe(0); // 52 exactly
    expect(segmentFareFor(260, 7) * 7 - (260 + 140)).toBe(6); // 37.14 → 38: 7 × 38 = 266, against 260 + 140 = 400 for the cost and bonuses: 406
  });

  it('a fractional segment cost (the ৳100 base spread by distance) is rounded up the same way', () => {
    // 232.73 (= 8/11 × 320) shared by 3 is 77.58 → 78: calculateSplit(numerator 2560, denominator 11, n 3)
    expect(calculateSplit(2560, 11, 3)).toBe(98); // 78 + 20
    expect(calculateSplit(2560, 11, 4)).toBe(79); // 58.18 → 59, + 20
  });

  it('refuses amounts that are not whole taka, or a split with fewer than two passengers', () => {
    expect(() => calculateSplit(260.5, 1, 3)).toThrow();
    expect(() => calculateSplit(260, 1, 1)).toThrow();
    expect(() => calculateSplit(-260, 1, 3)).toThrow();
  });
});

// ───────────────────────── the real zones, through the API ─────────────────────────
let jashim: any;
let nusrat: any;
let rafiq: any;
let shirin: any;

type Trip = { pickupZone: string; destinationZone: string };
const requestRide = (p: any, trip: Trip) =>
  request(app).post('/ride-requests').set(asUser(p.id)).send({ seatCount: 1, allowSharing: true, ...trip });
const accept = (id: string) => request(app).post(`/ride-requests/${id}/accept`).send({ driverId: jashim.id });
const driverAction = (id: string, action: 'arrive' | 'start' | 'complete') =>
  request(app).patch(`/driver/rides/${id}/${action}`).send({ driverId: jashim.id });
const fareOf = async (id: string) => (await RideRequest.findByPk(id))!.estimatedFare;

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

describe('Gulshan → Mohakhali → Dhanmondi on the real zones (Jashim’s Bullet)', () => {
  beforeAll(async () => {
    await sequelize.sync({ force: true });
  });
  afterAll(async () => {
    await sequelize.close();
  });
  beforeEach(async () => {
    const mk = async (name: string, role: 'DRIVER' | 'PASSENGER', n: number) =>
      (await User.create({ name: `${name} Test`, phone: `0171500000${n}`, email: `${name.toLowerCase()}-rr@test.com`, password: 'x', role })).toJSON();
    jashim = await mk('Jashim', 'DRIVER', 0);
    nusrat = await mk('Nusrat', 'PASSENGER', 1);
    rafiq = await mk('Rafiq', 'PASSENGER', 2);
    shirin = await mk('Shirin', 'PASSENGER', 3);
    await Vehicle.create({ driverId: jashim.id, modelName: 'Bullet', seatCapacity: 3, licensePlate: 'DTP-0001' });
  });
  afterEach(async () => {
    await PoolCheckpoint.destroy({ where: {} });
    await RideEvent.destroy({ where: {} });
    await RideRequest.destroy({ where: {} });
    await Vehicle.destroy({ where: {} });
    await User.destroy({ where: {} });
  });

  it('two join at Mohakhali for the 8 km leg (tripCost 100 + 160 = ৳260): each pays 260 / 2 + 20 = ৳150', async () => {
    const p1 = await join(nusrat, { pickupZone: 'Gulshan', destinationZone: 'Dhanmondi' });
    await start(p1);
    const p2 = await join(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Dhanmondi' });
    await start(p2);
    // Rafiq's estimate while two are on board, for the whole 8 km: exactly 150
    expect(await fareOf(p2)).toBe(150);
  });

  it('a third joins the same leg: each of the three pays ceil(260 / 3) + 20 = ৳107 on it, and the total reconciles', async () => {
    const p1 = await join(nusrat, { pickupZone: 'Gulshan', destinationZone: 'Dhanmondi' });
    await start(p1);
    const p2 = await join(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Dhanmondi' });
    await start(p2);
    const p3 = await join(shirin, { pickupZone: 'Mohakhali', destinationZone: 'Dhanmondi' });
    await start(p3);
    for (const id of [p1, p2, p3]) expect((await driverAction(id, 'complete')).status).toBe(200);

    // Persons 2 and 3 travelled only the 8 km leg, with 3 on board: 260 / 3 = 86.67 → 87, + 20 = 107 each
    expect(await fareOf(p2)).toBe(107);
    expect(await fareOf(p3)).toBe(107);
    // Person 1: 3 km alone (3/11 × 320 = 87.27 → 87), then the 8 km leg with 3 on board (8/11 × 320 = 232.73, / 3 = 77.58 → 78, + 20 = 98)
    expect(await fareOf(p1)).toBe(87 + 98);
    const total = (await fareOf(p1)) + (await fareOf(p2)) + (await fareOf(p3));
    expect(total).toBe(185 + 107 + 107);
    expect(Number.isInteger(total)).toBe(true);
  });
});
