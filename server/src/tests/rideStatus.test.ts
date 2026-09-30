/**
 * The passenger's ride status page — what the API tells a passenger about their own ride.
 *
 * Story cast (same as the seed): Jashim drives Bullet (DTP-0001, 3 seats); Nusrat, Rafiq and
 * Shirin ride Mohakhali → Badda.
 *
 *   - once a driver has accepted: driver name / photo / phone / Tesla ID, vehicle nickname
 *   - pool: shared or "just you", seats taken, and other passengers by FIRST NAME only
 *   - never another passenger's phone, fare, destination, surname or id
 *   - the driver's phone only while the ride is in progress — never while REQUESTED
 *   - a passenger can only read or cancel their own ride (403 for anyone else's)
 */
import request from 'supertest';
import { app } from '../index';
import { sequelize, User, Vehicle, RideRequest, DriverProfile } from '../models';
import { ensureOneActiveRideIndex } from '../migrations';
import { asUser } from './helpers';

let jashim: any;
let nusrat: any;
let rafiq: any;
let shirin: any;
let bullet: any;

const ROUTE = { pickupZone: 'Mohakhali', destinationZone: 'Badda', seatCount: 1, allowSharing: true };

const requestRide = (passenger: any, body: Record<string, unknown> = ROUTE) =>
  request(app).post('/ride-requests').set(asUser(passenger.id)).send(body);
const accept = (rideId: string) => request(app).post(`/ride-requests/${rideId}/accept`).send({ driverId: jashim.id });
const driverAction = (rideId: string, action: 'arrive' | 'start' | 'complete' | 'cancel') =>
  request(app).patch(`/driver/rides/${rideId}/${action}`).send({ driverId: jashim.id });
const passengerCancel = (rideId: string, passenger: any) =>
  request(app).patch(`/passenger/rides/${rideId}/cancel`).set(asUser(passenger.id)).send({});
/** The ride as the passenger's status page reads it. */
const view = (rideId: string, passenger: any) => request(app).get(`/passenger/rides/${rideId}`).set(asUser(passenger.id));

async function book(passenger: any, body: Record<string, unknown> = ROUTE): Promise<string> {
  const created = await requestRide(passenger, body);
  expect(created.status).toBe(201);
  return created.body.rideRequest.id as string;
}
async function bookAndAccept(passenger: any, body: Record<string, unknown> = ROUTE): Promise<string> {
  const id = await book(passenger, body);
  expect((await accept(id)).status).toBe(200);
  return id;
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
  await ensureOneActiveRideIndex();
});
afterAll(async () => {
  await sequelize.close();
});
beforeEach(async () => {
  await sequelize.query("DELETE FROM sqlite_sequence WHERE name = 'DriverProfiles'");
  const mk = async (name: string, role: 'DRIVER' | 'PASSENGER', phone: string) =>
    (await User.create({ name, phone, email: `${name.split(' ')[0]!.toLowerCase()}@test.com`, password: 'x', role })).toJSON();
  jashim = await mk('Jashim', 'DRIVER', '01711000000');
  nusrat = await mk('Nusrat Jahan', 'PASSENGER', '01711000001');
  rafiq = await mk('Rafiq Ahmed', 'PASSENGER', '01711000002');
  shirin = await mk('Shirin Akter', 'PASSENGER', '01711000003');
  await DriverProfile.create({ userId: jashim.id, homeZone: 'Banani', nid: '1234567890' }); // Tesla ID DTP-0001
  bullet = (await Vehicle.create({ driverId: jashim.id, modelName: 'Bullet', seatCapacity: 3, licensePlate: 'DTP-0001' })).toJSON();
});
afterEach(async () => {
  await RideRequest.destroy({ where: {} });
  await Vehicle.destroy({ where: {} });
  await DriverProfile.destroy({ where: {} });
  await User.destroy({ where: {} });
});

describe('driver & vehicle', () => {
  it('while the ride is still REQUESTED there is no driver and no phone number at all', async () => {
    const id = await book(nusrat);
    const res = await view(id, nusrat);

    expect(res.status).toBe(200);
    expect(res.body.ride).toMatchObject({ status: 'REQUESTED', driver: null, driverName: null, pool: null, vehicle: null, canCancel: true });
    expect(JSON.stringify(res.body)).not.toContain(jashim.phone);
  });

  it('even a ride row that has a driver id but is still REQUESTED never shows the driver', async () => {
    const id = await book(nusrat);
    await RideRequest.update({ driverId: jashim.id, vehicleId: bullet.id }, { where: { id } });
    const res = await view(id, nusrat);
    expect(res.body.ride.status).toBe('REQUESTED');
    expect(res.body.ride.driver).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(jashim.phone);
  });

  it('once Jashim accepts: name, phone, Tesla ID and the Bullet vehicle, with a null photo when there is none', async () => {
    const id = await bookAndAccept(nusrat);
    const { ride } = (await view(id, nusrat)).body;

    expect(ride.status).toBe('MATCHED');
    expect(ride.driver).toEqual({ name: 'Jashim', phone: '01711000000', photoUrl: null, teslaId: 'DTP-0001' });
    expect(ride.vehicle).toMatchObject({ nickname: 'Bullet', teslaId: 'DTP-0001', seatCapacity: 3 });
  });

  it('returns the driver photo URL when the driver uploaded one', async () => {
    await DriverProfile.update({ profilePicture: 'jashim-photo.png' }, { where: { userId: jashim.id } });
    const id = await bookAndAccept(nusrat);
    expect((await view(id, nusrat)).body.ride.driver.photoUrl).toBe('/uploads/jashim-photo.png');
  });

  it('the driver phone is shown while the ride is in progress and gone once it is over', async () => {
    const id = await bookAndAccept(nusrat);
    const phoneOf = async () => (await view(id, nusrat)).body.ride.driver?.phone;

    expect(await phoneOf()).toBe('01711000000'); // MATCHED
    await driverAction(id, 'arrive');
    expect(await phoneOf()).toBe('01711000000'); // DRIVER_ARRIVED
    await driverAction(id, 'start');
    expect(await phoneOf()).toBe('01711000000'); // STARTED
    await driverAction(id, 'complete');
    const done = (await view(id, nusrat)).body.ride;
    expect(done.status).toBe('COMPLETED');
    expect(done.driver.phone).toBeNull(); // no reason to keep it after the trip
    expect(done.driver.name).toBe('Jashim');
  });

  it('a legacy driver without a phone number still works (phone is null)', async () => {
    await User.update({ phone: null }, { where: { id: jashim.id } });
    const id = await bookAndAccept(nusrat);
    expect((await view(id, nusrat)).body.ride.driver).toMatchObject({ name: 'Jashim', phone: null });
  });
});

describe('pool info', () => {
  it('a passenger alone on the Bullet sees "just you": not shared, 1 of 3 seats taken', async () => {
    const id = await bookAndAccept(nusrat);
    const { pool } = (await view(id, nusrat)).body.ride;
    expect(pool).toEqual({ isShared: false, poolSize: 1, otherPassengers: [], seatsTaken: 1, seatCapacity: 3 });
  });

  it('Nusrat and Rafiq sharing: Nusrat sees "1 other passenger · Rafiq" and 2 of 3 seats taken', async () => {
    const nusratRide = await bookAndAccept(nusrat);
    await bookAndAccept(rafiq);

    const { ride } = (await view(nusratRide, nusrat)).body;
    expect(ride.pool).toEqual({
      isShared: true,
      poolSize: 2,
      otherPassengers: [{ firstName: 'Rafiq' }], // first name only, not "Rafiq Ahmed"
      seatsTaken: 2,
      seatCapacity: 3,
    });
    expect(ride.coPassengers).toBe(1);
    expect(ride.isSharedRide).toBe(true);
  });

  it('Nusrat never sees Rafiq\'s phone number, fare, destination, surname or ids', async () => {
    const nusratRide = await bookAndAccept(nusrat);
    const rafiqRide = await bookAndAccept(rafiq);

    for (const res of [
      await view(nusratRide, nusrat),
      await request(app).get('/passenger/rides/active').set(asUser(nusrat.id)),
    ]) {
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(rafiq.phone); // 01711000002
      expect(text).not.toContain('Ahmed'); // surname
      expect(text).not.toContain(rafiq.id); // passenger id
      expect(text).not.toContain(rafiqRide); // ride id
    }

    // The other passenger is exactly { firstName } — there is no field that could carry a fare,
    // destination or phone.
    const { pool } = (await view(nusratRide, nusrat)).body.ride;
    expect(pool.otherPassengers[0]).toEqual({ firstName: 'Rafiq' });
    expect(Object.keys(pool.otherPassengers[0])).toEqual(['firstName']);
    expect(Object.keys(pool).sort()).toEqual(['isShared', 'otherPassengers', 'poolSize', 'seatCapacity', 'seatsTaken']);
  });

  it('Nusrat sees only her own fare: ৳125 (saves ৳55), and Rafiq sees his own', async () => {
    const nusratRide = await bookAndAccept(nusrat);
    const rafiqRide = await bookAndAccept(rafiq);
    expect((await view(nusratRide, nusrat)).body.ride).toMatchObject({ estimatedFare: 125, poolDiscount: 55, baseFare: 180 });
    expect((await view(rafiqRide, rafiq)).body.ride).toMatchObject({ estimatedFare: 125, poolDiscount: 55 });
  });

  it('with three passengers the two others are listed by first name', async () => {
    const nusratRide = await bookAndAccept(nusrat);
    await bookAndAccept(rafiq);
    await bookAndAccept(shirin);
    const { pool } = (await view(nusratRide, nusrat)).body.ride;
    expect(pool.otherPassengers.map((p: any) => p.firstName).sort()).toEqual(['Rafiq', 'Shirin']);
    expect(pool).toMatchObject({ isShared: true, poolSize: 3, seatsTaken: 3, seatCapacity: 3 });
  });

  it('seats taken counts seats, not passengers (a 2-seat booking plus a 1-seat one = 3 of 3)', async () => {
    const nusratRide = await bookAndAccept(nusrat);
    await bookAndAccept(rafiq, { ...ROUTE, seatCount: 2 });
    const { pool } = (await view(nusratRide, nusrat)).body.ride;
    expect(pool).toMatchObject({ poolSize: 2, seatsTaken: 3, seatCapacity: 3 });
  });

  it('shows someone joining and then leaving', async () => {
    const nusratRide = await bookAndAccept(nusrat);
    expect((await view(nusratRide, nusrat)).body.ride.pool.isShared).toBe(false);

    const rafiqRide = await bookAndAccept(rafiq);
    expect((await view(nusratRide, nusrat)).body.ride.pool.otherPassengers).toEqual([{ firstName: 'Rafiq' }]);

    await passengerCancel(rafiqRide, rafiq);
    const after = (await view(nusratRide, nusrat)).body.ride;
    expect(after.pool).toMatchObject({ isShared: false, otherPassengers: [], seatsTaken: 1 });
    expect(after.estimatedFare).toBe(180); // and the fare went back up
  });

  it('a cancelled co-passenger disappears from the list', async () => {
    const nusratRide = await bookAndAccept(nusrat);
    const rafiqRide = await bookAndAccept(rafiq);
    await driverAction(rafiqRide, 'cancel');
    expect((await view(nusratRide, nusrat)).body.ride.pool.otherPassengers).toEqual([]);
  });
});

describe('ride status, fare and actions', () => {
  it('walks Matched → Driver Arrived → Started → Completed, with cancel allowed only before the driver arrives', async () => {
    const id = await bookAndAccept(nusrat);
    let ride = (await view(id, nusrat)).body.ride;
    expect(ride).toMatchObject({ status: 'MATCHED', canCancel: true, fareLocked: false });

    await driverAction(id, 'arrive');
    ride = (await view(id, nusrat)).body.ride;
    expect(ride).toMatchObject({ status: 'DRIVER_ARRIVED', canCancel: false, fareLocked: false });

    await driverAction(id, 'start');
    ride = (await view(id, nusrat)).body.ride;
    expect(ride).toMatchObject({ status: 'STARTED', canCancel: false, fareLocked: true });

    await driverAction(id, 'complete');
    ride = (await view(id, nusrat)).body.ride;
    expect(ride).toMatchObject({ status: 'COMPLETED', canCancel: false, fareLocked: true, pool: null });
  });

  it('a CANCELLED ride reports it clearly, with no pool and no phone', async () => {
    const id = await bookAndAccept(nusrat);
    await bookAndAccept(rafiq);
    await driverAction(id, 'cancel');

    const { ride } = (await view(id, nusrat)).body;
    expect(ride).toMatchObject({ status: 'CANCELLED', canCancel: false, pool: null });
    expect(ride.driver.phone).toBeNull();
  });

  it('the passenger cancelling shows CANCELLED on the next read', async () => {
    const id = await bookAndAccept(nusrat);
    expect((await passengerCancel(id, nusrat)).status).toBe(200);
    expect((await view(id, nusrat)).body.ride.status).toBe('CANCELLED');
  });

  it('the active list carries the same driver and pool details', async () => {
    await bookAndAccept(nusrat);
    await bookAndAccept(rafiq);
    const list = await request(app).get('/passenger/rides/active').set(asUser(nusrat.id));
    expect(list.body.rides[0]).toMatchObject({
      driver: { name: 'Jashim', phone: '01711000000', teslaId: 'DTP-0001' },
      pool: { isShared: true, otherPassengers: [{ firstName: 'Rafiq' }], seatsTaken: 2, seatCapacity: 3 },
    });
  });

  it('history never carries a phone number', async () => {
    const id = await bookAndAccept(nusrat);
    await driverAction(id, 'arrive');
    await driverAction(id, 'start');
    await driverAction(id, 'complete');
    const history = await request(app).get('/passenger/rides/history').set(asUser(nusrat.id));
    expect(history.body.rides).toHaveLength(1);
    expect(JSON.stringify(history.body)).not.toContain(jashim.phone);
  });

  it('carries no live location fields (there is no GPS tracking)', async () => {
    const id = await bookAndAccept(nusrat);
    expect(JSON.stringify((await view(id, nusrat)).body)).not.toMatch(/latitude|longitude|\blat\b|\blng\b|location|gps/i);
  });
});

describe('a passenger can only reach their own ride', () => {
  it('another passenger gets 403 and no data for someone else\'s ride', async () => {
    const nusratRide = await bookAndAccept(nusrat);
    const res = await view(nusratRide, rafiq);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'This ride belongs to another passenger.' });
    expect(JSON.stringify(res.body)).not.toMatch(/Jashim|01711|Bullet|DTP/);
  });

  it('is 401 without a login, and 404 for a ride that does not exist', async () => {
    const id = await bookAndAccept(nusrat);
    expect((await request(app).get(`/passenger/rides/${id}`)).status).toBe(401);
    expect((await request(app).get(`/passenger/rides/${id}`).set('Authorization', 'Bearer not-a-token')).status).toBe(403);
    expect((await view('11111111-1111-1111-1111-111111111111', nusrat)).status).toBe(404);
  });

  it('a forged passengerId cannot be used to read or cancel a ride', async () => {
    const nusratRide = await bookAndAccept(nusrat);

    // Rafiq's login + Nusrat's id in the query
    expect((await request(app).get(`/passenger/rides/${nusratRide}?passengerId=${nusrat.id}`).set(asUser(rafiq.id))).status).toBe(403);
    expect((await request(app).get(`/passenger/rides/active?passengerId=${nusrat.id}`).set(asUser(rafiq.id))).status).toBe(403);
    expect((await request(app).get(`/passenger/rides/history?passengerId=${nusrat.id}`).set(asUser(rafiq.id))).status).toBe(403);
    const cancel = await request(app).patch(`/passenger/rides/${nusratRide}/cancel`).set(asUser(rafiq.id)).send({ passengerId: nusrat.id });
    expect(cancel.status).toBe(403);
    // And with no login at all, Nusrat's id alone gets nothing
    expect((await request(app).get(`/passenger/rides/active?passengerId=${nusrat.id}`)).status).toBe(401);
    expect((await request(app).patch(`/passenger/rides/${nusratRide}/cancel`).send({ passengerId: nusrat.id })).status).toBe(401);
  });

  it('cancelling someone else\'s ride is refused and the ride stays as it was', async () => {
    const nusratRide = await bookAndAccept(nusrat);
    expect((await passengerCancel(nusratRide, rafiq)).status).toBe(403);
    expect((await RideRequest.findByPk(nusratRide))!.status).toBe('MATCHED');
  });

  it('a driver login cannot use the passenger routes', async () => {
    const id = await bookAndAccept(nusrat);
    expect((await request(app).get(`/passenger/rides/${id}`).set(asUser(jashim.id, 'DRIVER'))).status).toBe(403);
    expect((await request(app).get('/passenger/rides/active').set(asUser(jashim.id, 'DRIVER'))).status).toBe(403);
  });

  it('each passenger only ever lists their own rides', async () => {
    await bookAndAccept(nusrat);
    await bookAndAccept(rafiq);
    const list = await request(app).get('/passenger/rides/active').set(asUser(rafiq.id));
    expect(list.body.rides).toHaveLength(1);
    expect(list.body.rides[0].passengerId).toBe(rafiq.id);
  });
});
