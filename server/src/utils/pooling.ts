import { areRoutesCompatible, RouteLeg } from './routeDirection';

/** The parts of a ride the pooling rules look at. */
export interface PoolRide extends RouteLeg {
  status: string;
  allowSharing: boolean;
}

export type PoolVerdict =
  | { ok: true }
  | { ok: false; code: 'CANDIDATE_IS_PRIVATE' | 'VEHICLE_IS_PRIVATE' | 'ROUTE_MISMATCH'; message: string };

/**
 * Can `candidate` (a REQUESTED ride) join the rides already on a vehicle?
 *
 * `pool` = the vehicle's rides that are MATCHED, DRIVER_ARRIVED or STARTED. A ride that has STARTED
 * no longer blocks joining: someone whose route runs the same way can be added mid-trip.
 *
 * Every rule here is about WHO may share; whether a seat is free is decided separately, by the atomic
 * seat claim in the accept route (the one place capacity is enforced).
 *
 *   1. A private ride needs an empty vehicle, and a vehicle carrying a private ride takes nobody.
 *   2. The candidate's route must be compatible with EVERY ride in the pool
 *      (direction-aware, see utils/routeDirection.ts). An empty pool accepts any route.
 *
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

  const clash = pool.find(
    (r) =>
      !areRoutesCompatible(
        { pickupZone: r.pickupZone, destinationZone: r.destinationZone, started: r.status === 'STARTED' },
        candidate
      )
  );
  if (clash) {
    return {
      ok: false,
      code: 'ROUTE_MISMATCH',
      message:
        `Pool incompatible: ${candidate.pickupZone} → ${candidate.destinationZone} does not run the same way as ` +
        `${clash.pickupZone} → ${clash.destinationZone} already in this vehicle.`,
    };
  }

  return { ok: true };
}
