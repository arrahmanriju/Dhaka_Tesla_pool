import { Router, Request, Response } from 'express';
import { User, Vehicle } from '../models';

const router = Router();

// POST /vehicle
// Register a vehicle for a driver
router.post('/', async (req: Request, res: Response) => {
  try {
    const { driverId, modelName, seatCapacity, licensePlate } = req.body;

    if (!driverId || !modelName || seatCapacity === undefined || !licensePlate) {
      return res.status(400).json({ error: 'driverId, modelName, seatCapacity, and licensePlate are required.' });
    }

    if (!Number.isInteger(seatCapacity) || seatCapacity <= 0) {
      return res.status(400).json({ error: 'seatCapacity must be a positive integer.' });
    }

    const driver = await User.findByPk(driverId);
    if (!driver || driver.role !== 'DRIVER') {
      return res.status(404).json({ error: 'Driver not found or invalid role.' });
    }

    // Assumption for MVP: A driver can only have ONE active vehicle at a time.
    // If they already have an active vehicle, prevent registering another.
    const activeVehicle = await Vehicle.findOne({ where: { driverId, isActive: true } });
    if (activeVehicle) {
      return res.status(400).json({ error: 'Driver already has an active vehicle. (MVP limits to 1 active vehicle per driver)' });
    }

    const existingLicense = await Vehicle.findOne({ where: { licensePlate } });
    if (existingLicense) {
      return res.status(409).json({ error: 'Vehicle with this license plate already exists.' });
    }

    const vehicle = await Vehicle.create({
      driverId,
      modelName,
      seatCapacity,
      licensePlate,
      isActive: true, // Defaulting to active upon registration
    });

    res.status(201).json({ vehicle });
  } catch (error) {
    console.error('Vehicle registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /vehicle/driver/:driverId
// Get the active vehicle for a specific driver
router.get('/driver/:driverId', async (req: Request, res: Response) => {
  try {
    const { driverId } = req.params;
    
    // MVP Assumption: we just return the currently active vehicle
    const vehicle = await Vehicle.findOne({ where: { driverId, isActive: true } });
    if (!vehicle) {
      return res.status(404).json({ error: 'No active vehicle found for this driver.' });
    }

    res.json({ vehicle });
  } catch (error) {
    console.error('Get vehicle error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
