/**
 * Pooling test suite — covers all cases A–J specified in the PRD.
 *
 * Fare formula (reference):
 *   baseFare       = 100 BDT
 *   distanceCharge = distanceKm × 20 BDT × seatCount
 *   poolDiscount   = 30 BDT per passenger when poolSize >= 2, else 0
 *   fare           = baseFare + distanceCharge - poolDiscount  (minimum 100 BDT)
 *   stored in integer paisa (× 100)
 *
 * Gulshan → Banani = 2 km
 *   Solo (1 seat):   100 + (2×20×1) - 0  = 140 BDT = 14 000 paisa
 *   Pooled (1 seat): 100 + (2×20×1) - 30 = 110 BDT = 11 000 paisa
 */

import request from 'supertest';
import { app } from '../index';
import { sequelize, User, Vehicle, RideRequest } from '../models';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const mkEmail = (tag: string) => `${tag}-${Date.now()}@test.com`;

async function createDriver(tag: string) {
  return (await User.create({
    name: `Driver-${tag}`,
    email: mkEmail(`driver-${tag}`),
    password: 'pwd',
    role: 'DRIVER',
  })).toJSON() as any;
}

async function createPassenger(tag: string) {
  return (await User.create({
    name: `Pass-${tag}`,
    email: mkEmail(`pass-${tag}`),
    password: 'pwd',
    role: 'PASSENGER',
  })).toJSON() as any;
}

async function createVehicle(driverId: string, capacity = 4, plate?: string) {
  return (await Vehicle.create({
    driverId,
    modelName: 'Tesla Model 3',
    seatCapacity: capacity,
    licensePlate: plate ?? `PLT-${Date.now()}`,
    isActive: true,
    occupiedSeats: 0,
  })).toJSON() as any;
}

async function requestRide(
  app: any,
  passengerId: string,
  pickup = 'Gulshan',
  destination = 'Banani',
  seats = 1
) {
  const res = await request(app).post('/ride-requests').send({
    passengerId, pickupZone: pickup, destinationZone: destination, seatCount: seats,
  });
  return res;
}

async function acceptRide(app: any, rideId: string, driverId: string) {
  return request(app).post(`/ride-requests/${rideId}/accept`).send({ driverId });
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------
describe('Pooling — all cases A–J', () => {
  beforeAll(async () => {
    await sequelize.sync({ force: true });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  afterEach(async () => {
    await RideRequest.destroy({ where: {} });
    await Vehicle.destroy({ where: {} });
    await User.destroy({ where: {} });
  });

  // =========================================================================
  // CASE A: Two passengers on the same route → one pool, both fares discounted
  // =========================================================================
  it('A: two passengers same route → pool discount applied to both', async () => {
    const driver = await createDriver('A');
    const p1 = await createPassenger('A1');
    const p2 = await createPassenger('A2');
    await createVehicle(driver.id, 4);

    // Both request Gulshan → Banani, 1 seat
    const r1 = await requestRide(app, p1.id, 'Gulshan', 'Banani', 1);
    const r2 = await requestRide(app, p2.id, 'Gulshan', 'Banani', 1);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);

    // Solo fare before pooling: 100 + (2×20×1) - 0 = 140 BDT = 14 000 paisa
    expect(r1.body.rideRequest.estimatedFare).toBe(14000);
    expect(r2.body.rideRequest.estimatedFare).toBe(14000);

    // Driver accepts P1 → solo, no discount yet
    const acc1 = await acceptRide(app, r1.body.rideRequest.id, driver.id);
    expect(acc1.status).toBe(200);
    expect(acc1.body.rideRequest.estimatedFare).toBe(14000);
    expect(acc1.body.rideRequest.poolDiscount).toBe(0);

    // Driver accepts P2 → now 2 in pool, BOTH should be discounted
    const acc2 = await acceptRide(app, r2.body.rideRequest.id, driver.id);
    expect(acc2.status).toBe(200);
    // P2's fare: 100 + 40 - 30 = 110 BDT = 11 000 paisa
    expect(acc2.body.rideRequest.estimatedFare).toBe(11000);
    expect(acc2.body.rideRequest.poolDiscount).toBe(3000); // 30 BDT

    // P1's fare must also have been recalculated
    const p1Ride = await RideRequest.findByPk(r1.body.rideRequest.id);
    expect((p1Ride as any).estimatedFare).toBe(11000);
    expect((p1Ride as any).poolDiscount).toBe(3000);

    // Passenger view should show shared ride badge and co-passengers
    const activeRes = await request(app)
      .get(`/passenger/rides/active?passengerId=${p1.id}`);
    expect(activeRes.status).toBe(200);
    const activeRide = activeRes.body.rides[0];
    expect(activeRide.isSharedRide).toBe(true);
    expect(activeRide.coPassengers).toBe(1);
    expect(activeRide.poolDiscountApplied).toBe(true);
    expect(activeRide.estimatedFare).toBe(11000);
    // Driver name should be present
    expect(activeRide.driverName).toBeTruthy();
    // Vehicle should be present
    expect(activeRide.vehicle).not.toBeNull();
  });

  // =========================================================================
  // CASE B: Passenger 2 on a different route → pool incompatible
  // =========================================================================
  it('B: incompatible destination → pool rejected, ride stays REQUESTED', async () => {
    const driver = await createDriver('B');
    const p1 = await createPassenger('B1');
    const p2 = await createPassenger('B2');
    await createVehicle(driver.id, 4);

    const r1 = await requestRide(app, p1.id, 'Gulshan', 'Banani', 1);
    // P2 wants Gulshan → Dhanmondi (different destination)
    const r2 = await requestRide(app, p2.id, 'Gulshan', 'Dhanmondi', 1);

    // Accept P1 into pool
    const acc1 = await acceptRide(app, r1.body.rideRequest.id, driver.id);
    expect(acc1.status).toBe(200);

    // Accept P2 → should be rejected (incompatible destination)
    const acc2 = await acceptRide(app, r2.body.rideRequest.id, driver.id);
    expect(acc2.status).toBe(409);
    expect(acc2.body.error).toMatch(/incompatible/i);

    // P2's ride must still be REQUESTED
    const p2Ride = await RideRequest.findByPk(r2.body.rideRequest.id);
    expect((p2Ride as any).status).toBe('REQUESTED');
  });

  // =========================================================================
  // CASE C: Capacity — request for 2 seats when only 1 remains
  // =========================================================================
  it('C: capacity enforcement — 2-seat request rejected when only 1 seat available', async () => {
    const driver = await createDriver('C');
    const p1 = await createPassenger('C1');
    const p2 = await createPassenger('C2');
    await createVehicle(driver.id, 3); // 3-seat vehicle

    // P1 takes 2 seats
    const r1 = await requestRide(app, p1.id, 'Gulshan', 'Banani', 2);
    await acceptRide(app, r1.body.rideRequest.id, driver.id);

    // Vehicle now has 1 seat left; P2 wants 2 → should be rejected
    const r2 = await requestRide(app, p2.id, 'Gulshan', 'Banani', 2);
    const acc2 = await acceptRide(app, r2.body.rideRequest.id, driver.id);
    expect(acc2.status).toBe(409);
    expect(acc2.body.error).toMatch(/seat/i);

    // Vehicle's occupiedSeats must not have exceeded capacity
    const veh = await Vehicle.findOne({ where: { driverId: driver.id } });
    expect((veh as any).occupiedSeats).toBe(2);
  });

  // =========================================================================
  // CASE D: P1 cancels after P2 joined → P2 continues, fare reverts to solo
  // =========================================================================
  it('D: P1 cancels after pool formed → P2 continues, discount removed', async () => {
    const driver = await createDriver('D');
    const p1 = await createPassenger('D1');
    const p2 = await createPassenger('D2');
    await createVehicle(driver.id, 4);

    const r1 = await requestRide(app, p1.id, 'Gulshan', 'Banani', 1);
    const r2 = await requestRide(app, p2.id, 'Gulshan', 'Banani', 1);

    await acceptRide(app, r1.body.rideRequest.id, driver.id);
    await acceptRide(app, r2.body.rideRequest.id, driver.id);

    // Both should now have discounted fare
    let p1Ride = await RideRequest.findByPk(r1.body.rideRequest.id);
    let p2Ride = await RideRequest.findByPk(r2.body.rideRequest.id);
    expect((p1Ride as any).estimatedFare).toBe(11000);
    expect((p2Ride as any).estimatedFare).toBe(11000);

    // P1 cancels
    const cancelRes = await request(app)
      .patch(`/passenger/rides/${r1.body.rideRequest.id}/cancel`)
      .send({ passengerId: p1.id });
    expect(cancelRes.status).toBe(200);

    // P2's ride must still be MATCHED and fare reverted to solo price
    p2Ride = await RideRequest.findByPk(r2.body.rideRequest.id);
    expect((p2Ride as any).status).toBe('MATCHED');
    expect((p2Ride as any).estimatedFare).toBe(14000); // back to solo fare
    expect((p2Ride as any).poolDiscount).toBe(0);

    // P1's ride is CANCELLED
    p1Ride = await RideRequest.findByPk(r1.body.rideRequest.id);
    expect((p1Ride as any).status).toBe('CANCELLED');
  });

  // =========================================================================
  // CASE E: P2 cancels → P1's fare reverts
  // =========================================================================
  it('E: P2 cancels → P1 fare reverts to solo', async () => {
    const driver = await createDriver('E');
    const p1 = await createPassenger('E1');
    const p2 = await createPassenger('E2');
    await createVehicle(driver.id, 4);

    const r1 = await requestRide(app, p1.id, 'Gulshan', 'Banani', 1);
    const r2 = await requestRide(app, p2.id, 'Gulshan', 'Banani', 1);
    await acceptRide(app, r1.body.rideRequest.id, driver.id);
    await acceptRide(app, r2.body.rideRequest.id, driver.id);

    // P2 cancels
    const cancelRes = await request(app)
      .patch(`/passenger/rides/${r2.body.rideRequest.id}/cancel`)
      .send({ passengerId: p2.id });
    expect(cancelRes.status).toBe(200);

    // P1's fare should revert to 14 000 paisa (solo)
    const p1Ride = await RideRequest.findByPk(r1.body.rideRequest.id);
    expect((p1Ride as any).estimatedFare).toBe(14000);
    expect((p1Ride as any).poolDiscount).toBe(0);
  });

  // =========================================================================
  // CASE F: Concurrency — two requests for the last seat, only one wins
  // =========================================================================
  it('F: concurrent accept of last seat → exactly one succeeds', async () => {
    const driver = await createDriver('F');
    const p1 = await createPassenger('F1');
    const p2 = await createPassenger('F2');
    await createVehicle(driver.id, 4);

    // Both ask for 3 seats (sum = 6 > 4)
    const r1 = await requestRide(app, p1.id, 'Gulshan', 'Banani', 3);
    const r2 = await requestRide(app, p2.id, 'Gulshan', 'Banani', 3);

    const [acc1, acc2] = await Promise.all([
      acceptRide(app, r1.body.rideRequest.id, driver.id),
      acceptRide(app, r2.body.rideRequest.id, driver.id),
    ]);

    const statuses = [acc1.status, acc2.status];
    expect(statuses).toContain(200);
    expect(statuses).toContain(409);

    // Vehicle must not be overbooked
    const veh = await Vehicle.findOne({ where: { driverId: driver.id } });
    expect((veh as any).occupiedSeats).toBe(3);
  });

  // =========================================================================
  // CASE G: Invalid state transitions
  // =========================================================================
  it('G: invalid state transitions are rejected', async () => {
    const driver = await createDriver('G');
    const p1 = await createPassenger('G1');
    await createVehicle(driver.id, 4);

    const r1 = await requestRide(app, p1.id, 'Gulshan', 'Banani', 1);
    await acceptRide(app, r1.body.rideRequest.id, driver.id);

    // MATCHED → STARTED (must go MATCHED → DRIVER_ARRIVED → STARTED)
    const badStart = await request(app)
      .patch(`/driver/rides/${r1.body.rideRequest.id}/start`)
      .send({ driverId: driver.id });
    expect(badStart.status).toBe(409);

    // COMPLETED → STARTED is invalid
    await request(app).patch(`/driver/rides/${r1.body.rideRequest.id}/arrive`).send({ driverId: driver.id });
    await request(app).patch(`/driver/rides/${r1.body.rideRequest.id}/start`).send({ driverId: driver.id });
    await request(app).patch(`/driver/rides/${r1.body.rideRequest.id}/complete`).send({ driverId: driver.id });

    const badRestart = await request(app)
      .patch(`/driver/rides/${r1.body.rideRequest.id}/start`)
      .send({ driverId: driver.id });
    expect(badRestart.status).toBe(409);
  });

  // =========================================================================
  // CASE H: Authorization
  // =========================================================================
  it('H: passenger cannot view or cancel another passenger ride', async () => {
    const p1 = await createPassenger('H1');
    const p2 = await createPassenger('H2');

    const r1 = await requestRide(app, p1.id, 'Gulshan', 'Banani', 1);
    const rideId = r1.body.rideRequest.id;

    // P2 tries to view P1's ride
    const viewRes = await request(app)
      .get(`/passenger/rides/${rideId}?passengerId=${p2.id}`);
    expect(viewRes.status).toBe(404);

    // P2 tries to cancel P1's ride
    const cancelRes = await request(app)
      .patch(`/passenger/rides/${rideId}/cancel`)
      .send({ passengerId: p2.id });
    expect(cancelRes.status).toBe(404);
  });

  it('H: driver cannot act on a pool that is not theirs', async () => {
    const driver1 = await createDriver('H-D1');
    const driver2 = await createDriver('H-D2');
    const p1 = await createPassenger('H-P1');
    await createVehicle(driver1.id, 4, 'PLT-HD1');
    await createVehicle(driver2.id, 4, 'PLT-HD2');

    const r1 = await requestRide(app, p1.id, 'Gulshan', 'Banani', 1);
    await acceptRide(app, r1.body.rideRequest.id, driver1.id);

    // driver2 tries to mark arrival on driver1's ride
    const arriveRes = await request(app)
      .patch(`/driver/rides/${r1.body.rideRequest.id}/arrive`)
      .send({ driverId: driver2.id });
    expect(arriveRes.status).toBe(403);
  });

  // =========================================================================
  // CASE I: P2 requests after trip STARTED → not added to pool
  // =========================================================================
  it('I: cannot join pool after trip has started', async () => {
    const driver = await createDriver('I');
    const p1 = await createPassenger('I1');
    const p2 = await createPassenger('I2');
    await createVehicle(driver.id, 4);

    const r1 = await requestRide(app, p1.id, 'Gulshan', 'Banani', 1);
    await acceptRide(app, r1.body.rideRequest.id, driver.id);
    await request(app).patch(`/driver/rides/${r1.body.rideRequest.id}/arrive`).send({ driverId: driver.id });
    await request(app).patch(`/driver/rides/${r1.body.rideRequest.id}/start`).send({ driverId: driver.id });

    // P2 requests and driver tries to accept → rejected
    const r2 = await requestRide(app, p2.id, 'Gulshan', 'Banani', 1);
    const acc2 = await acceptRide(app, r2.body.rideRequest.id, driver.id);
    expect(acc2.status).toBe(409);
    expect(acc2.body.error).toMatch(/started/i);
  });

  // =========================================================================
  // CASE J: Independent statuses — P1 completes while P2 is still in progress
  // =========================================================================
  it('J: passengers have independent statuses and history', async () => {
    const driver = await createDriver('J');
    const p1 = await createPassenger('J1');
    const p2 = await createPassenger('J2');
    await createVehicle(driver.id, 4);

    const r1 = await requestRide(app, p1.id, 'Gulshan', 'Banani', 1);
    const r2 = await requestRide(app, p2.id, 'Gulshan', 'Banani', 1);
    await acceptRide(app, r1.body.rideRequest.id, driver.id);
    await acceptRide(app, r2.body.rideRequest.id, driver.id);

    // Move P1 through full lifecycle to COMPLETED
    await request(app).patch(`/driver/rides/${r1.body.rideRequest.id}/arrive`).send({ driverId: driver.id });
    await request(app).patch(`/driver/rides/${r1.body.rideRequest.id}/start`).send({ driverId: driver.id });
    await request(app).patch(`/driver/rides/${r1.body.rideRequest.id}/complete`).send({ driverId: driver.id });

    // P1 is COMPLETED, P2 is still MATCHED
    const p1Final = await RideRequest.findByPk(r1.body.rideRequest.id);
    const p2Still = await RideRequest.findByPk(r2.body.rideRequest.id);
    expect((p1Final as any).status).toBe('COMPLETED');
    expect((p2Still as any).status).toBe('MATCHED'); // unaffected

    // P1 appears in history
    const historyRes = await request(app)
      .get(`/passenger/rides/history?passengerId=${p1.id}`);
    expect(historyRes.status).toBe(200);
    expect(historyRes.body.rides).toHaveLength(1);
    expect(historyRes.body.rides[0].status).toBe('COMPLETED');

    // P2 still appears in active rides
    const activeRes = await request(app)
      .get(`/passenger/rides/active?passengerId=${p2.id}`);
    expect(activeRes.status).toBe(200);
    expect(activeRes.body.rides).toHaveLength(1);
  });

  // =========================================================================
  // FARE FORMULA VERIFICATION (explicit numbers)
  // =========================================================================
  it('Fare formula: Gulshan→Banani solo=14000 paisa, pooled=11000 paisa', async () => {
    const driver = await createDriver('F1');
    const p1 = await createPassenger('F-P1');
    const p2 = await createPassenger('F-P2');
    await createVehicle(driver.id, 4);

    const r1 = await requestRide(app, p1.id, 'Gulshan', 'Banani', 1);
    // Solo fare: 100 + (2km × 20 × 1) - 0 = 140 BDT = 14 000 paisa
    expect(r1.body.rideRequest.estimatedFare).toBe(14000);
    expect(r1.body.rideRequest.poolDiscount).toBe(0);

    await acceptRide(app, r1.body.rideRequest.id, driver.id);

    const r2 = await requestRide(app, p2.id, 'Gulshan', 'Banani', 1);
    await acceptRide(app, r2.body.rideRequest.id, driver.id);

    // After pool: 100 + 40 - 30 = 110 BDT = 11 000 paisa each
    const p1Final = await RideRequest.findByPk(r1.body.rideRequest.id);
    const p2Final = await RideRequest.findByPk(r2.body.rideRequest.id);
    expect((p1Final as any).estimatedFare).toBe(11000);
    expect((p2Final as any).estimatedFare).toBe(11000);
    expect((p1Final as any).poolDiscount).toBe(3000); // 30 BDT in paisa
    expect((p2Final as any).poolDiscount).toBe(3000);
  });
});
