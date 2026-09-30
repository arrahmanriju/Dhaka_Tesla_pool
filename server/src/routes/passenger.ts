import { Router, Response, NextFunction } from 'express';
import { Op } from 'sequelize';
import { User, RideRequest, Vehicle, DriverProfile } from '../models';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
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
// Every /passenger/rides route runs as the LOGGED-IN passenger.
//
// The caller is identified by their login token, never by an id they send. A `passengerId`
// in the query or body is still accepted (older clients send one) but it must be the caller's
// own id: someone else's id gets a 403. Only passengers may use these routes.
//
// This matters more now that a ride carries the driver's phone number and the first names of
// the other passengers: an id that can be forged would leak them.
// ---------------------------------------------------------------------------
function ownPassenger(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  authenticateToken(req, res, () => {
    if (req.user!.role !== 'PASSENGER') {
      res.status(403).json({ error: 'Only passengers can view or change rides.' });
      return;
    }
    const claimed = req.query.passengerId ?? req.body?.passengerId;
    if (typeof claimed === 'string' && claimed !== req.user!.id) {
      res.status(403).json({ error: 'You can only access your own rides.' });
      return;
    }
    next();
  });
}

// ---------------------------------------------------------------------------
// Helper: find a ride and enforce ownership.
// Returns the ride if it belongs to this passenger; otherwise writes the error
// (404 if there is no such ride, 403 if it is someone else's) and returns null.
// ---------------------------------------------------------------------------
async function findOwnedRide(rideId: string, passengerId: string, res: Response) {
  const ride = await RideRequest.findOne({ where: { id: rideId } });

  if (!ride) {
    res.status(404).json({ error: 'Ride not found.' });
    return null;
  }

  if ((ride as any).passengerId !== passengerId) {
    res.status(403).json({ error: 'This ride belongs to another passenger.' });
    return null;
  }

  return ride;
}

// ---------------------------------------------------------------------------
// Helper: enrich a RideRequest with the driver, vehicle and pool details the passenger's
// ride status page shows.
//
// What a passenger may see (and nothing more):
//   driver   — name, photo, Tesla ID, and the PHONE NUMBER only while the ride is in progress
//              (MATCHED, DRIVER_ARRIVED, STARTED). Never while it is still REQUESTED, and
//              not once it is over.
//   pool     — is it shared, seats taken, and the FIRST NAME of each other passenger.
//              Never another passenger's phone, fare, destination, surname or ids.
//   fare     — this passenger's own fare only.
// ---------------------------------------------------------------------------
const IN_PROGRESS: RideStatus[] = ['MATCHED', 'DRIVER_ARRIVED', 'STARTED'];
const OPEN: RideStatus[] = ['REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED'];

const firstName = (fullName: string | null | undefined) => (fullName ?? '').trim().split(/\s+/)[0] ?? '';

async function enrichRide(ride: any) {
  const status = ride.status as RideStatus;
  const vehicle: any = ride.vehicleId
    ? await Vehicle.findByPk(ride.vehicleId, {
        attributes: ['id', 'modelName', 'licensePlate', 'seatCapacity', 'occupiedSeats'],
      })
    : null;

  // ── Driver: only once a driver has accepted (never while REQUESTED) ──
  let driver: { name: string | null; phone: string | null; photoUrl: string | null; teslaId: string | null } | null = null;
  if (ride.driverId && status !== 'REQUESTED') {
    const [user, profile] = await Promise.all([
      User.findByPk(ride.driverId, { attributes: ['name', 'phone'] }),
      DriverProfile.findOne({ where: { userId: ride.driverId }, attributes: ['id', 'profilePicture'] }),
    ]);
    driver = {
      name: user?.name ?? null,
      phone: IN_PROGRESS.includes(status) ? (user?.phone ?? null) : null,
      photoUrl: profile?.profilePicture ? `/uploads/${profile.profilePicture}` : null,
      teslaId: profile?.driverCode ?? null,
    };
  }

  const vehicleInfo = vehicle
    ? {
        ...vehicle.toJSON(),
        nickname: vehicle.modelName,
        teslaId: driver?.teslaId ?? vehicle.licensePlate,
      }
    : null;

  // ── Pool: who else is on this vehicle right now (only while the ride is open) ──
  let pool: {
    isShared: boolean;
    poolSize: number;
    otherPassengers: { firstName: string }[];
    seatsTaken: number;
    seatCapacity: number;
  } | null = null;
  if (ride.vehicleId && vehicle && OPEN.includes(status)) {
    // Only the columns needed to count seats and find names — no fares, zones or phones are read.
    const poolRides: any[] = await RideRequest.findAll({
      where: { vehicleId: ride.vehicleId, status: { [Op.in]: OPEN } },
      attributes: ['id', 'passengerId', 'seatCount'],
      order: [['createdAt', 'ASC']],
    });
    const others = poolRides.filter((r) => r.id !== ride.id);
    const users: any[] = others.length
      ? await User.findAll({ where: { id: others.map((r) => r.passengerId) }, attributes: ['id', 'name'] })
      : [];
    const names = new Map(users.map((u) => [u.id, firstName(u.name)]));
    pool = {
      isShared: others.length > 0,
      poolSize: Math.max(1, poolRides.length),
      otherPassengers: others.map((r) => ({ firstName: names.get(r.passengerId) ?? '' })),
      seatsTaken: poolRides.reduce((sum, r) => sum + r.seatCount, 0),
      seatCapacity: vehicle.seatCapacity,
    };
  }

  const poolSize = pool?.poolSize ?? 1;
  const coPassengers = pool ? pool.otherPassengers.length : 0;
  const driverName = driver?.name ?? null;

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
    driver,
    driverName,
    pool,
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
// GET /passenger/rides/active   (login required)
// Passenger tracks live status of their current (non-terminal) ride(s): status, driver and
// vehicle, pool (shared or not, seats, first names of the others), and their own fare.
// Does NOT reveal other passengers' phones, fares, destinations or ids.
// ---------------------------------------------------------------------------
router.get('/rides/active', ownPassenger, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const passengerId = req.user!.id;
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
// GET /passenger/rides/history   (login required)
// Passenger views their completed and cancelled ride history.
// ---------------------------------------------------------------------------
router.get('/rides/history', ownPassenger, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const passengerId = req.user!.id;
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
// GET /passenger/rides/:id   (login required)
// Passenger tracks one specific ride by ID — the ride status page polls this every 5 seconds.
// 404 if there is no such ride; 403 if it belongs to another passenger.
// ---------------------------------------------------------------------------
router.get('/rides/:id', ownPassenger, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const passengerId = req.user!.id;
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
// PATCH /passenger/rides/:id/cancel   (login required)
// Passenger cancels their own ride.
// Only allowed in REQUESTED or MATCHED states (see rationale at top of file).
// 404 if there is no such ride; 403 for a ride that belongs to another passenger.
//
// POOL FARE RECALCULATION:
//   If the cancelled ride was part of a pool (vehicleId set), we release its
//   seats and immediately recalculate the remaining pool passengers' fares.
//   If only 1 passenger remains, their discount is removed (back to baseFare).
// ---------------------------------------------------------------------------
router.patch('/rides/:id/cancel', ownPassenger, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rideId = req.params.id as string;
    const passengerId = req.user!.id;

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
