import { Router, Response } from 'express';
import { User, Vehicle, DriverProfile, sequelize, storagePath } from '../models';
import { DHAKA_ZONES } from '../models/RideRequest';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import {
  validateOnboarding,
  maskNid,
  saveProfilePicture,
  deleteProfilePicture,
  UPLOADS_DIR,
} from '../utils/onboarding';

const router = Router();
const uploadsDir = UPLOADS_DIR(storagePath);

// SQLite lets one connection write at a time, and every Sequelize transaction opens its own
// connection. Drivers submitting at the same moment would therefore collide with
// "SQLITE_BUSY: database is locked" and get a 500. Onboarding writes are queued so each
// submission waits its turn instead, and a short retry covers the rare case of an unrelated
// write (e.g. a ride being accepted) holding the lock. Uniqueness of the Tesla ID / NID does
// not depend on this — the database's AUTOINCREMENT and UNIQUE constraints guarantee it.
let writeQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => undefined);
  return run;
}
async function retryWhenBusy<T>(task: () => Promise<T>, attempts = 6): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await task();
    } catch (error: any) {
      const busy = /SQLITE_BUSY|database is locked/i.test(String(error?.message));
      if (!busy || i >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * i * i)); // 50, 200, 450 ms …
    }
  }
}

// The caller is identified by their JWT, never by an id in the request, so a driver can
// only ever read or create their own onboarding record (it holds their NID).
async function currentDriver(req: AuthenticatedRequest, res: Response) {
  const user = await User.findByPk(req.user!.id);
  if (!user) {
    res.status(401).json({ error: 'Driver not found. Please log in again.' });
    return null;
  }
  if (user.role !== 'DRIVER') {
    res.status(403).json({ error: 'Only drivers can onboard.' });
    return null;
  }
  return user;
}

/** What the *owning driver* sees. The NID is masked and this is never used for passengers. */
function ownerView(profile: DriverProfile, vehicle: Vehicle | null) {
  return {
    driverCode: profile.driverCode,
    nickname: vehicle?.modelName ?? null,
    seatCapacity: vehicle?.seatCapacity ?? null,
    homeZone: profile.homeZone,
    nidMasked: maskNid(profile.nid),
    profilePictureUrl: profile.profilePicture ? `/uploads/${profile.profilePicture}` : null,
  };
}

// ---------------------------------------------------------------------------
// GET /driver/onboarding
// Read-only name/phone (already given at signup), the allowed zones, and — if the driver
// has already onboarded — their profile.
// ---------------------------------------------------------------------------
router.get('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const driver = await currentDriver(req, res);
    if (!driver) return;

    const [profile, vehicle] = await Promise.all([
      DriverProfile.findOne({ where: { userId: driver.id } }),
      Vehicle.findOne({ where: { driverId: driver.id, isActive: true } }),
    ]);

    res.json({
      driver: { name: driver.name, phone: driver.phone },
      zones: DHAKA_ZONES,
      onboarded: !!profile,
      profile: profile ? ownerView(profile, vehicle) : null,
      // A driver who registered a vehicle before onboarding existed: lets the form prefill.
      existingVehicle: !profile && vehicle ? { nickname: vehicle.modelName, seatCapacity: vehicle.seatCapacity } : null,
    });
  } catch (error) {
    console.error('[onboarding] get error:', error);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---------------------------------------------------------------------------
// POST /driver/onboarding
// Body: { nickname, seatCapacity, homeZone, nid, profilePicture? (data URL) }
// Creates the driver's profile (and their vehicle) and returns the new Tesla ID.
// ---------------------------------------------------------------------------
router.post('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  let savedPicture: string | null = null;
  try {
    const driver = await currentDriver(req, res);
    if (!driver) return;

    const checked = validateOnboarding(req.body ?? {});
    if (!checked.ok) {
      return res.status(400).json({ error: Object.values(checked.fields)[0], code: 'VALIDATION', fields: checked.fields });
    }
    const { nickname, seatCapacity, homeZone, nid, picture } = checked.value;

    // Friendly pre-checks. The UNIQUE constraints below are the real guarantee.
    if (await DriverProfile.findOne({ where: { userId: driver.id } })) {
      return res.status(409).json({ error: 'You have already completed onboarding.', code: 'ALREADY_ONBOARDED' });
    }
    if (await DriverProfile.findOne({ where: { nid } })) {
      return res.status(409).json({ error: 'This NID number is already registered.', code: 'NID_TAKEN', fields: { nid: 'This NID number is already registered.' } });
    }

    if (picture) savedPicture = saveProfilePicture(uploadsDir, picture);

    // Profile + vehicle succeed or fail together. The Tesla ID comes from the profile's
    // AUTOINCREMENT id, so concurrent onboardings can never be given the same one.
    const result = await serialized(() => retryWhenBusy(() => sequelize.transaction(async (t: any) => {
      const profile = await DriverProfile.create(
        { userId: driver.id, homeZone, nid, profilePicture: savedPicture },
        { transaction: t }
      );

      let vehicle = await Vehicle.findOne({ where: { driverId: driver.id, isActive: true }, transaction: t });
      if (vehicle) {
        // Registered under the old flow: keep the vehicle (and its rides), update it.
        if (seatCapacity < vehicle.occupiedSeats) {
          throw Object.assign(new Error('SEATS_IN_USE'), { occupiedSeats: vehicle.occupiedSeats });
        }
        await vehicle.update({ modelName: nickname, seatCapacity }, { transaction: t });
      } else {
        // The Tesla ID doubles as the vehicle's unique identifier (no plate is collected here).
        vehicle = await Vehicle.create(
          { driverId: driver.id, modelName: nickname, seatCapacity, licensePlate: profile.driverCode, isActive: true },
          { transaction: t }
        );
      }
      return { profile, vehicle };
    })));

    return res.status(201).json({
      message: 'Onboarding complete.',
      profile: ownerView(result.profile, result.vehicle),
    });
  } catch (error: any) {
    if (savedPicture) deleteProfilePicture(uploadsDir, savedPicture);

    if (error?.message === 'SEATS_IN_USE') {
      return res.status(409).json({
        error: `Your vehicle currently has ${error.occupiedSeats} seat(s) in use; capacity cannot be lower.`,
        code: 'SEATS_IN_USE',
        fields: { seatCapacity: 'Capacity is lower than the seats currently in use.' },
      });
    }
    // Lost a race on a UNIQUE constraint (same NID / same driver submitted twice at once).
    if (error?.name === 'SequelizeUniqueConstraintError') {
      const column: string = error.errors?.[0]?.path ?? '';
      if (column.includes('nid')) {
        return res.status(409).json({ error: 'This NID number is already registered.', code: 'NID_TAKEN', fields: { nid: 'This NID number is already registered.' } });
      }
      return res.status(409).json({ error: 'You have already completed onboarding.', code: 'ALREADY_ONBOARDED' });
    }
    console.error('[onboarding] post error:', error?.name, error?.message); // never log the body (it holds the NID)
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
