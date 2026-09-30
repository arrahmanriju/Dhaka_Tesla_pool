import { Router, Request, Response } from 'express';
import { Op, Transaction } from 'sequelize';
import { sequelize, User, RideRequest, Vehicle, RideDecline } from '../models';
import {
  ACTIVE_RIDE_STATUSES,
  DHAKA_ZONES,
  MAX_SEATS_PER_RIDE,
  MIN_SEATS_PER_RIDE,
  POOL_JOINABLE_STATUSES,
  TERMINAL_STATUSES,
} from '../models/RideRequest';
import { calculateBaseFare, estimateFare } from '../utils/fareCalculator';
import { nextPoolNumber, passengerLabel } from '../utils/passengerLabels';
import { isFareFinal, recalculatePoolFares } from '../utils/poolFares';
import { checkPoolJoin, loadPool, PoolVerdict } from '../utils/pooling';
import { recordRideEvent } from '../utils/rideEvents';
import { claimSeats } from '../utils/seats';
import { DEFAULT_PAYMENT_METHOD, PAYMENT_METHODS, PaymentMethod, isPaymentMethod } from '../utils/payments';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// ---------------------------------------------------------------------------
// HELPER: format a RideRequest for the API response
// ---------------------------------------------------------------------------
function formatRide(r: any) {
  return {
    id: r.id,
    // Never the passenger's user id, and never their name: a driver sees "Passenger N" (null until accepted)
    passengerLabel: passengerLabel(r.poolNumber),
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
    // true once the passenger's own journey has ended (COMPLETED or CANCELLED_IN_TRANSIT): only then is
    // estimatedFare the final amount. Until then it is an estimate that follows the pool.
    fareFinal: isFareFinal(r.status),
    // Payment: how this ride is paid, and (once the journey has ended) what was owed or charged.
    // Never a wallet balance: that is only ever returned to the passenger themselves.
    paymentMethod: r.paymentMethod,
    paymentStatus: r.paymentStatus,
    paymentAmount: r.paymentAmount ?? null,
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
  paymentMethod: PaymentMethod;
};

function validateRideInput(raw: {
  pickupZone?: unknown;
  destinationZone?: unknown;
  seatCount?: unknown;
  allowSharing?: unknown;
  paymentMethod?: unknown;
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

  // Payment defaults to cash when omitted; anything else must be one of the two methods.
  if (raw.paymentMethod !== undefined && !isPaymentMethod(raw.paymentMethod)) {
    fields.paymentMethod = `Choose a payment method: ${PAYMENT_METHODS.join(' or ')}.`;
  }

  if (Object.keys(fields).length > 0) return { fields };
  return {
    input: {
      pickupZone: raw.pickupZone as string,
      destinationZone: raw.destinationZone as string,
      seatCount: raw.seatCount as number,
      allowSharing: raw.allowSharing === undefined ? true : (raw.allowSharing as boolean),
      paymentMethod: raw.paymentMethod === undefined ? DEFAULT_PAYMENT_METHOD : (raw.paymentMethod as PaymentMethod),
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
    const { pickupZone, destinationZone, seatCount, allowSharing, paymentMethod } = result.input;
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

      const created = await RideRequest.create(
        {
          passengerId: passenger.id,
          pickupZone,
          destinationZone,
          seatCount,
          allowSharing,
          paymentMethod,
          baseFare: soloFare,
          estimatedFare: soloFare,
          poolDiscount: 0,
          status: 'REQUESTED',
        },
        { transaction: t }
      );
      await recordRideEvent(created, 'REQUESTED', null, { id: passenger.id, role: 'PASSENGER' }, t);
      return created;
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
router.get('/me', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    // The caller is the logged-in passenger; a passengerId that is not theirs is refused.
    if (req.user!.role !== 'PASSENGER') return res.status(403).json({ error: 'Only passengers can view their requests.' });
    const passengerId = req.user!.id;
    const claimed = req.query.passengerId;
    if (typeof claimed === 'string' && claimed !== passengerId) {
      return res.status(403).json({ error: 'You can only access your own rides.' });
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
//   3. this driver has not declined it
//   4. checkPoolJoin() accepts it for the rides already on the vehicle (MATCHED, DRIVER_ARRIVED or
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
    const pool = await loadPool(vehicle.id);
    const midTrip = pool.some((r) => r.status === 'STARTED');

    // Requests this driver has already declined never come back to them.
    const declined = await RideDecline.findAll({ where: { driverId }, attributes: ['rideRequestId'] });
    const declinedIds = declined.map((d: any) => d.rideRequestId as string);

    const candidates: any[] = await RideRequest.findAll({
      where: {
        status: 'REQUESTED',
        seatCount: { [Op.lte]: availableSeats },
        ...(declinedIds.length > 0 ? { id: { [Op.notIn]: declinedIds } } : {}),
      },
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
      const pool = await loadPool(vehicle.id, t);
      const candidate: any = await RideRequest.findOne({ where: { id: rideReq.id, status: 'REQUESTED' }, transaction: t });
      if (!candidate) throw new Error('ALREADY_TAKEN');

      const verdict = checkPoolJoin(pool, candidate);
      if (!verdict.ok) throw new PoolRejected(verdict);

      // ── STEP 2: Atomic seat reservation ────────────────────────────────
      // One conditional UPDATE (utils/seats.ts, shared with the QR street-ride flow): seats are taken
      // only where seatCapacity >= occupiedSeats + seatCount.
      if (!(await claimSeats(vehicle.id, candidate.seatCount, t))) {
        throw new Error('CAPACITY_EXCEEDED');
      }

      // (A PRIVATE ride only got this far on an empty vehicle: checkPoolJoin refuses it anywhere else, so
      // there is no pooling, route or multi-passenger logic for it. The seat claim above is its baseline
      // capacity check: the vehicle must have room for the seats it asked for.)

      // ── STEP 3: Atomically transition the ride to MATCHED ───────────────
      // WHERE status='REQUESTED' prevents double-acceptance by two drivers.
      // "Passenger N": the next number in this car (utils/passengerLabels.ts), fixed for the ride's lifetime.
      const poolNumber = await nextPoolNumber(vehicle.id, t);
      const [reqUpdatedCount] = await RideRequest.update(
        {
          status: 'MATCHED',
          vehicleId: vehicle.id,
          driverId,
          poolNumber,
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
      // started is re-estimated (trip cost / riders + the driver bonus, for the pool); rides that are on
      // board are re-estimated from the pool's checkpoints. Only finished rides are settled and final.
      await recalculatePoolFares(vehicle.id, t);

      // ── STEP 5: History. `ridersOnboard` > 0 on this event means the passenger joined mid-trip. ──
      await recordRideEvent({ ...candidate.toJSON(), vehicleId: vehicle.id }, 'MATCHED', 'REQUESTED', { id: driverId, role: 'DRIVER' }, t);
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
// POST /ride-requests/:id/decline   (driver login required)
//
// The driver dismisses a pending request. It stays REQUESTED for every other driver and stops
// appearing in this driver's pending list. Declining twice is fine. A request that is no longer
// REQUESTED (already taken or cancelled) gets 409.
// ---------------------------------------------------------------------------
router.post('/:id/decline', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    if (req.user!.role !== 'DRIVER') return res.status(403).json({ error: 'Only drivers can decline rides.' });
    const driverId = req.user!.id;
    const claimed = req.body?.driverId;
    if (typeof claimed === 'string' && claimed !== driverId) {
      return res.status(403).json({ error: 'You can only decline as yourself.' });
    }

    const rideReq: any = await RideRequest.findByPk(id);
    if (!rideReq) return res.status(404).json({ error: 'Ride request not found.' });
    if (rideReq.status !== 'REQUESTED') {
      return res.status(409).json({ error: 'This request is no longer waiting for a driver.' });
    }

    await RideDecline.findOrCreate({ where: { rideRequestId: id, driverId } });
    res.json({ message: 'Request declined.', rideId: id });
  } catch (error) {
    console.error('Decline ride error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /ride-requests/:id/pool-info
// Returns the pool summary for a matched ride: co-passengers count (no PII),
// and whether they are saving anything by sharing.
// ---------------------------------------------------------------------------
router.get('/:id/pool-info', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const passengerId = req.user!.id; // the logged-in passenger, never an id from the query

    const ride: any = await RideRequest.findByPk(id);
    if (!ride) return res.status(404).json({ error: 'Ride not found.' });
    if (ride.passengerId !== passengerId) {
      return res.status(404).json({ error: 'Ride not found.' }); // no enumeration
    }

    if (!ride.vehicleId) {
      // Not yet matched — no pool info
      return res.json({ poolSize: 1, coPassengers: 0, poolDiscountApplied: false });
    }

    const poolRides: any[] = await RideRequest.findAll({
      where: {
        vehicleId: ride.vehicleId,
        status: { [Op.notIn]: [...TERMINAL_STATUSES] },
      },
    });

    const poolSize = poolRides.length;

    res.json({
      poolSize,
      coPassengers: poolSize - 1,
      poolDiscountApplied: ride.poolDiscount > 0,
    });
  } catch (error) {
    console.error('Pool info error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { recalculatePoolFares };
export default router;
