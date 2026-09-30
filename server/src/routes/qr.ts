import { Router, Request, Response, NextFunction } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import {
  QRError,
  closeStaleSessions,
  getDriverBonus,
  getActiveSessionView,
  getSessionView,
  joinSession,
  markArrived,
  previewVehicle,
} from '../services/qrRides';

// ---------------------------------------------------------------------------
// /qr : street rides by QR code, for drivers with no smartphone.
//
// Every route here is used by a logged-in PASSENGER (the driver never logs in and takes no action),
// except GET /qr/bonus, where a driver (or an admin tool with a driver's login) reads the bonus record.
// The passenger is always the person in the login token, never an id from the request.
// ---------------------------------------------------------------------------
const router = Router();

/** Answers a QRError with its status and message; anything else is a 500 (handled by the app's JSON error handler). */
const handle = (fn: (req: AuthenticatedRequest, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req as AuthenticatedRequest, res);
    } catch (err) {
      if (err instanceof QRError) {
        return res.status(err.status).json({ error: err.message, code: err.code, ...(err.fields ? { fields: err.fields } : {}) });
      }
      next(err);
    }
  };

function passengerOnly(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  authenticateToken(req, res, () => {
    if (req.user!.role !== 'PASSENGER') {
      return res.status(403).json({ error: 'Only passengers can join street rides.', code: 'PASSENGER_ONLY' });
    }
    next();
  });
}

// GET /qr/vehicles/:code : what a passenger sees after scanning, before joining (vehicle nickname, free
// seats, and whether a ride is already open). Nothing about the driver.
router.get('/vehicles/:code', passengerOnly, handle(async (req, res) => {
  res.json(await previewVehicle(req.params.code));
}));

// POST /qr/join { vehicleCode, pickupZone, destinationZone, seatCount?, sessionId? }
// Opens the vehicle's session or joins the open one. `paymentMethod`, if sent, must be "cash".
router.post('/join', passengerOnly, handle(async (req, res) => {
  const body = req.body ?? {};
  const { sessionId } = await joinSession({
    passengerId: req.user!.id,
    vehicleCode: body.vehicleCode,
    pickupZone: body.pickupZone,
    destinationZone: body.destinationZone,
    seatCount: body.seatCount,
    sessionId: body.sessionId,
    paymentMethod: body.paymentMethod,
  });
  res.status(201).json({ session: await getSessionView(sessionId, req.user!.id) });
}));

// GET /qr/sessions/mine : the street ride the passenger is on right now, or { session: null }. A ride that has
// ended for them is NOT returned: the Street Ride page resets to "scan or enter a code", and the finished
// trip is in GET /passenger/rides/history (with source "QR").
router.get('/sessions/mine', passengerOnly, handle(async (req, res) => {
  await closeStaleSessions();
  res.json({ session: await getActiveSessionView(req.user!.id) });
}));

// GET /qr/sessions/:id : one session, only for a passenger who is in it (403 for anyone else)
router.get('/sessions/:id', passengerOnly, handle(async (req, res) => {
  await closeStaleSessions();
  res.json({ session: await getSessionView(req.params.id as string, req.user!.id) });
}));

// POST /qr/sessions/:id/arrived : the passenger marks their own leg as done. Nobody else can do it for them,
// and there is no driver confirmation anywhere.
router.post('/sessions/:id/arrived', passengerOnly, handle(async (req, res) => {
  await markArrived({ passengerId: req.user!.id, sessionId: req.params.id as string });
  res.json({ session: await getSessionView(req.params.id as string, req.user!.id) });
}));

// GET /qr/bonus (driver login) : the driver's own street-ride bonus record
router.get('/bonus', authenticateToken, handle(async (req, res) => {
  if (req.user!.role !== 'DRIVER') return res.status(403).json({ error: 'Only drivers can view this.', code: 'DRIVER_ONLY' });
  res.json(await getDriverBonus(req.user!.id));
}));

export default router;
