import { Op, Transaction } from 'sequelize';
import { fn, col, where as sqlWhere } from 'sequelize';
import { sequelize, Vehicle, RideRequest, QRRideSession, QRRideParticipant, DriverBonus } from '../models';
import { ACTIVE_RIDE_STATUSES, DHAKA_ZONES, MAX_SEATS_PER_RIDE } from '../models/RideRequest';
import { calculateBaseFare, segmentDistanceKm, segmentFare } from '../utils/fareCalculator';
import { claimSeats, releaseSeats } from '../utils/seats';
import { compactVehicleCode, normalizeVehicleCode } from '../utils/vehicleCode';

// ---------------------------------------------------------------------------
// STREET RIDES BY QR CODE
//
// For drivers with no smartphone. The driver never logs in and never does anything here: every state
// change is triggered by a passenger (scan or type the vehicle code, join, "I have arrived"), and a
// timer closes anything nobody closed.
//
//   1. A passenger scans the QR on the vehicle (or types its vehicleCode). If the vehicle has no OPEN
//      session, one is created with that passenger; if it has one, they join it. No route-compatibility
//      check: driver and passenger already agreed on the street. Only capacity is enforced, by the same
//      atomic seat claim the app flow uses (utils/seats.ts).
//   2. Fares use the app's segment formula (utils/fareCalculator.ts segmentFare): the trip cost spread over
//      the journey, each stretch alone at its share, or split between the riders on board (rounded up) + ৳20.
//      The "checkpoints" are simply the joins and exits of this session, in order.
//   3. Each passenger marks their own arrival. When everyone has, the session closes.
//   4. A session still OPEN after QR_SESSION_TIMEOUT_MINUTES is closed automatically and every passenger
//      who never confirmed is AUTO_COMPLETED.
//
// PAYMENT IS CASH ONLY, and the wallet is never touched. Why: the driver has no app and no wallet
// account, so there is nobody to credit and nothing on the driver's side to confirm a transfer. The
// passenger pays the driver in cash at the end; the app only records the amount owed.
//
// PRIVACY: the passengers in one car see each other only as "Passenger 1", "Passenger 2" (join order),
// never names, phones, ids, routes or fares, exactly like the app flow, even though they are physically
// together. The driver's identity is never returned to passengers at all.
// ---------------------------------------------------------------------------

/**
 * How long a session may stay OPEN before it is closed automatically. 90 minutes: longer than any
 * realistic trip across Dhaka even in bad traffic (the longest zone hop is under an hour), yet short
 * enough that a forgotten session does not keep a car "occupied" through the next trip. Measured from
 * when the session opened, as specified; it is a plain environment setting if it needs tuning.
 */
export const QR_SESSION_TIMEOUT_MINUTES = Number(process.env.QR_SESSION_TIMEOUT_MINUTES) || 90;

/** Credited to the driver's record for every passenger beyond the first in a session (whole taka). */
export const DRIVER_BONUS_PER_EXTRA_PASSENGER = 10;

/** An error with the HTTP status and code the route should answer with. */
export class QRError extends Error {
  constructor(public status: number, public code: string, message: string, public fields?: Record<string, string>) {
    super(message);
  }
}

const IMMEDIATE = { type: Transaction.TYPES.IMMEDIATE };

/**
 * The ONE place a code is turned into a vehicle: the `Vehicles.vehicleCode` column, compared without
 * hyphens, so "DTP-0001", "dtp-0001" and "DTP0001" all find the same active vehicle. (For an onboarded
 * driver that code is their Tesla ID, the same value the app shows as "Tesla ID".)
 */
async function findVehicleByCode(canonicalCode: string, transaction?: Transaction) {
  return Vehicle.findOne({
    where: {
      [Op.and]: [
        sqlWhere(fn('REPLACE', col('vehicleCode'), '-', ''), compactVehicleCode(canonicalCode)),
        { isActive: true },
      ],
    },
    ...(transaction ? { transaction } : {}),
  });
}

// ─────────────────────────── fares from the joins and exits ───────────────────────────

/**
 * The fare for one passenger, from the order in which people joined and got off. Each join or exit is a
 * checkpoint (zone, passengers on board after it); the passenger's own journey runs from their join to
 * their exit, and segmentFare prices every stretch for who was on board. While they
 * are still riding, the last stretch is estimated to their destination with whoever is on board now.
 */
export function priceParticipant(all: QRRideParticipant[], target: QRRideParticipant) {
  type Ev = { seq: number; zone: string; delta: 1 | -1; pid: string; kind: 'join' | 'exit' };
  const events: Ev[] = [];
  for (const p of all) {
    events.push({ seq: p.joinSeq, zone: p.pickupZone, delta: 1, pid: p.id, kind: 'join' });
    if (p.exitSeq !== null) events.push({ seq: p.exitSeq, zone: p.destinationZone, delta: -1, pid: p.id, kind: 'exit' });
  }
  events.sort((a, b) => a.seq - b.seq);
  let count = 0;
  const counted = events.map((e) => ({ ...e, count: (count += e.delta) }));

  const start = counted.findIndex((e) => e.pid === target.id && e.kind === 'join');
  const exited = target.exitSeq !== null;
  const end = exited ? counted.findIndex((e) => e.pid === target.id && e.kind === 'exit') : counted.length - 1;
  const points = counted.slice(start, end + 1).map((e) => ({ zone: e.zone, passengerCount: e.count }));

  return segmentFare({
    points,
    ...(exited ? {} : { exitZone: target.destinationZone }),
    seatCount: target.seatCount,
  });
}

// ─────────────────────────── closing ───────────────────────────

/** Records an exit for a participant (in memory; the caller saves) and takes the next event number. */
function nextSeq(session: QRRideSession): number {
  session.eventSeq += 1;
  return session.eventSeq;
}

/** Saves final fares for participants that have just exited, releases their seats. */
async function settleAndRelease(
  vehicleId: string,
  all: QRRideParticipant[],
  exiting: QRRideParticipant[],
  transaction: Transaction
): Promise<void> {
  for (const p of exiting) {
    const priced = priceParticipant(all, p);
    p.finalFare = priced.fare;
    p.poolDiscount = priced.poolDiscount;
    // Cash only: record what is owed to the driver, do not touch any wallet (see the top of this file)
    p.paymentMethod = 'cash';
    p.paymentStatus = 'CASH_DUE';
    p.paymentAmount = priced.fare;
    await p.save({ transaction });
    await releaseSeats(vehicleId, p.seatCount, transaction);
  }
}

/** Closes a session whose passengers have all finished, or timed out. Call inside an IMMEDIATE transaction. */
async function closeSession(session: QRRideSession, reason: 'ALL_ARRIVED' | 'TIMEOUT', now: Date, transaction: Transaction) {
  session.status = 'CLOSED';
  session.closedAt = now;
  session.closeReason = reason;
  await session.save({ transaction });
}

/**
 * Closes every session that has been OPEN longer than QR_SESSION_TIMEOUT_MINUTES. Each passenger who
 * never confirmed arrival becomes AUTO_COMPLETED, is charged as if they had arrived at their destination
 * (exits are ordered shortest trip first, then by join order), their seats are released and the session is CLOSED (TIMEOUT).
 * Runs before every street-ride request and once a minute (index.ts), and `now` can be passed in tests.
 * Returns how many sessions were closed.
 */
export async function closeStaleSessions(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - QR_SESSION_TIMEOUT_MINUTES * 60_000);
  const stale = await QRRideSession.findAll({ where: { status: 'OPEN', openedAt: { [Op.lt]: cutoff } }, attributes: ['id'] });
  let closed = 0;
  for (const { id } of stale) {
    await sequelize.transaction(IMMEDIATE, async (t) => {
      const session = await QRRideSession.findOne({ where: { id, status: 'OPEN' }, transaction: t }); // re-read under the lock
      if (!session) return; // someone closed it a moment ago
      const all = await QRRideParticipant.findAll({ where: { sessionId: id }, order: [['joinSeq', 'ASC']], transaction: t });
      // Nobody said where or when they got off, so assume shorter trips ended first (ties: who joined first).
      // Ordering by join alone would have someone with a nearby destination "ride on" to a far one and back.
      const riding = all
        .filter((p) => p.status === 'RIDING')
        .sort((a, b) =>
          segmentDistanceKm(a.pickupZone, a.destinationZone) - segmentDistanceKm(b.pickupZone, b.destinationZone) || a.joinSeq - b.joinSeq);
      for (const p of riding) {
        p.exitSeq = nextSeq(session);
        p.exitedAt = now;
        p.status = 'AUTO_COMPLETED';
      }
      await settleAndRelease(session.vehicleId, all, riding, t);
      await closeSession(session, 'TIMEOUT', now, t);
      closed++;
    });
  }
  return closed;
}

// ─────────────────────────── joining ───────────────────────────

export interface JoinInput {
  passengerId: string;
  vehicleCode: unknown;
  pickupZone: unknown;
  destinationZone: unknown;
  seatCount?: unknown;
  /** The session the passenger saw when they scanned. If it has closed since, joining is refused (never a silent new one). */
  sessionId?: unknown;
  paymentMethod?: unknown;
  now?: Date;
}

function validateJoin(input: JoinInput) {
  const fields: Record<string, string> = {};
  const code = normalizeVehicleCode(input.vehicleCode);
  if (!code) fields.vehicleCode = 'Enter the code shown on the vehicle sticker.';
  const isZone = (z: unknown): z is string => typeof z === 'string' && (DHAKA_ZONES as readonly string[]).includes(z);
  if (!isZone(input.pickupZone)) fields.pickupZone = 'Choose a valid pickup zone.';
  if (!isZone(input.destinationZone)) fields.destinationZone = 'Choose a valid destination zone.';
  if (!fields.pickupZone && !fields.destinationZone && input.pickupZone === input.destinationZone) {
    fields.destinationZone = 'Pickup and destination zones cannot be the same.';
  }
  const seatCount = input.seatCount === undefined ? 1 : input.seatCount;
  if (typeof seatCount !== 'number' || !Number.isInteger(seatCount) || seatCount < 1 || seatCount > MAX_SEATS_PER_RIDE) {
    fields.seatCount = `Seats must be a whole number from 1 to ${MAX_SEATS_PER_RIDE}.`;
  }
  if (input.paymentMethod !== undefined && input.paymentMethod !== 'cash') {
    fields.paymentMethod = 'Street rides are paid in cash to the driver.';
  }
  if (input.sessionId !== undefined && typeof input.sessionId !== 'string') fields.sessionId = 'Invalid ride.';
  if (Object.keys(fields).length > 0) {
    throw new QRError(400, 'VALIDATION', Object.values(fields)[0]!, fields);
  }
  return {
    code: code!,
    pickupZone: input.pickupZone as string,
    destinationZone: input.destinationZone as string,
    seatCount: seatCount as number,
    sessionId: input.sessionId as string | undefined,
  };
}

/**
 * Joins the vehicle's OPEN session, or opens one. Everything happens in one IMMEDIATE transaction, so two
 * passengers scanning at the same moment run one after the other: the second finds the session the first
 * opened, and the last seat can only be claimed once (claimSeats).
 * Returns the ids; read the passenger's own view with getSessionView().
 */
export async function joinSession(input: JoinInput): Promise<{ sessionId: string; participantId: string }> {
  const v = validateJoin(input);
  const now = input.now ?? new Date();
  await closeStaleSessions(now);

  return sequelize.transaction(IMMEDIATE, async (t) => {
    const vehicle = await findVehicleByCode(v.code, t);
    if (!vehicle) {
      throw new QRError(404, 'VEHICLE_NOT_FOUND', "We couldn't find a vehicle with that code. Check the code on the sticker and try again.");
    }

    // One place at a time: not in an app ride, and not already in a street ride
    const appRide = await RideRequest.findOne({
      where: { passengerId: input.passengerId, status: { [Op.in]: [...ACTIVE_RIDE_STATUSES] } },
      transaction: t,
    });
    if (appRide) {
      throw new QRError(409, 'ACTIVE_RIDE_EXISTS', 'You already have an active ride. Finish or cancel it before joining a street ride.');
    }
    // (a RIDING participant only ever exists in an OPEN session: closing a session finishes everyone)
    const already = await QRRideParticipant.findOne({
      where: { passengerId: input.passengerId, status: 'RIDING' },
      transaction: t,
    });
    if (already) throw new QRError(409, 'ALREADY_IN_SESSION', "You're already on a street ride. Tap \"I've arrived\" when you get off.");

    let session = await QRRideSession.findOne({ where: { vehicleId: vehicle.id, status: 'OPEN' }, transaction: t });
    if (v.sessionId) {
      // The passenger is joining the ride they were shown: if it ended meanwhile, refuse rather than open a different one
      if (!session || session.id !== v.sessionId) {
        throw new QRError(409, 'SESSION_CLOSED', 'This ride has already ended. Scan the code again to start a new one.');
      }
    }
    // Someone who already finished their leg of THIS still-open ride cannot join it a second time (one place per
    // session); a clear message beats a database error. They can start a new ride once this one has closed.
    if (session) {
      const finishedHere = await QRRideParticipant.findOne({ where: { sessionId: session.id, passengerId: input.passengerId }, transaction: t });
      if (finishedHere) {
        throw new QRError(409, 'ALREADY_IN_THIS_RIDE', "You've already finished your trip in this vehicle's current ride. You can start a new one once it ends.");
      }
    }
    if (!session) session = await QRRideSession.create({ vehicleId: vehicle.id, openedAt: now }, { transaction: t });

    // Capacity: the same atomic claim the app flow uses. No claim, no join (and the transaction rolls back).
    if (!(await claimSeats(vehicle.id, v.seatCount, t))) {
      throw new QRError(409, 'CAPACITY_EXCEEDED', 'Not enough seats available.');
    }

    const before = await QRRideParticipant.count({ where: { sessionId: session.id }, transaction: t });
    const joinSeq = nextSeq(session);
    await session.save({ transaction: t });

    const participant = await QRRideParticipant.create(
      {
        sessionId: session.id,
        passengerId: input.passengerId,
        passengerNumber: before + 1,
        pickupZone: v.pickupZone,
        destinationZone: v.destinationZone,
        seatCount: v.seatCount,
        joinedAt: now,
        joinSeq,
        baseFare: calculateBaseFare(v.pickupZone, v.destinationZone, v.seatCount),
      },
      { transaction: t }
    );

    // A small fixed bonus for the driver for every passenger beyond the first
    if (before >= 1) {
      await DriverBonus.create(
        { driverId: vehicle.driverId, sessionId: session.id, participantId: participant.id, amount: DRIVER_BONUS_PER_EXTRA_PASSENGER },
        { transaction: t }
      );
    }
    return { sessionId: session.id, participantId: participant.id };
  });
}

// ─────────────────────────── arriving ───────────────────────────

/** The passenger marks their own leg as done. No driver confirmation exists or is needed. */
export async function markArrived(input: { passengerId: string; sessionId: string; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  await closeStaleSessions(now);

  await sequelize.transaction(IMMEDIATE, async (t) => {
    const session = await QRRideSession.findByPk(input.sessionId, { transaction: t });
    if (!session) throw new QRError(404, 'SESSION_NOT_FOUND', 'That ride could not be found.');
    const me = await QRRideParticipant.findOne({ where: { sessionId: session.id, passengerId: input.passengerId }, transaction: t });
    if (!me) throw new QRError(403, 'NOT_YOUR_RIDE', 'This is not your ride.');
    if (session.status !== 'OPEN') throw new QRError(409, 'SESSION_CLOSED', 'This ride has already ended.');
    if (me.status !== 'RIDING') throw new QRError(409, 'ALREADY_ARRIVED', "You've already marked this ride as finished.");

    const all = await QRRideParticipant.findAll({ where: { sessionId: session.id }, order: [['joinSeq', 'ASC']], transaction: t });
    const mine = all.find((p) => p.id === me.id)!;
    mine.exitSeq = nextSeq(session);
    mine.exitedAt = now;
    mine.status = 'ARRIVED';
    await settleAndRelease(session.vehicleId, all, [mine], t);

    if (all.every((p) => p.status !== 'RIDING')) await closeSession(session, 'ALL_ARRIVED', now, t);
    else await session.save({ transaction: t });
  });
}

// ─────────────────────────── what each side sees ───────────────────────────

/**
 * A session as ONE passenger may see it. The other passengers appear only as "Passenger N" with whether
 * they are still riding: no names, phones, ids, zones or fares. The driver's identity is not included.
 * Throws 403 unless the viewer is a passenger of the session.
 */
export async function getSessionView(sessionId: string, viewerId: string) {
  const session = await QRRideSession.findByPk(sessionId);
  if (!session) throw new QRError(404, 'SESSION_NOT_FOUND', 'That ride could not be found.');
  const all = await QRRideParticipant.findAll({ where: { sessionId }, order: [['passengerNumber', 'ASC']] });
  const me = all.find((p) => p.passengerId === viewerId);
  if (!me) throw new QRError(403, 'NOT_YOUR_RIDE', 'This is not your ride.');
  const vehicle = await Vehicle.findByPk(session.vehicleId, { attributes: ['vehicleCode', 'modelName', 'seatCapacity', 'occupiedSeats'] });

  const finished = me.status !== 'RIDING';
  const priced = priceParticipant(all, me);
  return {
    id: session.id,
    status: session.status,
    openedAt: session.openedAt,
    closedAt: session.closedAt,
    closeReason: session.closeReason,
    autoCloseAfterMinutes: QR_SESSION_TIMEOUT_MINUTES,
    vehicle: {
      vehicleCode: vehicle?.vehicleCode ?? null,
      nickname: vehicle?.modelName ?? null,
      seatCapacity: vehicle?.seatCapacity ?? null,
      seatsFree: vehicle ? vehicle.seatCapacity - vehicle.occupiedSeats : null,
    },
    you: {
      passengerNumber: me.passengerNumber,
      pickupZone: me.pickupZone,
      destinationZone: me.destinationZone,
      seatCount: me.seatCount,
      status: me.status,
      joinedAt: me.joinedAt,
      exitedAt: me.exitedAt,
      baseFare: me.baseFare,
      // the final fare once their own journey has ended, otherwise a running estimate
      fare: finished ? me.finalFare : priced.fare,
      fareFinal: finished,
      poolDiscount: finished ? me.poolDiscount : priced.poolDiscount,
      // stretch by stretch, without zone names (they would show where the others joined and left)
      fareBreakdown: {
        segments: priced.segments.map((s) => ({
          distanceKm: s.distanceKm,
          passengers: s.passengers,
          driverBonus: s.driverBonus,
          charge: s.charge,
        })),
      },
      payment: { method: 'cash' as const, status: me.paymentStatus, amount: me.paymentAmount },
    },
    passengers: all.map((p) => ({
      label: `Passenger ${p.passengerNumber}`,
      isYou: p.id === me.id,
      status: p.status,
    })),
  };
}

/**
 * The street ride the passenger is on RIGHT NOW, or null. Once their own leg has ended (they tapped "I've
 * arrived", or the session timed out, or it closed) it is not an active ride any more: the Street Ride page
 * goes back to "scan or enter a vehicle code", and the trip lives in the passenger's ride history
 * (getQRHistory). (A RIDING participant only ever exists in an OPEN session.)
 */
export async function getActiveSessionView(passengerId: string) {
  const riding = await QRRideParticipant.findOne({ where: { passengerId, status: 'RIDING' } });
  return riding ? getSessionView(riding.sessionId, passengerId) : null;
}

/**
 * The passenger's FINISHED street trips, shaped like the app's ride-history rows so the one history list
 * (GET /passenger/rides/history) can show both. `source: 'QR'` tells them apart from `'APP'` rides, and
 * `qr` carries what only a street trip has. `updatedAt` is when the passenger's own trip ended, the date the
 * list is sorted by. Only this passenger's own trips: co-passengers never appear, and `driverBonus` is the
 * bonus THEIR joining earned the driver (10 for a second or later passenger, 0 for the first).
 */
export async function getQRHistory(passengerId: string) {
  const trips = await QRRideParticipant.findAll({
    where: { passengerId, status: { [Op.in]: ['ARRIVED', 'AUTO_COMPLETED'] } },
    order: [['exitedAt', 'DESC']],
  });
  if (trips.length === 0) return [];
  const sessions = await QRRideSession.findAll({ where: { id: { [Op.in]: trips.map((t) => t.sessionId) } } });
  const vehicles = await Vehicle.findAll({
    where: { id: { [Op.in]: sessions.map((s) => s.vehicleId) } },
    attributes: ['id', 'vehicleCode', 'modelName'],
  });
  const bonuses = await DriverBonus.findAll({ where: { participantId: { [Op.in]: trips.map((t) => t.id) } } });
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const vehicleById = new Map(vehicles.map((v) => [v.id, v]));
  const bonusByTrip = new Map(bonuses.map((b) => [b.participantId, b.amount]));

  return trips.map((p) => {
    const session = sessionById.get(p.sessionId)!;
    const vehicle = vehicleById.get(session.vehicleId);
    return {
      id: p.id,
      source: 'QR' as const,
      pickupZone: p.pickupZone,
      destinationZone: p.destinationZone,
      seatCount: p.seatCount,
      baseFare: p.baseFare,
      estimatedFare: p.finalFare ?? 0, // the final fare, like an app ride's estimatedFare once it has ended
      poolDiscount: p.poolDiscount ?? 0,
      fareFinal: true,
      status: 'COMPLETED' as const, // the passenger's trip is complete (see qr.autoCompleted for how it ended)
      cancellationZone: null,
      paymentMethod: 'cash' as const,
      paymentStatus: p.paymentStatus,
      paymentAmount: p.paymentAmount,
      timeline: [],
      vehicleId: session.vehicleId,
      createdAt: p.joinedAt,
      updatedAt: p.exitedAt ?? p.joinedAt,
      qr: {
        sessionId: session.id,
        passengerNumber: p.passengerNumber,
        autoCompleted: p.status === 'AUTO_COMPLETED',
        joinedAt: p.joinedAt,
        exitedAt: p.exitedAt,
        sessionStatus: session.status,
        sessionClosedAt: session.closedAt,
        sessionCloseReason: session.closeReason,
        vehicleCode: vehicle?.vehicleCode ?? null,
        vehicleNickname: vehicle?.modelName ?? null,
        driverBonus: bonusByTrip.get(p.id) ?? 0,
      },
    };
  });
}

/** What a passenger sees after scanning, before joining. Reveals nothing about the driver. */
export async function previewVehicle(rawCode: unknown, now: Date = new Date()) {
  const code = normalizeVehicleCode(rawCode);
  const vehicle = code ? await findVehicleByCode(code) : null;
  if (!vehicle) throw new QRError(404, 'VEHICLE_NOT_FOUND', "We couldn't find a vehicle with that code. Check the code on the sticker and try again.");
  await closeStaleSessions(now);
  const open = await QRRideSession.findOne({ where: { vehicleId: vehicle.id, status: 'OPEN' } });
  const count = open ? await QRRideParticipant.count({ where: { sessionId: open.id } }) : 0;
  return {
    vehicleCode: vehicle.vehicleCode,
    vehicle: { nickname: vehicle.modelName, seatCapacity: vehicle.seatCapacity, seatsFree: vehicle.seatCapacity - vehicle.occupiedSeats },
    session: open ? { id: open.id, passengerCount: count } : null,
  };
}

/** A driver's street-ride bonus record (the driver themselves, or an admin report, reads it; passengers never do). */
export async function getDriverBonus(driverId: string) {
  const rows = await DriverBonus.findAll({ where: { driverId }, order: [['id', 'DESC']] });
  return {
    perExtraPassenger: DRIVER_BONUS_PER_EXTRA_PASSENGER,
    total: rows.reduce((s, r) => s + r.amount, 0),
    entries: rows.map((r) => ({ sessionId: r.sessionId, amount: r.amount, at: r.createdAt })),
  };
}
