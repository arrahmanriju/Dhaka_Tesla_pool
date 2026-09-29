import { DhakaZone, DHAKA_ZONES } from '../models/RideRequest';

// ---------------------------------------------------------------------------
// Zone distance matrix (km) — Dhaka areas, symmetric
// ---------------------------------------------------------------------------
const DISTANCE_MATRIX: Record<string, Record<string, number>> = {
  Gulshan:      { Banani: 2, Dhanmondi: 10, Uttara: 12, Mirpur: 9, Motijheel: 8, Mohammadpur: 11, Badda: 3 },
  Banani:       { Gulshan: 2, Dhanmondi: 9, Uttara: 10, Mirpur: 8, Motijheel: 9, Mohammadpur: 10, Badda: 4 },
  Dhanmondi:    { Gulshan: 10, Banani: 9, Uttara: 16, Mirpur: 7, Motijheel: 6, Mohammadpur: 3, Badda: 11 },
  Uttara:       { Gulshan: 12, Banani: 10, Dhanmondi: 16, Mirpur: 9, Motijheel: 18, Mohammadpur: 15, Badda: 14 },
  Mirpur:       { Gulshan: 9, Banani: 8, Dhanmondi: 7, Uttara: 9, Motijheel: 12, Mohammadpur: 5, Badda: 10 },
  Motijheel:    { Gulshan: 8, Banani: 9, Dhanmondi: 6, Uttara: 18, Mirpur: 12, Mohammadpur: 8, Badda: 9 },
  Mohammadpur:  { Gulshan: 11, Banani: 10, Dhanmondi: 3, Uttara: 15, Mirpur: 5, Motijheel: 8, Badda: 12 },
  Badda:        { Gulshan: 3, Banani: 4, Dhanmondi: 11, Uttara: 14, Mirpur: 10, Motijheel: 9, Mohammadpur: 12 },
};

// ---------------------------------------------------------------------------
// Fare constants
// ---------------------------------------------------------------------------
/** Fixed base fare per ride segment (BDT) */
export const BASE_FARE_BDT = 100;

/** Variable charge per km per seat (BDT) */
export const RATE_PER_KM_PER_SEAT_BDT = 20;

/**
 * POOL DISCOUNT: applied per-passenger (BDT) when 2 or more passengers
 * share the same vehicle on the same pool trip.
 *
 * The discount applies to ALL passengers already in the pool and to the
 * newcomer simultaneously. It is removed if pool size drops back to 1
 * (e.g. if one passenger cancels).
 */
export const POOL_DISCOUNT_BDT = 30;

// ---------------------------------------------------------------------------
// Distance helper
// ---------------------------------------------------------------------------
function getDistance(pickup: DhakaZone, dropoff: DhakaZone): number {
  if (pickup === dropoff) return 1; // 1 km minimum
  return DISTANCE_MATRIX[pickup]?.[dropoff]
    ?? DISTANCE_MATRIX[dropoff]?.[pickup]
    ?? 8; // fallback default
}

// ---------------------------------------------------------------------------
// calculateFareForPassenger
//
// Returns the fare (integer paisa) for ONE passenger's segment.
//
// Formula:
//   passengerFare = baseFare + distanceCharge - poolDiscount
//
// Where:
//   baseFare       = 100 BDT  (fixed per ride segment)
//   distanceCharge = distanceKm × 20 BDT × seatCount
//   poolDiscount   = 30 BDT  if poolSize >= 2, else 0
//
// Worked example (Nusrat: Gulshan→Banani, 1 seat, alone):
//   baseFare       = 100 BDT
//   distanceCharge = 2km × 20 × 1 = 40 BDT
//   poolDiscount   = 0  (alone)
//   fare           = 140 BDT = 14 000 paisa
//
// After Rafiq joins the SAME pool (Gulshan→Banani, 1 seat):
//   Nusrat's fare recalculated with poolDiscount=30:
//   fare = 100 + 40 - 30 = 110 BDT = 11 000 paisa  ← recalculated downward
//   Rafiq's fare:
//   fare = 100 + 40 - 30 = 110 BDT = 11 000 paisa
// ---------------------------------------------------------------------------
export function calculateFareForPassenger(
  pickup: string,
  dropoff: string,
  seatCount: number,
  poolSize: number   // total number of DISTINCT passengers in the pool (including this one)
): number {
  if (!DHAKA_ZONES.includes(pickup as any) || !DHAKA_ZONES.includes(dropoff as any)) {
    throw new Error('Invalid zone');
  }

  const distanceKm = getDistance(pickup as DhakaZone, dropoff as DhakaZone);
  const distanceCharge = distanceKm * RATE_PER_KM_PER_SEAT_BDT * seatCount;
  const poolDiscount = poolSize >= 2 ? POOL_DISCOUNT_BDT : 0;

  const fareBdt = Math.max(BASE_FARE_BDT, BASE_FARE_BDT + distanceCharge - poolDiscount);
  return fareBdt * 100; // integer paisa
}

/**
 * Legacy shim so existing callers don't break.
 * Assumes pool size = 1 (no co-passengers yet, discount not applied at creation time;
 * it will be applied when a second passenger joins via recalculatePoolFares()).
 */
export function calculateEstimatedFare(
  pickup: string,
  dropoff: string,
  seatCount: number
): number {
  return calculateFareForPassenger(pickup, dropoff, seatCount, 1);
}
