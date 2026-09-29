import { Router, Request, Response } from 'express';
import { User, RideRequest, Vehicle } from '../models';
import { validateTransition, RideStatus } from '../models/RideRequest';

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
  if (!passenger || passenger.role !== 'PASSENGER') {
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
// GET /passenger/rides/active?passengerId=...
// Passenger tracks live status of their current (non-terminal) ride(s).
// Returns the ride status, vehicle info if matched, and estimated fare.
// ---------------------------------------------------------------------------
router.get('/rides/active', async (req: Request, res: Response) => {
  try {
    const passengerId = req.query.passengerId as string;
    const passenger = await resolvePassenger(passengerId, res);
    if (!passenger) return;

    const activeRides = await RideRequest.findAll({
      where: {
        passengerId,
        status: ['REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED'],
      },
      order: [['createdAt', 'DESC']],
    });

    // Enrich with vehicle details if the ride has been matched
    const enriched = await Promise.all(
      activeRides.map(async (ride: any) => {
        let vehicleInfo = null;
        if (ride.vehicleId) {
          const vehicle: any = await Vehicle.findByPk(ride.vehicleId, {
            attributes: ['id', 'modelName', 'licensePlate', 'seatCapacity'],
          });
          vehicleInfo = vehicle ? vehicle.toJSON() : null;
        }

        return {
          id: ride.id,
          pickupZone: ride.pickupZone,
          destinationZone: ride.destinationZone,
          seatCount: ride.seatCount,
          estimatedFare: ride.estimatedFare,
          estimatedFareBDT: (ride.estimatedFare / 100).toFixed(2),
          status: ride.status,
          vehicle: vehicleInfo,
          canCancel: PASSENGER_CANCELLABLE.includes(ride.status as RideStatus),
          createdAt: ride.createdAt,
          updatedAt: ride.updatedAt,
        };
      })
    );

    res.json({ rides: enriched });
  } catch (error) {
    console.error('Passenger active rides error:', error);
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

    let vehicleInfo = null;
    if (ride.vehicleId) {
      const vehicle: any = await Vehicle.findByPk(ride.vehicleId, {
        attributes: ['id', 'modelName', 'licensePlate', 'seatCapacity'],
      });
      vehicleInfo = vehicle ? vehicle.toJSON() : null;
    }

    res.json({
      ride: {
        id: ride.id,
        pickupZone: ride.pickupZone,
        destinationZone: ride.destinationZone,
        seatCount: ride.seatCount,
        estimatedFare: ride.estimatedFare,
        estimatedFareBDT: (ride.estimatedFare / 100).toFixed(2),
        status: ride.status,
        vehicle: vehicleInfo,
        canCancel: PASSENGER_CANCELLABLE.includes(ride.status as RideStatus),
        createdAt: ride.createdAt,
        updatedAt: ride.updatedAt,
      },
    });
  } catch (error) {
    console.error('Passenger get ride error:', error);
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
        status: ['COMPLETED', 'CANCELLED'],
      },
      order: [['updatedAt', 'DESC']],
    });

    res.json({
      rides: history.map((r: any) => ({
        id: r.id,
        pickupZone: r.pickupZone,
        destinationZone: r.destinationZone,
        seatCount: r.seatCount,
        estimatedFare: r.estimatedFare,
        estimatedFareBDT: (r.estimatedFare / 100).toFixed(2),
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
// PATCH /passenger/rides/:id/cancel
// Passenger cancels their own ride.
// Only allowed in REQUESTED or MATCHED states (see rationale at top of file).
// A 404 is returned for rides belonging to other passengers (no enumeration).
// ---------------------------------------------------------------------------
router.patch('/rides/:id/cancel', async (req: Request, res: Response) => {
  try {
    const rideId = req.params.id as string;
    const { passengerId } = req.body;

    const passenger = await resolvePassenger(passengerId, res);
    if (!passenger) return;

    const ride: any = await findOwnedRide(rideId, passengerId, res);
    if (!ride) return;

    // State-machine guard — use the same validateTransition as driver routes
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
      await RideRequest.update(
        { status: 'CANCELLED' },
        { where: { id: rideId, passengerId }, transaction: t }
      );

      // If already matched to a vehicle, release the reserved seats
      if (ride.vehicleId) {
        await Vehicle.update(
          { occupiedSeats: sequelize.literal(`MAX(0, occupiedSeats - ${ride.seatCount})`) },
          { where: { id: ride.vehicleId }, transaction: t }
        );
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
