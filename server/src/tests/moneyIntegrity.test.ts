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
import { FarePoint, pooledFare, segmentDistanceKm, segmentFare } from '../utils/fareCalculator';
import { asUser } from './helpers';

beforeAll(async () => {
  await sequelize.sync({ force: true });
});
afterAll(async () => {
  await sequelize.close();
});

describe('money is integer taka', () => {
  describe('the arithmetic', () => {
    it('a single shared segment is exactly tripCost / n rounded half up, plus the ৳20 bonus (checked with integer maths)', () => {
      for (const a of DHAKA_ZONES) {
        for (const b of DHAKA_ZONES) {
          const km = segmentDistanceKm(a, b);
          expect(Number.isInteger(km)).toBe(true);
          for (const seats of [1, 2, 3]) {
            const tripCost = 100 + 20 * seats * km;
            for (const n of [1, 2, 3, 4, 5]) {
              const fare = segmentFare({ points: [{ zone: a, passengerCount: n }], exitZone: b, seatCount: seats }).fare;
              // round(tripCost / n) half up = floor((2 × tripCost + n) / (2n)): no fraction ever appears
              const expected = n === 1 || km === 0 ? tripCost : Math.floor((2 * tripCost + n) / (2 * n)) + 20;
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

    // The fare of a multi-segment journey, computed a second way: with exact BigInt fractions, then
    // rounded once (half up). It must equal segmentFare's running-total rounding, and the segment
    // charges must add up to it exactly.
    const exactFare = (points: FarePoint[], exitZone: string, seats: number): bigint => {
      const legs = points.map((p, i) => ({ km: segmentDistanceKm(p.zone, points[i + 1]?.zone ?? exitZone), n: p.passengerCount }));
      const journeyKm = legs.reduce((sum, l) => sum + l.km, 0);
      const solo = 100 + 20 * seats * journeyKm;
      // numerator over the denominator journeyKm × 60 (60 = lcm of every count used below, 1..5)
      const den = BigInt(journeyKm * 60);
      let num = 0n;
      for (const l of legs) {
        num += BigInt(l.km * solo * (60 / l.n)) + (l.n >= 2 && l.km > 0 ? BigInt(20) * den : 0n);
      }
      return (2n * num + den) / (2n * den); // round half up
    };

    it('a journey with several segments: charges are integers, add up to the fare, and the fare is the exact total rounded once', () => {
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
                expect(BigInt(bill.fare)).toBe(exactFare(points, zones[k]!, seats));
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

    it('a tie rounds up: an exact total of 317.5 is ৳318, never ৳317', () => {
      // journeyKm 16, tripCost 420: 9 km alone = 236.25, then 7 km with 3 on board = 183.75 / 3 + 20 = 81.25
      const bill = segmentFare({
        points: [{ zone: 'Uttara', passengerCount: 1 }, { zone: 'Mirpur', passengerCount: 3 }],
        exitZone: 'Dhanmondi',
        seatCount: 1,
      });
      expect(bill.fare).toBe(318);
      expect(bill.segments.map((s) => s.charge)).toEqual([236, 82]);
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
