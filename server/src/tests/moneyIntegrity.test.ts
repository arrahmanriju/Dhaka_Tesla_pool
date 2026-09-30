/**
 * Money is always a whole number of taka: never a float, never a fraction. (The app stores whole
 * taka, the unit fares have used since the paisa -> taka migration; "integer" is the invariant.)
 * SQLite would happily store 12.5 in an INTEGER column, so the models must refuse it.
 */
import request from 'supertest';
import { app } from '../index';
import { sequelize, User, Vehicle, RideRequest, RideEvent, WalletTransaction } from '../models';
import { DHAKA_ZONES } from '../models/RideRequest';
import { collectPayment } from '../utils/payments';
import { FarePoint, pooledFare, segmentDistanceKm, segmentFare, segmentFareFor } from '../utils/fareCalculator';
import { asUser } from './helpers';

beforeAll(async () => {
  await sequelize.sync({ force: true });
});
afterAll(async () => {
  await sequelize.close();
});

describe('money is integer taka', () => {
  describe('the arithmetic', () => {
    it('a single shared segment is exactly tripCost / n rounded UP, plus the ৳20 bonus (checked with integer maths)', () => {
      for (const a of DHAKA_ZONES) {
        for (const b of DHAKA_ZONES) {
          const km = segmentDistanceKm(a, b);
          expect(Number.isInteger(km)).toBe(true);
          for (const seats of [1, 2, 3]) {
            const tripCost = 100 + 20 * seats * km;
            for (const n of [1, 2, 3, 4, 5]) {
              const fare = segmentFare({ points: [{ zone: a, passengerCount: n }], exitZone: b, seatCount: seats }).fare;
              // ceil(tripCost / n) = floor((tripCost + n − 1) / n): no fraction ever appears
              const expected = n === 1 || km === 0 ? tripCost : Math.floor((tripCost + n - 1) / n) + 20;
              expect(fare).toBe(expected);
            }
          }
        }
      }
    });

    it('every fare, every segment charge and every discount is an integer, for all zone pairs, seats and pool sizes', () => {
      for (const from of DHAKA_ZONES) {
        for (const to of DHAKA_ZONES) {
          if (from === to) continue;
          for (const seats of [1, 2, 3]) {
            for (const n of [1, 2, 3, 4]) {
              for (const allowSharing of [true, false]) {
                const fare = pooledFare(from, to, seats, n, allowSharing);
                expect(Number.isInteger(fare)).toBe(true);
                const bill = segmentFare({ points: [{ zone: from, passengerCount: n }], exitZone: to, seatCount: seats, allowSharing });
                for (const s of bill.segments) {
                  expect(Number.isInteger(s.charge)).toBe(true);
                  expect(Number.isInteger(s.driverBonus)).toBe(true);
                }
                expect(Number.isInteger(bill.poolDiscount) && bill.poolDiscount >= 0).toBe(true);
                expect(Number.isInteger(bill.soloFare)).toBe(true);
              }
            }
          }
        }
      }
    });

    // The fare of a multi-segment journey, computed a second way: with BigInt integer maths, one segment at a time.
    // A shared segment is ceil(segKm × solo / (journeyKm × n)) + 20; the solo segments are rounded together
    // (nearest taka, halves up, on their running total). It must equal segmentFare, and the segment charges
    // must add up to the fare exactly.
    const expectedFare = (points: FarePoint[], exitZone: string, seats: number): bigint => {
      const legs = points.map((p, i) => ({ km: BigInt(segmentDistanceKm(p.zone, points[i + 1]?.zone ?? exitZone)), n: BigInt(p.passengerCount) }));
      const journeyKm = legs.reduce((sum, l) => sum + l.km, 0n);
      const solo = 100n + 20n * BigInt(seats) * journeyKm;
      let fare = 0n;
      let soloExact = 0n; // in units of 1/journeyKm
      for (const l of legs) {
        if (l.km === 0n) continue;
        if (l.n === 1n) soloExact += l.km * solo;
        else fare += (l.km * solo + journeyKm * l.n - 1n) / (journeyKm * l.n) + 20n; // ceil, then the bonus
      }
      return fare + (2n * soloExact + journeyKm) / (2n * journeyKm); // solo part: nearest, halves up
    };

    it('a journey with several segments: charges are integers, add up to the fare, and match an independent integer calculation', () => {
      const zones = ['Uttara', 'Mirpur', 'Dhanmondi', 'Mohakhali', 'Badda', 'Gulshan', 'Banani'];
      let checked = 0;
      for (let i = 0; i < zones.length; i++) {
        for (let j = 0; j < zones.length; j++) {
          for (let k = 0; k < zones.length; k++) {
            if (i === j || j === k) continue;
            for (const counts of [[1, 2], [2, 3], [3, 1], [2, 2], [1, 4], [4, 3], [5, 2]] as const) {
              const points: FarePoint[] = [{ zone: zones[i]!, passengerCount: counts[0] }, { zone: zones[j]!, passengerCount: counts[1] }];
              for (const seats of [1, 2]) {
                const bill = segmentFare({ points, exitZone: zones[k]!, seatCount: seats });
                expect(bill.segments.every((s) => Number.isInteger(s.charge))).toBe(true);
                expect(bill.segments.reduce((sum, s) => sum + s.charge, 0)).toBe(bill.fare);
                expect(BigInt(bill.fare)).toBe(expectedFare(points, zones[k]!, seats));
                checked++;
              }
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(1000);
    });

    it('a passenger who rides alone pays exactly the trip cost, however many segments the journey has', () => {
      const bill = segmentFare({
        points: [{ zone: 'Uttara', passengerCount: 1 }, { zone: 'Mirpur', passengerCount: 1 }, { zone: 'Mohakhali', passengerCount: 1 }],
        exitZone: 'Badda',
        seatCount: 1,
      });
      // journeyKm 9 + 7 + 4 = 20, tripCost 500: the pieces 225 + 175 + 100 add up exactly
      expect(bill.fare).toBe(500);
      expect(bill.segments.map((s) => s.charge)).toEqual([225, 175, 100]);
    });

    it('every passenger sharing a segment pays the same rounded-up amount, and the driver keeps the remainder', () => {
      // tripCost 260 shared by 3 is 86.67: each pays 87 (up) + 20 = 107, so the three pay 321 for 260 + 60 = 320
      for (const n of [2, 3, 4, 5, 6, 7]) {
        const each = segmentFareFor(260, n);
        expect(each).toBe(Math.ceil(260 / n) + 20);
        const collected = each * n;
        expect(Number.isInteger(collected)).toBe(true);
        expect(collected).toBeGreaterThanOrEqual(260 + 20 * n); // never less than the cost plus the bonuses
        expect(collected - (260 + 20 * n)).toBeLessThan(n); // and the extra is less than one taka each
      }
    });

    it('a wallet debit refuses a fractional, negative or unsafe amount instead of truncating it', async () => {
      const ride = { id: '00000000-0000-4000-8000-000000000000', passengerId: '00000000-0000-4000-8000-000000000001', paymentMethod: 'wallet' };
      for (const bad of [12.5, -5, NaN, Infinity, 2 ** 60]) await expect(collectPayment(ride, bad)).rejects.toThrow(/Invalid amount/);
    });
  });

  describe('what can be stored', () => {
    let passenger: any;
    beforeEach(async () => {
      passenger = (await User.create({ name: 'Nusrat', phone: '01716000001', email: 'n-money@test.com', password: 'x', role: 'PASSENGER', walletBalance: 100 })).toJSON();
    });
    afterEach(async () => {
      await WalletTransaction.destroy({ where: {} });
      await RideEvent.destroy({ where: {} });
      await RideRequest.destroy({ where: {} });
      await Vehicle.destroy({ where: {} });
      await User.destroy({ where: {} });
    });

    const ride = (extra: Record<string, unknown>) =>
      RideRequest.create({ passengerId: passenger.id, pickupZone: 'Mohakhali', destinationZone: 'Badda', seatCount: 1, baseFare: 180, estimatedFare: 180, poolDiscount: 0, ...extra } as any);

    it('rejects a fractional wallet balance, on create and on update', async () => {
      await expect(User.create({ name: 'B', phone: '01716000002', email: 'b-money@test.com', password: 'x', role: 'PASSENGER', walletBalance: 12.5 } as any)).rejects.toThrow();
      await expect(User.update({ walletBalance: 1.5 }, { where: { id: passenger.id } })).rejects.toThrow();
      expect((await User.findByPk(passenger.id))!.walletBalance).toBe(100);
    });

    it('rejects a fractional or negative wallet balance from a direct write', async () => {
      await expect(User.update({ walletBalance: -1 }, { where: { id: passenger.id } })).rejects.toThrow();
    });

    it.each(['baseFare', 'estimatedFare', 'poolDiscount', 'paymentAmount'])('rejects a fractional ride %s', async (field) => {
      await expect(ride({ [field]: 155.5 })).rejects.toThrow();
      const ok = await ride({});
      await expect(RideRequest.update({ [field]: 0.25 } as any, { where: { id: ok.id } })).rejects.toThrow();
      expect(await RideRequest.count()).toBe(1);
    });

    it('rejects a fractional ledger amount or event fare', async () => {
      const r = await ride({});
      await expect(WalletTransaction.create({ userId: passenger.id, rideRequestId: r.id, type: 'DEBIT', amount: 10.5, balanceAfter: 1 } as any)).rejects.toThrow();
      await expect(WalletTransaction.create({ userId: passenger.id, rideRequestId: r.id, type: 'DEBIT', amount: 10, balanceAfter: 0.5 } as any)).rejects.toThrow();
      await expect(RideEvent.create({ rideRequestId: r.id, passengerId: passenger.id, status: 'COMPLETED', chargedFare: 99.9 } as any)).rejects.toThrow();
      await expect(RideEvent.create({ rideRequestId: r.id, passengerId: passenger.id, status: 'COMPLETED', fullTripEstimate: 1.1 } as any)).rejects.toThrow();
    });

    it('every money column is declared INTEGER, and the API only ever returns integers', async () => {
      const types = async (table: string) =>
        Object.fromEntries(((await sequelize.query(`PRAGMA table_info(\`${table}\`)`))[0] as any[]).map((c) => [c.name, String(c.type).toUpperCase()]));
      const rides = await types('RideRequests');
      for (const c of ['baseFare', 'estimatedFare', 'poolDiscount', 'paymentAmount']) expect(rides[c]).toBe('INTEGER');
      expect((await types('Users')).walletBalance).toBe('INTEGER');
      const ledger = await types('WalletTransactions');
      expect([ledger.amount, ledger.balanceAfter]).toEqual(['INTEGER', 'INTEGER']);
      const events = await types('RideEvents');
      expect([events.chargedFare, events.fullTripEstimate]).toEqual(['INTEGER', 'INTEGER']);

      const created = await request(app).post('/ride-requests').set(asUser(passenger.id)).send({ pickupZone: 'Mohakhali', destinationZone: 'Badda', seatCount: 1 });
      for (const k of ['baseFare', 'estimatedFare', 'poolDiscount']) expect(Number.isInteger(created.body.rideRequest[k])).toBe(true);
      const w = await request(app).get('/passenger/wallet').set(asUser(passenger.id));
      expect(Number.isInteger(w.body.balance)).toBe(true);
    });
  });
});
