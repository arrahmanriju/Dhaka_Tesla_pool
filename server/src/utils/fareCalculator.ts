import { DhakaZone, DHAKA_ZONES } from '../models/RideRequest';

// Mock distances between zones (in km)
// For simplicity, we just randomize or use a predefined basic matrix
const DISTANCE_MATRIX: Record<string, Record<string, number>> = {
  Gulshan: { Banani: 2, Dhanmondi: 10, Uttara: 12, Mirpur: 9, Motijheel: 8, Mohammadpur: 11, Badda: 3 },
  Banani: { Gulshan: 2, Dhanmondi: 9, Uttara: 10, Mirpur: 8, Motijheel: 9, Mohammadpur: 10, Badda: 4 },
  // Simple fallback for others
};

function getDistance(pickup: DhakaZone, dropoff: DhakaZone): number {
  if (pickup === dropoff) return 1; // 1km minimum

  if (DISTANCE_MATRIX[pickup]?.[dropoff]) {
    return DISTANCE_MATRIX[pickup][dropoff];
  }
  if (DISTANCE_MATRIX[dropoff]?.[pickup]) {
    return DISTANCE_MATRIX[dropoff][pickup];
  }

  // Fallback default distance for MVP
  return 8;
}

export function calculateEstimatedFare(pickup: string, dropoff: string, seatCount: number): number {
  // Ensure we cast safely
  if (!DHAKA_ZONES.includes(pickup as any) || !DHAKA_ZONES.includes(dropoff as any)) {
    throw new Error('Invalid zone');
  }

  const distanceKm = getDistance(pickup as DhakaZone, dropoff as DhakaZone);

  // Constants (in BDT)
  const BASE_FARE = 100;
  const RATE_PER_KM = 20;
  // Pool discount: assuming if you book more seats, you don't get pool discount, or pool discount is a fixed 20%
  // The formula says: passengerFare = baseFare + distanceCharge - poolDiscount
  // Let's say poolDiscount is 30 BDT if sharing (i.e. seatCount = 1). If seatCount >= 4, it's not a pool.
  const poolDiscount = seatCount <= 2 ? 30 : 0; 
  
  const distanceCharge = distanceKm * RATE_PER_KM * seatCount;
  
  let passengerFareBdt = BASE_FARE + distanceCharge - poolDiscount;
  if (passengerFareBdt < BASE_FARE) passengerFareBdt = BASE_FARE;

  // Store money as integer paisa (100 paisa = 1 BDT)
  return passengerFareBdt * 100;
}
