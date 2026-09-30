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
// SHARE RATE — how much of their OWN base fare each passenger pays, by pool size.
//
//   1 passenger  → 100%   driver earns 100% of one base fare
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
 * Percentage of their own base fare a passenger pays.
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
  return Math.floor((taka + FARE_ROUNDING_BDT / 2) / FARE_ROUNDING_BDT) * FARE_ROUNDING_BDT;
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
// applyShareRate
//
//   passengerFare = baseFare × shareRate, rounded to the nearest ৳5
//
// Works from the passenger's own stored base fare, so pooled passengers with different
// destinations each get the same percentage off their own price.
//
//   base ৳180: alone ৳180 · with 2 → ৳125 (126) · with 3 → ৳100 (99)
//   base ৳100: alone ৳100 · with 2 → ৳70        · with 3 → ৳55
// ---------------------------------------------------------------------------
export function applyShareRate(baseFare: number, poolSize: number, allowSharing = true): number {
  const percent = shareRatePercent(poolSize, allowSharing);
  // round(baseFare × percent / 100 to the nearest 5) in exact integer arithmetic (halves up):
  //   floor((baseFare × percent / 100 + 2.5) / 5) × 5  ==  floor((baseFare × percent + 250) / 500) × 5
  return Math.floor((baseFare * percent + 250) / 500) * FARE_ROUNDING_BDT;
}

/**
 * The fare (whole taka) for ONE passenger's segment.
 * `poolSize` is the number of passengers in the pool, including this one.
 */
export function calculateFareForPassenger(
  pickup: string,
  dropoff: string,
  seatCount: number,
  poolSize: number,
  allowSharing = true
): number {
  return applyShareRate(calculateBaseFare(pickup, dropoff, seatCount), poolSize, allowSharing);
}

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
  /** Percentage of the base fare each of them pays */
  ratePercent: number;
  /** What this passenger pays (whole taka) */
  fare: number;
}

/**
 * What the passenger pays alone, and what they would pay as others join.
 *
 *   baseFare = their own full fare; a private ride always costs exactly this
 *   fare     = same as baseFare (nobody has joined yet)
 *   tiers    = the price with 2, 3 … passengers; empty for a private ride
 *              (never pooled) or a booking that fills the whole car
 *   poolFare = the first tier (price once one other person joins); null when there are no tiers
 *
 * Built from the same functions that price the stored ride, so the estimate can never
 * drift from what is charged.
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
        fare: applyShareRate(baseFare, passengers),
      });
    }
  }
  return { baseFare, fare: baseFare, poolFare: tiers[0]?.fare ?? null, tiers };
}

// ---------------------------------------------------------------------------
// prorateFare — what a passenger pays when they leave a STARTED ride at a zone of their choice
//
// Uses the SAME distance table and per-km rate as the original estimate, only measured from the
// pickup to the cancellation zone instead of to the original destination:
//
//   fare = baseCharge + distanceCharge − poolDiscount
//     baseCharge     = ৳100 (BASE_FARE_BDT)
//     distanceCharge = distanceKm(pickup → cancellationZone) × ৳20 × seatCount
//     poolDiscount   = the discount quoted at match time, in taka, unchanged
//
// (baseCharge + distanceCharge, rounded to the nearest ৳5, is exactly calculateBaseFare() for the
// shorter trip. The stored `baseFare` column is that whole "solo fare", not just the ৳100.)
//
// Two safety limits so the number is always sensible:
//   • never below ৳0 (a large pool discount on a long trip cannot make a short one negative), and
//   • never above the fare the passenger had locked for the full trip: leaving early must not
//     cost more than staying (zone distances are a table, not geometry, so a zone can be "farther"
//     than the destination).
// ---------------------------------------------------------------------------
export interface ProRatedFare {
  baseCharge: number;
  distanceKm: number;
  distanceCharge: number;
  /** baseCharge + distanceCharge, rounded to the nearest ৳5: the solo fare for the part travelled */
  grossFare: number;
  poolDiscount: number;
  /** What the passenger is charged (whole taka) */
  fare: number;
  /** true when the ৳0 floor or the locked-fare ceiling changed the result */
  limited: boolean;
}

export function prorateFare(
  pickup: string,
  cancellationZone: string,
  seatCount: number,
  poolDiscount: number,
  lockedFare: number
): ProRatedFare {
  if (!DHAKA_ZONES.includes(pickup as any) || !DHAKA_ZONES.includes(cancellationZone as any)) {
    throw new Error('Invalid zone');
  }
  const distanceKm = getDistance(pickup as DhakaZone, cancellationZone as DhakaZone);
  const distanceCharge = distanceKm * RATE_PER_KM_PER_SEAT_BDT * seatCount;
  const grossFare = roundToNearest5(BASE_FARE_BDT + distanceCharge);
  const net = grossFare - poolDiscount;
  const fare = Math.min(Math.max(net, 0), lockedFare);
  return {
    baseCharge: BASE_FARE_BDT,
    distanceKm,
    distanceCharge,
    grossFare,
    poolDiscount,
    fare,
    limited: fare !== net,
  };
}
