import { Op, Transaction } from 'sequelize';
import { RideEvent, RideRequest } from '../models';
import { POOL_JOINABLE_STATUSES } from '../models/RideRequest';
import { checkOnboardRoute, checkRoutes, OnboardLeg, RouteLeg } from './routeDirection';

/** The parts of a ride the pooling rules look at. */
export interface PoolRide extends RouteLeg {
  status: string;
  allowSharing: boolean;
  /** For a STARTED ride: grows with the time it started (later = larger). */
  startedOrder?: number | undefined;
}

/**
 * The rides currently on a vehicle (MATCHED, DRIVER_ARRIVED, STARTED), with the order in which the
 * STARTED ones started (from the lifecycle history). Read inside the accepting transaction so the
 * pool is seen exactly as it is under the write lock.
 */
export async function loadPool(vehicleId: string, transaction: Transaction | null = null): Promise<PoolRide[]> {
  const rides: any[] = await RideRequest.findAll({
    where: { vehicleId, status: { [Op.in]: [...POOL_JOINABLE_STATUSES] } },
    transaction,
  });
  const startedIds = rides.filter((r) => r.status === 'STARTED').map((r) => r.id as string);
  const order = new Map<string, number>();
  if (startedIds.length > 0) {
    const events: any[] = await RideEvent.findAll({
      where: { rideRequestId: { [Op.in]: startedIds }, status: 'STARTED' },
      attributes: ['rideRequestId', 'id'],
      transaction,
    });
    for (const e of events) order.set(e.rideRequestId, Math.max(order.get(e.rideRequestId) ?? 0, e.id));
  }
  return rides.map((r) => ({
    pickupZone: r.pickupZone,
    destinationZone: r.destinationZone,
    status: r.status,
    allowSharing: r.allowSharing,
    startedOrder: r.status === 'STARTED' ? (order.get(r.id) ?? 0) : undefined,
  }));
}

export type PoolVerdict =
  | { ok: true }
  | { ok: false; code: 'CANDIDATE_IS_PRIVATE' | 'VEHICLE_IS_PRIVATE' | 'ROUTE_MISMATCH'; message: string };

const WHY: Record<string, string> = {
  DIRECTION: 'it does not head the same way',
  CORRIDOR: 'its pickup is too far from that route',
  NO_OVERLAP: 'the two trips do not share any road',
  PICKUP_BEHIND: 'its pickup is behind the vehicle',
  PICKUP_PAST_END: 'its pickup is past the end of the vehicle’s route',
  PICKUP_OFF_ROUTE: 'its pickup is not on the vehicle’s route',
  DESTINATION_OFF_ROUTE: 'its destination leaves the vehicle’s route',
};

/**
 * Can `candidate` (a REQUESTED ride) join the rides already on a vehicle?
 *
 *   1. A private ride needs an empty vehicle, and a vehicle carrying a private ride takes nobody.
 *   2. If any ride on the vehicle has STARTED, the candidate must fit the road the vehicle is
 *      actually on (checkOnboardRoute: pickup on the road ahead with no real detour, destination
 *      continuing the same way). This is the strict test for a trip under way.
 *   3. Against rides that have not started yet, the candidate needs the ordinary direction and
 *      corridor test (checkRoutes) with each of them.
 *   An empty vehicle accepts any route.
 *
 * Whether a seat is free is decided separately, by the atomic seat claim in the accept route.
 * Used by both the driver's pending list and the accept route, so the two can never disagree.
 */
export function checkPoolJoin(pool: PoolRide[], candidate: PoolRide): PoolVerdict {
  if (!candidate.allowSharing && pool.length > 0) {
    return {
      ok: false,
      code: 'CANDIDATE_IS_PRIVATE',
      message: 'This is a private ride request: it needs a vehicle with no other passengers.',
    };
  }
  if (pool.some((r) => !r.allowSharing)) {
    return {
      ok: false,
      code: 'VEHICLE_IS_PRIVATE',
      message: 'Cannot add a passenger: this vehicle is carrying a private ride.',
    };
  }

  const mismatch = (reason: string) => ({
    ok: false as const,
    code: 'ROUTE_MISMATCH' as const,
    message: `Pool incompatible: ${candidate.pickupZone} → ${candidate.destinationZone} cannot join this vehicle: ${WHY[reason]}.`,
  });

  const onboard: OnboardLeg[] = pool
    .filter((r) => r.status === 'STARTED')
    .map((r) => ({ pickupZone: r.pickupZone, destinationZone: r.destinationZone, order: r.startedOrder ?? 0 }));
  if (onboard.length > 0) {
    const verdict = checkOnboardRoute(onboard, candidate);
    if (!verdict.compatible) return mismatch(verdict.reason);
  }

  for (const r of pool.filter((x) => x.status !== 'STARTED')) {
    const verdict = checkRoutes(r, candidate);
    if (!verdict.compatible) return mismatch(verdict.reason);
  }

  return { ok: true };
}
