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
import { percentOf, pooledFare, roundToNearest5, segmentDistanceKm, segmentFare } from '../utils/fareCalculator';
import { asUser } from './helpers';

beforeAll(async () => {
  await sequelize.sync({ force: true });
});
afterAll(async () => {
  await sequelize.close();
});

describe('money is integer taka', () => {
  describe('the arithmetic', () => {
    it('roundToNearest5 matches exact integer rounding (halves up) for every whole-taka amount', () => {
      for (let t = 0; t <= 5000; t++) {
        const r = t % 5;
        const expected = r >= 3 ? t + (5 - r) : t - r; // 2.5 never occurs for whole taka: 3+ rounds up, 2 or less down
        expect(roundToNearest5(t)).toBe(expected);
      }
    });

    it('percentOf is exact or throws: it never truncates a fraction', () => {
      expect(percentOf(180, 70)).toBe(126);
      expect(percentOf(100, 55)).toBe(55);
      expect(() => percentOf(15, 70)).toThrow(/whole number of taka/); // 10.5
      expect(() => percentOf(1.5, 100)).toThrow();
      expect(() => percentOf(Number.MAX_SAFE_INTEGER, 100)).toThrow();
    });

    it('every fare, every segment charge and every discount is an integer, for all zone pairs, seats and pool sizes', () => {
      for (const from of DHAKA_ZONES) {
        for (const to of DHAKA_ZONES) {
          if (from === to) continue;
          for (const seats of [1, 2, 3]) {
            for (const n of [1, 2, 3, 4]) {
              for (const allowSharing of [true, false]) {
                const fare = pooledFare(from, to, seats, n, allowSharing);
                expect(Number.isInteger(fare) && fare % 5 === 0).toBe(true);
                const bill = segmentFare({ points: [{ zone: from, passengerCount: n }], exitZone: to, seatCount: seats, allowSharing });
                for (const s of bill.segments) {
                  expect(Number.isInteger(s.charge)).toBe(true);
                  expect(Number.isInteger(s.distanceCharge)).toBe(true);
                }
                expect(Number.isInteger(bill.poolDiscount) && bill.poolDiscount >= 0).toBe(true);
                expect(Number.isInteger(bill.soloFare)).toBe(true);
              }
            }
          }
        }
      }
    });

    it('a segment is exactly its distance charge times its rate, with nothing lost to rounding', () => {
      for (const a of DHAKA_ZONES) {
        for (const b of DHAKA_ZONES) {
          const km = segmentDistanceKm(a, b);
          expect(Number.isInteger(km)).toBe(true);
          for (const n of [1, 2, 3]) {
            const s = segmentFare({ points: [{ zone: a, passengerCount: n }], exitZone: b, seatCount: 3 }).segments[0]!;
            expect(s.charge * 100).toBe(s.distanceCharge * s.ratePercent); // exact, no remainder dropped
          }
        }
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
