import request from 'supertest';
import { app } from '../index';
import { sequelize, User, Vehicle, RideRequest } from '../models';
import { asUser } from './helpers';

describe('Ride Request API and Logic', () => {
  beforeAll(async () => {
    // Force sync database for tests
    await sequelize.sync({ force: true });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  afterEach(async () => {
    // Clear data between tests
    await RideRequest.destroy({ where: {} });
    await Vehicle.destroy({ where: {} });
    await User.destroy({ where: {} });
  });

  describe('Seat capacity and Concurrency', () => {
    it('should never exceed vehicle seat capacity even concurrently', async () => {
      const driver = (await User.create({ name: 'Driver', email: 'driver@test.com', password: 'pwd', role: 'DRIVER' })).toJSON() as any;
      const passenger1 = (await User.create({ name: 'P1', email: 'p1@test.com', password: 'pwd', role: 'PASSENGER' })).toJSON() as any;
      const passenger2 = (await User.create({ name: 'P2', email: 'p2@test.com', password: 'pwd', role: 'PASSENGER' })).toJSON() as any;

      const vehicle = (await Vehicle.create({
        driverId: driver.id,
        modelName: 'Bullet',
        seatCapacity: 4,
        licensePlate: 'BULLET-01',
      })).toJSON() as any;

      // Two requests of 3 seats each
      const res1 = await request(app).post('/ride-requests').set(asUser(passenger1.id)).send({ pickupZone: 'Gulshan', destinationZone: 'Banani', seatCount: 3 });
      const res2 = await request(app).post('/ride-requests').set(asUser(passenger2.id)).send({ pickupZone: 'Dhanmondi', destinationZone: 'Banani', seatCount: 3 });
      const req1 = res1.body.rideRequest;
      const req2 = res2.body.rideRequest;

      // Concurrent accept
      const [out1, out2] = await Promise.all([
        request(app).post(`/ride-requests/${req1.id}/accept`).send({ driverId: driver.id }),
        request(app).post(`/ride-requests/${req2.id}/accept`).send({ driverId: driver.id })
      ]);

      const statuses = [out1.status, out2.status];
      expect(statuses).toContain(200);
      expect(statuses).toContain(409);

      const v = (await Vehicle.findByPk(vehicle.id))?.toJSON() as any;
      expect(v.occupiedSeats).toBe(3); // one of the 3-seat requests got accepted, the other rejected
    });
  });

  describe('State transitions', () => {
    it('rejects invalid state transitions', async () => {
      const passenger = (await User.create({ name: 'P', email: 'p@test.com', password: 'pwd', role: 'PASSENGER' })).toJSON() as any;
      const driver = (await User.create({ name: 'D', email: 'd@test.com', password: 'pwd', role: 'DRIVER' })).toJSON() as any;
      await Vehicle.create({ driverId: driver.id, modelName: 'Car', seatCapacity: 4, licensePlate: 'CAR-10' });

      const resReq = await request(app).post('/ride-requests').set(asUser(passenger.id)).send({ pickupZone: 'Gulshan', destinationZone: 'Banani', seatCount: 1 });
      const rideId = resReq.body.rideRequest.id;

      // Accept the ride to assign the driver (moves to MATCHED)
      await request(app).post(`/ride-requests/${rideId}/accept`).send({ driverId: driver.id });

      // Try to jump straight to STARTED without DRIVER_ARRIVED
      const resStart = await request(app).patch(`/driver/rides/${rideId}/start`).send({ driverId: driver.id });
      expect(resStart.status).toBe(409); // Should reject
    });
  });

  describe('Fares', () => {
    it('stores the full solo fare at creation; the pool discount only applies once someone joins', async () => {
      // Formula: baseFare(100) + distanceKm * 20 * seats, minus 30 once 2+ passengers share.
      // Gulshan -> Banani is 2 km.
      // Solo, 1 seat: 100 + 2 * 20 * 1 = 140 BDT.
      const p1 = (await User.create({ name: 'Nusrat', email: 'nusrat@test.com', password: 'pwd', role: 'PASSENGER' })).toJSON() as any;
      const res1 = await request(app).post('/ride-requests').set(asUser(p1.id)).send({ pickupZone: 'Gulshan', destinationZone: 'Banani', seatCount: 1 });
      expect(res1.body.rideRequest.estimatedFare).toBe(14000); // 140 BDT in paisa

      // Solo, 3 seats (the maximum): 100 + 2 * 20 * 3 = 220 BDT.
      const p2 = (await User.create({ name: 'Rafiq', email: 'rafiq@test.com', password: 'pwd', role: 'PASSENGER' })).toJSON() as any;
      const res2 = await request(app).post('/ride-requests').set(asUser(p2.id)).send({ pickupZone: 'Gulshan', destinationZone: 'Banani', seatCount: 3 });
      expect(res2.body.rideRequest.estimatedFare).toBe(22000); // 220 BDT
    });
  });

  describe('Isolation', () => {
    it('prevents a passenger from viewing or modifying another passenger ride', async () => {
      const p1 = (await User.create({ name: 'P1', email: 'p1@test.com', password: 'pwd', role: 'PASSENGER' })).toJSON() as any;
      const p2 = (await User.create({ name: 'P2', email: 'p2@test.com', password: 'pwd', role: 'PASSENGER' })).toJSON() as any;
      
      const resReq = await request(app).post('/ride-requests').set(asUser(p1.id)).send({ pickupZone: 'Gulshan', destinationZone: 'Banani', seatCount: 1 });
      const p1RideId = resReq.body.rideRequest.id;

      const resView = await request(app).get(`/passenger/rides/${p1RideId}?passengerId=${p2.id}`);
      expect(resView.status).toBe(404);

      const resCancel = await request(app).patch(`/passenger/rides/${p1RideId}/cancel`).send({
        passengerId: p2.id
      });
      expect(resCancel.status).toBe(404);
    });
  });

  describe('Cancellation', () => {
    it('allows cancellation in REQUESTED state', async () => {
      const p1 = (await User.create({ name: 'P1', email: 'p1@test.com', password: 'pwd', role: 'PASSENGER' })).toJSON() as any;
      const resReq = await request(app).post('/ride-requests').set(asUser(p1.id)).send({ pickupZone: 'Gulshan', destinationZone: 'Banani', seatCount: 1 });
      const rideId = resReq.body.rideRequest.id;

      const resCancel = await request(app).patch(`/passenger/rides/${rideId}/cancel`).send({
        passengerId: p1.id
      });
      expect(resCancel.status).toBe(200);
    });

    it('denies passenger cancellation after driver arrived', async () => {
      const p1 = (await User.create({ name: 'P1', email: 'p1@test.com', password: 'pwd', role: 'PASSENGER' })).toJSON() as any;
      const d1 = (await User.create({ name: 'D1', email: 'd1@test.com', password: 'pwd', role: 'DRIVER' })).toJSON() as any;
      await Vehicle.create({ driverId: d1.id, modelName: 'Car', seatCapacity: 4, licensePlate: 'CAR-C2' });

      const resReq = await request(app).post('/ride-requests').set(asUser(p1.id)).send({ pickupZone: 'Gulshan', destinationZone: 'Banani', seatCount: 1 });
      const rideId = resReq.body.rideRequest.id;

      await request(app).post(`/ride-requests/${rideId}/accept`).send({ driverId: d1.id });
      await request(app).patch(`/driver/rides/${rideId}/arrive`).send({ driverId: d1.id });

      const resCancel = await request(app).patch(`/passenger/rides/${rideId}/cancel`).send({
        passengerId: p1.id
      });
      expect(resCancel.status).toBe(409); // Cannot cancel
    });
  });
});
