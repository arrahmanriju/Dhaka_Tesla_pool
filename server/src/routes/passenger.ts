import { Router, Response, NextFunction } from 'express';
import { Op, Transaction } from 'sequelize';
import { sequelize, User, RideRequest, Vehicle, DriverProfile, RideEvent, WalletTransaction } from '../models';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { validateTransition, RideStatus, DHAKA_ZONES } from '../models/RideRequest';
import { isFareFinal, recalculatePoolFares } from '../utils/poolFares';
import { shareRatePercent } from '../utils/fareCalculator';
import { priceJourney, recordExit } from '../utils/checkpoints';
import { settleJourney } from '../utils/journeySettlement';
import { collectPayment } from '../utils/payments';
import { recordRideEvent, joinedMidTrip } from '../utils/rideEvents';

const router = Router();

// ---------------------------------------------------------------------------
// CANCELLABLE STATES — documented rationale:
//
//   REQUESTED     → CANCELLED  ✔ No driver has committed yet. Zero cost.
//   MATCHED       → CANCELLED  ✔ Driver was matched but not yet on the way.
//                               The passenger can still back out; the driver
//                               has not yet been physically inconvenienced.
//
//   DRIVER_ARRIVED→ CANCELLED  ✗ NOT allowed for the passenger.
//                               The driver has already made the physical trip
//                               to the pickup point. Cancelling here penalises
//                               the driver unfairly. Only a driver can cancel
//                               in this state (no-show, etc.).
//
//   STARTED       → CANCELLED  ✗ Trip is in progress — cannot cancel.
//   COMPLETED     → CANCELLED  ✗ Terminal state — cannot undo.
//   CANCELLED     → CANCELLED  ✗ Already cancelled.
//
// Summary: passengers may cancel in REQUESTED or MATCHED only.
// ---------------------------------------------------------------------------
const PASSENGER_CANCELLABLE: RideStatus[] = ['REQUESTED', 'MATCHED'];

// ---------------------------------------------------------------------------
// Helper: verify caller is a PASSENGER
// ---------------------------------------------------------------------------
async function resolvePassenger(passengerId: string | undefined, res: Response) {
  if (!passengerId) {
    res.status(400).json({ error: 'passengerId is required.' });
    return null;
  }
  const passenger = await User.findByPk(passengerId);
  if (!passenger) {
    res.status(401).json({ error: 'Passenger not found. Please log in again.' });
    return null;
  }
  if (passenger.role !== 'PASSENGER') {
    res.status(403).json({ error: 'Only passengers can perform this action.' });
    return null;
  }
  return passenger;
}

// ---------------------------------------------------------------------------
// Every /passenger/rides route runs as the LOGGED-IN passenger.
//
// The caller is identified by their login token, never by an id they send. A `passengerId`
// in the query or body is still accepted (older clients send one) but it must be the caller's
// own id: someone else's id gets a 403. Only passengers may use these routes.
//
// This matters more now that a ride carries the driver's phone number and the first names of
// the other passengers: an id that can be forged would leak them.
// ---------------------------------------------------------------------------
function ownPassenger(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  authenticateToken(req, res, () => {
    if (req.user!.role !== 'PASSENGER') {
      res.status(403).json({ error: 'Only passengers can view or change rides.' });
      return;
    }
    const claimed = req.query.passengerId ?? req.body?.passengerId;
    if (typeof claimed === 'string' && claimed !== req.user!.id) {
      res.status(403).json({ error: 'You can only access your own rides.' });
      return;
    }
    next();
  });
}

// ---------------------------------------------------------------------------
// Helper: find a ride and enforce ownership.
// Returns the ride if it belongs to this passenger; otherwise writes the error
// (404 if there is no such ride, 403 if it is someone else's) and returns null.
// ---------------------------------------------------------------------------
async function findOwnedRide(rideId: string, passengerId: string, res: Response) {
  const ride = await RideRequest.findOne({ where: { id: rideId } });

  if (!ride) {
    res.status(404).json({ error: 'Ride not found.' });
    return null;
  }

  if ((ride as any).passengerId !== passengerId) {
    res.status(403).json({ error: 'This ride belongs to another passenger.' });
    return null;
  }

  return ride;
}

// ---------------------------------------------------------------------------
// Helper: enrich a RideRequest with the driver, vehicle and pool details the passenger's
// ride status page shows.
//
// What a passenger may see (and nothing more):
//   driver   — name, photo, Tesla ID, and the PHONE NUMBER only while the ride is in progress
//              (MATCHED, DRIVER_ARRIVED, STARTED). Never while it is still REQUESTED, and
//              not once it is over.
//   pool     — is it shared, seats taken, and the FIRST NAME of each other passenger.
//              Never another passenger's phone, fare, destination, surname or ids.
//   fare     — this passenger's own fare only.
// ---------------------------------------------------------------------------
const IN_PROGRESS: RideStatus[] = ['MATCHED', 'DRIVER_ARRIVED', 'STARTED'];
const OPEN: RideStatus[] = ['REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED'];

const firstName = (fullName: string | null | undefined) => (fullName ?? '').trim().split(/\s+/)[0] ?? '';

// ---------------------------------------------------------------------------
// The passenger's OWN lifecycle history: when the ride was requested, matched, and so on.
// Only events of this passenger's ride are read (also filtered by passengerId), and they carry
// nothing about anyone else: `ridersOnboard` is just a head count of people already travelling
// when this passenger was matched, and `joinedMidTrip` says that count was above zero.
// ---------------------------------------------------------------------------
async function timelineFor(rideIds: string[], passengerId: string) {
  if (rideIds.length === 0) return new Map<string, any[]>();
  const events: any[] = await RideEvent.findAll({
    where: { rideRequestId: { [Op.in]: rideIds }, passengerId },
    order: [['id', 'ASC']],
  });
  const byRide = new Map<string, any[]>();
  for (const e of events) {
    const list = byRide.get(e.rideRequestId) ?? [];
    list.push({
      status: e.status,
      at: e.createdAt,
      ...(e.status === 'MATCHED' ? { ridersOnboard: e.ridersOnboard, joinedMidTrip: joinedMidTrip(e) } : {}),
      ...(e.status === 'CANCELLED_IN_TRANSIT' || e.status === 'COMPLETED'
        ? { cancellationZone: e.cancellationZone, chargedFare: e.chargedFare, fullTripEstimate: e.fullTripEstimate }
        : {}),
    });
    byRide.set(e.rideRequestId, list);
  }
  return byRide;
}

// The passenger's own fare, stretch by stretch: final once their journey has ended, otherwise the running
// estimate for a ride that is on board. null before boarding.
async function billFor(ride: any) {
  if (!['STARTED', 'COMPLETED', 'CANCELLED_IN_TRANSIT'].includes(ride.status)) return null;
  const priced = await priceJourney(ride);
  return priced ? { ...passengerBill(priced, priced.fare, null), final: priced.exited } : null;
}

async function enrichRide(ride: any, timeline: any[] = []) {
  const status = ride.status as RideStatus;
  const vehicle: any = ride.vehicleId
    ? await Vehicle.findByPk(ride.vehicleId, {
        attributes: ['id', 'modelName', 'licensePlate', 'seatCapacity', 'occupiedSeats'],
      })
    : null;

  // ── Driver: only once a driver has accepted (never while REQUESTED) ──
  let driver: { name: string | null; phone: string | null; photoUrl: string | null; teslaId: string | null } | null = null;
  if (ride.driverId && status !== 'REQUESTED') {
    const [user, profile] = await Promise.all([
      User.findByPk(ride.driverId, { attributes: ['name', 'phone'] }),
      DriverProfile.findOne({ where: { userId: ride.driverId }, attributes: ['id', 'profilePicture'] }),
    ]);
    driver = {
      name: user?.name ?? null,
      phone: IN_PROGRESS.includes(status) ? (user?.phone ?? null) : null,
      photoUrl: profile?.profilePicture ? `/uploads/${profile.profilePicture}` : null,
      teslaId: profile?.driverCode ?? null,
    };
  }

  const vehicleInfo = vehicle
    ? {
        ...vehicle.toJSON(),
        nickname: vehicle.modelName,
        teslaId: driver?.teslaId ?? vehicle.licensePlate,
      }
    : null;

  // ── Pool: who else is on this vehicle right now (only while the ride is open) ──
  let pool: {
    isShared: boolean;
    poolSize: number;
    otherPassengers: { firstName: string }[];
    seatsTaken: number;
    seatCapacity: number;
  } | null = null;
  if (ride.vehicleId && vehicle && OPEN.includes(status)) {
    // Only the columns needed to count seats and find names — no fares, zones or phones are read.
    const poolRides: any[] = await RideRequest.findAll({
      where: { vehicleId: ride.vehicleId, status: { [Op.in]: OPEN } },
      attributes: ['id', 'passengerId', 'seatCount'],
      order: [['createdAt', 'ASC']],
    });
    const others = poolRides.filter((r) => r.id !== ride.id);
    const users: any[] = others.length
      ? await User.findAll({ where: { id: others.map((r) => r.passengerId) }, attributes: ['id', 'name'] })
      : [];
    const names = new Map(users.map((u) => [u.id, firstName(u.name)]));
    pool = {
      isShared: others.length > 0,
      poolSize: Math.max(1, poolRides.length),
      otherPassengers: others.map((r) => ({ firstName: names.get(r.passengerId) ?? '' })),
      seatsTaken: poolRides.reduce((sum, r) => sum + r.seatCount, 0),
      seatCapacity: vehicle.seatCapacity,
    };
  }

  const poolSize = pool?.poolSize ?? 1;
  const coPassengers = pool ? pool.otherPassengers.length : 0;
  const driverName = driver?.name ?? null;

  return {
    id: ride.id,
    passengerId: ride.passengerId,
    pickupZone: ride.pickupZone,
    destinationZone: ride.destinationZone,
    seatCount: ride.seatCount,
    allowSharing: ride.allowSharing,
    // Only THIS passenger's own fare is ever returned (never a co-passenger's). Whole taka.
    baseFare: ride.baseFare, // the fare riding alone
    estimatedFare: ride.estimatedFare, // what they pay right now
    poolDiscount: ride.poolDiscount, // what they save by sharing
    fareFinal: isFareFinal(ride.status), // true once their own journey has ended; before that it is an estimate
    status: ride.status,
    vehicle: vehicleInfo,
    driver,
    driverName,
    pool,
    coPassengers,
    poolSize,
    shareRatePercent: shareRatePercent(poolSize, ride.allowSharing),
    poolDiscountApplied: ride.poolDiscount > 0,
    isSharedRide: coPassengers > 0,
    canCancel: PASSENGER_CANCELLABLE.includes(ride.status as RideStatus),
    // a STARTED ride can still be left mid-route (PATCH /passenger/rides/:id/cancel-in-transit)
    canCancelInTransit: ride.status === 'STARTED',
    // How this ride is paid, and whether it has been (the passenger's own ride only)
    paymentMethod: ride.paymentMethod,
    paymentStatus: ride.paymentStatus,
    paymentAmount: ride.paymentAmount ?? null,
    cancellationZone: ride.cancellationZone ?? null,
    fareBreakdown: await billFor(ride),
    timeline,
    joinedMidTrip: timeline.some((e) => e.joinedMidTrip === true),
    createdAt: ride.createdAt,
    updatedAt: ride.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// GET /passenger/wallet   (login required)
// The logged-in passenger's own TeslaPay wallet: balance (whole taka) and their recent debits.
// It is always the CALLER's wallet: the id comes from the login token, and a passengerId that is not
// theirs is refused (ownPassenger). No other route returns a wallet balance to anyone else,
// including drivers, who only ever see a ride's payment status.
// ---------------------------------------------------------------------------
router.get('/wallet', ownPassenger, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const passenger = await resolvePassenger(req.user!.id, res);
    if (!passenger) return;
    const transactions: any[] = await WalletTransaction.findAll({
      where: { userId: passenger.id },
      order: [['id', 'DESC']],
      limit: 20,
    });
    res.json({
      balance: passenger.walletBalance,
      currency: 'BDT',
      transactions: transactions.map((t) => ({
        rideId: t.rideRequestId,
        type: t.type,
        amount: t.amount,
        balanceAfter: t.balanceAfter,
        at: t.createdAt,
      })),
    });
  } catch (error) {
    console.error('Passenger wallet error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /passenger/rides/active   (login required)
// Passenger tracks live status of their current (non-terminal) ride(s): status, driver and
// vehicle, pool (shared or not, seats, first names of the others), and their own fare.
// Does NOT reveal other passengers' phones, fares, destinations or ids.
// ---------------------------------------------------------------------------
router.get('/rides/active', ownPassenger, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const passengerId = req.user!.id;
    const passenger = await resolvePassenger(passengerId, res);
    if (!passenger) return;

    const activeRides = await RideRequest.findAll({
      where: {
        passengerId,
        status: { [Op.in]: ['REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED'] },
      },
      order: [['createdAt', 'DESC']],
    });

    const timelines = await timelineFor(activeRides.map((r: any) => r.id), passengerId);
    const enriched = await Promise.all(activeRides.map((r: any) => enrichRide(r, timelines.get(r.id) ?? [])));
    res.json({ rides: enriched });
  } catch (error) {
    console.error('Passenger active rides error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /passenger/rides/history   (login required)
// Passenger views their completed and cancelled ride history.
// ---------------------------------------------------------------------------
router.get('/rides/history', ownPassenger, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const passengerId = req.user!.id;
    const passenger = await resolvePassenger(passengerId, res);
    if (!passenger) return;

    const history = await RideRequest.findAll({
      where: {
        passengerId,
        status: { [Op.in]: ['COMPLETED', 'CANCELLED', 'CANCELLED_IN_TRANSIT'] },
      },
      order: [['updatedAt', 'DESC']],
    });

    const timelines = await timelineFor(history.map((r: any) => r.id), passengerId);
    res.json({
      rides: history.map((r: any) => ({
        id: r.id,
        timeline: timelines.get(r.id) ?? [],
        cancellationZone: r.cancellationZone ?? null,
        paymentMethod: r.paymentMethod,
        paymentStatus: r.paymentStatus,
        paymentAmount: r.paymentAmount ?? null,
        pickupZone: r.pickupZone,
        destinationZone: r.destinationZone,
        seatCount: r.seatCount,
        baseFare: r.baseFare,
        estimatedFare: r.estimatedFare,
        poolDiscount: r.poolDiscount,
        fareFinal: isFareFinal(r.status),
        status: r.status,
        vehicleId: r.vehicleId,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    });
  } catch (error) {
    console.error('Passenger history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /passenger/rides/:id   (login required)
// Passenger tracks one specific ride by ID — the ride status page polls this every 5 seconds.
// 404 if there is no such ride; 403 if it belongs to another passenger.
// ---------------------------------------------------------------------------
router.get('/rides/:id', ownPassenger, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const passengerId = req.user!.id;
    const rideId = req.params.id as string;

    const passenger = await resolvePassenger(passengerId, res);
    if (!passenger) return;

    const ride: any = await findOwnedRide(rideId, passengerId, res);
    if (!ride) return;

    const timelines = await timelineFor([ride.id], passengerId);
    res.json({ ride: await enrichRide(ride, timelines.get(ride.id) ?? []) });
  } catch (error) {
    console.error('Passenger get ride error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /passenger/rides/:id/cancel   (login required)
// Passenger cancels their own ride.
// Only allowed in REQUESTED or MATCHED states (see rationale at top of file).
// 404 if there is no such ride; 403 for a ride that belongs to another passenger.
//
// POOL FARE RECALCULATION:
//   If the cancelled ride was part of a pool (vehicleId set), we release its
//   seats and immediately recalculate the remaining pool passengers' fares.
//   If only 1 passenger remains, their discount is removed (back to baseFare).
// ---------------------------------------------------------------------------
router.patch('/rides/:id/cancel', ownPassenger, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rideId = req.params.id as string;
    const passengerId = req.user!.id;

    const passenger = await resolvePassenger(passengerId, res);
    if (!passenger) return;

    const ride: any = await findOwnedRide(rideId, passengerId, res);
    if (!ride) return;

    // State-machine guard
    const machineErr = validateTransition(ride.status as RideStatus, 'CANCELLED');
    if (machineErr) {
      res.status(409).json({ error: machineErr });
      return;
    }

    // Extra passenger-specific guard: DRIVER_ARRIVED onwards is not passenger-cancellable
    if (!PASSENGER_CANCELLABLE.includes(ride.status as RideStatus)) {
      res.status(409).json({
        error: `Passengers cannot cancel a ride in ${ride.status} state. The driver is already on their way or the trip is in progress.`,
      });
      return;
    }

    await sequelize.transaction(async (t: any) => {
      // 1. Mark this ride cancelled
      await RideRequest.update(
        { status: 'CANCELLED' },
        { where: { id: rideId, passengerId }, transaction: t }
      );
      await recordRideEvent(ride, 'CANCELLED', ride.status, { id: passengerId, role: 'PASSENGER' }, t);

      if (ride.vehicleId) {
        // 2. Release the reserved seats
        await Vehicle.update(
          { occupiedSeats: sequelize.literal(`MAX(0, occupiedSeats - ${ride.seatCount})`) },
          { where: { id: ride.vehicleId }, transaction: t }
        );

        // 3. Recalculate fares for the remaining pool passengers.
        //    recalculatePoolFares() will NOT include this now-CANCELLED ride
        //    because it filters by non-terminal statuses.
        await recalculatePoolFares(ride.vehicleId, t);
      }
    });

    res.json({
      message: 'Ride cancelled successfully.',
      rideId,
      status: 'CANCELLED',
    });
  } catch (error) {
    console.error('Passenger cancel ride error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// The passenger's OWN payment for a ride, and their own wallet balance after it. Only ever built for the
// logged-in passenger's ride: the wallet balance is private to them.
async function paymentOf(rideId: string, passengerId: string) {
  const [ride, user]: any[] = await Promise.all([
    RideRequest.findByPk(rideId, { attributes: ['paymentMethod', 'paymentStatus', 'paymentAmount'] }),
    User.findByPk(passengerId, { attributes: ['walletBalance'] }),
  ]);
  return {
    method: ride?.paymentMethod,
    status: ride?.paymentStatus,
    amount: ride?.paymentAmount ?? null,
    walletBalance: user?.walletBalance ?? 0,
  };
}

// ---------------------------------------------------------------------------
// The passenger's own fare breakdown, stretch by stretch. Zone names are left out on purpose: the
// checkpoints between a passenger's boarding and exit are where OTHER passengers boarded or got
// off, which a passenger must not learn. What is shown is only how far, how many were on board,
// the share rate and the charge for each stretch.
// ---------------------------------------------------------------------------
function passengerBill(bill: any | null, fare: number, previousEstimate: number | null) {
  return {
    baseCharge: bill?.baseCharge ?? 100,
    segments: (bill?.segments ?? []).map((s: any) => ({
      distanceKm: s.distanceKm,
      distanceCharge: s.distanceCharge,
      passengers: s.passengers,
      ratePercent: s.ratePercent,
      charge: s.charge,
    })),
    distanceTotal: bill?.distanceTotal ?? null,
    soloFare: bill?.soloFare ?? null,
    poolDiscount: bill?.poolDiscount ?? null,
    fare,
    fullTripEstimate: previousEstimate,
  };
}

// ---------------------------------------------------------------------------
// PATCH /passenger/rides/:id/cancel-in-transit   (login required)   body: { cancellationZone }
//
// A passenger leaves a ride that has already STARTED. They were picked up and travelled part of the
// route, so the ride ends as CANCELLED_IN_TRANSIT (not CANCELLED, which means "never happened").
//
//   • cancellationZone is required: the nearest predefined zone where they are dropped off (same
//     zone list as everywhere else). It must differ from the pickup zone, and from the destination
//     zone (a passenger who reaches their destination completes the trip instead).
//   • The fare is settled by the same checkpoint / segment pricing as every other journey: the
//     cancellation zone becomes a checkpoint (passenger count − 1) and their journey is priced from
//     where they boarded up to it (settleJourney → segmentFare in utils/fareCalculator.ts). They pay
//     only for the segments they actually travelled, each at the share rate for who was on board.
//     `estimatedFare` becomes that final charge.
//   • The seat is released at once, so the vehicle is eligible again for the pending-request
//     filter without a re-match.
//   • 404 no such ride · 403 someone else's ride · 409 the ride is not STARTED (including COMPLETED).
//
// ASSUMPTION — nobody else's fare is settled or rewritten by this. A passenger still on board is not
// charged extra or refunded because someone left: each journey is priced only from the segments that
// passenger travelled. Passengers still on board simply continue with one fewer passenger, so their
// own NEXT segments are priced at the lower share rate (their running estimate is refreshed), while
// the segments already travelled keep the rate that applied when they were travelled.
// ---------------------------------------------------------------------------
router.patch('/rides/:id/cancel-in-transit', ownPassenger, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rideId = req.params.id as string;
    const passengerId = req.user!.id;

    const passenger = await resolvePassenger(passengerId, res);
    if (!passenger) return;

    const ride: any = await findOwnedRide(rideId, passengerId, res);
    if (!ride) return;

    // The ride must be STARTED (a COMPLETED or already-cancelled ride can never be cancelled here)
    const machineErr = validateTransition(ride.status as RideStatus, 'CANCELLED_IN_TRANSIT');
    if (machineErr) {
      res.status(409).json({
        error: ride.status === 'COMPLETED' ? 'This ride is already completed.' : machineErr,
        code: 'NOT_IN_TRANSIT',
      });
      return;
    }

    const zone = req.body?.cancellationZone;
    if (typeof zone !== 'string' || !(DHAKA_ZONES as readonly string[]).includes(zone)) {
      res.status(400).json({
        error: 'Choose the zone where you are being dropped off.',
        code: 'VALIDATION',
        fields: { cancellationZone: 'Choose the zone where you are being dropped off.' },
      });
      return;
    }
    if (zone === ride.pickupZone || zone === ride.destinationZone) {
      const msg = zone === ride.pickupZone
        ? 'The drop-off zone cannot be your pickup zone.'
        : 'That is your destination: the driver completes the trip there.';
      res.status(400).json({ error: msg, code: 'VALIDATION', fields: { cancellationZone: msg } });
      return;
    }

    const result = await sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE }, async (t: any) => {
      // Re-read under the write lock: the driver may have completed the ride a moment ago.
      const current: any = await RideRequest.findOne({ where: { id: rideId, passengerId }, transaction: t });
      if (!current || current.status !== 'STARTED') throw new Error('NOT_IN_TRANSIT');

      const [changed] = await RideRequest.update(
        { status: 'CANCELLED_IN_TRANSIT', cancellationZone: zone },
        { where: { id: rideId, passengerId, status: 'STARTED' }, transaction: t }
      );
      if (changed === 0) throw new Error('NOT_IN_TRANSIT');

      // The cancellation zone is a checkpoint (passengers on board - 1); then the journey is priced
      // from where they boarded to here, segment by segment.
      await recordExit(current, 'PASSENGER_LEFT', zone, t);
      const settled = await settleJourney(current, t);

      // Release the seat immediately, and refresh the running estimates of whoever is still on board
      if (current.vehicleId) {
        await Vehicle.update(
          { occupiedSeats: sequelize.literal(`MAX(0, occupiedSeats - ${current.seatCount})`) },
          { where: { id: current.vehicleId }, transaction: t }
        );
        await recalculatePoolFares(current.vehicleId, t);
      }

      const charged = settled.bill?.fare ?? current.estimatedFare;
      // Collect the fare for the part travelled: wallet debit by exactly this amount, or cash owed.
      await collectPayment(current, charged, t);
      await recordRideEvent(current, 'CANCELLED_IN_TRANSIT', 'STARTED', { id: passengerId, role: 'PASSENGER' }, t, {
        cancellationZone: zone,
        chargedFare: charged,
        fullTripEstimate: settled.previousEstimate,
      });
      return { settled, charged };
    });

    res.json({
      message: 'You left the ride. You will be charged for the part you travelled.',
      rideId,
      status: 'CANCELLED_IN_TRANSIT',
      cancellationZone: zone,
      fare: passengerBill(result.settled.bill, result.charged, result.settled.previousEstimate),
      payment: await paymentOf(rideId, passengerId),
    });
  } catch (error: any) {
    if (error.message === 'NOT_IN_TRANSIT') {
      return res.status(409).json({ error: 'This ride is no longer in progress.', code: 'NOT_IN_TRANSIT' });
    }
    console.error('Passenger cancel-in-transit error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
