import { DHAKA_ZONES } from '../models/RideRequest';

// ---------------------------------------------------------------------------
// DIRECTION-AWARE POOL COMPATIBILITY
//
// Two ride requests can share a Tesla when they travel the same way along the same corridor.
// No map service is used: every zone has a fixed point on a small grid, and the whole rule is
// integer arithmetic, so it can be checked by hand.
//
// GRID — x grows east, y grows north, 1 unit ≈ 0.5 km. (Rounded from real zone centres, with
// Motijheel near the bottom edge; distances for FARES still come from fareCalculator.ts.)
// ---------------------------------------------------------------------------
export type Point = { x: number; y: number };

export const ZONE_COORDS: Readonly<Record<string, Point>> = {
  Uttara:        { x: 6,  y: 32 },
  Mirpur:        { x: 4,  y: 17 },
  Mohammadpur:   { x: 2,  y: 8 },
  Dhanmondi:     { x: 5,  y: 4 },
  Motijheel:     { x: 14, y: 1 },
  Mohakhali:     { x: 11, y: 11 },
  Banani:        { x: 12, y: 14 },
  Gulshan:       { x: 13, y: 14 },
  'Gulshan 1':   { x: 14, y: 11 },
  Badda:         { x: 15, y: 11 },
};

/** Largest angle (degrees) between two routes that still counts as "the same direction". */
export const MAX_ANGLE_DEGREES = 45;

/** How far (grid units, 4 units = 2 km) a pickup may sit from the line of a trip that has NOT started. */
export const CORRIDOR_UNITS = 4;

/** For a trip UNDER WAY the pickup must be much closer to the road: 2 units = 1 km. */
export const ONBOARD_PICKUP_CORRIDOR_UNITS = 2;

/** A destination may drift at most this far from the road of a trip under way: 4 units = 2 km. */
export const ONBOARD_DESTINATION_CORRIDOR_UNITS = 4;

/** A route as the rule sees it: where it starts and ends. */
export interface RouteLeg {
  pickupZone: string;
  destinationZone: string;
}

export type RouteMismatch = 'DIRECTION' | 'CORRIDOR' | 'NO_OVERLAP';

export type RouteVerdict = { compatible: true } | { compatible: false; reason: RouteMismatch };

const coord = (zone: string): Point => {
  const p = ZONE_COORDS[zone];
  if (!p) throw new Error(`Unknown zone: ${zone}`);
  return p;
};

const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const minus = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });

/** RULE 1 (both cases): the angle between u and v is at most 45°.  u·v > 0 and 2(u·v)² ≥ |u|²|v|² */
const sameDirection = (u: Point, v: Point): boolean => {
  const uv = dot(u, v);
  return uv > 0 && 2 * uv * uv >= dot(u, u) * dot(v, v);
};

/** Is `p` (given as p − origin = w) at most `units` from the line whose direction is u?  (u×w)² ≤ units²·|u|² */
const withinCorridor = (u: Point, w: Point, units: number): boolean => {
  const off = cross(u, w);
  return off * off <= units * units * dot(u, u);
};

// ---------------------------------------------------------------------------
// RULE A — a trip that has NOT started (MATCHED / DRIVER_ARRIVED)
//
// `existing` is a route already in the pool, A → B. `candidate` is the new request, C → D.
//   u = B − A   (the existing route)      v = D − C   (the candidate)      w = C − A
//
//   1. SAME DIRECTION   angle(u, v) ≤ 45°
//   2. IN THE CORRIDOR  C is at most 4 units (2 km) from the line through A and B:  (u×w)² ≤ 4²·|u|²
//   3. THEY OVERLAP     measured along u, C is before B and D is after A:  u·w < |u|²  and  u·(D−A) > 0
//
// Identical routes always pass. A pool is compatible with a candidate only when EVERY route in it is.
// ---------------------------------------------------------------------------
export function checkRoutes(existing: RouteLeg, candidate: RouteLeg): RouteVerdict {
  const A = coord(existing.pickupZone);
  const B = coord(existing.destinationZone);
  const C = coord(candidate.pickupZone);
  const D = coord(candidate.destinationZone);

  const u = minus(B, A);
  const v = minus(D, C);
  const w = minus(C, A);

  if (!sameDirection(u, v)) return { compatible: false, reason: 'DIRECTION' };
  if (!withinCorridor(u, w, CORRIDOR_UNITS)) return { compatible: false, reason: 'CORRIDOR' };
  if (dot(u, w) >= dot(u, u) || dot(u, minus(D, A)) <= 0) return { compatible: false, reason: 'NO_OVERLAP' };
  return { compatible: true };
}

export const areRoutesCompatible = (existing: RouteLeg, candidate: RouteLeg): boolean =>
  checkRoutes(existing, candidate).compatible;

// ---------------------------------------------------------------------------
// RULE B — a trip UNDER WAY (at least one ride on the vehicle is STARTED). Stricter.
//
// There is no live GPS, so the vehicle's route is worked out from the rides on board (STARTED):
//
//   P  current position  = the pickup zone of the MOST RECENTLY started onboard ride
//                          (the car has at least reached the last place it picked someone up)
//   F  final destination = the destination of an onboard ride that is FARTHEST from P
//                          (squared grid distance; first one wins a tie)
//   u  = F − P   the road still ahead
//
// A request C → D (v = D − C, w = C − P) is offered only if ALL hold:
//
//   (a) PICKUP ON THE ROAD AHEAD, with no real detour
//       a1. not behind the car             u·w ≥ 0
//       a2. before the end of the road     u·w < |u|²
//       a3. no real detour     at most 2 units (1 km) from the line P→F:  (u×w)² ≤ 2²·|u|²
//   (b) DESTINATION CONTINUES THE SAME WAY
//       b1. same direction as EVERY onboard passenger (angle between their own route and v ≤ 45°)
//       b2. D at most 4 units (2 km) from the line P→F, before F or beyond it:  (u×(D−P))² ≤ 4²·|u|²
//
// The pending list hides anything that fails; the accept route refuses it.
// ---------------------------------------------------------------------------
export type OnboardMismatch =
  | 'DIRECTION'
  | 'PICKUP_BEHIND'
  | 'PICKUP_PAST_END'
  | 'PICKUP_OFF_ROUTE'
  | 'DESTINATION_OFF_ROUTE';

export type OnboardVerdict = { compatible: true } | { compatible: false; reason: OnboardMismatch };

/** An onboard ride; `order` grows with the time it started (later = larger). */
export interface OnboardLeg extends RouteLeg {
  order: number;
}

/** P and F for the rides on board. `legs` must not be empty. */
export function onboardRoute(legs: OnboardLeg[]): { position: string; finalDestination: string } {
  const latest = legs.reduce((best, l) => (l.order > best.order ? l : best), legs[0]!);
  const P = coord(latest.pickupZone);
  const dist2 = (zone: string) => {
    const d = minus(coord(zone), P);
    return dot(d, d);
  };
  const farthest = legs.reduce((best, l) => (dist2(l.destinationZone) > dist2(best.destinationZone) ? l : best), latest);
  return { position: latest.pickupZone, finalDestination: farthest.destinationZone };
}

export function checkOnboardRoute(legs: OnboardLeg[], candidate: RouteLeg): OnboardVerdict {
  const { position, finalDestination } = onboardRoute(legs);
  const P = coord(position);
  const u = minus(coord(finalDestination), P);
  const C = coord(candidate.pickupZone);
  const D = coord(candidate.destinationZone);
  const v = minus(D, C);
  const w = minus(C, P);

  // (b1) same direction as everyone on board
  for (const l of legs) {
    if (!sameDirection(minus(coord(l.destinationZone), coord(l.pickupZone)), v)) {
      return { compatible: false, reason: 'DIRECTION' };
    }
  }
  // (a1, a2, a3) the pickup is on the road ahead
  if (dot(u, w) < 0) return { compatible: false, reason: 'PICKUP_BEHIND' };
  if (dot(u, w) >= dot(u, u)) return { compatible: false, reason: 'PICKUP_PAST_END' };
  if (!withinCorridor(u, w, ONBOARD_PICKUP_CORRIDOR_UNITS)) return { compatible: false, reason: 'PICKUP_OFF_ROUTE' };
  // (b2) the destination stays near the road
  if (!withinCorridor(u, minus(D, P), ONBOARD_DESTINATION_CORRIDOR_UNITS)) {
    return { compatible: false, reason: 'DESTINATION_OFF_ROUTE' };
  }
  return { compatible: true };
}

/** Sanity check used by tests: every zone the app offers has a grid point. */
export const zonesWithoutCoordinates = (): string[] => DHAKA_ZONES.filter((z) => !ZONE_COORDS[z]);
