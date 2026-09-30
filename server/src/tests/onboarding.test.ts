import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { app } from '../index';
import { sequelize, storagePath, User, Vehicle, RideRequest, DriverProfile } from '../models';
import { UPLOADS_DIR } from '../utils/onboarding';
import { asUser } from './helpers';

const uploadsDir = UPLOADS_DIR(storagePath);
const uploadCount = () => (fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir).length : 0);
const listUploads = () => (fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : []);
const preexistingUploads = new Set(listUploads()); // never touched by cleanup

// 1×1 transparent PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_URL = `data:image/png;base64,${PNG_B64}`;
const jpegUrl = (extra = 32) =>
  `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(extra)]).toString('base64')}`;

let phoneSeq = 0;
const nextPhone = () => `0171${String(1000000 + ++phoneSeq)}`;
let nidSeq = 0;
const nextNid = () => String(1000000000 + ++nidSeq); // 10 digits, unique

async function signup(role: 'DRIVER' | 'PASSENGER', name = role === 'DRIVER' ? 'Jashim' : 'Nusrat') {
  const res = await request(app)
    .post('/auth/signup')
    .send({ name, phone: nextPhone(), password: 'secret123', role });
  expect(res.status).toBe(201);
  return { id: res.body.user.id as string, token: res.body.token as string, phone: res.body.user.phone as string, name };
}

const form = (over: Record<string, unknown> = {}) => ({
  nickname: 'Bullet',
  seatCapacity: 3,
  homeZone: 'Banani',
  nid: nextNid(),
  ...over,
});
const onboard = (token: string, body: Record<string, unknown>) =>
  request(app).post('/driver/onboarding').set('Authorization', `Bearer ${token}`).send(body);
const getOnboarding = (token: string) => request(app).get('/driver/onboarding').set('Authorization', `Bearer ${token}`);

describe('Driver onboarding', () => {
  beforeAll(async () => {
    await sequelize.sync({ force: true });
  });
  afterAll(async () => {
    await sequelize.close();
  });
  beforeEach(async () => {
    await RideRequest.destroy({ where: {} });
    await Vehicle.destroy({ where: {} });
    await DriverProfile.destroy({ where: {} });
    await User.destroy({ where: {} });
    await sequelize.query("DELETE FROM sqlite_sequence WHERE name = 'DriverProfiles'");
  });

  describe('GET /driver/onboarding', () => {
    it('returns the driver\'s name + phone read-only, the zone list, and onboarded=false', async () => {
      const d = await signup('DRIVER');
      const res = await getOnboarding(d.token);
      expect(res.status).toBe(200);
      expect(res.body.driver).toEqual({ name: 'Jashim', phone: d.phone });
      expect(res.body.onboarded).toBe(false);
      expect(res.body.profile).toBeNull();
      expect(res.body.zones).toContain('Banani');
    });

    it('requires a login and a DRIVER account', async () => {
      expect((await request(app).get('/driver/onboarding')).status).toBe(401);
      const p = await signup('PASSENGER');
      expect((await getOnboarding(p.token)).status).toBe(403);
      expect((await onboard(p.token, form())).status).toBe(403);
    });
  });

  describe('POST /driver/onboarding', () => {
    it('onboards a driver: returns DTP-0001, creates the vehicle, hides the full NID', async () => {
      const d = await signup('DRIVER');
      const body = form({ nid: '1234567890' });
      const res = await onboard(d.token, body);
      expect(res.status).toBe(201);
      expect(res.body.profile).toMatchObject({
        driverCode: 'DTP-0001',
        nickname: 'Bullet',
        seatCapacity: 3,
        homeZone: 'Banani',
        nidMasked: '******7890',
        profilePictureUrl: null,
      });
      expect(JSON.stringify(res.body)).not.toContain('1234567890'); // full NID never echoed

      const vehicle: any = await Vehicle.findOne({ where: { driverId: d.id } });
      expect(vehicle).toMatchObject({ modelName: 'Bullet', seatCapacity: 3, licensePlate: 'DTP-0001', isActive: true });

      const again = await getOnboarding(d.token);
      expect(again.body.onboarded).toBe(true);
      expect(again.body.profile.driverCode).toBe('DTP-0001');
      expect(JSON.stringify(again.body)).not.toContain('1234567890');
    });

    it('issues sequential IDs: DTP-0001, DTP-0002, ...', async () => {
      const codes: string[] = [];
      for (let i = 0; i < 3; i++) {
        const d = await signup('DRIVER', `Driver${i}`);
        codes.push((await onboard(d.token, form())).body.profile.driverCode);
      }
      expect(codes).toEqual(['DTP-0001', 'DTP-0002', 'DTP-0003']);
    });

    it('never reuses an ID, even after the newest profile is deleted', async () => {
      const a = await signup('DRIVER', 'Driver A');
      const b = await signup('DRIVER', 'Driver B');
      await onboard(a.token, form());
      expect((await onboard(b.token, form())).body.profile.driverCode).toBe('DTP-0002');
      await DriverProfile.destroy({ where: { userId: b.id } });
      const c = await signup('DRIVER', 'Driver C');
      expect((await onboard(c.token, form())).body.profile.driverCode).toBe('DTP-0003'); // COUNT+1 would say 0002
    });

    it('gives every driver a distinct ID when many onboard at the same moment', async () => {
      const drivers = await Promise.all(Array.from({ length: 12 }, (_, i) => signup('DRIVER', `Racer${i}`)));
      const results = await Promise.all(drivers.map((d) => onboard(d.token, form())));

      results.forEach((r) => expect(r.status).toBe(201));
      const codes = results.map((r) => r.body.profile.driverCode);
      expect(new Set(codes).size).toBe(12);
      expect([...codes].sort()).toEqual(Array.from({ length: 12 }, (_, i) => `DTP-${String(i + 1).padStart(4, '0')}`));
      expect(await DriverProfile.count()).toBe(12);
      expect(await Vehicle.count()).toBe(12);
    });

    it('cannot be submitted twice by the same driver (even concurrently)', async () => {
      const d = await signup('DRIVER');
      const [r1, r2] = await Promise.all([onboard(d.token, form()), onboard(d.token, form())]);
      expect([r1.status, r2.status].sort()).toEqual([201, 409]);
      expect(await DriverProfile.count()).toBe(1);
      expect(await Vehicle.count()).toBe(1);
      const late = await onboard(d.token, form());
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('ALREADY_ONBOARDED');
    });

    describe('validation', () => {
      let token: string;
      beforeEach(async () => {
        token = (await signup('DRIVER')).token;
      });
      const expectField = async (over: Record<string, unknown>, field: string) => {
        const res = await onboard(token, form(over));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION');
        expect(res.body.fields).toHaveProperty(field);
        expect(await DriverProfile.count()).toBe(0);
        expect(await Vehicle.count()).toBe(0);
      };

      it('requires every field', async () => {
        const res = await onboard(token, {});
        expect(res.status).toBe(400);
        expect(Object.keys(res.body.fields).sort()).toEqual(['homeZone', 'nickname', 'nid', 'seatCapacity']);
      });

      it.each([[''], ['   '], ['x'], ['a'.repeat(31)], ['<script>']])('rejects nickname %j', (nickname) =>
        expectField({ nickname }, 'nickname'));

      it.each([['Bullet'], ['Bullet 2'], ["Jashim's Tesla"], ['বুলেট']])('accepts nickname %j', async (nickname) => {
        const t = (await signup('DRIVER')).token;
        expect((await onboard(t, form({ nickname }))).status).toBe(201);
      });

      it.each([[0], [4], [-1], [1.5], ['two'], [null]])('rejects seat capacity %j (must be 1–3)', (seatCapacity) =>
        expectField({ seatCapacity }, 'seatCapacity'));

      it.each([[1], [2], [3], ['2']])('accepts seat capacity %j', async (seatCapacity) => {
        const t = (await signup('DRIVER')).token;
        const res = await onboard(t, form({ seatCapacity }));
        expect(res.status).toBe(201);
        expect(res.body.profile.seatCapacity).toBe(Number(seatCapacity));
      });

      it.each([[''], ['Narnia'], ['banani']])('rejects home zone %j', (homeZone) => expectField({ homeZone }, 'homeZone'));

      it.each([
        ['123456789'], // 9 digits
        ['12345678901'], // 11
        ['123456789012'], // 12
        ['12345678901234'], // 14
        ['1234567890123456'], // 16
        ['123456789012345678'], // 18
        ['12345abcde'],
        ['1234-567-890'],
        ['1234 567 890'],
      ])('rejects NID %j', (nid) => expectField({ nid }, 'nid'));

      it.each([['1234567890'], ['1234567890123'], ['12345678901234567']])('accepts NID of 10/13/17 digits: %s', async (nid) => {
        const t = (await signup('DRIVER')).token;
        expect((await onboard(t, form({ nid }))).status).toBe(201);
      });

      it('accepts Bangla digits in the NID and stores them as ASCII', async () => {
        const t = (await signup('DRIVER')).token;
        const res = await onboard(t, form({ nid: '১২৩৪৫৬৭৮৯০' }));
        expect(res.status).toBe(201);
        expect(res.body.profile.nidMasked).toBe('******7890');
        expect((await DriverProfile.findOne())!.nid).toBe('1234567890');
      });
    });

    describe('NID uniqueness', () => {
      it('rejects an NID already used by another driver', async () => {
        const a = await signup('DRIVER', 'Driver A');
        const b = await signup('DRIVER', 'Driver B');
        expect((await onboard(a.token, form({ nid: '9999999999' }))).status).toBe(201);
        const res = await onboard(b.token, form({ nid: '9999999999' }));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('NID_TAKEN');
        expect(res.body.fields.nid).toBeTruthy();
        expect(await DriverProfile.count()).toBe(1);
        expect(await Vehicle.count()).toBe(1); // B got no vehicle
      });

      it('lets exactly one of two simultaneous submissions with the same NID win', async () => {
        const a = await signup('DRIVER', 'Driver A');
        const b = await signup('DRIVER', 'Driver B');
        const [r1, r2] = await Promise.all([
          onboard(a.token, form({ nid: '8888888888' })),
          onboard(b.token, form({ nid: '8888888888' })),
        ]);
        expect([r1.status, r2.status].sort()).toEqual([201, 409]);
        expect(await DriverProfile.count()).toBe(1);
      });

      it('a failed submission does not burn a Tesla ID', async () => {
        const a = await signup('DRIVER', 'Driver A');
        const b = await signup('DRIVER', 'Driver B');
        const c = await signup('DRIVER', 'Driver C');
        await onboard(a.token, form({ nid: '7777777777' }));
        await onboard(b.token, form({ nid: '7777777777' })); // rejected before insert
        expect((await onboard(c.token, form())).body.profile.driverCode).toBe('DTP-0002');
      });
    });

    describe('profile picture', () => {
      it('is optional', async () => {
        const d = await signup('DRIVER');
        const res = await onboard(d.token, form());
        expect(res.status).toBe(201);
        expect(res.body.profile.profilePictureUrl).toBeNull();
      });

      it('accepts a PNG and a JPEG, stores them with random names, and serves them', async () => {
        const before = uploadCount();
        const d1 = await signup('DRIVER');
        const r1 = await onboard(d1.token, form({ profilePicture: PNG_URL }));
        expect(r1.status).toBe(201);
        expect(r1.body.profile.profilePictureUrl).toMatch(/^\/uploads\/[0-9a-f-]{36}\.png$/);

        const d2 = await signup('DRIVER');
        const r2 = await onboard(d2.token, form({ profilePicture: jpegUrl() }));
        expect(r2.status).toBe(201);
        expect(r2.body.profile.profilePictureUrl).toMatch(/^\/uploads\/[0-9a-f-]{36}\.jpg$/);
        expect(uploadCount()).toBe(before + 2);

        const served = await request(app).get(r1.body.profile.profilePictureUrl);
        expect(served.status).toBe(200);
        expect(served.headers['x-content-type-options']).toBe('nosniff');
      });

      it('rejects other image types, and files whose bytes do not match the label', async () => {
        const d = await signup('DRIVER');
        const gif = `data:image/gif;base64,${Buffer.from('GIF89a....').toString('base64')}`;
        const fakePng = `data:image/png;base64,${Buffer.from('this is not an image').toString('base64')}`;
        const jpegAsPng = jpegUrl().replace('image/jpeg', 'image/png');
        for (const profilePicture of [gif, fakePng, jpegAsPng, 'not-a-data-url', 12345]) {
          const res = await onboard(d.token, form({ profilePicture }));
          expect(res.status).toBe(400);
          expect(res.body.fields).toHaveProperty('profilePicture');
        }
        expect(await DriverProfile.count()).toBe(0);
      });

      it('rejects a file larger than 2 MB, accepts exactly 2 MB', async () => {
        const png = Buffer.from(PNG_B64, 'base64');
        const pad = (bytes: number) =>
          `data:image/png;base64,${Buffer.concat([png, Buffer.alloc(bytes - png.length)]).toString('base64')}`;
        const d = await signup('DRIVER');
        const tooBig = await onboard(d.token, form({ profilePicture: pad(2 * 1024 * 1024 + 1) }));
        expect(tooBig.status).toBe(400);
        expect(tooBig.body.fields.profilePicture).toMatch(/2 MB/);

        const exact = await onboard(d.token, form({ profilePicture: pad(2 * 1024 * 1024) }));
        expect(exact.status).toBe(201);
      });

      it('leaves no orphan file behind when the submission is rejected', async () => {
        const a = await signup('DRIVER', 'Driver A');
        const b = await signup('DRIVER', 'Driver B');
        await onboard(a.token, form({ nid: '6666666666' }));
        const before = uploadCount();
        const res = await onboard(b.token, form({ nid: '6666666666', profilePicture: PNG_URL }));
        expect(res.status).toBe(409);
        expect(uploadCount()).toBe(before);
      });
    });

    describe('driver who registered a vehicle before onboarding existed', () => {
      it('keeps and updates their existing vehicle instead of creating a second', async () => {
        const d = await signup('DRIVER');
        const old: any = await Vehicle.create({ driverId: d.id, modelName: 'Tesla Model 3', seatCapacity: 4, licensePlate: 'DHA-1234' });
        const pre = await getOnboarding(d.token);
        expect(pre.body.existingVehicle).toEqual({ nickname: 'Tesla Model 3', seatCapacity: 4 });

        const res = await onboard(d.token, form({ nickname: 'Bullet', seatCapacity: 2 }));
        expect(res.status).toBe(201);
        expect(await Vehicle.count({ where: { driverId: d.id } })).toBe(1);
        const v: any = await Vehicle.findByPk(old.id);
        expect(v).toMatchObject({ modelName: 'Bullet', seatCapacity: 2, licensePlate: 'DHA-1234' });
      });

      it('refuses a capacity below the seats currently in use, and rolls everything back', async () => {
        const d = await signup('DRIVER');
        await Vehicle.create({ driverId: d.id, modelName: 'Old', seatCapacity: 3, licensePlate: 'DHA-9', occupiedSeats: 3 });
        const res = await onboard(d.token, form({ seatCapacity: 2 }));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('SEATS_IN_USE');
        expect(await DriverProfile.count()).toBe(0);
      });
    });
  });

  describe('Going online', () => {
    const setOnline = (id: string, isOnline: boolean) => request(app).put(`/driver/${id}/status`).send({ isOnline });

    it('is blocked until onboarding is complete, then allowed', async () => {
      const d = await signup('DRIVER');
      const blocked = await setOnline(d.id, true);
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('ONBOARDING_REQUIRED');
      expect((await User.findByPk(d.id))!.isOnline).toBe(false);

      await onboard(d.token, form());
      const ok = await setOnline(d.id, true);
      expect(ok.status).toBe(200);
      expect(ok.body.isOnline).toBe(true);
    });

    it('going offline is always allowed', async () => {
      const d = await signup('DRIVER');
      expect((await setOnline(d.id, false)).status).toBe(200);
    });

    it('a failed onboarding does not unlock going online', async () => {
      const d = await signup('DRIVER');
      await onboard(d.token, form({ seatCapacity: 9 }));
      expect((await setOnline(d.id, true)).status).toBe(403);
    });
  });

  describe('NID privacy', () => {
    it('never appears in anything a passenger can see', async () => {
      const NID = '5555512345';
      const driver = await signup('DRIVER', 'Jashim');
      const passenger = await signup('PASSENGER', 'Nusrat');
      await onboard(driver.token, form({ nid: NID }));

      const created = await request(app)
        .post('/ride-requests').set(asUser(passenger.id)).send({ pickupZone: 'Gulshan', destinationZone: 'Banani', seatCount: 1 });
      expect(created.status).toBe(201);
      const rideId = created.body.rideRequest.id;
      const accepted = await request(app).post(`/ride-requests/${rideId}/accept`).send({ driverId: driver.id });
      expect(accepted.status).toBe(200);

      const responses = [
        created,
        accepted,
        await request(app).get(`/passenger/rides/active?passengerId=${passenger.id}`),
        await request(app).get(`/passenger/rides/${rideId}?passengerId=${passenger.id}`),
        await request(app).get(`/passenger/rides/history?passengerId=${passenger.id}`),
        await request(app).get(`/ride-requests/me?passengerId=${passenger.id}`),
        await request(app).get('/auth/me').set('Authorization', `Bearer ${passenger.token}`),
      ];
      for (const r of responses) {
        const text = JSON.stringify(r.body);
        expect(text).not.toContain(NID);
        expect(text).not.toMatch(/nid/i);
      }

      // and the passenger can't use the onboarding endpoint to read it either
      expect((await getOnboarding(passenger.token)).status).toBe(403);
      // the vehicle a passenger *does* see carries the nickname + Tesla ID, but no NID
      const active = await request(app).get(`/passenger/rides/active?passengerId=${passenger.id}`);
      expect(active.body.rides[0].vehicle).toMatchObject({ modelName: 'Bullet', licensePlate: 'DTP-0001' });
    });

    it('the owning driver only ever gets a masked NID', async () => {
      const d = await signup('DRIVER');
      await onboard(d.token, form({ nid: '1111122222333' }));
      const text = JSON.stringify((await getOnboarding(d.token)).body);
      expect(text).not.toContain('1111122222333');
      expect(text).toContain('*********2333');
    });
  });

  afterAll(() => {
    // remove only the pictures these tests created
    for (const f of listUploads()) if (!preexistingUploads.has(f)) fs.rmSync(path.join(uploadsDir, f), { force: true });
  });
});
