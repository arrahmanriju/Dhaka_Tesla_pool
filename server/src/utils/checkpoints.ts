import { randomUUID } from 'crypto';
import { Transaction } from 'sequelize';
import { PoolCheckpoint, RideRequest } from '../models';
import { CheckpointKind } from '../models/PoolCheckpoint';
import { FarePoint, SegmentFare, segmentFare } from './fareCalculator';

/**
 * Records a checkpoint. Call it inside the transaction that changed the ride's status, AFTER the
 * change: the passenger count is the number of rides on the vehicle that are STARTED right then
 * (so it is "previous + 1" when a ride boards and "previous - 1" when one leaves).
 */
async function addCheckpoint(
  ride: { id: string; vehicleId?: string | null },
  zone: string,
  kind: CheckpointKind,
  transaction: Transaction | null
): Promise<PoolCheckpoint | null> {
  if (!ride.vehicleId) return null;
  const passengerCount = await RideRequest.count({ where: { vehicleId: ride.vehicleId, status: 'STARTED' }, transaction });
  const latest = await PoolCheckpoint.findOne({ where: { vehicleId: ride.vehicleId }, order: [['id', 'DESC']], transaction });
  // Same run while people are still on board; a new run when a passenger boards an empty vehicle.
  const continuing = latest !== null && latest.passengerCount > 0 && kind !== 'TRIP_STARTED';
  return PoolCheckpoint.create(
    { runId: continuing ? latest.runId : randomUUID(), vehicleId: ride.vehicleId, zone, passengerCount, kind, rideRequestId: ride.id },
    { transaction }
  );
}

/** The ride has just become STARTED: it boards at its pickup zone. */
export async function recordBoarding(
  ride: { id: string; vehicleId?: string | null; pickupZone: string },
  transaction: Transaction | null = null
) {
  if (!ride.vehicleId) return null;
  const onBoard = await RideRequest.count({ where: { vehicleId: ride.vehicleId, status: 'STARTED' }, transaction });
  return addCheckpoint(ride, ride.pickupZone, onBoard <= 1 ? 'TRIP_STARTED' : 'PASSENGER_JOINED', transaction);
}

/** The ride has just ended (COMPLETED at its destination, or CANCELLED_IN_TRANSIT at the cancellation zone). */
export async function recordExit(
  ride: { id: string; vehicleId?: string | null },
  kind: 'PASSENGER_DROPPED_OFF' | 'PASSENGER_LEFT',
  zone: string,
  transaction: Transaction | null = null
) {
  return addCheckpoint(ride, zone, kind, transaction);
}

/**
 * The checkpoints of one passenger's journey, from where they boarded to where they got off
 * (inclusive), or up to the latest checkpoint while they are still on board. null when the ride has
 * no boarding checkpoint (a ride that started before checkpoints existed).
 */
export async function journeyPoints(
  rideId: string,
  transaction: Transaction | null = null
): Promise<{ points: FarePoint[]; exited: boolean; zones: string[] } | null> {
  const boarding = await PoolCheckpoint.findOne({
    where: { rideRequestId: rideId, kind: ['TRIP_STARTED', 'PASSENGER_JOINED'] },
    order: [['id', 'ASC']],
    transaction,
  });
  if (!boarding) return null;

  const run: PoolCheckpoint[] = await PoolCheckpoint.findAll({
    where: { runId: boarding.runId, vehicleId: boarding.vehicleId },
    order: [['id', 'ASC']],
    transaction,
  });
  const journey: PoolCheckpoint[] = [];
  let exited = false;
  for (const cp of run) {
    if (cp.id < boarding.id) continue;
    journey.push(cp);
    if (cp.rideRequestId === rideId && (cp.kind === 'PASSENGER_LEFT' || cp.kind === 'PASSENGER_DROPPED_OFF')) {
      exited = true;
      break;
    }
  }
  return {
    points: journey.map((c) => ({ zone: c.zone, passengerCount: c.passengerCount })),
    zones: journey.map((c) => c.zone),
    exited,
  };
}

/**
 * Prices a passenger's journey from the checkpoints.
 *   - once they have exited (their own drop-off / cancellation checkpoint exists): the FINAL fare
 *   - while still on board: an estimate that assumes the passengers now on board stay until the
 *     passenger's original destination (the last stretch runs from the latest checkpoint to it)
 * Returns null for a ride with no boarding checkpoint.
 */
export async function priceJourney(
  ride: { id: string; pickupZone?: string; destinationZone: string; seatCount: number; allowSharing: boolean; baseFare?: number },
  transaction: Transaction | null = null
): Promise<(SegmentFare & { exited: boolean; zones: string[] }) | null> {
  const journey = await journeyPoints(ride.id, transaction);
  if (!journey) return null;
  // A PRIVATE ride is never split, so its fare is the flat price of the route: no segments, no split, no
  // bonus, no rounding. (Nobody else is ever on board, and the checkpoints are not walked.)
  if (!ride.allowSharing && ride.baseFare !== undefined && ride.baseFare > 0) {
    return { segments: [], soloFare: ride.baseFare, fare: ride.baseFare, poolDiscount: 0, exited: journey.exited, zones: journey.zones };
  }
  const priced = segmentFare({
    points: journey.points,
    ...(journey.exited ? {} : { exitZone: ride.destinationZone }),
    seatCount: ride.seatCount,
    allowSharing: ride.allowSharing,
  });
  return { ...priced, exited: journey.exited, zones: journey.zones };
}
