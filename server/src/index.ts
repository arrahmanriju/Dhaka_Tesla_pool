import express, { Request, Response, NextFunction } from 'express';
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
import { migrateUsersTable, migrateRideRequestsTable, migrateFaresToTaka, migrateMidTripCancellation, migratePayments, ensureOneActiveRideIndex } from './migrations';

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

// Errors always leave as JSON with a human-readable `error`, never as Express's default HTML page: the
// client shows that text (or a friendly fallback by status), so it must always be there.
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'That address does not exist.', code: 'NOT_FOUND' });
});
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That upload is too large.', code: 'TOO_LARGE' });
  }
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'The request could not be read.', code: 'BAD_REQUEST' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Export app for testing
export { app };

if (require.main === module) {
  // Sync database and start server
  migrateUsersTable()
    .then(() => migrateRideRequestsTable())
    // Add every new column BEFORE anything reads RideRequests through the model (the paisa -> taka
    // migration re-prices open pools), because the model selects all of its columns.
    .then(() => migrateMidTripCancellation())
    .then(() => migratePayments())
    .then(() => migrateFaresToTaka())
    .then(() => sequelize.sync())
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
