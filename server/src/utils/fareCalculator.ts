import { DhakaZone, DHAKA_ZONES, MAX_SEATS_PER_RIDE } from '../models/RideRequest';

// ---------------------------------------------------------------------------
// Zone distance matrix (km) — Dhaka areas, symmetric
// ---------------------------------------------------------------------------
const DISTANCE_MATRIX: Record<string, Record<string, number>> = {
  Gulshan:      { Banani: 2, Dhanmondi: 10, Uttara: 12, Mirpur: 9, Motijheel: 8, Mohammadpur: 11, Badda: 3, Mohakhali: 3, 'Gulshan 1': 1 },
  Banani:       { Gulshan: 2, Dhanmondi: 9, Uttara: 10, Mirpur: 8, Motijheel: 9, Mohammadpur: 10, Badda: 4, Mohakhali: 2, 'Gulshan 1': 3 },
  Dhanmondi:    { Gulshan: 10, Banani: 9, Uttara: 16, Mirpur: 7, Motijheel: 6, Mohammadpur: 3, Badda: 11, Mohakhali: 8, 'Gulshan 1': 10 },
  Uttara:       { Gulshan: 12, Banani: 10, Dhanmondi: 16, Mirpur: 9, Motijheel: 18, Mohammadpur: 15, Badda: 14, Mohakhali: 11, 'Gulshan 1': 12 },
  Mirpur:       { Gulshan: 9, Banani: 8, Dhanmondi: 7, Uttara: 9, Motijheel: 12, Mohammadpur: 5, Badda: 10, Mohakhali: 7, 'Gulshan 1': 9 },
  Motijheel:    { Gulshan: 8, Banani: 9, Dhanmondi: 6, Uttara: 18, Mirpur: 12, Mohammadpur: 8, Badda: 9, Mohakhali: 9, 'Gulshan 1': 8 },
  Mohammadpur:  { Gulshan: 11, Banani: 10, Dhanmondi: 3, Uttara: 15, Mirpur: 5, Motijheel: 8, Badda: 12, Mohakhali: 9, 'Gulshan 1': 11 },
  Badda:        { Gulshan: 3, Banani: 4, Dhanmondi: 11, Uttara: 14, Mirpur: 10, Motijheel: 9, Mohammadpur: 12, Mohakhali: 4, 'Gulshan 1': 3 },
  Mohakhali:    { Gulshan: 3, Banani: 2, Dhanmondi: 8, Uttara: 11, Mirpur: 7, Motijheel: 9, Mohammadpur: 9, Badda: 4, 'Gulshan 1': 4 },
  'Gulshan 1':  { Gulshan: 1, Banani: 3, Dhanmondi: 10, Uttara: 12, Mirpur: 9, Motijheel: 8, Mohammadpur: 11, Badda: 3, Mohakhali: 4 },
};

// ---------------------------------------------------------------------------
// Fare constants — all money in this app is WHOLE TAKA (integers, never paisa)
// ---------------------------------------------------------------------------
/** Fixed part of a route's base fare (BDT) */
export const BASE_FARE_BDT = 100;

/** Variable charge per km per seat (BDT) */
export const RATE_PER_KM_PER_SEAT_BDT = 20;

/** Every fare is rounded to the nearest ৳5. */
export const FARE_ROUNDING_BDT = 5;

// ---------------------------------------------------------------------------
// SHARE RATE — how much of the DISTANCE CHARGE of a stretch each passenger pays, by how many are on board.
//
//   1 passenger  → 100%   driver earns 100% of the distance charge
//   2 passengers →  70%   each; driver earns 140%
//   3 passengers →  55%   each; driver earns 165%
//
// Kept as whole percentages so every calculation is exact integer arithmetic
// (0.7 × 180 in floating point is 125.99999999999999).
// A pool larger than 3 keeps the 3-passenger rate (the fleet's largest Tesla seats 3,
// but older vehicles registered before onboarding may be bigger).
// ---------------------------------------------------------------------------
export const SHARE_RATE_PERCENT: Readonly<Record<number, number>> = { 1: 100, 2: 70, 3: 55 };
export const MAX_RATE_TIER = 3;

/**
 * Percentage of the distance charge a passenger pays.
 * A private ride (allowSharing = false) always pays 100%, whatever the pool looks like.
 */
export function shareRatePercent(poolSize: number, allowSharing = true): number {
  if (!allowSharing || poolSize <= 1) return SHARE_RATE_PERCENT[1]!;
  return SHARE_RATE_PERCENT[Math.min(Math.floor(poolSize), MAX_RATE_TIER)]!;
}

// ---------------------------------------------------------------------------
// Distance helper
// ---------------------------------------------------------------------------
function getDistance(pickup: DhakaZone, dropoff: DhakaZone): number {
  if (pickup === dropoff) return 1; // 1 km minimum
  return DISTANCE_MATRIX[pickup]?.[dropoff]
    ?? DISTANCE_MATRIX[dropoff]?.[pickup]
    ?? 8; // fallback default
}

/** Rounds a taka amount to the nearest ৳5 (halves round up). */
export function roundToNearest5(taka: number): number {
  // (taka + 2.5) / 5 written as (2 × taka + 5) / 10, so a whole-taka input never goes through a fraction
  return Math.floor((2 * taka + FARE_ROUNDING_BDT) / (2 * FARE_ROUNDING_BDT)) * FARE_ROUNDING_BDT;
}

// ---------------------------------------------------------------------------
// calculateBaseFare
//
// A passenger's OWN base fare: what their pickup → destination costs when they ride alone.
//
//   baseFare = 100 + distanceKm × 20 × seatCount        (whole taka)
//
// Example (Mohakhali → Badda, 4 km, 1 seat):  100 + 4 × 20 × 1 = ৳180
// Set once when the ride is requested and never changes.
// ---------------------------------------------------------------------------
export function calculateBaseFare(pickup: string, dropoff: string, seatCount: number): number {
  if (!DHAKA_ZONES.includes(pickup as any) || !DHAKA_ZONES.includes(dropoff as any)) {
    throw new Error('Invalid zone');
  }
  const distanceKm = getDistance(pickup as DhakaZone, dropoff as DhakaZone);
  return roundToNearest5(BASE_FARE_BDT + distanceKm * RATE_PER_KM_PER_SEAT_BDT * seatCount);
}

// ---------------------------------------------------------------------------
// SEGMENT-BASED FARES  (replaces the old "quote × share rate, then lock at START" model)
//
// A passenger's journey is cut into SEGMENTS at the pool's CHECKPOINTS (see models/PoolCheckpoint.ts):
// a checkpoint is a zone where the number of passengers on the vehicle changed. Walk the checkpoints
// from where the passenger boarded to where they got off; each consecutive pair is a segment.
//
//   for each segment  zoneA → zoneB, with n passengers on board during it:
//       distanceCharge = distanceKm(zoneA → zoneB) × ৳20 × seatCount
//       charge         = distanceCharge × shareRate(n)         shareRate: 1 → 100%, 2 → 70%, 3+ → 55%
//                        (so the pool discount applies only when n > 1)
//   fare = ৳100 base fare (once, never discounted) + Σ charge, rounded to the nearest ৳5
//   poolDiscount = (৳100 + Σ distanceCharge, rounded)  −  fare        what pooling saved on this journey
//
// The passenger's own exit (drop-off at their destination, or a mid-trip cancellation at a zone they
// name) is a checkpoint like any other, so a cancellation is not a special case: the journey simply
// ends at that checkpoint and the same walk prices it.
//
// Distances come from the zone table above. Two checkpoints in the same zone are 0 km apart (no
// charge), unlike calculateBaseFare, where a trip must have two different zones.
//
// WORKED EXAMPLE — Nusrat rides Uttara → Dhanmondi; Rafiq boards at Mirpur and both go to Dhanmondi.
//   checkpoints:  (Uttara, 1)  (Mirpur, 2)  (Dhanmondi, 1) (Nusrat drops)  (Dhanmondi, 0) (Rafiq drops)
//   Nusrat: Uttara → Mirpur    9 km × 20 = ৳180, alone (100%)        = ৳180
//           Mirpur → Dhanmondi 7 km × 20 = ৳140, 2 on board (70%)    = ৳98
//           fare = 100 + 180 + 98 = ৳378 → ৳380      (riding alone all the way: 100 + 320 = ৳420)
//   Rafiq:  Mirpur → Dhanmondi ৳140 × 70% = ৳98;  fare = 100 + 98 = ৳198 → ৳200   (alone: 100 + 140 = ৳240)
// ---------------------------------------------------------------------------

/**
 * `percent` % of a whole-taka amount, as a whole number of taka. Fails loudly instead of truncating:
 * a distance charge is km × ৳20 × seats, always a multiple of 20, and the rates are 100, 70 and 55, so
 * the result is always exact. If that ever stops being true (a new rate, a fractional distance) this
 * throws rather than silently losing a fraction of a taka.
 */
export function percentOf(amount: number, percent: number): number {
  const product = amount * percent;
  if (!Number.isSafeInteger(product) || product % 100 !== 0) {
    throw new Error(`${percent}% of ৳${amount} is not a whole number of taka`);
  }
  return product / 100;
}

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
  distanceCharge: number;
  /** Passengers on board during this segment */
  passengers: number;
  /** Share rate applied: 100 when alone, 70 with 2, 55 with 3+ */
  ratePercent: number;
  /** distanceCharge × ratePercent / 100 (a whole number of taka: distance charges are multiples of ৳20) */
  charge: number;
}

export interface SegmentFare {
  baseCharge: number;
  segments: FareSegment[];
  /** Σ distanceCharge, before any pool discount */
  distanceTotal: number;
  /** What the same journey would cost riding alone (rounded to ৳5) */
  soloFare: number;
  /** What the passenger pays (whole taka, a multiple of ৳5) */
  fare: number;
  /** soloFare − fare */
  poolDiscount: number;
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
}): SegmentFare {
  const { points, exitZone, seatCount, allowSharing = true } = input;
  if (points.length === 0) throw new Error('A journey needs at least its boarding checkpoint');

  const legs: { from: FarePoint; toZone: string }[] = [];
  for (let i = 0; i + 1 < points.length; i++) legs.push({ from: points[i]!, toZone: points[i + 1]!.zone });
  if (exitZone !== undefined) legs.push({ from: points[points.length - 1]!, toZone: exitZone });

  const segments: FareSegment[] = legs.map(({ from, toZone }) => {
    const distanceKm = segmentDistanceKm(from.zone, toZone);
    const distanceCharge = distanceKm * RATE_PER_KM_PER_SEAT_BDT * seatCount;
    const ratePercent = shareRatePercent(from.passengerCount, allowSharing);
    return {
      fromZone: from.zone,
      toZone,
      distanceKm,
      distanceCharge,
      passengers: from.passengerCount,
      ratePercent,
      charge: percentOf(distanceCharge, ratePercent),
    };
  });

  const distanceTotal = segments.reduce((s, x) => s + x.distanceCharge, 0);
  const chargeTotal = segments.reduce((s, x) => s + x.charge, 0);
  const fare = roundToNearest5(BASE_FARE_BDT + chargeTotal);
  const soloFare = roundToNearest5(BASE_FARE_BDT + distanceTotal);
  return { baseCharge: BASE_FARE_BDT, segments, distanceTotal, soloFare, fare, poolDiscount: soloFare - fare };
}

/**
 * The fare for a whole route with a constant number of passengers on board: the QUOTE shown before
 * a ride starts (and the running estimate). It is segmentFare() with one segment, so a quote and the
 * final fare agree whenever the pool does not change during the trip.
 */
export function pooledFare(pickup: string, dropoff: string, seatCount: number, poolSize: number, allowSharing = true): number {
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
  /** Percentage of the distance charge each of them pays */
  ratePercent: number;
  /** What this passenger pays (whole taka) */
  fare: number;
}

/**
 * What the passenger pays alone, and what they would pay as others join and stay for the whole trip.
 *
 *   baseFare = their own full fare; a private ride always costs exactly this
 *   fare     = same as baseFare (nobody has joined yet)
 *   tiers    = the price with 2, 3 … passengers; empty for a private ride
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
  const maxPassengers = Math.min(MAX_RATE_TIER, MAX_SEATS_PER_RIDE - seatCount + 1);
  const tiers: FareTier[] = [];
  if (allowSharing) {
    for (let passengers = 2; passengers <= maxPassengers; passengers++) {
      tiers.push({
        passengers,
        ratePercent: shareRatePercent(passengers),
        fare: pooledFare(pickup, dropoff, seatCount, passengers),
      });
    }
  }
  return { baseFare, fare: baseFare, poolFare: tiers[0]?.fare ?? null, tiers };
}
