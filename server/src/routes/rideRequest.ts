import { Router, Request, Response } from 'express';
import { Op, Transaction } from 'sequelize';
import { sequelize, User, RideRequest, Vehicle } from '../models';
import {
  ACTIVE_RIDE_STATUSES,
  DHAKA_ZONES,
  MAX_SEATS_PER_RIDE,
  MIN_SEATS_PER_RIDE,
  POOL_JOINABLE_STATUSES,
} from '../models/RideRequest';
import { calculateBaseFare, estimateFare, shareRatePercent } from '../utils/fareCalculator';
import { isFareLocked, recalculatePoolFares } from '../utils/poolFares';
import { checkPoolJoin, PoolVerdict } from '../utils/pooling';
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
// MATCHING RULE (documented; see README "Direction-aware pool matching"):
//   A request is shown to a driver if ALL of the following hold:
//   1. status = REQUESTED (not yet accepted by anyone)
//   2. seatCount <= the vehicle's available seats
//   3. checkPoolJoin() accepts it for the rides already on the vehicle (MATCHED, DRIVER_ARRIVED or
//      STARTED): private rides are never mixed, and the route must run the same way as EVERY ride
//      in the pool (utils/routeDirection.ts). An empty vehicle accepts any route.
//
// A ride that has already STARTED does not close the pool: compatible requests keep showing up so
// the driver can add someone mid-trip. `midTrip` tells the caller that is the case.
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

    // Rides currently on this vehicle: they decide who else can join.
    const pool: any[] = await RideRequest.findAll({
      where: {
        vehicleId: vehicle.id,
        status: { [Op.in]: [...POOL_JOINABLE_STATUSES] },
      },
    });
    const midTrip = pool.some((r: any) => r.status === 'STARTED');

    const candidates: any[] = await RideRequest.findAll({
      where: { status: 'REQUESTED', seatCount: { [Op.lte]: availableSeats } },
      order: [['createdAt', 'ASC']],
    });
    const compatible = candidates.filter((c: any) => checkPoolJoin(pool, c).ok);

    res.json({
      requests: compatible.map((r: any) => ({ ...formatRide(r), joinsMidTrip: midTrip })),
      midTrip,
      availableSeats,
    });
  } catch (error) {
    console.error('Get pending requests error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /ride-requests/:id/accept
//
// Driver accepts a pending request. The ride is added to the driver's pool on their active vehicle.
// This is the ONLY way a passenger joins a pool, before the trip or in the middle of it.
//
// POOLING LOGIC (all inside one transaction, so it sees the pool exactly as it is when it commits):
//   - checkPoolJoin(): private rides are never mixed, and the request's route must run the same way
//     as every ride already on the vehicle. A STARTED ride does not block joining.
//   - the seat claim below: capacity can never be exceeded, even by simultaneous accepts.
//   - after accepting, every passenger who is not yet STARTED is re-priced (see utils/poolFares.ts).
//
// CONCURRENCY:
//   The transaction is IMMEDIATE: it takes SQLite's write lock up front, so two accepts for the same
//   vehicle run one after the other, and the second one re-reads the pool the first one left.
//   The seat claim is an atomic conditional UPDATE on the Vehicle row: occupiedSeats is incremented
//   only where seatCapacity >= occupiedSeats + seatCount. If it changes no row, capacity was
//   exceeded and CAPACITY_EXCEEDED rolls everything back.
// ---------------------------------------------------------------------------
class PoolRejected extends Error {
  constructor(public verdict: Extract<PoolVerdict, { ok: false }>) {
    super(verdict.code);
  }
}

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

    await sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE }, async (t: any) => {
      // ── STEP 1: Who is on the vehicle right now, and may this passenger join them? ──
      const pool: any[] = await RideRequest.findAll({
        where: { vehicleId: vehicle.id, status: { [Op.in]: [...POOL_JOINABLE_STATUSES] } },
        transaction: t,
      });
      const candidate: any = await RideRequest.findOne({ where: { id: rideReq.id, status: 'REQUESTED' }, transaction: t });
      if (!candidate) throw new Error('ALREADY_TAKEN');

      const verdict = checkPoolJoin(pool, candidate);
      if (!verdict.ok) throw new PoolRejected(verdict);

      // ── STEP 2: Atomic seat reservation ────────────────────────────────
      // Increment occupiedSeats only if seatCapacity >= occupiedSeats + seatCount.
      const [updatedCount] = await Vehicle.update(
        { occupiedSeats: sequelize.literal(`occupiedSeats + ${candidate.seatCount}`) },
        {
          where: {
            id: vehicle.id,
            seatCapacity: {
              [Op.gte]: sequelize.literal(`occupiedSeats + ${candidate.seatCount}`),
            },
          },
          transaction: t,
        }
      );

      if (updatedCount === 0) {
        throw new Error('CAPACITY_EXCEEDED');
      }

      // ── STEP 3: Atomically transition the ride to MATCHED ───────────────
      // WHERE status='REQUESTED' prevents double-acceptance by two drivers.
      const [reqUpdatedCount] = await RideRequest.update(
        {
          status: 'MATCHED',
          vehicleId: vehicle.id,
          driverId,
        },
        {
          where: { id: candidate.id, status: 'REQUESTED' },
          transaction: t,
        }
      );

      if (reqUpdatedCount === 0) {
        throw new Error('ALREADY_TAKEN');
      }

      // ── STEP 4: Recalculate pool fares ──────────────────────────────────
      // Now that this ride is MATCHED (vehicleId is set), the pool has grown. Everyone who has not
      // started is re-priced from their own base fare (70% each for 2 passengers, 55% for 3);
      // rides that have already STARTED keep their locked fare.
      await recalculatePoolFares(vehicle.id, t);
    });

    // Return the updated ride so the caller can see the new fare
    const updated = await RideRequest.findByPk(id);
    res.json({
      message: 'Ride accepted and added to pool successfully.',
      rideRequest: formatRide(updated!.toJSON()),
    });
  } catch (error: any) {
    if (error instanceof PoolRejected) {
      return res.status(409).json({ error: error.verdict.message, code: error.verdict.code });
    }
    if (error.message === 'CAPACITY_EXCEEDED') {
      return res.status(409).json({ error: 'Not enough seats available.' });
    }
    if (error.message === 'ALREADY_TAKEN') {
      return res.status(409).json({ error: 'Ride request was already accepted.' });
    }
    console.error('Accept ride error:', error);
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
