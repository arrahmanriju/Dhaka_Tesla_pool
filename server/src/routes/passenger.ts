import { Router, Request, Response } from 'express';
import { Op } from 'sequelize';
import { User, RideRequest, Vehicle } from '../models';
import { validateTransition, RideStatus } from '../models/RideRequest';
import { isFareLocked, recalculatePoolFares } from '../utils/poolFares';
import { shareRatePercent } from '../utils/fareCalculator';

const router = Router();

// ---------------------------------------------------------------------------
// CANCELLABLE STATES — documented rationale:
//
//   REQUESTED     → CANCELLED  ✔ No driver has committed yet. Zero cost.
//   MATCHED       → CANCELLED  ✔ Driver was matched but not yet on the way.
//                               The passenger can still back out; the driver
//                               has not yet been physically inconvenienced.
//
//   DRIVER_ARRIVED→ CANCELLED  ✗ NOT allowed for the passenger.
//                               The driver has already made the physical trip
//                               to the pickup point. Cancelling here penalises
//                               the driver unfairly. Only a driver can cancel
//                               in this state (no-show, etc.).
//
//   STARTED       → CANCELLED  ✗ Trip is in progress — cannot cancel.
//   COMPLETED     → CANCELLED  ✗ Terminal state — cannot undo.
//   CANCELLED     → CANCELLED  ✗ Already cancelled.
//
// Summary: passengers may cancel in REQUESTED or MATCHED only.
// ---------------------------------------------------------------------------
const PASSENGER_CANCELLABLE: RideStatus[] = ['REQUESTED', 'MATCHED'];

// ---------------------------------------------------------------------------
// Helper: verify caller is a PASSENGER
// ---------------------------------------------------------------------------
async function resolvePassenger(passengerId: string | undefined, res: Response) {
  if (!passengerId) {
    res.status(400).json({ error: 'passengerId is required.' });
    return null;
  }
  const passenger = await User.findByPk(passengerId);
  if (!passenger) {
    res.status(401).json({ error: 'Passenger not found. Please log in again.' });
    return null;
  }
  if (passenger.role !== 'PASSENGER') {
    res.status(403).json({ error: 'Only passengers can perform this action.' });
    return null;
  }
  return passenger;
}

// ---------------------------------------------------------------------------
// Helper: find a ride and enforce ownership.
// Returns the ride if it belongs to this passenger; otherwise writes a 403/404
// and returns null. Using a generic 404 for non-owned rides prevents
// information leakage (passenger cannot confirm whether a ride ID even exists
// if it belongs to someone else).
// ---------------------------------------------------------------------------
async function findOwnedRide(rideId: string, passengerId: string, res: Response) {
  const ride = await RideRequest.findOne({ where: { id: rideId } });

  if (!ride) {
    res.status(404).json({ error: 'Ride not found.' });
    return null;
  }

  // Ownership check — deliberately returns the same 404 to avoid enumeration
  if ((ride as any).passengerId !== passengerId) {
    res.status(404).json({ error: 'Ride not found.' });
    return null;
  }

  return ride;
}

// ---------------------------------------------------------------------------
// Helper: enrich a RideRequest with vehicle, driver name, and pool info.
// Returns ONLY the requesting passenger's own data — no co-passenger PII.
// ---------------------------------------------------------------------------
async function enrichRide(ride: any) {
  let vehicleInfo = null;
  let driverName: string | null = null;
  let coPassengers = 0;
  let poolSize = 1;

  if (ride.vehicleId) {
    const vehicle: any = await Vehicle.findByPk(ride.vehicleId, {
      attributes: ['id', 'modelName', 'licensePlate', 'seatCapacity', 'occupiedSeats'],
    });
    vehicleInfo = vehicle ? vehicle.toJSON() : null;

    // Count co-passengers (excluding this passenger) — count only, no PII
    const poolCount = await RideRequest.count({
      where: {
        vehicleId: ride.vehicleId,
        status: { [Op.notIn]: ['CANCELLED', 'COMPLETED'] },
      },
    });
    poolSize = Math.max(1, poolCount);
    coPassengers = poolSize - 1;
  }

  if (ride.driverId) {
    const driver: any = await User.findByPk(ride.driverId, {
      attributes: ['name'],
    });
    driverName = driver?.name ?? null;
  }

  return {
    id: ride.id,
    passengerId: ride.passengerId,
    pickupZone: ride.pickupZone,
    destinationZone: ride.destinationZone,
    seatCount: ride.seatCount,
    allowSharing: ride.allowSharing,
    // Only THIS passenger's own fare is ever returned (never a co-passenger's). Whole taka.
    baseFare: ride.baseFare, // the fare riding alone
    estimatedFare: ride.estimatedFare, // what they pay right now
    poolDiscount: ride.poolDiscount, // what they save by sharing
    fareLocked: isFareLocked(ride.status), // true once the trip has started
    status: ride.status,
    vehicle: vehicleInfo,
    driverName,
    coPassengers,
    poolSize,
    shareRatePercent: shareRatePercent(poolSize, ride.allowSharing),
    poolDiscountApplied: ride.poolDiscount > 0,
    isSharedRide: coPassengers > 0,
    canCancel: PASSENGER_CANCELLABLE.includes(ride.status as RideStatus),
    createdAt: ride.createdAt,
    updatedAt: ride.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// GET /passenger/rides/active?passengerId=...
// Passenger tracks live status of their current (non-terminal) ride(s).
// Returns the ride status, vehicle info, driver name, pool co-passenger count,
// fare (with discount if pool applies), and "shared ride" flag.
// Does NOT reveal other passengers' fares or PII.
// ---------------------------------------------------------------------------
router.get('/rides/active', async (req: Request, res: Response) => {
  try {
    const passengerId = req.query.passengerId as string;
    const passenger = await resolvePassenger(passengerId, res);
    if (!passenger) return;

    const activeRides = await RideRequest.findAll({
      where: {
        passengerId,
        status: { [Op.in]: ['REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED'] },
      },
      order: [['createdAt', 'DESC']],
    });

    const enriched = await Promise.all(activeRides.map(enrichRide));
    res.json({ rides: enriched });
  } catch (error) {
    console.error('Passenger active rides error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /passenger/rides/history?passengerId=...
// Passenger views their completed and cancelled ride history.
// ---------------------------------------------------------------------------
router.get('/rides/history', async (req: Request, res: Response) => {
  try {
    const passengerId = req.query.passengerId as string;
    const passenger = await resolvePassenger(passengerId, res);
    if (!passenger) return;

    const history = await RideRequest.findAll({
      where: {
        passengerId,
        status: { [Op.in]: ['COMPLETED', 'CANCELLED'] },
      },
      order: [['updatedAt', 'DESC']],
    });

    res.json({
      rides: history.map((r: any) => ({
        id: r.id,
        pickupZone: r.pickupZone,
        destinationZone: r.destinationZone,
        seatCount: r.seatCount,
        baseFare: r.baseFare,
        estimatedFare: r.estimatedFare,
        poolDiscount: r.poolDiscount,
        fareLocked: isFareLocked(r.status),
        status: r.status,
        vehicleId: r.vehicleId,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    });
  } catch (error) {
    console.error('Passenger history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /passenger/rides/:id?passengerId=...
// Passenger tracks one specific ride by ID.
// A 404 is returned if the ride doesn't exist OR belongs to another passenger.
// ---------------------------------------------------------------------------
router.get('/rides/:id', async (req: Request, res: Response) => {
  try {
    const passengerId = req.query.passengerId as string;
    const rideId = req.params.id as string;

    const passenger = await resolvePassenger(passengerId, res);
    if (!passenger) return;

    const ride: any = await findOwnedRide(rideId, passengerId, res);
    if (!ride) return;

    res.json({ ride: await enrichRide(ride) });
  } catch (error) {
    console.error('Passenger get ride error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /passenger/rides/:id/cancel
// Passenger cancels their own ride.
// Only allowed in REQUESTED or MATCHED states (see rationale at top of file).
// A 404 is returned for rides belonging to other passengers (no enumeration).
//
// POOL FARE RECALCULATION:
//   If the cancelled ride was part of a pool (vehicleId set), we release its
//   seats and immediately recalculate the remaining pool passengers' fares.
//   If only 1 passenger remains, their discount is removed (back to baseFare).
// ---------------------------------------------------------------------------
router.patch('/rides/:id/cancel', async (req: Request, res: Response) => {
  try {
    const rideId = req.params.id as string;
    const { passengerId } = req.body;

    const passenger = await resolvePassenger(passengerId, res);
    if (!passenger) return;

    const ride: any = await findOwnedRide(rideId, passengerId, res);
    if (!ride) return;

    // State-machine guard
    const machineErr = validateTransition(ride.status as RideStatus, 'CANCELLED');
    if (machineErr) {
      res.status(409).json({ error: machineErr });
      return;
    }

    // Extra passenger-specific guard: DRIVER_ARRIVED onwards is not passenger-cancellable
    if (!PASSENGER_CANCELLABLE.includes(ride.status as RideStatus)) {
      res.status(409).json({
        error: `Passengers cannot cancel a ride in ${ride.status} state. The driver is already on their way or the trip is in progress.`,
      });
      return;
    }

    const { sequelize } = require('../models/index');

    await sequelize.transaction(async (t: any) => {
      // 1. Mark this ride cancelled
      await RideRequest.update(
        { status: 'CANCELLED' },
        { where: { id: rideId, passengerId }, transaction: t }
      );

      if (ride.vehicleId) {
        // 2. Release the reserved seats
        await Vehicle.update(
          { occupiedSeats: sequelize.literal(`MAX(0, occupiedSeats - ${ride.seatCount})`) },
          { where: { id: ride.vehicleId }, transaction: t }
        );

        // 3. Recalculate fares for the remaining pool passengers.
        //    recalculatePoolFares() will NOT include this now-CANCELLED ride
        //    because it filters by non-terminal statuses. Fares that are already
        //    locked (STARTED) are left alone.
        await recalculatePoolFares(ride.vehicleId, t);
      }
    });

    res.json({
      message: 'Ride cancelled successfully.',
      rideId,
      status: 'CANCELLED',
    });
  } catch (error) {
    console.error('Passenger cancel ride error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
