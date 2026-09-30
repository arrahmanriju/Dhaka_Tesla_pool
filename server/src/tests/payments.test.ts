/**
 * Simulated payments: cash or TeslaPay wallet, settled with the FINAL segment-based fare.
 *
 * Worked example (numbers you can check by hand; see segmentFares.test.ts). Nusrat rides Uttara →
 * Dhanmondi and starts alone; Rafiq boards at Mirpur going to Dhanmondi; both are dropped there.
 *   Nusrat's fare = 100 + 180 (Uttara → Mirpur alone) + 98 (Mirpur → Dhanmondi at 70%) = 378 → ৳380
 *   Rafiq's  fare = 100 + 98 = 198 → ৳200
 * Nusrat pays from her wallet: ৳1000 − ৳380 = ৳620. Rafiq pays cash: his wallet stays ৳500.
 *
 * Money is whole taka, the unit fares are stored in.
 */
import request from 'supertest';
import { app } from '../index';
import { sequelize, User, Vehicle, RideRequest, RideEvent, PoolCheckpoint, WalletTransaction } from '../models';
import { migratePayments } from '../migrations';
import { collectPayment } from '../utils/payments';
import { asUser } from './helpers';

let jashim: any;
let nusrat: any;
let rafiq: any;
let shirin: any;
let bullet: any;

type Trip = { pickupZone: string; destinationZone: string };
const UTTARA_TO_DHANMONDI: Trip = { pickupZone: 'Uttara', destinationZone: 'Dhanmondi' };
const MIRPUR_TO_DHANMONDI: Trip = { pickupZone: 'Mirpur', destinationZone: 'Dhanmondi' };

const requestRide = (p: any, trip: Trip, paymentMethod?: unknown) =>
  request(app)
    .post('/ride-requests')
    .set(asUser(p.id))
    .send({ seatCount: 1, allowSharing: true, ...trip, ...(paymentMethod === undefined ? {} : { paymentMethod }) });
const accept = (id: string) => request(app).post(`/ride-requests/${id}/accept`).send({ driverId: jashim.id });
const driverAction = (id: string, action: 'arrive' | 'start' | 'complete') =>
  request(app).patch(`/driver/rides/${id}/${action}`).send({ driverId: jashim.id });
const leave = (id: string, who: any, cancellationZone: string) =>
  request(app).patch(`/passenger/rides/${id}/cancel-in-transit`).set(asUser(who.id)).send({ cancellationZone });
const wallet = (who: any) => request(app).get('/passenger/wallet').set(asUser(who.id));
const ride = async (id: string) => (await RideRequest.findByPk(id))!;
const balance = async (who: any) => (await User.findByPk(who.id))!.walletBalance;

async function join(p: any, trip: Trip, paymentMethod?: unknown) {
  const created = await requestRide(p, trip, paymentMethod);
  expect(created.status).toBe(201);
  const id = created.body.rideRequest.id as string;
  expect((await accept(id)).status).toBe(200);
  return id;
}
async function start(id: string) {
  expect((await driverAction(id, 'arrive')).status).toBe(200);
  expect((await driverAction(id, 'start')).status).toBe(200);
}
/** Nusrat (wallet) starts alone at Uttara; Rafiq (cash) boards at Mirpur. */
async function nusratWalletRafiqCash() {
  const n = await join(nusrat, UTTARA_TO_DHANMONDI, 'wallet');
  await start(n);
  const r = await join(rafiq, MIRPUR_TO_DHANMONDI, 'cash');
  await start(r);
  return { n, r };
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});
afterAll(async () => {
  await sequelize.close();
});

describe('Simulated payments — cash and TeslaPay wallet', () => {
  beforeEach(async () => {
    const mk = async (name: string, role: 'DRIVER' | 'PASSENGER', n: number, walletBalance = 0) =>
      (await User.create({ name: `${name} Test`, phone: `0171500000${n}`, email: `${name.toLowerCase()}-pay@test.com`, password: 'x', role, walletBalance })).toJSON();
    jashim = await mk('Jashim', 'DRIVER', 0);
    nusrat = await mk('Nusrat', 'PASSENGER', 1, 1000);
    rafiq = await mk('Rafiq', 'PASSENGER', 2, 500);
    shirin = await mk('Shirin', 'PASSENGER', 3, 120);
    bullet = (await Vehicle.create({ driverId: jashim.id, modelName: 'Bullet', seatCapacity: 3, licensePlate: 'DTP-0001' })).toJSON();
  });
  afterEach(async () => {
    await WalletTransaction.destroy({ where: {} });
    await PoolCheckpoint.destroy({ where: {} });
    await RideEvent.destroy({ where: {} });
    await RideRequest.destroy({ where: {} });
    await Vehicle.destroy({ where: {} });
    await User.destroy({ where: {} });
  });

  // ─────────────────────────── choosing a method ───────────────────────────
  describe('the payment method', () => {
    it('is chosen when the ride is requested, and defaults to cash', async () => {
      const w = await requestRide(nusrat, UTTARA_TO_DHANMONDI, 'wallet');
      expect(w.body.rideRequest).toMatchObject({ paymentMethod: 'wallet', paymentStatus: 'NOT_DUE', paymentAmount: null });
      const c = await requestRide(rafiq, UTTARA_TO_DHANMONDI);
      expect(c.body.rideRequest).toMatchObject({ paymentMethod: 'cash', paymentStatus: 'NOT_DUE' });
    });

    it('rejects anything but cash or wallet', async () => {
      for (const bad of ['bitcoin', '', 5, null, 'WALLET']) {
        const res = await requestRide(nusrat, UTTARA_TO_DHANMONDI, bad);
        expect(res.status).toBe(400);
        expect(res.body.fields.paymentMethod).toMatch(/cash or wallet/);
      }
      expect(await RideRequest.count()).toBe(0);
    });

    it('nothing is debited or owed before the journey ends', async () => {
      const { n } = await nusratWalletRafiqCash();
      expect(await ride(n)).toMatchObject({ status: 'STARTED', paymentStatus: 'NOT_DUE', paymentAmount: null });
      expect(await balance(nusrat)).toBe(1000);
    });
  });

  // ─────────────────────────── wallet debit ───────────────────────────
  describe('wallet rides', () => {
    it('debits exactly the final segment-based fare on COMPLETED: ৳380', async () => {
      const { n, r } = await nusratWalletRafiqCash();
      await driverAction(n, 'complete');
      await driverAction(r, 'complete');

      expect((await ride(n)).estimatedFare).toBe(380); // the fare from the checkpoint walk
      expect(await ride(n)).toMatchObject({ paymentMethod: 'wallet', paymentStatus: 'PAID', paymentAmount: 380 });
      expect(await balance(nusrat)).toBe(620); // 1000 − 380
      const ledger = await WalletTransaction.findAll({ where: { userId: nusrat.id } });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ rideRequestId: n, type: 'DEBIT', amount: 380, balanceAfter: 620 });
    });

    it('debits the segment fare for the part travelled on CANCELLED_IN_TRANSIT: ৳350', async () => {
      const { n } = await nusratWalletRafiqCash();
      const res = await leave(n, nusrat, 'Mohammadpur');

      expect(res.status).toBe(200);
      expect(res.body.fare.fare).toBe(350); // 100 + 180 + 70
      expect(res.body.payment).toEqual({ method: 'wallet', status: 'PAID', amount: 350, walletBalance: 650 });
      expect(await ride(n)).toMatchObject({ status: 'CANCELLED_IN_TRANSIT', paymentStatus: 'PAID', paymentAmount: 350 });
      expect(await balance(nusrat)).toBe(650);
    });

    it('the debit equals estimatedFare for every wallet ride, whatever the pool did', async () => {
      const a = await join(nusrat, { pickupZone: 'Mohakhali', destinationZone: 'Badda' }, 'wallet');
      const b = await join(rafiq, { pickupZone: 'Mohakhali', destinationZone: 'Badda' }, 'wallet');
      await start(a);
      await start(b);
      await driverAction(a, 'complete');
      await driverAction(b, 'complete');
      // both 4 km shared: 100 + 56 = 156 → ৳155 each
      expect(await balance(nusrat)).toBe(1000 - 155);
      expect(await balance(rafiq)).toBe(500 - 155);
      expect((await ride(a)).paymentAmount).toBe((await ride(a)).estimatedFare);
    });

    it('is charged once: completing a second time is refused and adds no second debit', async () => {
      const { n } = await nusratWalletRafiqCash();
      expect((await driverAction(n, 'complete')).status).toBe(200);
      expect((await driverAction(n, 'complete')).status).toBe(409);
      expect((await leave(n, nusrat, 'Mohammadpur')).status).toBe(409);
      expect(await balance(nusrat)).toBe(620);
      expect(await WalletTransaction.count({ where: { userId: nusrat.id } })).toBe(1);
    });
  });

  // ─────────────────────────── insufficient balance ───────────────────────────
  describe('insufficient balance', () => {
    it('is rejected without going negative: the payment FAILS, the ride still completes, the fare is flagged for cash', async () => {
      // Shirin has ৳120; Mohakhali → Badda alone is ৳180
      const s = await join(shirin, { pickupZone: 'Mohakhali', destinationZone: 'Badda' }, 'wallet');
      await start(s);
      const res = await driverAction(s, 'complete');

      expect(res.status).toBe(200); // the passenger did travel
      expect(res.body).toMatchObject({ status: 'COMPLETED', fare: 180, paymentMethod: 'wallet', paymentStatus: 'FAILED' });
      expect(await balance(shirin)).toBe(120); // untouched, never negative
      expect(await WalletTransaction.count({ where: { userId: shirin.id } })).toBe(0);
      // the amount still owed is recorded so the driver can collect it in cash
      expect(await ride(s)).toMatchObject({ status: 'COMPLETED', paymentStatus: 'FAILED', paymentAmount: 180 });
    });

    it('an exact balance pays and leaves ৳0, never below', async () => {
      await User.update({ walletBalance: 180 }, { where: { id: shirin.id } });
      const s = await join(shirin, { pickupZone: 'Mohakhali', destinationZone: 'Badda' }, 'wallet');
      await start(s);
      await driverAction(s, 'complete');
      expect(await ride(s)).toMatchObject({ paymentStatus: 'PAID', paymentAmount: 180 });
      expect(await balance(shirin)).toBe(0);
    });

    it('one taka short fails', async () => {
      await User.update({ walletBalance: 179 }, { where: { id: shirin.id } });
      const s = await join(shirin, { pickupZone: 'Mohakhali', destinationZone: 'Badda' }, 'wallet');
      await start(s);
      await driverAction(s, 'complete');
      expect(await ride(s)).toMatchObject({ paymentStatus: 'FAILED' });
      expect(await balance(shirin)).toBe(179);
    });

    it('also fails cleanly when leaving mid-trip', async () => {
      const s = await join(shirin, UTTARA_TO_DHANMONDI, 'wallet');
      await start(s);
      const res = await leave(s, shirin, 'Mirpur'); // 100 + 180 = ৳280 > ৳120
      expect(res.status).toBe(200);
      expect(res.body.payment).toEqual({ method: 'wallet', status: 'FAILED', amount: 280, walletBalance: 120 });
      expect(await ride(s)).toMatchObject({ status: 'CANCELLED_IN_TRANSIT', paymentStatus: 'FAILED', paymentAmount: 280 });
      expect(await balance(shirin)).toBe(120);
    });

    it('collectPayment never lets a balance go below zero, even called directly', async () => {
      const created = await requestRide(shirin, UTTARA_TO_DHANMONDI, 'wallet');
      const r = await ride(created.body.rideRequest.id);
      expect(await collectPayment(r, 200)).toBe('FAILED'); // ৳120 < ৳200
      expect(await balance(shirin)).toBe(120);
      expect(await collectPayment(r, 120)).toBe('PAID'); // exactly the balance
      expect(await balance(shirin)).toBe(0);
    });
  });

  // ─────────────────────────── cash ───────────────────────────
  describe('cash rides', () => {
    it('record the amount owed and never touch the wallet', async () => {
      const { n, r } = await nusratWalletRafiqCash();
      await driverAction(n, 'complete');
      await driverAction(r, 'complete');

      expect(await ride(r)).toMatchObject({ paymentMethod: 'cash', paymentStatus: 'CASH_DUE', paymentAmount: 200 });
      expect(await balance(rafiq)).toBe(500);
      expect(await WalletTransaction.count({ where: { userId: rafiq.id } })).toBe(0);
    });

    it('a cash passenger with an EMPTY wallet is not affected, and a mid-trip exit owes the part-trip fare', async () => {
      await User.update({ walletBalance: 0 }, { where: { id: rafiq.id } });
      const { r } = await nusratWalletRafiqCash();
      const res = await leave(r, rafiq, 'Mohammadpur'); // Mirpur → Mohammadpur, 2 on board: 100 + 70 = ৳170
      expect(res.body.payment).toEqual({ method: 'cash', status: 'CASH_DUE', amount: 170, walletBalance: 0 });
      expect(await balance(rafiq)).toBe(0);
      expect(await WalletTransaction.count()).toBe(0);
    });

    it('a cash ride never changes any wallet, including a co-passenger’s', async () => {
      const { n, r } = await nusratWalletRafiqCash();
      await driverAction(r, 'complete'); // Rafiq (cash) finishes first
      expect(await balance(nusrat)).toBe(1000); // Nusrat has not finished, and Rafiq's ride never debits anyone
      await driverAction(n, 'complete');
      expect(await balance(nusrat)).toBe(620);
      expect(await balance(rafiq)).toBe(500);
    });
  });

  // ─────────────────────────── who sees what ───────────────────────────
  describe('who can see what', () => {
    it('a passenger sees their own wallet balance and ledger', async () => {
      const { n, r } = await nusratWalletRafiqCash();
      await driverAction(n, 'complete');
      await driverAction(r, 'complete');

      const mine = await wallet(nusrat);
      expect(mine.status).toBe(200);
      expect(mine.body).toMatchObject({ balance: 620, currency: 'BDT' });
      expect(mine.body.transactions).toEqual([expect.objectContaining({ rideId: n, type: 'DEBIT', amount: 380, balanceAfter: 620 })]);
      expect((await wallet(rafiq)).body).toMatchObject({ balance: 500, transactions: [] });
    });

    it('a passenger can never see another passenger’s wallet', async () => {
      // Someone else's id is refused, no login is refused, and a driver's login is refused
      expect((await request(app).get(`/passenger/wallet?passengerId=${nusrat.id}`).set(asUser(rafiq.id))).status).toBe(403);
      expect((await request(app).get('/passenger/wallet')).status).toBe(401);
      expect((await request(app).get('/passenger/wallet').set(asUser(jashim.id, 'DRIVER'))).status).toBe(403);

      // The response for Rafiq is always Rafiq's, whatever else is asked for
      const res = await request(app).get('/passenger/wallet').set(asUser(rafiq.id));
      expect(res.body.balance).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain(nusrat.id);
    });

    it('no other passenger-facing response carries a wallet balance, and a ride shows only its own payment', async () => {
      const { n, r } = await nusratWalletRafiqCash();
      await driverAction(n, 'complete');

      const rafiqRide = await request(app).get(`/passenger/rides/${r}`).set(asUser(rafiq.id));
      const text = JSON.stringify(rafiqRide.body);
      expect(rafiqRide.body.ride).toMatchObject({ paymentMethod: 'cash', paymentStatus: 'NOT_DUE' });
      expect(text).not.toMatch(/walletBalance|balanceAfter/);
      expect(text).not.toContain('620'); // Nusrat's balance after paying
      expect((await request(app).get(`/passenger/rides/${n}`).set(asUser(rafiq.id))).status).toBe(403); // her ride, her payment

      const nusratRide = (await request(app).get(`/passenger/rides/${n}`).set(asUser(nusrat.id))).body.ride;
      expect(nusratRide).toMatchObject({ paymentMethod: 'wallet', paymentStatus: 'PAID', paymentAmount: 380 });
      const list = JSON.stringify((await request(app).get('/passenger/rides/history').set(asUser(nusrat.id))).body);
      expect(list).not.toMatch(/walletBalance/);
      expect((await request(app).get('/ride-requests/me').set(asUser(nusrat.id))).body.requests[0]).not.toHaveProperty('walletBalance');
    });

    it('the driver sees whether payment succeeded, never a wallet balance', async () => {
      const s = await join(shirin, { pickupZone: 'Mohakhali', destinationZone: 'Badda' }, 'wallet');
      await start(s);
      const completed = await driverAction(s, 'complete');
      expect(completed.body).toMatchObject({ paymentMethod: 'wallet', paymentStatus: 'FAILED' });

      const other = await join(nusrat, { pickupZone: 'Mohakhali', destinationZone: 'Badda' }, 'wallet');
      await start(other);

      const active = await request(app).get(`/driver/rides/active?driverId=${jashim.id}`);
      const history = await request(app).get(`/driver/rides/history?driverId=${jashim.id}`);
      expect(history.body.rides.find((x: any) => x.id === s)).toMatchObject({ paymentMethod: 'wallet', paymentStatus: 'FAILED' });
      expect(active.body.rides.find((x: any) => x.id === other)).toMatchObject({ paymentStatus: 'NOT_DUE' });
      const pool = await request(app).get(`/driver/rides/pool?driverId=${jashim.id}`);
      const timeline = await request(app).get('/driver/rides/timeline').set(asUser(jashim.id, 'DRIVER'));
      const pending = await request(app).get(`/ride-requests/pending?driverId=${jashim.id}`);
      const blob = JSON.stringify([completed.body, active.body, history.body, pool.body, timeline.body, pending.body]);
      expect(blob).not.toMatch(/walletBalance|"balance"|balanceAfter|"wallet":\{/);
      expect(blob).not.toContain('"1000"');
    });
  });

  // ─────────────────────────── edge cases ───────────────────────────
  describe('when nothing should be charged, or only once', () => {
    const MOHAKHALI_TO_BADDA: Trip = { pickupZone: 'Mohakhali', destinationZone: 'Badda' };

    it('a ride cancelled before it starts (by the passenger or the driver) is never charged', async () => {
      const a = await join(nusrat, MOHAKHALI_TO_BADDA, 'wallet');
      expect((await request(app).patch(`/passenger/rides/${a}/cancel`).set(asUser(nusrat.id)).send({})).status).toBe(200);
      const b = await join(rafiq, MOHAKHALI_TO_BADDA, 'wallet');
      expect((await request(app).patch(`/driver/rides/${b}/cancel`).send({ driverId: jashim.id })).status).toBe(200);
      const c = (await requestRide(shirin, MOHAKHALI_TO_BADDA, 'wallet')).body.rideRequest.id; // never accepted
      expect((await request(app).patch(`/passenger/rides/${c}/cancel`).set(asUser(shirin.id)).send({})).status).toBe(200);

      for (const id of [a, b, c]) expect(await ride(id)).toMatchObject({ status: 'CANCELLED', paymentStatus: 'NOT_DUE', paymentAmount: null });
      expect([await balance(nusrat), await balance(rafiq), await balance(shirin)]).toEqual([1000, 500, 120]);
      expect(await WalletTransaction.count()).toBe(0);
    });

    it('completing twice at the same moment debits once', async () => {
      const id = await join(nusrat, MOHAKHALI_TO_BADDA, 'wallet');
      await start(id);
      const results = await Promise.all([driverAction(id, 'complete'), driverAction(id, 'complete')]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await balance(nusrat)).toBe(1000 - 180);
      expect(await WalletTransaction.count({ where: { rideRequestId: id } })).toBe(1);
    });

    it('two rides in a row debit cumulatively, each ledger row showing the balance it left', async () => {
      for (let i = 0; i < 2; i++) {
        const id = await join(nusrat, MOHAKHALI_TO_BADDA, 'wallet');
        await start(id);
        await driverAction(id, 'complete');
      }
      expect(await balance(nusrat)).toBe(1000 - 180 - 180); // each ride is alone on board: ৳180
      const ledger = await WalletTransaction.findAll({ where: { userId: nusrat.id }, order: [['id', 'ASC']] });
      expect(ledger.map((l) => [l.amount, l.balanceAfter])).toEqual([[180, 820], [180, 640]]);
    });

    it('the payment shows on the passenger’s history and on the driver’s active list', async () => {
      const id = await join(nusrat, MOHAKHALI_TO_BADDA, 'wallet');
      await start(id);
      const active = await request(app).get(`/driver/rides/active?driverId=${jashim.id}`);
      expect(active.body.rides[0]).toMatchObject({ paymentMethod: 'wallet', paymentStatus: 'NOT_DUE' });
      await driverAction(id, 'complete');

      const history = await request(app).get('/passenger/rides/history').set(asUser(nusrat.id));
      expect(history.body.rides[0]).toMatchObject({ paymentMethod: 'wallet', paymentStatus: 'PAID', paymentAmount: 180, estimatedFare: 180 });
    });

    it('the driver sees a pending request’s payment method but never a balance', async () => {
      await requestRide(nusrat, MOHAKHALI_TO_BADDA, 'wallet');
      const pending = await request(app).get(`/ride-requests/pending?driverId=${jashim.id}`);
      expect(pending.body.requests[0]).toMatchObject({ paymentMethod: 'wallet', paymentStatus: 'NOT_DUE' });
      expect(JSON.stringify(pending.body)).not.toMatch(/walletBalance|balance/i);
    });
  });

  // ─────────────────────────── upgrading a database ───────────────────────────
  describe('upgrading an existing database', () => {
    it('adds the payment columns once, with safe defaults', async () => {
      await sequelize.query('ALTER TABLE `Users` DROP COLUMN `walletBalance`');
      for (const c of ['paymentMethod', 'paymentStatus', 'paymentAmount']) await sequelize.query(`ALTER TABLE \`RideRequests\` DROP COLUMN \`${c}\``);

      await migratePayments();
      await migratePayments(); // idempotent

      const cols = async (t: string) => ((await sequelize.query(`PRAGMA table_info(\`${t}\`)`))[0] as any[]).map((c) => c.name);
      expect(await cols('Users')).toContain('walletBalance');
      expect(await cols('RideRequests')).toEqual(expect.arrayContaining(['paymentMethod', 'paymentStatus', 'paymentAmount']));
      const u = await User.create({ name: 'Old', phone: '01715999999', email: 'old-pay@test.com', password: 'x', role: 'PASSENGER' });
      expect(u.walletBalance).toBe(0);
    });
  });
});
