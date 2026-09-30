/**
 * Street rides by QR code, for drivers with no smartphone: the driver never logs in and never acts.
 *
 * WORKED EXAMPLE (numbers you can check by hand). Zone distances: Uttara–Mirpur 9 km, Mirpur–Dhanmondi 7 km
 * (so Uttara → Dhanmondi is 9 + 7 = 16 km). Distance charge = km × ৳20. Share rate: 100% alone, 70% with 2.
 *   Nusrat scans Bullet's code and rides Uttara → Dhanmondi.   session opens; events: Nusrat joins at Uttara (1 on board)
 *   Rafiq  scans the same code and rides Uttara → Mirpur.       Rafiq joins at Uttara (2 on board)  → driver bonus ৳10
 *   Rafiq taps "I've arrived" (at Mirpur).                       Rafiq gets off at Mirpur (1 on board)
 *   Nusrat taps "I've arrived" (at Dhanmondi).                   Nusrat gets off at Dhanmondi (0 on board) → session CLOSED
 *
 *   Nusrat:  Uttara → Mirpur      9 km × 20 = ৳180  2 on board (70%)  = ৳126
 *            Mirpur → Dhanmondi   7 km × 20 = ৳140  alone (100%)      = ৳140
 *            fare = 100 + 126 + 140 = 366 → ৳365      (riding alone all the way: 100 + 320 = ৳420, so pooling saved ৳55)
 *   Rafiq:   Uttara → Mirpur      9 km × 20 = ৳180  2 on board (70%)  = ৳126
 *            fare = 100 + 126 = 226 → ৳225            (alone: 100 + 180 = ৳280, so pooling saved ৳55)
 *   Both pay CASH to the driver. The driver's record gets ৳10 (one passenger beyond the first). Revenue ৳590.
 */
import request from 'supertest';
import { app } from '../index';
import {
  sequelize,
  User,
  Vehicle,
  RideRequest,
  RideEvent,
  PoolCheckpoint,
  WalletTransaction,
  QRRideSession,
  QRRideParticipant,
  DriverBonus,
  DriverProfile,
} from '../models';
import { ensureOneActiveRideIndex, ensureOneOpenQRSessionIndex, migrateVehicleCodes } from '../migrations';
import { closeStaleSessions, QR_SESSION_TIMEOUT_MINUTES, DRIVER_BONUS_PER_EXTRA_PASSENGER } from '../services/qrRides';
import { normalizeVehicleCode } from '../utils/vehicleCode';
import { asUser } from './helpers';

let jashim: any;
let nusrat: any;
let rafiq: any;
let shirin: any;
let tania: any;
let bullet: any;
let jashimProfile: any;
let nidCounter = 1000000000;

const UTTARA_TO_DHANMONDI = { pickupZone: 'Uttara', destinationZone: 'Dhanmondi' };
const UTTARA_TO_MIRPUR = { pickupZone: 'Uttara', destinationZone: 'Mirpur' };

// Bullet's public code is its driver's Tesla ID (e.g. "DTP-0007"): the same value the app shows as "Tesla ID"
const join = (who: any, body: Record<string, unknown> = {}) =>
  request(app).post('/qr/join').set(asUser(who.id)).send({ vehicleCode: bullet.vehicleCode, ...body });
const arrived = (who: any, sessionId: string) => request(app).post(`/qr/sessions/${sessionId}/arrived`).set(asUser(who.id)).send({});
const view = (who: any, sessionId: string) => request(app).get(`/qr/sessions/${sessionId}`).set(asUser(who.id));
const occupied = async () => (await Vehicle.findByPk(bullet.id))!.occupiedSeats;
const sessions = () => QRRideSession.findAll({ where: { vehicleId: bullet.id }, order: [['createdAt', 'ASC']] });

beforeAll(async () => {
  await sequelize.sync({ force: true });
  await ensureOneActiveRideIndex();
  await ensureOneOpenQRSessionIndex();
});
afterAll(async () => {
  await sequelize.close();
});

describe('QR street rides', () => {
  beforeEach(async () => {
    const mk = async (name: string, role: 'DRIVER' | 'PASSENGER', n: number, walletBalance = 0) =>
      (await User.create({ name: `${name} Test`, phone: `0171700000${n}`, email: `${name.toLowerCase()}-qr@test.com`, password: 'x', role, walletBalance })).toJSON();
    jashim = await mk('Jashim', 'DRIVER', 0);
    nusrat = await mk('Nusrat', 'PASSENGER', 1, 1000);
    rafiq = await mk('Rafiq', 'PASSENGER', 2, 500);
    shirin = await mk('Shirin', 'PASSENGER', 3);
    tania = await mk('Tania', 'PASSENGER', 4);
    // Onboarded the way the real flow does it: profile first (its id becomes the Tesla ID), then the vehicle
    jashimProfile = await DriverProfile.create({ userId: jashim.id, homeZone: 'Banani', nid: String(++nidCounter) });
    bullet = (await Vehicle.create({ driverId: jashim.id, modelName: 'Bullet', seatCapacity: 3, licensePlate: jashimProfile.driverCode })).toJSON();
  });
  afterEach(async () => {
    await DriverBonus.destroy({ where: {} });
    await QRRideParticipant.destroy({ where: {} });
    await QRRideSession.destroy({ where: {} });
    await WalletTransaction.destroy({ where: {} });
    await PoolCheckpoint.destroy({ where: {} });
    await RideEvent.destroy({ where: {} });
    await RideRequest.destroy({ where: {} });
    await Vehicle.destroy({ where: {} });
    await DriverProfile.destroy({ where: {} });
    await User.destroy({ where: {} });
  });

  // ─────────────────────────── the vehicle code ───────────────────────────
  describe('the public vehicle code', () => {
    it('every vehicle gets a unique, typeable code automatically', async () => {
      const other = await User.create({ name: 'Kamal', phone: '01717999999', email: 'kamal-qr@test.com', password: 'x', role: 'DRIVER' });
      const codes = new Set<string>([bullet.vehicleCode]);
      for (let i = 0; i < 25; i++) {
        const v = await Vehicle.create({ driverId: other.id, modelName: `Car ${i}`, seatCapacity: 3, licensePlate: `AUTO-${i}`, isActive: false });
        expect(v.vehicleCode).toMatch(/^[ABCDEFGHJKMNPQRTUVWXYZ234679]{6}$/); // no look-alike characters
        codes.add(v.vehicleCode);
      }
      expect(codes.size).toBe(26);
    });

    it('is forgiving about case, spaces and hyphens, and rejects nonsense', () => {
      expect(normalizeVehicleCode('bullet')).toBe('BULLET');
      expect(normalizeVehicleCode('4kq 7m2')).toBe('4KQ7M2');
      // a hyphen is part of a Tesla ID and is kept
      expect(normalizeVehicleCode(' dtp-0001 ')).toBe('DTP-0001');
      expect(normalizeVehicleCode('DTP_0001')).toBe('DTP0001');
      for (const bad of ['', 'ab', 'x'.repeat(30), '???', '-DTP', 'DTP-', 'DTP--0001', null, 42]) expect(normalizeVehicleCode(bad)).toBeNull();
    });

    it('cannot be duplicated', async () => {
      await expect(Vehicle.create({ driverId: jashim.id, modelName: 'Clone', seatCapacity: 3, licensePlate: 'CLONE-1', vehicleCode: bullet.vehicleCode, isActive: false })).rejects.toThrow();
    });

    it('is added to an existing database once, and every existing vehicle is backfilled', async () => {
      // Rebuild Vehicles the way it looked before the QR flow: no vehicleCode column
      await sequelize.query('PRAGMA foreign_keys = OFF');
      await sequelize.query('DROP TABLE `Vehicles`');
      await sequelize.query(
        'CREATE TABLE `Vehicles` (`id` UUID PRIMARY KEY, `driverId` UUID NOT NULL, `modelName` VARCHAR(255) NOT NULL, `seatCapacity` INTEGER NOT NULL, ' +
          '`licensePlate` VARCHAR(255) NOT NULL UNIQUE, `isActive` TINYINT(1) NOT NULL DEFAULT 1, `occupiedSeats` INTEGER NOT NULL DEFAULT 0, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)'
      );
      // Jashim (who has a Tesla ID) has three legacy vehicles; Kamal, with no profile, has one
      const kamal = await User.create({ name: 'Kamal', phone: '01717777777', email: 'kamal3-qr@test.com', password: 'x', role: 'DRIVER' });
      const legacy: [string, string, string][] = [
        ['00000000-0000-4000-8000-000000000001', jashim.id, 'OLD-1'],
        ['00000000-0000-4000-8000-000000000002', jashim.id, 'OLD-2'],
        ['00000000-0000-4000-8000-000000000003', jashim.id, 'OLD-3'],
        ['00000000-0000-4000-8000-000000000004', kamal.id, 'OLD-4'],
      ];
      for (const [i, [id, driverId, plate]] of legacy.entries()) {
        await sequelize.query(
          'INSERT INTO `Vehicles` (`id`,`driverId`,`modelName`,`seatCapacity`,`licensePlate`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,?,?,?)',
          { replacements: [id, driverId, 'Old', 3, plate, new Date(2024, 0, 1 + i).toISOString(), new Date().toISOString()] }
        );
      }
      await migrateVehicleCodes();
      await migrateVehicleCodes(); // idempotent
      const rows = (await sequelize.query('SELECT id, vehicleCode FROM `Vehicles` ORDER BY id'))[0] as { id: string; vehicleCode: string }[];
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map((r) => r.vehicleCode)).size).toBe(4); // all unique
      // the driver's OLDEST active vehicle carries the Tesla ID; the rest, and Kamal's, get random codes
      expect(rows[0]!.vehicleCode).toBe(jashimProfile.driverCode);
      for (const r of rows.slice(1)) expect(r.vehicleCode).toMatch(/^[A-Z0-9]{6}$/);
      // put the schema back for the rest of the suite
      await sequelize.query('PRAGMA foreign_keys = ON');
      await sequelize.sync({ force: true });
      await ensureOneActiveRideIndex();
      await ensureOneOpenQRSessionIndex();
    });
  });

  // ─────────────────────────── the code shown is the code accepted ───────────────────────────
  describe('one public ID: the Tesla ID shown in the app is the code the lookup accepts', () => {
    it('an onboarded vehicle’s code IS its driver’s Tesla ID, and equals the plate copied from it', async () => {
      expect(bullet.vehicleCode).toBe(jashimProfile.driverCode); // e.g. "DTP-0007"
      expect(bullet.vehicleCode).toMatch(/^DTP-\d{4,}$/);
      expect(bullet.licensePlate).toBe(bullet.vehicleCode);
    });

    it('the "Tesla ID" the app displays for the vehicle is exactly what the street-ride lookup accepts', async () => {
      // What a passenger sees on an app ride card (RideStatusCard: vehicle.teslaId, i.e. the driver's Tesla ID)...
      const created = await request(app).post('/ride-requests').set(asUser(shirin.id)).send({ pickupZone: 'Mohakhali', destinationZone: 'Badda', seatCount: 1 });
      await request(app).post(`/ride-requests/${created.body.rideRequest.id}/accept`).send({ driverId: jashim.id });
      const card = (await request(app).get(`/passenger/rides/${created.body.rideRequest.id}`).set(asUser(shirin.id))).body.ride;
      const displayedTeslaId = card.vehicle.teslaId as string;
      expect(displayedTeslaId).toBe(jashimProfile.driverCode);

      // ...typed exactly as displayed into the street-ride lookup finds Bullet
      const found = await request(app).get(`/qr/vehicles/${encodeURIComponent(displayedTeslaId)}`).set(asUser(tania.id));
      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({ vehicleCode: displayedTeslaId, vehicle: { nickname: 'Bullet' } });
      // and joining with it works
      expect((await join(nusrat, { vehicleCode: displayedTeslaId, ...UTTARA_TO_DHANMONDI })).status).toBe(201);
    });

    it('the same Tesla ID is accepted however it is typed: case, spaces, and with or without the hyphen', async () => {
      const id = bullet.vehicleCode as string; // "DTP-0007"
      const spellings = [id, id.toLowerCase(), id.replace('-', ''), id.replace('-', '').toLowerCase(), `  ${id.toLowerCase()}  `, id.replace('-', ' ')];
      for (const typed of spellings) {
        const res = await request(app).get(`/qr/vehicles/${encodeURIComponent(typed)}`).set(asUser(tania.id));
        expect([typed, res.status]).toEqual([typed, 200]);
        expect(res.body.vehicleCode).toBe(id); // always answered with the canonical code
      }
      // and it is not fooled by a longer code that merely starts with it
      expect((await request(app).get(`/qr/vehicles/${id}9`).set(asUser(tania.id))).status).toBe(404);
    });

    it('a vehicle onboarded through the real onboarding endpoint gets its Tesla ID as its code', async () => {
      const signup = await request(app).post('/auth/signup').send({ name: 'Kamal', phone: '01717666666', password: 'secret123', role: 'DRIVER' });
      expect(signup.status).toBe(201);
      const done = await request(app)
        .post('/driver/onboarding')
        .set('Authorization', `Bearer ${signup.body.token}`)
        .send({ nickname: 'Rocket', seatCapacity: 3, homeZone: 'Banani', nid: String(++nidCounter) });
      expect(done.status).toBe(201);
      const teslaId = done.body.profile.driverCode as string;

      const vehicle = await Vehicle.findOne({ where: { driverId: signup.body.user.id } });
      expect(vehicle!.vehicleCode).toBe(teslaId);
      expect(vehicle!.licensePlate).toBe(teslaId);
      const found = await request(app).get(`/qr/vehicles/${teslaId}`).set(asUser(tania.id));
      expect(found.body).toMatchObject({ vehicleCode: teslaId, vehicle: { nickname: 'Rocket' } });
    });

    it('a vehicle with no driver profile still gets a usable random code', async () => {
      const kamal = await User.create({ name: 'Kamal', phone: '01717555555', email: 'kamal4-qr@test.com', password: 'x', role: 'DRIVER' });
      const v = await Vehicle.create({ driverId: kamal.id, modelName: 'Plain', seatCapacity: 3, licensePlate: 'PLAIN-1' });
      expect(v.vehicleCode).toMatch(/^[A-Z0-9]{6}$/);
      expect((await request(app).get(`/qr/vehicles/${v.vehicleCode}`).set(asUser(tania.id))).body.vehicle.nickname).toBe('Plain');
    });

    it('seat claims and releases never change a vehicle’s code', async () => {
      const before = bullet.vehicleCode;
      const a = await join(nusrat, UTTARA_TO_DHANMONDI);
      await join(rafiq, UTTARA_TO_MIRPUR);
      await arrived(rafiq, a.body.session.id);
      await arrived(nusrat, a.body.session.id);
      expect((await Vehicle.findByPk(bullet.id))!.vehicleCode).toBe(before);
    });

    it('a hand-set code is kept at creation, and the migration moves an old code to the Tesla ID exactly once', async () => {
      const kamal = await User.create({ name: 'Kamal', phone: '01717444444', email: 'kamal5-qr@test.com', password: 'x', role: 'DRIVER' });
      const profile = await DriverProfile.create({ userId: kamal.id, homeZone: 'Banani', nid: String(++nidCounter) });
      const v = await Vehicle.create({ driverId: kamal.id, modelName: 'Old', seatCapacity: 3, licensePlate: 'OLDPLATE', vehicleCode: 'ZZZZ99' });
      expect(v.vehicleCode).toBe('ZZZZ99'); // explicitly chosen: kept at creation
      await migrateVehicleCodes(); // the invariant: an onboarded active vehicle's code is its Tesla ID
      expect((await Vehicle.findByPk(v.id))!.vehicleCode).toBe(profile.driverCode);
      await migrateVehicleCodes();
      expect((await Vehicle.findByPk(v.id))!.vehicleCode).toBe(profile.driverCode);
      expect((await Vehicle.findByPk(bullet.id))!.vehicleCode).toBe(jashimProfile.driverCode); // untouched
    });
  });

  // ─────────────────────────── joining and fares (the worked example) ───────────────────────────
  describe('two passengers, different destinations', () => {
    it('worked example: Nusrat ৳365, Rafiq ৳225, the driver earns a ৳10 bonus, everyone pays cash', async () => {
      const first = await join(nusrat, UTTARA_TO_DHANMONDI);
      expect(first.status).toBe(201);
      const sessionId = first.body.session.id as string;
      expect(first.body.session.status).toBe('OPEN');
      // alone so far: 100 + 16 × 20 = ৳420
      expect(first.body.session.you).toMatchObject({ passengerNumber: 1, fare: 420, fareFinal: false, baseFare: 420 });

      const second = await join(rafiq, UTTARA_TO_MIRPUR);
      expect(second.status).toBe(201);
      expect(second.body.session.id).toBe(sessionId); // joined the OPEN session, no new one
      expect(second.body.session.you).toMatchObject({ passengerNumber: 2, fareFinal: false });
      // running estimates with 2 on board: Rafiq 100 + 180 × 70% = 226 → 225; Nusrat 100 + 320 × 70% = 324 → 325
      expect(second.body.session.you.fare).toBe(225);
      expect((await view(nusrat, sessionId)).body.session.you.fare).toBe(325);
      expect(await occupied()).toBe(2);

      // Rafiq gets off first, then Nusrat
      const r = await arrived(rafiq, sessionId);
      expect(r.status).toBe(200);
      expect(r.body.session.status).toBe('OPEN'); // Nusrat is still riding
      expect(r.body.session.you).toMatchObject({ status: 'ARRIVED', fare: 225, fareFinal: true, poolDiscount: 55 });
      expect(r.body.session.you.payment).toEqual({ method: 'cash', status: 'CASH_DUE', amount: 225 });
      expect(await occupied()).toBe(1);

      const n = await arrived(nusrat, sessionId);
      expect(n.body.session.status).toBe('CLOSED');
      expect(n.body.session.closeReason).toBe('ALL_ARRIVED');
      expect(n.body.session.you).toMatchObject({ status: 'ARRIVED', fare: 365, fareFinal: true, poolDiscount: 55 });
      expect(n.body.session.you.payment).toEqual({ method: 'cash', status: 'CASH_DUE', amount: 365 });
      // (the first stretch is 0 km: the moment between Nusrat joining and Rafiq joining at the same zone, which costs nothing)
      expect(n.body.session.you.fareBreakdown.segments).toEqual([
        { distanceKm: 0, distanceCharge: 0, passengers: 1, ratePercent: 100, charge: 0 },
        { distanceKm: 9, distanceCharge: 180, passengers: 2, ratePercent: 70, charge: 126 }, // shared
        { distanceKm: 7, distanceCharge: 140, passengers: 1, ratePercent: 100, charge: 140 }, // alone again
      ]);
      expect(await occupied()).toBe(0);

      // Revenue reconciles: each stretch charged once per passenger on it
      const fares = (await QRRideParticipant.findAll({ where: { sessionId }, order: [['passengerNumber', 'ASC']] })).map((p) => p.finalFare);
      expect(fares).toEqual([365, 225]);
      expect(365 + 225).toBe(590);
      // Every stretch charged once per passenger on it: 2 × ৳100 base + 126 + 126 (shared, both) + 140 (Nusrat alone) = ৳592,
      // and each fare is rounded down to the nearest ৳5 (366 → 365, 226 → 225): ৳2 in total, never more than ৳2.50 each
      expect(200 + 126 + 126 + 140 - 590).toBe(2);
    });

    it('the second passenger really does get a different fare from the first (different destinations)', async () => {
      const a = await join(nusrat, UTTARA_TO_DHANMONDI);
      await join(rafiq, UTTARA_TO_MIRPUR);
      const sessionId = a.body.session.id;
      await arrived(rafiq, sessionId);
      await arrived(nusrat, sessionId);
      const [n, r] = await QRRideParticipant.findAll({ where: { sessionId }, order: [['passengerNumber', 'ASC']] });
      expect(n!.finalFare).not.toBe(r!.finalFare);
      expect([n!.destinationZone, r!.destinationZone]).toEqual(['Dhanmondi', 'Mirpur']);
    });

    it('a passenger who rides alone pays the full solo fare and earns the driver no bonus', async () => {
      const s = await join(nusrat, UTTARA_TO_DHANMONDI);
      const done = await arrived(nusrat, s.body.session.id);
      expect(done.body.session.you).toMatchObject({ fare: 420, poolDiscount: 0 });
      expect(done.body.session.status).toBe('CLOSED');
      expect(await DriverBonus.count()).toBe(0);
    });
  });

  // ─────────────────────────── the driver bonus ───────────────────────────
  describe('the driver bonus', () => {
    it('is ৳10 for every passenger beyond the first, credited to the vehicle’s driver', async () => {
      expect(DRIVER_BONUS_PER_EXTRA_PASSENGER).toBe(10);
      await join(nusrat, UTTARA_TO_DHANMONDI);
      expect(await DriverBonus.count()).toBe(0); // the first passenger earns nothing extra
      await join(rafiq, UTTARA_TO_MIRPUR);
      expect(await DriverBonus.sum('amount')).toBe(10);
      await join(shirin, UTTARA_TO_MIRPUR);
      expect(await DriverBonus.sum('amount')).toBe(20);
      const rows = await DriverBonus.findAll();
      expect(rows.every((b) => b.driverId === jashim.id)).toBe(true);
    });

    it('the driver reads it with their own login; passengers cannot', async () => {
      await join(nusrat, UTTARA_TO_DHANMONDI);
      await join(rafiq, UTTARA_TO_MIRPUR);
      const res = await request(app).get('/qr/bonus').set(asUser(jashim.id, 'DRIVER'));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ perExtraPassenger: 10, total: 10 });
      expect(res.body.entries).toHaveLength(1);
      expect((await request(app).get('/qr/bonus').set(asUser(nusrat.id))).status).toBe(403);
      expect((await request(app).get('/qr/bonus')).status).toBe(401);
    });

    it('is not paid twice for one passenger, and a rejected join earns nothing', async () => {
      await join(nusrat, UTTARA_TO_DHANMONDI);
      await join(rafiq, UTTARA_TO_MIRPUR);
      expect((await join(rafiq, UTTARA_TO_MIRPUR)).status).toBe(409); // already in the session
      expect(await DriverBonus.sum('amount')).toBe(10);
    });
  });

  // ─────────────────────────── capacity: same as the app flow ───────────────────────────
  describe('capacity is enforced the same way as in the app', () => {
    it('refuses a passenger who does not fit, with the same 409 and message, and changes nothing', async () => {
      await join(nusrat, { ...UTTARA_TO_DHANMONDI, seatCount: 2 });
      await join(rafiq, UTTARA_TO_MIRPUR); // 3 of 3
      expect(await occupied()).toBe(3);

      const full = await join(shirin, UTTARA_TO_MIRPUR);
      expect(full.status).toBe(409);
      expect(full.body.error).toBe('Not enough seats available.'); // the app's accept says exactly this
      expect(full.body.code).toBe('CAPACITY_EXCEEDED');
      expect(await occupied()).toBe(3);
      expect(await QRRideParticipant.count()).toBe(2);
      expect(await DriverBonus.count()).toBe(1); // only Rafiq's
    });

    it('a request for more seats than are left is refused', async () => {
      await join(nusrat, { ...UTTARA_TO_DHANMONDI, seatCount: 2 }); // 1 seat left
      const res = await join(rafiq, { ...UTTARA_TO_MIRPUR, seatCount: 2 });
      expect(res.status).toBe(409);
      expect(await occupied()).toBe(2);
    });

    it('two passengers racing for the last seat: exactly one wins', async () => {
      await join(nusrat, { ...UTTARA_TO_DHANMONDI, seatCount: 2 }); // 1 seat left
      const results = await Promise.all([join(rafiq, UTTARA_TO_MIRPUR), join(shirin, UTTARA_TO_MIRPUR)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await occupied()).toBe(3); // never 4
      expect(await QRRideParticipant.count()).toBe(2);
    });

    it('two first passengers arriving together open ONE session between them', async () => {
      const results = await Promise.all([join(nusrat, UTTARA_TO_DHANMONDI), join(rafiq, UTTARA_TO_MIRPUR)]);
      expect(results.map((r) => r.status)).toEqual([201, 201]);
      expect(results[0]!.body.session.id).toBe(results[1]!.body.session.id);
      expect((await sessions()).filter((s) => s.status === 'OPEN')).toHaveLength(1);
      expect((await QRRideParticipant.findAll()).map((p) => p.passengerNumber).sort()).toEqual([1, 2]);
    });

    it('a seat freed by an arrival can be taken by the next passenger', async () => {
      await join(nusrat, { ...UTTARA_TO_DHANMONDI, seatCount: 2 });
      const r = await join(rafiq, UTTARA_TO_MIRPUR);
      expect((await join(shirin, UTTARA_TO_MIRPUR)).status).toBe(409);
      await arrived(rafiq, r.body.session.id);
      expect((await join(shirin, UTTARA_TO_MIRPUR)).status).toBe(201);
      expect(await occupied()).toBe(3);
    });
  });

  // ─────────────────────────── the two flows do not collide ───────────────────────────
  describe('street rides and app rides on the same vehicle', () => {
    const acceptAppRide = async (who: any, seatCount: number) => {
      const created = await request(app).post('/ride-requests').set(asUser(who.id)).send({ pickupZone: 'Mohakhali', destinationZone: 'Badda', seatCount });
      const id = created.body.rideRequest.id as string;
      const res = await request(app).post(`/ride-requests/${id}/accept`).send({ driverId: jashim.id });
      return { id, res };
    };

    it('share the vehicle’s seats, so the car can never be over-booked across both', async () => {
      const app1 = await acceptAppRide(shirin, 2); // an app ride takes 2 of 3 seats
      expect(app1.res.status).toBe(200);
      expect((await join(nusrat, { ...UTTARA_TO_DHANMONDI, seatCount: 2 })).status).toBe(409); // only 1 left
      expect((await join(nusrat, UTTARA_TO_DHANMONDI)).status).toBe(201);
      expect(await occupied()).toBe(3);
      // and the app flow sees the street passenger's seat when it looks for room
      const pending = await request(app).get(`/ride-requests/pending?driverId=${jashim.id}`);
      expect(pending.body.availableSeats).toBe(0);
    });

    it('do not release each other’s seats or show up in each other’s records', async () => {
      const app1 = await acceptAppRide(shirin, 2);
      const street = await join(nusrat, UTTARA_TO_DHANMONDI); // 3 of 3

      // The street passenger is not a ride: the app's pool, earnings and history know nothing about them
      const active = await request(app).get(`/driver/rides/active?driverId=${jashim.id}`);
      expect(active.body.rides).toHaveLength(1);
      expect(active.body.poolSize).toBe(1);
      expect(await RideRequest.count()).toBe(1);
      expect(await PoolCheckpoint.count()).toBe(0);

      // The street passenger leaves: only their own seat is released
      await arrived(nusrat, street.body.session.id);
      expect(await occupied()).toBe(2);
      // The app ride carries on, completes and releases only its own 2 seats
      await request(app).patch(`/driver/rides/${app1.id}/arrive`).send({ driverId: jashim.id });
      await request(app).patch(`/driver/rides/${app1.id}/start`).send({ driverId: jashim.id });
      await request(app).patch(`/driver/rides/${app1.id}/complete`).send({ driverId: jashim.id });
      expect(await occupied()).toBe(0);
    });

    it('an app ride completing does not close or charge a street session', async () => {
      const app1 = await acceptAppRide(shirin, 1);
      const street = await join(nusrat, UTTARA_TO_DHANMONDI);
      await request(app).patch(`/driver/rides/${app1.id}/arrive`).send({ driverId: jashim.id });
      await request(app).patch(`/driver/rides/${app1.id}/start`).send({ driverId: jashim.id });
      await request(app).patch(`/driver/rides/${app1.id}/complete`).send({ driverId: jashim.id });
      const s = await view(nusrat, street.body.session.id);
      expect(s.body.session).toMatchObject({ status: 'OPEN' });
      expect(s.body.session.you).toMatchObject({ status: 'RIDING', fare: 420, fareFinal: false });
      expect(await occupied()).toBe(1); // exactly the street passenger's seat
    });

    it('a passenger cannot be in an app ride and a street ride at once, nor two street rides', async () => {
      await acceptAppRide(shirin, 1);
      const both = await join(shirin, UTTARA_TO_DHANMONDI);
      expect(both.status).toBe(409);
      expect(both.body.code).toBe('ACTIVE_RIDE_EXISTS');

      const other = await User.create({ name: 'Kamal', phone: '01717888888', email: 'kamal2-qr@test.com', password: 'x', role: 'DRIVER' });
      await Vehicle.create({ driverId: other.id, modelName: 'Rocket', seatCapacity: 3, licensePlate: 'ROCKET-1', vehicleCode: 'ROCKET' });
      await join(nusrat, UTTARA_TO_DHANMONDI);
      const twice = await join(nusrat, UTTARA_TO_MIRPUR, );
      expect(twice.status).toBe(409);
      const elsewhere = await request(app).post('/qr/join').set(asUser(nusrat.id)).send({ vehicleCode: 'ROCKET', ...UTTARA_TO_MIRPUR });
      expect(elsewhere.body.code).toBe('ALREADY_IN_SESSION');
    });
  });

  // ─────────────────────────── ending a ride ───────────────────────────
  describe('arriving and closing', () => {
    it('the session closes when EVERY passenger has marked arrival, not before', async () => {
      const a = await join(nusrat, UTTARA_TO_DHANMONDI);
      await join(rafiq, UTTARA_TO_MIRPUR);
      await join(shirin, UTTARA_TO_MIRPUR);
      const id = a.body.session.id;
      await arrived(rafiq, id);
      await arrived(shirin, id);
      expect((await QRRideSession.findByPk(id))!.status).toBe('OPEN');
      await arrived(nusrat, id);
      expect(await QRRideSession.findByPk(id)).toMatchObject({ status: 'CLOSED', closeReason: 'ALL_ARRIVED' });
      expect((await QRRideSession.findByPk(id))!.closedAt).toBeTruthy();
      expect(await occupied()).toBe(0);
    });

    it('cannot be confirmed twice, and only by the passenger themselves', async () => {
      const a = await join(nusrat, UTTARA_TO_DHANMONDI);
      await join(rafiq, UTTARA_TO_MIRPUR);
      const id = a.body.session.id;
      // Shirin is not in this ride; nobody can arrive for someone else (the passenger is the person logged in)
      expect((await arrived(shirin, id)).status).toBe(403);
      expect((await request(app).post(`/qr/sessions/${id}/arrived`).send({})).status).toBe(401);
      expect((await request(app).post(`/qr/sessions/${id}/arrived`).set(asUser(jashim.id, 'DRIVER')).send({})).status).toBe(403); // no driver confirmation exists
      expect((await arrived(rafiq, id)).status).toBe(200);
      const again = await arrived(rafiq, id);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('ALREADY_ARRIVED');
      expect(await occupied()).toBe(1); // released once
    });

    it('a finished passenger can start a new street ride', async () => {
      const a = await join(nusrat, UTTARA_TO_DHANMONDI);
      await arrived(nusrat, a.body.session.id);
      const b = await join(nusrat, UTTARA_TO_MIRPUR);
      expect(b.status).toBe(201);
      expect(b.body.session.id).not.toBe(a.body.session.id);
    });
  });

  // ─────────────────────────── joining a closed ride ───────────────────────────
  describe('joining after CLOSED is rejected', () => {
    it('refuses to join the ride that was shown if it has closed, instead of quietly opening another', async () => {
      const a = await join(nusrat, UTTARA_TO_DHANMONDI);
      const sessionId = a.body.session.id;
      // Rafiq scanned while it was open (the preview returned its id)...
      const preview = await request(app).get(`/qr/vehicles/${bullet.vehicleCode}`).set(asUser(rafiq.id));
      expect(preview.body.session.id).toBe(sessionId);
      // ...but it closes before he confirms
      await arrived(nusrat, sessionId);

      const late = await join(rafiq, { ...UTTARA_TO_MIRPUR, sessionId });
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('SESSION_CLOSED');
      expect(late.body.error).toMatch(/already ended/i);
      expect(await QRRideParticipant.count({ where: { sessionId } })).toBe(1);
      expect(await occupied()).toBe(0);
      expect(await DriverBonus.count()).toBe(0);

      // Scanning again (no session id) simply starts a fresh ride
      const fresh = await join(rafiq, UTTARA_TO_MIRPUR);
      expect(fresh.status).toBe(201);
      expect(fresh.body.session.id).not.toBe(sessionId);
    });

    it('cannot mark arrival on a closed ride', async () => {
      const a = await join(nusrat, UTTARA_TO_DHANMONDI);
      await arrived(nusrat, a.body.session.id);
      const res = await arrived(nusrat, a.body.session.id);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already ended/i);
    });
  });

  // ─────────────────────────── the time limit ───────────────────────────
  describe('a stale session closes itself', () => {
    it('the limit is 90 minutes', () => {
      expect(QR_SESSION_TIMEOUT_MINUTES).toBe(90);
    });

    it('nobody arrived: after the limit the session is CLOSED and everyone is AUTO_COMPLETED and charged', async () => {
      const a = await join(nusrat, UTTARA_TO_DHANMONDI);
      await join(rafiq, UTTARA_TO_MIRPUR);
      const id = a.body.session.id;
      expect(await occupied()).toBe(2);

      const later = new Date(Date.now() + 91 * 60_000);
      expect(await closeStaleSessions(later)).toBe(1);

      const session = (await QRRideSession.findByPk(id))!;
      expect(session).toMatchObject({ status: 'CLOSED', closeReason: 'TIMEOUT' });
      const [n, r] = await QRRideParticipant.findAll({ where: { sessionId: id }, order: [['passengerNumber', 'ASC']] });
      expect([n!.status, r!.status]).toEqual(['AUTO_COMPLETED', 'AUTO_COMPLETED']);
      // charged as if they had arrived at their destinations, shorter trip first: the same ৳365 and ৳225 as the worked example
      expect([n!.finalFare, r!.finalFare]).toEqual([365, 225]);
      expect([n!.paymentStatus, r!.paymentStatus]).toEqual(['CASH_DUE', 'CASH_DUE']);
      expect([n!.paymentAmount, r!.paymentAmount]).toEqual([365, 225]);
      expect(n!.exitedAt).toBeTruthy();
      expect(await occupied()).toBe(0); // seats released
    });

    it('is not closed before the limit, and a passenger who did confirm stays ARRIVED', async () => {
      const a = await join(nusrat, UTTARA_TO_DHANMONDI);
      await join(rafiq, UTTARA_TO_MIRPUR);
      const id = a.body.session.id;
      await arrived(rafiq, id);

      expect(await closeStaleSessions(new Date(Date.now() + 89 * 60_000))).toBe(0);
      expect((await QRRideSession.findByPk(id))!.status).toBe('OPEN');

      expect(await closeStaleSessions(new Date(Date.now() + 91 * 60_000))).toBe(1);
      const [n, r] = await QRRideParticipant.findAll({ where: { sessionId: id }, order: [['passengerNumber', 'ASC']] });
      expect([n!.status, r!.status]).toEqual(['AUTO_COMPLETED', 'ARRIVED']);
      expect([n!.finalFare, r!.finalFare]).toEqual([365, 225]);
      expect(await occupied()).toBe(0);
    });

    it('happens on its own the next time anyone uses the street-ride API, with no timer needed', async () => {
      const a = await join(nusrat, UTTARA_TO_DHANMONDI);
      const id = a.body.session.id;
      // the session has been open for 2 hours
      await QRRideSession.update({ openedAt: new Date(Date.now() - 120 * 60_000) }, { where: { id } });
      expect(await occupied()).toBe(1);

      // Rafiq scans the same car: the stale session is closed and he starts a new one
      const fresh = await join(rafiq, UTTARA_TO_MIRPUR);
      expect(fresh.status).toBe(201);
      expect(fresh.body.session.id).not.toBe(id);
      expect(fresh.body.session.you.passengerNumber).toBe(1);
      expect(await QRRideSession.findByPk(id)).toMatchObject({ status: 'CLOSED', closeReason: 'TIMEOUT' });
      expect(await QRRideParticipant.findOne({ where: { sessionId: id } })).toMatchObject({ status: 'AUTO_COMPLETED', finalFare: 420, paymentStatus: 'CASH_DUE' });
      expect(await occupied()).toBe(1); // only Rafiq now
      // Nusrat, checking her ride, sees it ended (and what she owes)
      const mine = await request(app).get('/qr/sessions/mine').set(asUser(nusrat.id));
      expect(mine.body.session).toMatchObject({ status: 'CLOSED', closeReason: 'TIMEOUT' });
      expect(mine.body.session.you).toMatchObject({ status: 'AUTO_COMPLETED', fare: 420, fareFinal: true });
    });

    it('a passenger who tries to arrive after the timeout is told the ride has ended', async () => {
      const a = await join(nusrat, UTTARA_TO_DHANMONDI);
      await QRRideSession.update({ openedAt: new Date(Date.now() - 100 * 60_000) }, { where: { id: a.body.session.id } });
      const res = await arrived(nusrat, a.body.session.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SESSION_CLOSED');
    });

    it('closing twice at once charges and releases once', async () => {
      const a = await join(nusrat, UTTARA_TO_DHANMONDI);
      await join(rafiq, UTTARA_TO_MIRPUR);
      const later = new Date(Date.now() + 100 * 60_000);
      const [x, y] = await Promise.all([closeStaleSessions(later), closeStaleSessions(later)]);
      expect(x + y).toBe(1);
      expect(await occupied()).toBe(0);
      expect((await QRRideParticipant.findAll({ where: { sessionId: a.body.session.id } })).map((p) => p.finalFare).sort()).toEqual([225, 365]);
    });
  });

  // ─────────────────────────── cash only ───────────────────────────
  describe('payment is cash only', () => {
    it('never touches a wallet, even one with money in it', async () => {
      const a = await join(nusrat, UTTARA_TO_DHANMONDI); // Nusrat has ৳1000 in her wallet
      await arrived(nusrat, a.body.session.id);
      expect((await User.findByPk(nusrat.id))!.walletBalance).toBe(1000);
      expect(await WalletTransaction.count()).toBe(0);
      expect(await QRRideParticipant.findOne({ where: { passengerId: nusrat.id } })).toMatchObject({ paymentMethod: 'cash', paymentStatus: 'CASH_DUE', paymentAmount: 420 });
    });

    it('refuses a request to pay by wallet', async () => {
      const res = await join(nusrat, { ...UTTARA_TO_DHANMONDI, paymentMethod: 'wallet' });
      expect(res.status).toBe(400);
      expect(res.body.fields.paymentMethod).toMatch(/cash/i);
      expect(await QRRideSession.count()).toBe(0);
      expect(await occupied()).toBe(0);
    });
  });

  // ─────────────────────────── privacy ───────────────────────────
  describe('anonymized co-passengers', () => {
    it('shows the others as "Passenger N" only: no name, phone, id, route or fare', async () => {
      const a = await join(nusrat, UTTARA_TO_DHANMONDI);
      await join(rafiq, UTTARA_TO_MIRPUR);
      const third = await join(shirin, { pickupZone: 'Mohakhali', destinationZone: 'Badda' });
      const id = a.body.session.id;

      const rafiqView = await view(rafiq, id);
      expect(rafiqView.body.session.passengers).toEqual([
        { label: 'Passenger 1', isYou: false, status: 'RIDING' },
        { label: 'Passenger 2', isYou: true, status: 'RIDING' },
        { label: 'Passenger 3', isYou: false, status: 'RIDING' },
      ]);
      const text = JSON.stringify(rafiqView.body);
      for (const other of [nusrat, shirin]) {
        expect(text).not.toContain(other.id);
        expect(text).not.toContain(other.phone);
        expect(text).not.toContain(other.name);
        expect(text).not.toContain(other.name.split(' ')[0]);
      }
      expect(text).not.toContain('Dhanmondi'); // Nusrat's destination
      expect(text).not.toContain('Badda'); // Shirin's route
      // and the driver is never revealed to passengers
      expect(text).not.toContain(jashim.id);
      expect(text).not.toContain('Jashim');
      expect(text).not.toContain(jashim.phone);
      expect(third.body.session.you.passengerNumber).toBe(3);
    });

    it('the fare breakdown has no zone names (they would show where the others got on and off)', async () => {
      const a = await join(nusrat, UTTARA_TO_DHANMONDI);
      await join(rafiq, UTTARA_TO_MIRPUR);
      await arrived(rafiq, a.body.session.id);
      const mine = await view(nusrat, a.body.session.id);
      expect(JSON.stringify(mine.body.session.you.fareBreakdown)).not.toMatch(/Mirpur|fromZone|toZone|zone/i);
    });

    it('a stranger cannot read a session, and the preview reveals nothing about the driver', async () => {
      const a = await join(nusrat, UTTARA_TO_DHANMONDI);
      expect((await view(tania, a.body.session.id)).status).toBe(403);
      expect((await request(app).get(`/qr/sessions/${a.body.session.id}`)).status).toBe(401);
      expect((await view(tania, '00000000-0000-4000-8000-000000000000')).status).toBe(404);

      const preview = await request(app).get(`/qr/vehicles/${bullet.vehicleCode.toLowerCase()}`).set(asUser(tania.id)); // lower case works
      expect(preview.status).toBe(200);
      expect(preview.body).toEqual({
        vehicleCode: bullet.vehicleCode,
        vehicle: { nickname: 'Bullet', seatCapacity: 3, seatsFree: 2 },
        session: { id: a.body.session.id, passengerCount: 1 },
      });
    });
  });

  // ─────────────────────────── input and access ───────────────────────────
  describe('input and access', () => {
    it('an unknown or malformed code is a clear 404 / 400, never a crash', async () => {
      const unknown = await join(nusrat, { vehicleCode: 'ZZZZZZ', ...UTTARA_TO_DHANMONDI });
      expect(unknown.status).toBe(404);
      expect(unknown.body.error).toMatch(/couldn't find a vehicle/i);
      expect((await join(nusrat, { vehicleCode: '!!', ...UTTARA_TO_DHANMONDI })).status).toBe(400);
      expect((await request(app).get('/qr/vehicles/nonsense!').set(asUser(nusrat.id))).status).toBe(404);
    });

    it('validates zones and seats, naming the field', async () => {
      for (const [body, field] of [
        [{ pickupZone: 'Narnia', destinationZone: 'Dhanmondi' }, 'pickupZone'],
        [{ pickupZone: 'Uttara', destinationZone: 'Uttara' }, 'destinationZone'],
        [{ ...UTTARA_TO_DHANMONDI, seatCount: 9 }, 'seatCount'],
        [{ ...UTTARA_TO_DHANMONDI, seatCount: 1.5 }, 'seatCount'],
      ] as const) {
        const res = await join(nusrat, body as Record<string, unknown>);
        expect(res.status).toBe(400);
        expect(res.body.fields[field]).toBeTruthy();
      }
      expect(await QRRideSession.count()).toBe(0);
      expect(await occupied()).toBe(0);
    });

    it('needs a passenger login: no login is 401, and a driver’s login is refused', async () => {
      expect((await request(app).post('/qr/join').send({ vehicleCode: bullet.vehicleCode, ...UTTARA_TO_DHANMONDI })).status).toBe(401);
      expect((await request(app).post('/qr/join').set(asUser(jashim.id, 'DRIVER')).send({ vehicleCode: bullet.vehicleCode, ...UTTARA_TO_DHANMONDI })).status).toBe(403);
      expect((await request(app).get(`/qr/vehicles/${bullet.vehicleCode}`)).status).toBe(401);
    });

    it('a vehicle that is not active cannot be joined', async () => {
      await Vehicle.update({ isActive: false }, { where: { id: bullet.id } });
      expect((await join(nusrat, UTTARA_TO_DHANMONDI)).status).toBe(404);
    });
  });
});
