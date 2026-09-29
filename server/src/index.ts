import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth';
import vehicleRoutes from './routes/vehicle';
import rideRequestRoutes from './routes/rideRequest';
import driverRoutes from './routes/driver';
import { sequelize } from './models';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Auth routes
app.use('/auth', authRoutes);

// Vehicle routes
app.use('/vehicle', vehicleRoutes);

// Ride Request routes (passenger creates + views, driver accepts)
app.use('/ride-requests', rideRequestRoutes);

// Driver flow routes (arrive, start, complete, cancel, view passengers, history)
app.use('/driver', driverRoutes);

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: 'dhaka-tesla-pool-backend' });
});

// Sync database and start server
sequelize.sync().then(() => {
  console.log('Database synced');
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}).catch(err => {
  console.error('Failed to sync database:', err);
});

