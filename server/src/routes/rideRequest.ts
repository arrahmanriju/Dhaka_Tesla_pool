import { Router, Request, Response } from 'express';
import { User, RideRequest } from '../models';
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

export default router;
