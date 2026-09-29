import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth';
import driverRoutes from './routes/driver';
import vehicleRoutes from './routes/vehicle';
import rideRequestRoutes from './routes/rideRequest';
import { sequelize } from './models';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Auth routes
app.use('/auth', authRoutes);

// Driver routes
app.use('/driver', driverRoutes);

// Vehicle routes
app.use('/vehicle', vehicleRoutes);

// Ride Request routes
app.use('/ride-requests', rideRequestRoutes);

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

