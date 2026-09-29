import { Router, Request, Response } from 'express';
import { Op } from 'sequelize';
import { User, Vehicle, RideRequest, DriverProfile } from '../models';
import { validateTransition, RideStatus } from '../models/RideRequest';

const router = Router();

// Endpoint to toggle driver's online/offline status
router.put('/:id/status', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { isOnline } = req.body;

    if (typeof isOnline !== 'boolean') {
      return res.status(400).json({ error: 'isOnline must be a boolean.' });
    }

    const user = await User.findByPk(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (user.role !== 'DRIVER') {
      return res.status(403).json({ error: 'Only drivers can update their status.' });
    }

    // A driver must finish onboarding (vehicle, NID, home zone) before going online.
    // Going offline is always allowed.
    if (isOnline && !(await DriverProfile.findOne({ where: { userId: user.id } }))) {
      return res.status(403).json({
        error: 'Complete driver onboarding before going online.',
        code: 'ONBOARDING_REQUIRED',
      });
    }

    user.isOnline = isOnline;
    await user.save();

    res.json({ message: 'Status updated successfully.', isOnline: user.isOnline });
  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Helper: resolve driverId and verify the caller is a DRIVER
// ---------------------------------------------------------------------------
async function resolveDriver(driverId: string | undefined, res: Response) {
  if (!driverId) {
    res.status(400).json({ error: 'driverId is required.' });
    return null;
  }
  const driver = await User.findByPk(driverId);
  if (!driver) {
    res.status(401).json({ error: 'Driver not found. Please log in again.' });
    return null;
  }
  if (driver.role !== 'DRIVER') {
    res.status(403).json({ error: 'Only drivers can perform this action.' });
    return null;
  }
  return driver;
}

// ---------------------------------------------------------------------------
// Helper: advance a ride to the next status, enforcing the state machine.
// Checks that the ride is assigned to *this* driver before allowing the move.
// ---------------------------------------------------------------------------
async function advanceRide(
  req: Request,
  res: Response,
  targetStatus: RideStatus
): Promise<void> {
  const rideId = req.params.id as string;
  const { driverId } = req.body;

  const driver = await resolveDriver(driverId, res);
  if (!driver) return;

  const ride: any = await RideRequest.findByPk(rideId);
  if (!ride) {
    res.status(404).json({ error: 'Ride not found.' });
    return;
  }

  // Authorisation: only the assigned driver may move this ride
  if (ride.driverId !== driverId) {
    res.status(403).json({ error: 'This ride is not assigned to you.' });
    return;
  }

  // State machine guard
  const err = validateTransition(ride.status as RideStatus, targetStatus);
  if (err) {
    res.status(409).json({ error: err });
    return;
  }

  await RideRequest.update(
    { status: targetStatus },
    { where: { id: rideId } }
  );

  res.json({ message: `Ride status updated to ${targetStatus}.`, rideId, status: targetStatus });
}

// ---------------------------------------------------------------------------
// PATCH /driver/rides/:id/arrive
// Transition: MATCHED → DRIVER_ARRIVED
// ---------------------------------------------------------------------------
router.patch('/rides/:id/arrive', async (req: Request, res: Response) => {
  return advanceRide(req, res, 'DRIVER_ARRIVED');
});

// ---------------------------------------------------------------------------
// PATCH /driver/rides/:id/start
// Transition: DRIVER_ARRIVED → STARTED
// ---------------------------------------------------------------------------
router.patch('/rides/:id/start', async (req: Request, res: Response) => {
  return advanceRide(req, res, 'STARTED');
});

// ---------------------------------------------------------------------------
// PATCH /driver/rides/:id/complete
// Transition: STARTED → COMPLETED
// Releases the seat count back on the vehicle once all passengers are done.
// ---------------------------------------------------------------------------
router.patch('/rides/:id/complete', async (req: Request, res: Response) => {
  const rideId = req.params.id as string;
  const { driverId } = req.body;

  try {
    const driver = await resolveDriver(driverId, res);
    if (!driver) return;

    const ride: any = await RideRequest.findByPk(rideId);
    if (!ride) { res.status(404).json({ error: 'Ride not found.' }); return; }
    if (ride.driverId !== driverId) { res.status(403).json({ error: 'This ride is not assigned to you.' }); return; }

    const err = validateTransition(ride.status as RideStatus, 'COMPLETED');
    if (err) { res.status(409).json({ error: err }); return; }

    const { sequelize } = require('../models/index');

    await sequelize.transaction(async (t: any) => {
      await RideRequest.update(
        { status: 'COMPLETED' },
        { where: { id: rideId }, transaction: t }
      );

      // Free up the seats on the vehicle
      if (ride.vehicleId) {
        await Vehicle.update(
          { occupiedSeats: sequelize.literal(`MAX(0, occupiedSeats - ${ride.seatCount})`) },
          { where: { id: ride.vehicleId }, transaction: t }
        );
      }
    });

    res.json({ message: 'Ride completed.', rideId, status: 'COMPLETED' });
  } catch (error) {
    console.error('Complete ride error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /driver/rides/:id/cancel
// Transition: REQUESTED | MATCHED | DRIVER_ARRIVED → CANCELLED
// Also releases seats if already matched.
// ---------------------------------------------------------------------------
router.patch('/rides/:id/cancel', async (req: Request, res: Response) => {
  const rideId = req.params.id as string;
  const { driverId } = req.body;

  try {
    const driver = await resolveDriver(driverId, res);
    if (!driver) return;

    const ride: any = await RideRequest.findByPk(rideId);
    if (!ride) { res.status(404).json({ error: 'Ride not found.' }); return; }
    if (ride.driverId !== driverId) { res.status(403).json({ error: 'This ride is not assigned to you.' }); return; }

    const err = validateTransition(ride.status as RideStatus, 'CANCELLED');
    if (err) { res.status(409).json({ error: err }); return; }

    const { sequelize } = require('../models/index');

    await sequelize.transaction(async (t: any) => {
      await RideRequest.update(
        { status: 'CANCELLED' },
        { where: { id: rideId }, transaction: t }
      );

      // Release seats if the ride was already assigned to a vehicle
      if (ride.vehicleId) {
        await Vehicle.update(
          { occupiedSeats: sequelize.literal(`MAX(0, occupiedSeats - ${ride.seatCount})`) },
          { where: { id: ride.vehicleId }, transaction: t }
        );
      }
    });

    res.json({ message: 'Ride cancelled.', rideId, status: 'CANCELLED' });
  } catch (error) {
    console.error('Cancel ride error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /driver/rides/active?driverId=...
// Driver views their currently assigned/active passengers and seats
// ---------------------------------------------------------------------------
router.get('/rides/active', async (req: Request, res: Response) => {
  try {
    const driverId = req.query.driverId as string;
    const driver = await resolveDriver(driverId, res);
    if (!driver) return;

    const activeRides = await RideRequest.findAll({
      where: {
        driverId,
        // Rides still "in progress" — not yet terminal
        status: ['REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED'],
      },
      order: [['createdAt', 'ASC']],
    });

    const summary = activeRides.map((r: any) => ({
      id: r.id,
      passengerId: r.passengerId,
      pickupZone: r.pickupZone,
      destinationZone: r.destinationZone,
      seatCount: r.seatCount,
      status: r.status,
      baseFare: r.baseFare,
      estimatedFare: r.estimatedFare,
      estimatedFareBDT: (r.estimatedFare / 100).toFixed(2),
      poolDiscount: r.poolDiscount,
      poolDiscountBDT: (r.poolDiscount / 100).toFixed(2),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));

    const totalOccupied = activeRides.reduce((sum: number, r: any) => sum + r.seatCount, 0);

    // Get vehicle info for pool capacity display
    const vehicle: any = await Vehicle.findOne({ where: { driverId, isActive: true } });
    const vehicleInfo = vehicle ? {
      id: vehicle.id,
      modelName: vehicle.modelName,
      licensePlate: vehicle.licensePlate,
      seatCapacity: vehicle.seatCapacity,
      occupiedSeats: vehicle.occupiedSeats,
      availableSeats: vehicle.seatCapacity - vehicle.occupiedSeats,
    } : null;

    res.json({ rides: summary, totalOccupiedSeats: totalOccupied, vehicle: vehicleInfo });
  } catch (error) {
    console.error('Get active rides error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /driver/rides/history?driverId=...
// Driver views their completed / cancelled ride history
// ---------------------------------------------------------------------------
router.get('/rides/history', async (req: Request, res: Response) => {
  try {
    const driverId = req.query.driverId as string;
    const driver = await resolveDriver(driverId, res);
    if (!driver) return;

    const history = await RideRequest.findAll({
      where: {
        driverId,
        status: ['COMPLETED', 'CANCELLED'],
      },
      order: [['updatedAt', 'DESC']],
    });

    res.json({
      rides: history.map((r: any) => ({
        id: r.id,
        passengerId: r.passengerId,
        pickupZone: r.pickupZone,
        destinationZone: r.destinationZone,
        seatCount: r.seatCount,
        baseFare: r.baseFare,
        estimatedFare: r.estimatedFare,
        estimatedFareBDT: (r.estimatedFare / 100).toFixed(2),
        poolDiscount: r.poolDiscount,
        status: r.status,
        vehicleId: r.vehicleId,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    });
  } catch (error) {
    console.error('Get ride history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /driver/rides/pool?driverId=...
// Driver views the current pool summary: all active passengers grouped by
// vehicle, with seat counts and per-passenger status.
// Does NOT expose passenger PII beyond seat counts and statuses.
// ---------------------------------------------------------------------------
router.get('/rides/pool', async (req: Request, res: Response) => {
  try {
    const driverId = req.query.driverId as string;
    const driver = await resolveDriver(driverId, res);
    if (!driver) return;

    const vehicle: any = await Vehicle.findOne({ where: { driverId, isActive: true } });
    if (!vehicle) return res.status(404).json({ error: 'No active vehicle found.' });

    const poolRides: any[] = await RideRequest.findAll({
      where: {
        vehicleId: vehicle.id,
        status: { [Op.notIn]: ['CANCELLED', 'COMPLETED'] },
      },
      order: [['createdAt', 'ASC']],
    });

    const totalSeatsUsed = poolRides.reduce((s: number, r: any) => s + r.seatCount, 0);

    res.json({
      vehicle: {
        id: vehicle.id,
        modelName: vehicle.modelName,
        licensePlate: vehicle.licensePlate,
        seatCapacity: vehicle.seatCapacity,
        occupiedSeats: vehicle.occupiedSeats,
        availableSeats: vehicle.seatCapacity - vehicle.occupiedSeats,
      },
      poolSize: poolRides.length,
      totalSeatsUsed,
      passengers: poolRides.map((r: any) => ({
        rideId: r.id,
        // No passenger name/email — only operational data
        pickupZone: r.pickupZone,
        destinationZone: r.destinationZone,
        seatCount: r.seatCount,
        status: r.status,
        estimatedFareBDT: (r.estimatedFare / 100).toFixed(2),
        poolDiscountBDT: (r.poolDiscount / 100).toFixed(2),
      })),
    });
  } catch (error) {
    console.error('Get pool error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
