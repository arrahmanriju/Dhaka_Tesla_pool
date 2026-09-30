import { DhakaZone, DHAKA_ZONES, MAX_SEATS_PER_RIDE } from '../models/RideRequest';

// ---------------------------------------------------------------------------
// ZONE DISTANCES (km), and the rule that keeps them consistent
//
// Every fare is built from distances (tripCost = 100 + 20 × km × seats, and a journey's segments split
// that cost by their km), so the distances must add up the way roads do. They are therefore NOT a free-form
// table of guesses: DIRECT_KM below lists the direct road distance between zones, and the distances the
// fare code actually uses (ZONE_KM) are derived from it under two rules that are checked when the server
// starts and again by zoneDistances.test.ts:
//
//   1. TRIANGLE INEQUALITY. d(A, C) ≤ d(A, B) + d(B, C) for every three zones. Going through a zone never
//      beats the direct road, so a detour can only cost the same or more. The table is closed under this
//      rule when it is built (shortest paths, Floyd–Warshall), so an entry that is longer than a path through
//      other zones is shortened to that path instead of silently leaving a shortcut.
//   2. CORRIDORS ARE EXACTLY ADDITIVE. ROAD_CORRIDORS lists chains of zones that genuinely lie on one road,
//      in order. For any A, B, C in a corridor (A before B before C), d(A, B) + d(B, C) = d(A, C) exactly.
//      So a journey Gulshan → Mohakhali → Dhanmondi costs the same as Gulshan → Dhanmondi direct
//      (3 + 7 = 10 km, ৳100 + 10 × 20 = ৳300 either way). If the table is edited so a corridor stops adding
//      up, the server refuses to start.
//
// A zone that is NOT on the road between two others is a detour: the sum through it is longer, never shorter.
// isOnRoute(a, b, c) says whether b lies on a shortest route from a to c (the sum equals the direct distance).
// ---------------------------------------------------------------------------
const DIRECT_KM: Record<string, Record<string, number>> = {
  Gulshan:      { Banani: 2, Dhanmondi: 10, Uttara: 12, Mirpur: 9, Motijheel: 8, Mohammadpur: 11, Badda: 3, Mohakhali: 3, 'Gulshan 1': 1 },
  Banani:       { Gulshan: 2, Dhanmondi: 9, Uttara: 10, Mirpur: 8, Motijheel: 9, Mohammadpur: 10, Badda: 4, Mohakhali: 2, 'Gulshan 1': 3 },
  Dhanmondi:    { Gulshan: 10, Banani: 9, Uttara: 16, Mirpur: 7, Motijheel: 6, Mohammadpur: 3, Badda: 11, Mohakhali: 7, 'Gulshan 1': 10 },
  Uttara:       { Gulshan: 12, Banani: 10, Dhanmondi: 16, Mirpur: 9, Motijheel: 18, Mohammadpur: 14, Badda: 14, Mohakhali: 11, 'Gulshan 1': 12 },
  Mirpur:       { Gulshan: 9, Banani: 8, Dhanmondi: 7, Uttara: 9, Motijheel: 12, Mohammadpur: 5, Badda: 10, Mohakhali: 7, 'Gulshan 1': 9 },
  Motijheel:    { Gulshan: 8, Banani: 9, Dhanmondi: 6, Uttara: 18, Mirpur: 12, Mohammadpur: 8, Badda: 9, Mohakhali: 9, 'Gulshan 1': 8 },
  Mohammadpur:  { Gulshan: 11, Banani: 10, Dhanmondi: 3, Uttara: 14, Mirpur: 5, Motijheel: 8, Badda: 12, Mohakhali: 9, 'Gulshan 1': 11 },
  Badda:        { Gulshan: 3, Banani: 4, Dhanmondi: 11, Uttara: 14, Mirpur: 10, Motijheel: 9, Mohammadpur: 12, Mohakhali: 4, 'Gulshan 1': 3 },
  Mohakhali:    { Gulshan: 3, Banani: 2, Dhanmondi: 7, Uttara: 11, Mirpur: 7, Motijheel: 9, Mohammadpur: 9, Badda: 4, 'Gulshan 1': 4 },
  'Gulshan 1':  { Gulshan: 1, Banani: 3, Dhanmondi: 10, Uttara: 12, Mirpur: 9, Motijheel: 8, Mohammadpur: 11, Badda: 3, Mohakhali: 4 },
};

/**
 * Chains of zones that lie on one road, in order. Along a corridor the distances add up exactly (rule 2).
 * Gulshan → Mohakhali → Dhanmondi is the example: 3 + 7 = 10 = Gulshan → Dhanmondi.
 */
export const ROAD_CORRIDORS: ReadonlyArray<readonly string[]> = [
  ['Gulshan', 'Mohakhali', 'Dhanmondi'],
  ['Uttara', 'Mirpur', 'Dhanmondi'],
  ['Uttara', 'Mirpur', 'Mohammadpur'],
  ['Uttara', 'Banani', 'Gulshan'],
  ['Badda', 'Banani', 'Uttara'],
  ['Banani', 'Gulshan', 'Gulshan 1'],
  ['Gulshan 1', 'Gulshan', 'Mohakhali'],
];

/** The distances the fare code uses: DIRECT_KM made symmetric and closed under the triangle inequality. */
function buildZoneKm(direct: Record<string, Record<string, number>>): Record<string, Record<string, number>> {
  const zones = Object.keys(direct);
  const km: Record<string, Record<string, number>> = {};
  for (const a of zones) {
    km[a] = {};
    for (const b of zones) {
      if (a === b) { km[a]![b] = 0; continue; }
      const ab = direct[a]?.[b];
      const ba = direct[b]?.[a];
      if (ab === undefined && ba === undefined) throw new Error(`No distance for ${a} – ${b}`);
      if (ab !== undefined && ba !== undefined && ab !== ba) throw new Error(`${a} – ${b} is ${ab} km one way and ${ba} km the other`);
      const d = (ab ?? ba)!;
      if (!Number.isInteger(d) || d < 1) throw new Error(`${a} – ${b} must be a whole number of km, at least 1`);
      km[a]![b] = d;
    }
  }
  // Shortest paths: nothing is ever longer than the way through another zone (rule 1)
  for (const k of zones) for (const i of zones) for (const j of zones) {
    if (km[i]![k]! + km[k]![j]! < km[i]![j]!) km[i]![j] = km[i]![k]! + km[k]![j]!;
  }
  return km;
}

const ZONE_KM = buildZoneKm(DIRECT_KM);

// Rule 2, checked at start-up: a corridor that does not add up is a bug in the table, not a rounding matter.
for (const corridor of ROAD_CORRIDORS) {
  for (let i = 0; i < corridor.length; i++) for (let j = i + 1; j < corridor.length; j++) for (let k = j + 1; k < corridor.length; k++) {
    const [a, b, c] = [corridor[i]!, corridor[j]!, corridor[k]!];
    if (ZONE_KM[a]![b]! + ZONE_KM[b]![c]! !== ZONE_KM[a]![c]!) {
      throw new Error(`Zone distances are inconsistent: ${a} → ${b} → ${c} is ${ZONE_KM[a]![b]} + ${ZONE_KM[b]![c]} km, but ${a} → ${c} is ${ZONE_KM[a]![c]} km`);
    }
  }
}

/** Does `via` lie on a shortest route from `from` to `to`? (the two legs add up to the direct distance) */
export function isOnRoute(from: string, via: string, to: string): boolean {
  const d = (x: string, y: string) => (x === y ? 0 : ZONE_KM[x]?.[y]);
  const [ab, bc, ac] = [d(from, via), d(via, to), d(from, to)];
  if (ab === undefined || bc === undefined || ac === undefined) throw new Error('Invalid zone');
  return ab + bc === ac;
}

// ---------------------------------------------------------------------------
// Fare constants — all money in this app is WHOLE TAKA (integers, never paisa)
// ---------------------------------------------------------------------------
/** Fixed part of a trip's cost (BDT) */
export const BASE_FARE_BDT = 100;

/** Variable charge per km per seat (BDT) */
export const RATE_PER_KM_PER_SEAT_BDT = 20;

/** Flat driver bonus every passenger pays on each stretch they share with at least one other (BDT). */
export const DRIVER_BONUS_BDT = 20;

/** The Request Ride page quotes the price for a pool of up to this many passengers. */
export const MAX_QUOTED_POOL_SIZE = 3;

// ---------------------------------------------------------------------------
// Distance helper
// ---------------------------------------------------------------------------
function getDistance(pickup: DhakaZone, dropoff: DhakaZone): number {
  if (pickup === dropoff) return 1; // 1 km minimum
  const km = ZONE_KM[pickup]?.[dropoff];
  if (km === undefined) throw new Error('Invalid zone');
  return km;
}

// ---------------------------------------------------------------------------
// calculateBaseFare  =  the TRIP COST of a route
//
// What pickup → destination costs when the passenger rides alone (the trip cost the fare model splits):
//
//   tripCost = 100 + distanceKm × 20 × seatCount        (whole taka)
//
// Example (Gulshan → Dhanmondi, 10 km, 1 seat):  100 + 10 × 20 × 1 = ৳300
// Always a multiple of ৳20. Set once when the ride is requested and never changes.
// ---------------------------------------------------------------------------
export function calculateBaseFare(pickup: string, dropoff: string, seatCount: number): number {
  if (!DHAKA_ZONES.includes(pickup as any) || !DHAKA_ZONES.includes(dropoff as any)) {
    throw new Error('Invalid zone');
  }
  const distanceKm = getDistance(pickup as DhakaZone, dropoff as DhakaZone);
  return BASE_FARE_BDT + distanceKm * RATE_PER_KM_PER_SEAT_BDT * seatCount;
}

// ---------------------------------------------------------------------------
// SEGMENT-BASED FARES
//
// A passenger's journey is cut into SEGMENTS at the pool's CHECKPOINTS (see models/PoolCheckpoint.ts):
// a checkpoint is a zone where the number of passengers on the vehicle changed. Walk the checkpoints
// from where the passenger boarded to where they got off; each consecutive pair is a segment.
//
// For a segment with n passengers on board:
//
//   tripCost(segment) = the passenger's trip cost, spread over their journey by distance:
//                         100 × segKm / journeyKm  +  20 × segKm × seats
//                       (journeyKm = the sum of the segment distances, so the pieces add up to the whole
//                        trip cost: 100 + 20 × journeyKm × seats)
//   n = 1  →  segmentFare = tripCost(segment)                 riding alone: the full cost, nothing changes
//   n ≥ 2  →  segmentFare = ceil(tripCost(segment) / n) + ৳20  an even split, rounded UP, THEN a flat ৳20
//                                                              driver bonus for each passenger sharing the segment
//
//   fare = Σ segmentFare over the segments the passenger was on board for
//
// A passenger who rides the whole route with the same n therefore pays  tripCost / n + 20.
// The bonus applies to a segment that covers distance (a 0 km hop between two checkpoints in the same
// zone earns none). A private ride (allowSharing = false) is always priced as n = 1.
//
// ROUNDING RULE (whole taka, exact, reproducible by hand)
//   Money here is whole taka (never paisa). tripCost / n is rarely a whole number (260 / 3 = 86.67), so
//   a SHARED split is ROUNDED UP to the next whole taka, for EVERY passenger sharing that segment:
//       segmentFare (n ≥ 2) = ceil(tripCost / n) + ৳20         260 / 3 → 87, + 20 = ৳107 for each of the three
//   Everyone on the segment pays the same rounded-up amount (never "some pay 87 and one pays 86"), so the
//   n of them together pay a little more than tripCost + 20n: the extra fraction (here 3 × 87 = 261 against
//   260) is kept by the driver as additional profit. This is the ONLY place a segment cost is split, and
//   the only place a fraction of a taka can appear on a shared segment. (calculateSplit below.)
//
//   A SOLO segment is not split, so nothing is rounded up. But when the ৳100 base is spread over a
//   journey by distance, one solo segment's share can itself be a fraction, so the solo segments of a
//   journey are rounded together (nearest whole taka, halves up, on their running total). That keeps a
//   passenger who rides alone the whole way at exactly their trip cost however the journey is cut.
//
//   Every segment charge is a whole number, the fare is their sum, and it is computed with integer
//   arithmetic only, so there is no floating-point drift anywhere.
//
// The passenger's own exit is a checkpoint like any other, and a mid-trip cancellation at a zone they
// name is one too: it lowers the count on board for everyone after it, so the people who stay are priced
// by this same walk. The person who LEAVES is the one exception: they pay half their quoted fare
// (cancellationFare below), not a walked fare.
//
// Distances come from the zone table above. Two checkpoints in the same zone are 0 km apart (no
// charge). A journey of 0 km in total costs the ৳100 base.
//
// WORKED EXAMPLE — Gulshan → Dhanmondi, 10 km, tripCost = 100 + 10 × 20 = ৳300:
//   alone              ৳300
//   2 on board         300 / 2 + 20 = 150 + 20 = ৳170 each
//   3 on board         300 / 3 + 20 = 100 + 20 = ৳120 each
// and a segment that does not divide evenly: tripCost 260 shared by 3 is 86.67, rounded UP to 87,
// + 20 = ৳107 each (three of them pay ৳321 for a segment that cost ৳260 + 60; the driver keeps the ৳1).
// ---------------------------------------------------------------------------

/** Distance for one segment: 0 within a zone, otherwise the table distance. */
export function segmentDistanceKm(from: string, to: string): number {
  if (!DHAKA_ZONES.includes(from as any) || !DHAKA_ZONES.includes(to as any)) throw new Error('Invalid zone');
  if (from === to) return 0;
  return getDistance(from as DhakaZone, to as DhakaZone);
}

/** A checkpoint as the fare walk sees it: the zone, and how many passengers are on board from there on. */
export interface FarePoint {
  zone: string;
  passengerCount: number;
}

export interface FareSegment {
  fromZone: string;
  toZone: string;
  distanceKm: number;
  /** Passengers on board during this segment (1 for a private ride) */
  passengers: number;
  /** The flat driver bonus inside `charge`: ৳20 when 2 or more were on board, else 0 */
  driverBonus: number;
  /** What this passenger pays for the segment, in whole taka (see the rounding rule above) */
  charge: number;
}

export interface SegmentFare {
  segments: FareSegment[];
  /** What the whole journey costs riding alone: 100 + 20 × journeyKm × seats */
  soloFare: number;
  /** What the passenger pays (whole taka) = Σ segment charges */
  fare: number;
  /** soloFare − fare, never below 0 (a very short shared stretch can cost slightly more than riding alone) */
  poolDiscount: number;
}

/** ceil(numerator / denominator) for positive integers, in integer arithmetic. */
const ceilDiv = (numerator: number, denominator: number): number => Math.floor((numerator + denominator - 1) / denominator);

/**
 * THE SPLIT: what one passenger pays for a segment shared by n ≥ 2 passengers.
 *
 *   calculateSplit(tripCostNumerator, tripCostDenominator, n) = ceil(tripCost / n) + ৳20
 *
 * where tripCost = numerator / denominator (a segment's share of the trip cost can be a fraction). The
 * division is ROUNDED UP to the next whole taka, the same for every one of the n passengers, and the
 * driver keeps the difference (see the rounding rule above). Integer arithmetic only.
 */
export function calculateSplit(tripCostNumerator: number, tripCostDenominator: number, n: number): number {
  if (!Number.isSafeInteger(tripCostNumerator) || !Number.isSafeInteger(tripCostDenominator * n) || tripCostNumerator < 0 || tripCostDenominator < 1 || n < 2) {
    throw new Error('A split needs whole-taka amounts and at least two passengers');
  }
  return ceilDiv(tripCostNumerator, tripCostDenominator * n) + DRIVER_BONUS_BDT;
}

/**
 * What one passenger pays for a segment whose whole-taka trip cost is `tripCost`, with `activeCount` on board:
 * the trip cost alone when solo, otherwise the rounded-up split plus the ৳20 bonus.
 *   segmentFareFor(40, 1)  = 40         segmentFareFor(260, 2) = 150         segmentFareFor(260, 3) = 87 + 20 = 107
 */
export function segmentFareFor(tripCost: number, activeCount: number): number {
  return activeCount <= 1 ? tripCost : calculateSplit(tripCost, 1, activeCount);
}

/**
 * Prices a journey from its checkpoints.
 *   points   the checkpoints from the passenger's boarding (first) onwards, in order
 *   exitZone if given, one more segment runs from the last point to this zone with the last point's
 *            passenger count (used for an estimate, before the passenger's own exit checkpoint exists)
 */
export function segmentFare(input: {
  points: FarePoint[];
  exitZone?: string;
  seatCount: number;
  allowSharing?: boolean;
  /** Distance between two zones in km. Defaults to the zone table; a "what if" network can be passed instead. */
  distanceKm?: (from: string, to: string) => number;
}): SegmentFare {
  const { points, exitZone, seatCount, allowSharing = true, distanceKm = segmentDistanceKm } = input;
  if (points.length === 0) throw new Error('A journey needs at least its boarding checkpoint');

  const legs: { from: FarePoint; toZone: string }[] = [];
  for (let i = 0; i + 1 < points.length; i++) legs.push({ from: points[i]!, toZone: points[i + 1]!.zone });
  if (exitZone !== undefined) legs.push({ from: points[points.length - 1]!, toZone: exitZone });

  const raw = legs.map(({ from, toZone }) => ({
    fromZone: from.zone,
    toZone,
    distanceKm: distanceKm(from.zone, toZone),
    passengers: allowSharing ? Math.max(1, Math.floor(from.passengerCount)) : 1,
  }));

  const journeyKm = raw.reduce((sum, s) => sum + s.distanceKm, 0);
  const soloFare = BASE_FARE_BDT + RATE_PER_KM_PER_SEAT_BDT * seatCount * journeyKm;
  if (journeyKm === 0) {
    // nowhere travelled: just the base, and nothing to split
    return {
      segments: raw.map((s) => ({ ...s, driverBonus: 0, charge: 0 })),
      soloFare,
      fare: soloFare,
      poolDiscount: 0,
    };
  }

  // A segment's trip cost is segKm / journeyKm of soloFare: the fraction (segKm × soloFare) / journeyKm.
  let soloUnits = 0; // running total of the solo segments' exact amounts, in units of 1/journeyKm
  let soloRoundedBefore = 0;
  const segments: FareSegment[] = raw.map((s) => {
    if (s.distanceKm === 0) return { ...s, driverBonus: 0, charge: 0 };
    if (s.passengers === 1) {
      // Alone: not split. The solo segments are rounded together (nearest taka, halves up, running total).
      soloUnits += s.distanceKm * soloFare;
      const rounded = Math.floor((2 * soloUnits + journeyKm) / (2 * journeyKm));
      const charge = rounded - soloRoundedBefore;
      soloRoundedBefore = rounded;
      return { ...s, driverBonus: 0, charge };
    }
    // Shared: split n ways, ROUNDED UP for every passenger on the segment, plus the driver bonus.
    return { ...s, driverBonus: DRIVER_BONUS_BDT, charge: calculateSplit(s.distanceKm * soloFare, journeyKm, s.passengers) };
  });

  const fare = segments.reduce((sum, s) => sum + s.charge, 0);
  if (!Number.isSafeInteger(fare)) throw new Error('Fare arithmetic overflow');
  return { segments, soloFare, fare, poolDiscount: Math.max(0, soloFare - fare) };
}

/**
 * THE FARE OF A PASSENGER WHO LEAVES MID-TRIP (CANCELLED_IN_TRANSIT): half of the fare they were quoted.
 *
 *   cancellationFare = quotedFare / 2        (nearest whole taka, halves up: 113 / 2 = 56.5 → ৳57)
 *
 * This is a deliberate, customer-friendly LENIENCY POLICY, not a price. It is NOT pro-rated by distance
 * and it does NOT walk the checkpoints like a completed ride does (see segmentFare above): however far
 * they travelled before getting off, they pay half of what they were quoted. `quotedFare` is the pooled
 * fare for their whole route that they were shown when they boarded (RideRequest.quotedFare), before
 * anything changed mid-trip.
 *
 * Only the person who leaves is priced this way. Everyone who stays on board is priced by the ordinary
 * segment walk, with no adjustment for the cancellation: it only shows up as a checkpoint where the
 * number of passengers on board drops by one.
 */
export function cancellationFare(quotedFare: number): number {
  if (!Number.isSafeInteger(quotedFare) || quotedFare < 0) throw new Error('A quoted fare is a whole number of taka');
  return Math.floor((quotedFare + 1) / 2); // quotedFare / 2, halves up, in integers
}

/**
 * The fare for a whole route with a constant number of passengers on board: the QUOTE shown before
 * a ride starts (and the running estimate). It is segmentFare() with one segment, so a quote and the
 * final fare agree whenever the pool does not change during the trip: tripCost / n + 20.
 */
export function pooledFare(pickup: string, dropoff: string, seatCount: number, poolSize: number, allowSharing = true): number {
  // A PRIVATE ride (allowSharing = false) is never pooled: its fare is always the flat price of the route,
  // whatever the pool looks like. The segment, split and rounding logic is skipped altogether.
  if (!allowSharing) return calculateBaseFare(pickup, dropoff, seatCount);
  return segmentFare({ points: [{ zone: pickup, passengerCount: poolSize }], exitZone: dropoff, seatCount, allowSharing }).fare;
}

/** Kept for existing callers: the fare for ONE passenger's route in a pool of `poolSize`. */
export const calculateFareForPassenger = pooledFare;

/**
 * Legacy shim so existing callers don't break: the solo fare (no co-passengers yet).
 * The fare drops later, when others join, via recalculatePoolFares().
 */
export function calculateEstimatedFare(pickup: string, dropoff: string, seatCount: number): number {
  return calculateBaseFare(pickup, dropoff, seatCount);
}

// ---------------------------------------------------------------------------
// Fare estimate shown on the Request Ride page
// ---------------------------------------------------------------------------
export interface FareTier {
  /** Passengers in the pool, including this one */
  passengers: number;
  /** What this passenger pays (whole taka) */
  fare: number;
}

/**
 * What the passenger pays alone, and what they would pay as others join and stay for the whole trip.
 *
 *   baseFare = their own full fare; a private ride always costs exactly this
 *   fare     = same as baseFare (nobody has joined yet)
 *   tiers    = the price with 2, 3 … passengers (tripCost / n + 20); empty for a private ride
 *              (never pooled) or a booking that fills the whole car
 *   poolFare = the first tier (price once one other person joins); null when there are no tiers
 *
 * Built from the same function that prices the stored ride, so the estimate can never drift from
 * what is charged (the final fare can differ only if the pool changes part-way through the trip).
 */
export function estimateFare(
  pickup: string,
  dropoff: string,
  seatCount: number,
  allowSharing: boolean
): { baseFare: number; fare: number; poolFare: number | null; tiers: FareTier[] } {
  const baseFare = calculateBaseFare(pickup, dropoff, seatCount);
  // Other passengers can only join while seats remain in the largest (3-seat) car.
  const maxPassengers = Math.min(MAX_QUOTED_POOL_SIZE, MAX_SEATS_PER_RIDE - seatCount + 1);
  const tiers: FareTier[] = [];
  if (allowSharing) {
    for (let passengers = 2; passengers <= maxPassengers; passengers++) {
      tiers.push({ passengers, fare: pooledFare(pickup, dropoff, seatCount, passengers) });
    }
  }
  return { baseFare, fare: baseFare, poolFare: tiers[0]?.fare ?? null, tiers };
}
