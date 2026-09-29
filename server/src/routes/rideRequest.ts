import { Router, Request, Response } from 'express';
import { Op } from 'sequelize';
import { User, RideRequest, Vehicle } from '../models';
import {
  DHAKA_ZONES,
  POOL_JOINABLE_STATUSES,
  areZonesCompatible,
} from '../models/RideRequest';
import {
  calculateFareForPassenger,
  calculateEstimatedFare,
  POOL_DISCOUNT_BDT,
} from '../utils/fareCalculator';

const router = Router();

// ---------------------------------------------------------------------------
// HELPER: recalculatePoolFares
//
// Call this inside a transaction whenever the number of active passengers in
// a pool changes (second passenger joins, or a passenger cancels).
//
// poolSize = the NEW number of distinct passengers still in the pool.
//
// POOL DISCOUNT RULE:
//   poolSize >= 2  → discount = POOL_DISCOUNT_BDT × 100 paisa per passenger
//   poolSize == 1  → discount = 0 (back to full fare)
//
// We update every ACTIVE (non-terminal) ride in the pool so they all see
// the same discount decision.
// ---------------------------------------------------------------------------
async function recalculatePoolFares(
  vehicleId: string,
  sequelizeInstance: any,
  transaction: any
): Promise<void> {
  // All non-cancelled, non-completed rides on this vehicle
  const activeRides: any[] = await RideRequest.findAll({
    where: {
      vehicleId,
      status: { [Op.notIn]: ['CANCELLED', 'COMPLETED'] },
    },
    transaction,
  });

  const poolSize = activeRides.length;

  for (const ride of activeRides) {
    const newFare = calculateFareForPassenger(
      ride.pickupZone,
      ride.destinationZone,
      ride.seatCount,
      poolSize
    );
    const newDiscount = poolSize >= 2 ? POOL_DISCOUNT_BDT * 100 : 0;

    await RideRequest.update(
      { estimatedFare: newFare, poolDiscount: newDiscount },
      { where: { id: ride.id }, transaction }
    );
  }
}

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
    baseFare: r.baseFare,
    estimatedFare: r.estimatedFare,
    estimatedFareBDT: (r.estimatedFare / 100).toFixed(2),
    poolDiscount: r.poolDiscount,
    poolDiscountBDT: (r.poolDiscount / 100).toFixed(2),
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// POST /ride-requests
// Passenger creates a ride request.
//
// Fare is calculated with poolSize=1 (solo). It will be recalculated
// downward when a second passenger joins the same pool.
// ---------------------------------------------------------------------------
router.post('/', async (req: Request, res: Response) => {
  try {
    const { passengerId, pickupZone, destinationZone, seatCount } = req.body;

    if (!passengerId || !pickupZone || !destinationZone || !seatCount) {
      return res.status(400).json({
        error: 'passengerId, pickupZone, destinationZone, and seatCount are required.',
      });
    }

    if (!DHAKA_ZONES.includes(pickupZone) || !DHAKA_ZONES.includes(destinationZone)) {
      return res.status(400).json({ error: `Zones must be one of: ${DHAKA_ZONES.join(', ')}` });
    }

    if (!Number.isInteger(seatCount) || seatCount < 1) {
      return res.status(400).json({ error: 'seatCount must be a positive integer.' });
    }

    if (pickupZone === destinationZone) {
      return res.status(400).json({ error: 'Pickup and destination zones cannot be the same.' });
    }

    const passenger = await User.findByPk(passengerId);
    if (!passenger) {
      return res.status(401).json({ error: 'Passenger not found. Please log in again.' });
    }
    if (passenger.role !== 'PASSENGER') {
      return res.status(403).json({ error: 'User is not a passenger.' });
    }

    // Fare at creation time: no pool yet (poolSize = 1, no discount)
    const soloFare = calculateEstimatedFare(pickupZone, destinationZone, seatCount);

    const rideRequest = await RideRequest.create({
      passengerId,
      pickupZone,
      destinationZone,
      seatCount,
      baseFare: soloFare,
      estimatedFare: soloFare,
      poolDiscount: 0,
    });

    res.status(201).json({ rideRequest: formatRide(rideRequest) });
  } catch (error) {
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

    const whereClause: any = {
      status: 'REQUESTED',
      seatCount: { [Op.lte]: availableSeats },
    };

    if (pooledRides.length > 0) {
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

    const { sequelize } = require('../models/index');

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
      // recalculatePoolFares() counts all non-terminal rides on the vehicle
      // and applies/removes the pool discount accordingly.
      await recalculatePoolFares(vehicle.id, sequelize, t);
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
    if (error.message === 'ALREADY_TAKEN') {
      return res.status(409).json({ error: 'Ride request was already accepted.' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /ride-requests/:id/pool-info
// Returns the pool summary for a matched ride: co-passengers count (no PII),
// and whether a pool discount is being applied.
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
      return res.json({ poolSize: 1, coPassengers: 0, poolDiscountApplied: false });
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
      poolDiscountApplied: poolSize >= 2,
    });
  } catch (error) {
    console.error('Pool info error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { recalculatePoolFares };
export default router;
