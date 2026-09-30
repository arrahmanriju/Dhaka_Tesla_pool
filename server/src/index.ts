import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth';
import driverRoutes from './routes/driver';
import vehicleRoutes from './routes/vehicle';
import rideRequestRoutes from './routes/rideRequest';
import passengerRoutes from './routes/passenger';
import { sequelize, storagePath } from './models';
import { UPLOADS_DIR } from './utils/onboarding';
import onboardingRoutes from './routes/onboarding';
import { migrateUsersTable, migrateRideRequestsTable, migrateFaresToTaka, migrateMidTripCancellation, ensureOneActiveRideIndex } from './migrations';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
// The onboarding form uploads a profile picture (max 2 MB) as a base64 data URL, which is
// larger than the default 100 kB JSON limit. Must be registered before the global parser.
app.use('/driver/onboarding', express.json({ limit: '3mb' }));
app.use(express.json());

// Driver profile pictures (random file names, JPG/PNG only, see utils/onboarding.ts).
app.use('/uploads', express.static(UPLOADS_DIR(storagePath), {
  index: false,
  dotfiles: 'deny',
  setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
}));

// Auth routes
app.use('/auth', authRoutes);

// Driver onboarding (must come before the generic /driver router)
app.use('/driver/onboarding', onboardingRoutes);

// Driver routes
app.use('/driver', driverRoutes);


// Vehicle routes
app.use('/vehicle', vehicleRoutes);

// Ride Request routes (passenger creates + views, driver accepts)
app.use('/ride-requests', rideRequestRoutes);

// Passenger status routes (live tracking, history, cancellation)
app.use('/passenger', passengerRoutes);
// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: 'dhaka-tesla-pool-backend' });
});

// Export app for testing
export { app };

if (require.main === module) {
  // Sync database and start server
  migrateUsersTable()
    .then(() => migrateRideRequestsTable())
    .then(() => migrateFaresToTaka())
    .then(() => sequelize.sync())
    .then(() => migrateMidTripCancellation())
    .then(() => ensureOneActiveRideIndex())
    .then(() => {
      console.log('Database synced');
      app.listen(port, () => {
        console.log(`Server is running on port ${port}`);
      });
    })
    .catch(err => {
      console.error('Failed to sync database:', err);
    });
}
