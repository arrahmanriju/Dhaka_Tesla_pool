import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth';
import driverRoutes from './routes/driver';
import vehicleRoutes from './routes/vehicle';
import rideRequestRoutes from './routes/rideRequest';
import passengerRoutes from './routes/passenger';
import qrRoutes from './routes/qr';
import { requireJwtSecret } from './config/jwtSecret';
import { closeStaleSessions } from './services/qrRides';
import { sequelize, storagePath } from './models';
import { UPLOADS_DIR } from './utils/onboarding';
import onboardingRoutes from './routes/onboarding';
import { migrateUsersTable, migrateRideRequestsTable, migrateFaresToTaka, migrateMidTripCancellation, migratePayments, migratePassengerLabels, migrateVehicleCodes, ensureOneActiveRideIndex, ensureOneOpenQRSessionIndex } from './migrations';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// CORS: in production set CORS_ORIGIN to the address(es) of the website that calls this API (comma separated,
// e.g. https://your-app.vercel.app). Only those origins may call it from a browser. Left unset (local
// development) every origin is allowed.
const allowedOrigins = (process.env.CORS_ORIGIN ?? '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
app.use(cors(allowedOrigins.length > 0 ? { origin: allowedOrigins } : undefined));
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
// Street rides by QR code (drivers with no smartphone; every action is the passenger's)
app.use('/qr', qrRoutes);
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
  // Refuse to start without a strong JWT_SECRET: it signs every login token and password-reset code, and there is
  // deliberately no default (config/jwtSecret.ts). Fail here, loudly, before anything else runs.
  try {
    requireJwtSecret();
  } catch (error) {
    console.error(`\n${(error as Error).message}\n`);
    process.exit(1);
  }

  if (process.env.NODE_ENV === 'production' && allowedOrigins.length === 0) {
    console.warn('[cors] CORS_ORIGIN is not set: every website may call this API from a browser. Set it to your frontend address.');
  }

  // Sync database and start server
  migrateUsersTable()
    .then(() => migrateRideRequestsTable())
    // Add every new column BEFORE anything reads RideRequests through the model (the paisa -> taka
    // migration re-prices open pools), because the model selects all of its columns.
    .then(() => migrateMidTripCancellation())
    .then(() => migratePayments())
    .then(() => migratePassengerLabels())
    .then(() => migrateVehicleCodes())
    .then(() => migrateFaresToTaka())
    .then(() => sequelize.sync())
    .then(() => ensureOneActiveRideIndex())
    .then(() => ensureOneOpenQRSessionIndex())
    .then(() => {
      console.log('Database synced');
      // Nobody closes a street ride but its passengers, so once a minute close any that ran past the time limit
      // (they are also closed lazily on every /qr request). unref: the timer never keeps the process alive.
      setInterval(() => { closeStaleSessions().catch((e) => console.error('QR sweep failed:', e)); }, 60_000).unref();
      app.listen(port, () => {
        console.log(`Server is running on port ${port}`);
      });
    })
    .catch(err => {
      console.error('Failed to sync database:', err);
    });
}
