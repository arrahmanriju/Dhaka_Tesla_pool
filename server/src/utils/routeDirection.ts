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

/** How far (grid units, 4 units = 2 km) a pickup may sit from the line of an existing route. */
export const CORRIDOR_UNITS = 4;

/** A route as the rule sees it: where it starts and ends, and whether it has already left. */
export interface RouteLeg {
  pickupZone: string;
  destinationZone: string;
  /** true once the trip has STARTED: the car has left its pickup and cannot go back for someone behind it. */
  started?: boolean;
}

export type RouteMismatch = 'DIRECTION' | 'CORRIDOR' | 'NO_OVERLAP' | 'BEHIND_TRIP';

export type RouteVerdict = { compatible: true } | { compatible: false; reason: RouteMismatch };

const coord = (zone: string): Point => {
  const p = ZONE_COORDS[zone];
  if (!p) throw new Error(`Unknown zone: ${zone}`);
  return p;
};

const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const minus = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });

// ---------------------------------------------------------------------------
// THE RULE
//
// `existing` is a route already in the pool, A → B. `candidate` is the new request, C → D.
//   u = B − A   (the existing route)      v = D − C   (the candidate)      w = C − A
//
// The candidate can share the car with `existing` when ALL of these hold:
//
//   1. SAME DIRECTION   the angle between u and v is at most 45°.
//                       In integers:  u·v > 0  and  2·(u·v)² ≥ |u|²·|v|²
//   2. IN THE CORRIDOR  the pickup C is at most 4 units (2 km) from the line through A and B.
//                       In integers:  (u×w)² ≤ 4²·|u|²
//   3. THEY OVERLAP     measured along u, C is before B and D is after A, so the two trips share
//                       part of the road.        In integers:  u·w < |u|²  and  u·(D−A) > 0
//   4. NOT BEHIND       if `existing` has STARTED, the car has already left A, so C must not be
//                       behind A:  u·w ≥ 0.   (There is no live GPS, so "at or past the start of the
//                       started trip" is the closest safe test.)
//
// Identical routes (same pickup, same destination) always pass. A pool is compatible with a
// candidate only when EVERY route in it is (see utils/pooling.ts).
// ---------------------------------------------------------------------------
export function checkRoutes(existing: RouteLeg, candidate: RouteLeg): RouteVerdict {
  const A = coord(existing.pickupZone);
  const B = coord(existing.destinationZone);
  const C = coord(candidate.pickupZone);
  const D = coord(candidate.destinationZone);

  const u = minus(B, A);
  const v = minus(D, C);
  const w = minus(C, A);
  const uu = dot(u, u);
  const vv = dot(v, v);

  // 1. same direction (≤ 45°)
  const uv = dot(u, v);
  if (uv <= 0 || 2 * uv * uv < uu * vv) return { compatible: false, reason: 'DIRECTION' };

  // 2. pickup inside the corridor around the existing route
  const off = cross(u, w);
  if (off * off > CORRIDOR_UNITS * CORRIDOR_UNITS * uu) return { compatible: false, reason: 'CORRIDOR' };

  // 3. the two trips share part of the road
  if (dot(u, w) >= uu || dot(u, minus(D, A)) <= 0) return { compatible: false, reason: 'NO_OVERLAP' };

  // 4. a started trip cannot go back for someone behind its start
  if (existing.started && dot(u, w) < 0) return { compatible: false, reason: 'BEHIND_TRIP' };

  return { compatible: true };
}

export const areRoutesCompatible = (existing: RouteLeg, candidate: RouteLeg): boolean =>
  checkRoutes(existing, candidate).compatible;

/** Sanity check used by tests: every zone the app offers has a grid point. */
export const zonesWithoutCoordinates = (): string[] => DHAKA_ZONES.filter((z) => !ZONE_COORDS[z]);
