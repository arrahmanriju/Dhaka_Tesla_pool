import { Router, Request, Response } from 'express';
import { User, RideRequest, Vehicle } from '../models';
import { DHAKA_ZONES } from '../models/RideRequest';
import { calculateEstimatedFare } from '../utils/fareCalculator';

const router = Router();

// POST /ride-requests
// Passenger creates a ride request
router.post('/', async (req: Request, res: Response) => {
  try {
    const { passengerId, pickupZone, destinationZone, seatCount } = req.body;

    if (!passengerId || !pickupZone || !destinationZone || !seatCount) {
      return res.status(400).json({ error: 'passengerId, pickupZone, destinationZone, and seatCount are required.' });
    }

    if (!DHAKA_ZONES.includes(pickupZone) || !DHAKA_ZONES.includes(destinationZone)) {
      return res.status(400).json({ error: `Zones must be one of: ${DHAKA_ZONES.join(', ')}` });
    }

    if (!Number.isInteger(seatCount) || seatCount < 1) {
      return res.status(400).json({ error: 'seatCount must be a positive integer.' });
    }

    const passenger = await User.findByPk(passengerId);
    if (!passenger || passenger.role !== 'PASSENGER') {
      return res.status(404).json({ error: 'Passenger not found or invalid role.' });
    }

    const estimatedFare = calculateEstimatedFare(pickupZone, destinationZone, seatCount);

    const rideRequest = await RideRequest.create({
      passengerId,
      pickupZone,
      destinationZone,
      seatCount,
      estimatedFare,
    });

    res.status(201).json({ rideRequest });
  } catch (error) {
    console.error('Create ride request error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /ride-requests/me
// Passenger views their own requests
// In MVP, we just take passengerId from query or body since we lack auth middleware on master
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

    res.json({ requests });
  } catch (error) {
    console.error('Get ride requests error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /ride-requests/pending
// Driver sees relevant pending requests
router.get('/pending', async (req: Request, res: Response) => {
  try {
    const driverId = req.query.driverId as string;
    if (!driverId) return res.status(400).json({ error: 'driverId required' });

    const driver = await User.findByPk(driverId);
    if (!driver || driver.role !== 'DRIVER') return res.status(403).json({ error: 'Invalid driver' });

    const vehicle: any = await Vehicle.findOne({ where: { driverId, isActive: true } });
    if (!vehicle) return res.status(404).json({ error: 'No active vehicle found' });

    const availableSeats = vehicle.seatCapacity - vehicle.occupiedSeats;

    // MATCHING RULE (documented for MVP):
    // 1. Request status must be PENDING.
    // 2. Request seatCount <= availableSeats.
    // 3. For simplicity in MVP, if the vehicle already has active pooled requests,
    //    the new request MUST have the exact same destinationZone to share the vehicle.
    //    If the vehicle is empty, any destination is valid.
    
    // Find current active pooled requests for this vehicle
    const pooledRequests = await RideRequest.findAll({
      where: { vehicleId: vehicle.id, status: 'MATCHED' },
    });

    const whereClause: any = {
      status: 'REQUESTED',
    };

    if (pooledRequests.length > 0) {
      // Must match the destination of the existing pool
      const firstPooled = pooledRequests[0];
      if (firstPooled) {
        whereClause.destinationZone = firstPooled.destinationZone;
      }
    }

    const pendingRequests: any = await RideRequest.findAll({
      where: whereClause,
      order: [['createdAt', 'ASC']],
    });

    // Filter by available seats (since we didn't use Op.lte above to avoid extra imports for MVP)
    const relevantRequests = pendingRequests.filter((r: any) => r.seatCount <= availableSeats);

    res.json({ requests: relevantRequests });
  } catch (error) {
    console.error('Get pending requests error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /ride-requests/:id/accept
// Driver accepts a ride, assigning it to a pool on their vehicle
router.post('/:id/accept', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { driverId } = req.body;

    if (!driverId) return res.status(400).json({ error: 'driverId required' });

    const vehicle: any = await Vehicle.findOne({ where: { driverId, isActive: true } });
    if (!vehicle) return res.status(404).json({ error: 'No active vehicle found' });

    const request: any = await RideRequest.findByPk(id);
    if (!request || request.status !== 'REQUESTED') {
      return res.status(400).json({ error: 'Request not found or not in REQUESTED state.' });
    }

    // CONCURRENCY MECHANISM:
    // We use an atomic UPDATE with a WHERE clause constraint (Optimistic Concurrency).
    // We attempt to increment `occupiedSeats` only if `seatCapacity` remains >= `occupiedSeats + seatCount`.
    // If affected count is 0, the transaction/update failed (another driver claimed it, or capacity exceeded).
    // We wrap this in a Sequelize transaction so if the RideRequest update fails, the seat addition rolls back.
    
    const { sequelize } = require('../models/index');
    
    await sequelize.transaction(async (t: any) => {
      // 1. Atomic increment with constraint
      const [updatedCount] = await Vehicle.update(
        { occupiedSeats: sequelize.literal(`occupiedSeats + ${request.seatCount}`) },
        { 
          where: { 
            id: vehicle.id,
            // SQLite safe constraint format
            seatCapacity: {
              [require('sequelize').Op.gte]: sequelize.literal(`occupiedSeats + ${request.seatCount}`)
            }
          },
          transaction: t 
        }
      );

      if (updatedCount === 0) {
        throw new Error('CAPACITY_EXCEEDED');
      }

      // 2. Atomically set MATCHED + assign driverId — fails if already taken concurrently
      const [reqUpdatedCount] = await RideRequest.update(
        { status: 'MATCHED', vehicleId: vehicle.id, driverId },
        { 
          where: { id: request.id, status: 'REQUESTED' },
          transaction: t
        }
      );

      if (reqUpdatedCount === 0) {
        throw new Error('ALREADY_TAKEN');
      }
    });

    res.json({ message: 'Ride accepted and added to pool successfully.' });
  } catch (error: any) {
    console.error('Accept ride error:', error);
    if (error.message === 'CAPACITY_EXCEEDED') {
      return res.status(409).json({ error: 'Not enough seats available.' });
    }
    if (error.message === 'ALREADY_TAKEN') {
      return res.status(409).json({ error: 'Ride request was already accepted by someone else.' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
