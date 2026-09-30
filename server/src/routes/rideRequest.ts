import { Router, Request, Response } from 'express';
import { Op, Transaction } from 'sequelize';
import { sequelize, User, RideRequest, Vehicle } from '../models';
import {
  ACTIVE_RIDE_STATUSES,
  DHAKA_ZONES,
  MAX_SEATS_PER_RIDE,
  MIN_SEATS_PER_RIDE,
  POOL_JOINABLE_STATUSES,
  areZonesCompatible,
} from '../models/RideRequest';
import { calculateBaseFare, estimateFare, shareRatePercent } from '../utils/fareCalculator';
import { isFareLocked, recalculatePoolFares } from '../utils/poolFares';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// ---------------------------------------------------------------------------
// HELPER: format a RideRequest for the API response
// ---------------------------------------------------------------------------
function formatRide(r: any) {
  return {
    id: r.id,
    passengerId: r.passengerId,
    driverId: r.driverId ?? null,
    vehicleId: r.vehicleId ?? null,
    pickupZone: r.pickupZone,
    destinationZone: r.destinationZone,
    seatCount: r.seatCount,
    allowSharing: r.allowSharing,
    // Money is whole taka. baseFare = the fare riding alone; estimatedFare = what this passenger
    // pays right now; poolDiscount = what they save by sharing (baseFare − estimatedFare).
    baseFare: r.baseFare,
    estimatedFare: r.estimatedFare,
    poolDiscount: r.poolDiscount,
    // true once the trip has started: the fare can no longer change
    fareLocked: isFareLocked(r.status),
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// HELPER: validateRideInput
//
// The single set of rules for a ride request, shared by the fare estimate and
// the create endpoint so the two can never disagree. Values are checked strictly
// (no coercion): seatCount must be an integer, allowSharing a boolean.
// Returns per-field messages (keyed by form field) or the cleaned values.
// ---------------------------------------------------------------------------
type RideInput = {
  pickupZone: string;
  destinationZone: string;
  seatCount: number;
  allowSharing: boolean;
};

function validateRideInput(raw: {
  pickupZone?: unknown;
  destinationZone?: unknown;
  seatCount?: unknown;
  allowSharing?: unknown;
}): { fields: Record<string, string> } | { input: RideInput } {
  const fields: Record<string, string> = {};
  const isZone = (z: unknown): z is string =>
    typeof z === 'string' && (DHAKA_ZONES as readonly string[]).includes(z);

  if (!isZone(raw.pickupZone)) fields.pickupZone = 'Choose a valid pickup zone.';
  if (!isZone(raw.destinationZone)) fields.destinationZone = 'Choose a valid destination zone.';
  if (!fields.pickupZone && !fields.destinationZone && raw.pickupZone === raw.destinationZone) {
    fields.destinationZone = 'Pickup and destination zones cannot be the same.';
  }

  if (
    typeof raw.seatCount !== 'number' ||
    !Number.isInteger(raw.seatCount) ||
    raw.seatCount < MIN_SEATS_PER_RIDE ||
    raw.seatCount > MAX_SEATS_PER_RIDE
  ) {
    fields.seatCount = `Seats must be a whole number from ${MIN_SEATS_PER_RIDE} to ${MAX_SEATS_PER_RIDE}.`;
  }

  // Sharing defaults to ON when omitted; anything else must be a real boolean.
  if (raw.allowSharing !== undefined && typeof raw.allowSharing !== 'boolean') {
    fields.allowSharing = 'allowSharing must be true or false.';
  }

  if (Object.keys(fields).length > 0) return { fields };
  return {
    input: {
      pickupZone: raw.pickupZone as string,
      destinationZone: raw.destinationZone as string,
      seatCount: raw.seatCount as number,
      allowSharing: raw.allowSharing === undefined ? true : (raw.allowSharing as boolean),
    },
  };
}

/** Resolves the logged-in passenger from the token; writes the error response and returns null if not one. */
async function requirePassenger(req: AuthenticatedRequest, res: Response) {
  const passenger = req.user ? await User.findByPk(req.user.id) : null;
  if (!passenger) {
    res.status(401).json({ error: 'Passenger not found. Please log in again.' });
    return null;
  }
  if (passenger.role !== 'PASSENGER') {
    res.status(403).json({ error: 'Only passengers can request rides.' });
    return null;
  }
  return passenger;
}

// ---------------------------------------------------------------------------
// GET /ride-requests/zones
// The zone list for the request form. Served from here so the dropdown can
// never offer a zone the server would reject.
// ---------------------------------------------------------------------------
router.get('/zones', authenticateToken, (_req: Request, res: Response) => {
  res.json({ zones: DHAKA_ZONES, minSeats: MIN_SEATS_PER_RIDE, maxSeats: MAX_SEATS_PER_RIDE });
});

// ---------------------------------------------------------------------------
// GET /ride-requests/estimate?pickupZone=&destinationZone=&seatCount=&allowSharing=
// Fare preview shown while the passenger fills in the form. Nothing is saved.
// ---------------------------------------------------------------------------
router.get('/estimate', authenticateToken, (req: AuthenticatedRequest, res: Response) => {
  const { pickupZone, destinationZone, seatCount, allowSharing } = req.query;
  const result = validateRideInput({
    pickupZone,
    destinationZone,
    // Query values are strings; convert them here so the validator can stay strict.
    seatCount: typeof seatCount === 'string' && seatCount.trim() !== '' ? Number(seatCount) : undefined,
    allowSharing: allowSharing === 'true' ? true : allowSharing === 'false' ? false : allowSharing,
  });
  if ('fields' in result) {
    return res.status(400).json({ error: Object.values(result.fields)[0], code: 'VALIDATION', fields: result.fields });
  }

  // Whole taka. `fare` is the price riding alone; `tiers` is the (lower) price as 2 or 3
  // passengers share. A private ride has no tiers.
  res.json(
    estimateFare(
      result.input.pickupZone,
      result.input.destinationZone,
      result.input.seatCount,
      result.input.allowSharing
    )
  );
});

// ---------------------------------------------------------------------------
// POST /ride-requests
// Passenger creates a ride request (status REQUESTED).
//
// The passenger is identified by the login token, never by the request body, so
// nobody can book a ride in someone else's name. Name and phone stay on the account.
//
// Rules: valid zones, different zones, 1–3 seats, one active ride per passenger.
// Fare starts as the passenger's own base fare (riding alone); it drops when others join.
// ---------------------------------------------------------------------------
router.post('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const passenger = await requirePassenger(req, res);
    if (!passenger) return;

    const result = validateRideInput(req.body ?? {});
    if ('fields' in result) {
      return res.status(400).json({ error: Object.values(result.fields)[0], code: 'VALIDATION', fields: result.fields });
    }
    const { pickupZone, destinationZone, seatCount, allowSharing } = result.input;
    const soloFare = calculateBaseFare(pickupZone, destinationZone, seatCount);

    // Check + insert in one transaction. The partial unique index (see migrations.ts) is the
    // backstop if two requests from the same passenger race past the check.
    // IMMEDIATE takes the write lock up front. With the default (deferred) transaction two
    // simultaneous requests both read first and then deadlock on the insert (SQLITE_BUSY);
    // this way the second one waits, then sees the first ride and gets the 409.
    const rideRequest = await sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE }, async (t: any) => {
      const existing = await RideRequest.findOne({
        where: { passengerId: passenger.id, status: { [Op.in]: [...ACTIVE_RIDE_STATUSES] } },
        transaction: t,
      });
      if (existing) throw new Error('ACTIVE_RIDE_EXISTS');

      return RideRequest.create(
        {
          passengerId: passenger.id,
          pickupZone,
          destinationZone,
          seatCount,
          allowSharing,
          baseFare: soloFare,
          estimatedFare: soloFare,
          poolDiscount: 0,
          status: 'REQUESTED',
        },
        { transaction: t }
      );
    });

    res.status(201).json({ rideRequest: formatRide(rideRequest) });
  } catch (error: any) {
    if (error.message === 'ACTIVE_RIDE_EXISTS' || error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({
        error: 'You already have an active ride. Finish or cancel it before requesting another.',
        code: 'ACTIVE_RIDE_EXISTS',
      });
    }
    console.error('Create ride request error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /ride-requests/me
// Passenger views their own requests (all statuses).
// ---------------------------------------------------------------------------
router.get('/me', async (req: Request, res: Response) => {
  try {
    const passengerId = req.query.passengerId as string;
    if (!passengerId) {
      return res.status(400).json({ error: 'passengerId is required in query params.' });
    }

    const requests = await RideRequest.findAll({
      where: { passengerId },
      order: [['createdAt', 'DESC']],
    });

    res.json({ requests: requests.map(formatRide) });
  } catch (error) {
    console.error('Get ride requests error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /ride-requests/pending
//
// MATCHING RULE (documented):
//   A request is shown to a driver if ALL of the following hold:
//   1. status = REQUESTED (not yet accepted by anyone)
//   2. seatCount <= vehicle's available seats
//   3. If the vehicle already has an active pool (status in POOL_JOINABLE_STATUSES),
//      the new request's destinationZone must match the existing pool's destination
//      (exact zone match — see areZonesCompatible() in RideRequest.ts).
//      If the pool has already STARTED, no new passengers can join.
//   4. The new request's pickupZone must match the vehicle's current pool pickup zone
//      (if a pool exists).
//
// This keeps pooling simple and auditable without real routing.
// ---------------------------------------------------------------------------
router.get('/pending', async (req: Request, res: Response) => {
  try {
    const driverId = req.query.driverId as string;
    if (!driverId) return res.status(400).json({ error: 'driverId required' });

    const driver = await User.findByPk(driverId);
    if (!driver || driver.role !== 'DRIVER') {
      return res.status(403).json({ error: 'Invalid driver' });
    }

    const vehicle: any = await Vehicle.findOne({ where: { driverId, isActive: true } });
    if (!vehicle) return res.status(404).json({ error: 'No active vehicle found' });

    const availableSeats = vehicle.seatCapacity - vehicle.occupiedSeats;

    // Find current active rides on this vehicle to enforce pooling constraints
    const pooledRides: any[] = await RideRequest.findAll({
      where: {
        vehicleId: vehicle.id,
        status: { [Op.in]: [...POOL_JOINABLE_STATUSES] },
      },
    });

    // A vehicle carrying a private ride takes nobody else.
    if (pooledRides.some((r: any) => !r.allowSharing)) {
      return res.json({ requests: [] });
    }

    const whereClause: any = {
      status: 'REQUESTED',
      seatCount: { [Op.lte]: availableSeats },
    };

    if (pooledRides.length > 0) {
      // A pool is already running: only passengers who agreed to share can join it.
      whereClause.allowSharing = true;
      // Pool already exists — new passengers must have same destination
      const firstRide = pooledRides[0]!;
      whereClause.pickupZone = firstRide.pickupZone;
      whereClause.destinationZone = firstRide.destinationZone;
    }

    const pendingRequests: any[] = await RideRequest.findAll({
      where: whereClause,
      order: [['createdAt', 'ASC']],
    });

    res.json({ requests: pendingRequests.map(formatRide) });
  } catch (error) {
    console.error('Get pending requests error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /ride-requests/:id/accept
//
// Driver accepts a pending request. The ride is added to the driver's pool
// on their active vehicle.
//
// POOLING LOGIC:
//   - If the vehicle has no active rides: accept freely (first in pool).
//   - If the vehicle has active rides (pool exists):
//       • Ensure the new request's pickup and destination match the pool
//         (same rules as GET /pending).
//       • Ensure pool is not yet STARTED (no new joiners after trip starts).
//   - After accepting, recalculate ALL pool fares:
//       • 2+ passengers → apply POOL_DISCOUNT to everyone
//       • 1 passenger   → no discount
//
// CONCURRENCY:
//   We use a Sequelize transaction with a conditional atomic UPDATE on the
//   Vehicle row. The WHERE clause for the seat increment includes a constraint
//   `seatCapacity >= occupiedSeats + seatCount`. SQLite evaluates this
//   atomically during the UPDATE. If the constraint fails (capacity full),
//   `updatedCount` is 0 and we throw CAPACITY_EXCEEDED, rolling back the
//   transaction. A second concurrent request that passes the constraint check
//   but arrives after the first committed will see `updatedCount = 0` too
//   because the arithmetic no longer satisfies the constraint.
// ---------------------------------------------------------------------------
router.post('/:id/accept', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { driverId } = req.body;

    if (!driverId) return res.status(400).json({ error: 'driverId required' });

    const driver = await User.findByPk(driverId);
    if (!driver || driver.role !== 'DRIVER') {
      return res.status(403).json({ error: 'Only drivers can accept rides.' });
    }

    const vehicle: any = await Vehicle.findOne({ where: { driverId, isActive: true } });
    if (!vehicle) return res.status(404).json({ error: 'No active vehicle found' });

    const rideReq: any = await RideRequest.findByPk(id);
    if (!rideReq || rideReq.status !== 'REQUESTED') {
      return res.status(400).json({ error: 'Request not found or not in REQUESTED state.' });
    }

    // Check pool compatibility if vehicle already has active rides
    const pooledRides: any[] = await RideRequest.findAll({
      where: {
        vehicleId: vehicle.id,
        status: { [Op.in]: [...POOL_JOINABLE_STATUSES] },
      },
    });

    // Private rides: a private passenger needs an empty vehicle, and a vehicle
    // carrying a private ride takes nobody else.
    if (!rideReq.allowSharing && pooledRides.length > 0) {
      return res.status(409).json({
        error: 'This is a private ride request: it needs a vehicle with no other passengers.',
      });
    }
    if (pooledRides.some((r: any) => !r.allowSharing)) {
      return res.status(409).json({
        error: 'Cannot add a passenger: this vehicle is carrying a private ride.',
      });
    }

    if (pooledRides.length > 0) {
      const firstRide = pooledRides[0]!;

      // Rule: no new passengers once trip has started
      const hasStarted = pooledRides.some((r: any) => r.status === 'STARTED');
      if (hasStarted) {
        return res.status(409).json({
          error: 'Cannot add a new passenger: the trip has already started.',
        });
      }

      // Rule: pickup zone must match
      if (rideReq.pickupZone !== firstRide.pickupZone) {
        return res.status(409).json({
          error: `Pool incompatible: pickup zone must be ${firstRide.pickupZone} to join this pool.`,
        });
      }

      // Rule: destination must be compatible (same zone)
      if (!areZonesCompatible(firstRide.destinationZone, rideReq.destinationZone)) {
        return res.status(409).json({
          error: `Pool incompatible: destination zone must be ${firstRide.destinationZone} to join this pool.`,
        });
      }
    }

    await sequelize.transaction(async (t: any) => {
      // ── STEP 1: Atomic seat reservation ────────────────────────────────
      // Increment occupiedSeats only if seatCapacity >= occupiedSeats + seatCount.
      // This is the concurrency guard: two simultaneous requests race here;
      // the losing one sees updatedCount=0 and gets CAPACITY_EXCEEDED.
      const [updatedCount] = await Vehicle.update(
        { occupiedSeats: sequelize.literal(`occupiedSeats + ${rideReq.seatCount}`) },
        {
          where: {
            id: vehicle.id,
            seatCapacity: {
              [Op.gte]: sequelize.literal(`occupiedSeats + ${rideReq.seatCount}`),
            },
          },
          transaction: t,
        }
      );

      if (updatedCount === 0) {
        throw new Error('CAPACITY_EXCEEDED');
      }

      // Re-check the private-ride rule now that this transaction holds the write lock:
      // two accepts (a private and a shared one) could otherwise slip past the check
      // above at the same time.
      const onVehicle: any[] = await RideRequest.findAll({
        where: { vehicleId: vehicle.id, status: { [Op.in]: [...POOL_JOINABLE_STATUSES] } },
        transaction: t,
      });
      if (onVehicle.some((r: any) => !r.allowSharing) || (!rideReq.allowSharing && onVehicle.length > 0)) {
        throw new Error('PRIVATE_CONFLICT');
      }

      // ── STEP 2: Atomically transition the ride to MATCHED ───────────────
      // WHERE status='REQUESTED' prevents double-acceptance by two drivers.
      const [reqUpdatedCount] = await RideRequest.update(
        {
          status: 'MATCHED',
          vehicleId: vehicle.id,
          driverId,
        },
        {
          where: { id: rideReq.id, status: 'REQUESTED' },
          transaction: t,
        }
      );

      if (reqUpdatedCount === 0) {
        throw new Error('ALREADY_TAKEN');
      }

      // ── STEP 3: Recalculate pool fares for ALL passengers ───────────────
      // Now that this ride is MATCHED (vehicleId is set), the pool has grown.
      // Every current passenger is re-priced from their own base fare (70% each for 2
      // passengers, 55% for 3); rides that have already STARTED keep their locked fare.
      await recalculatePoolFares(vehicle.id, t);
    });

    // Return the updated ride so the caller can see the new fare
    const updated = await RideRequest.findByPk(id);
    res.json({
      message: 'Ride accepted and added to pool successfully.',
      rideRequest: formatRide(updated!.toJSON()),
    });
  } catch (error: any) {
    console.error('Accept ride error:', error);
    if (error.message === 'CAPACITY_EXCEEDED') {
      return res.status(409).json({ error: 'Not enough seats available.' });
    }
    if (error.message === 'PRIVATE_CONFLICT') {
      return res.status(409).json({ error: 'Private rides cannot be pooled with other passengers.' });
    }
    if (error.message === 'ALREADY_TAKEN') {
      return res.status(409).json({ error: 'Ride request was already accepted.' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /ride-requests/:id/pool-info
// Returns the pool summary for a matched ride: co-passengers count (no PII),
// and how much of their own fare each passenger pays (the share rate).
// ---------------------------------------------------------------------------
router.get('/:id/pool-info', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const passengerId = req.query.passengerId as string;

    const ride: any = await RideRequest.findByPk(id);
    if (!ride) return res.status(404).json({ error: 'Ride not found.' });
    if (ride.passengerId !== passengerId) {
      return res.status(404).json({ error: 'Ride not found.' }); // no enumeration
    }

    if (!ride.vehicleId) {
      // Not yet matched — no pool info
      return res.json({ poolSize: 1, coPassengers: 0, shareRatePercent: 100, poolDiscountApplied: false });
    }

    const poolRides: any[] = await RideRequest.findAll({
      where: {
        vehicleId: ride.vehicleId,
        status: { [Op.notIn]: ['CANCELLED', 'COMPLETED'] },
      },
    });

    const poolSize = poolRides.length;

    res.json({
      poolSize,
      coPassengers: poolSize - 1,
      shareRatePercent: shareRatePercent(poolSize, ride.allowSharing),
      poolDiscountApplied: ride.poolDiscount > 0,
    });
  } catch (error) {
    console.error('Pool info error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { recalculatePoolFares };
export default router;
