import { Op, Transaction } from 'sequelize';
import { RideRequest } from '../models';
import { applyShareRate, calculateBaseFare } from './fareCalculator';

/**
 * A ride's fare is final once it is STARTED (and stays final as COMPLETED). Nothing that happens
 * in the pool afterwards may change what that passenger pays.
 */
export const isFareLocked = (status: string): boolean => status === 'STARTED' || status === 'COMPLETED';

/**
 * Recomputes every passenger's fare on a vehicle after someone joins or leaves its pool.
 *
 *   poolSize = passengers currently on the vehicle (ride requests that are not CANCELLED/COMPLETED)
 *   fare     = own base fare × share rate for that pool size, rounded to the nearest ৳5
 *   poolDiscount = what the passenger saves compared with riding alone (base − fare)
 *
 * Each passenger is priced from their OWN base fare (their own pickup → destination), so
 * pooled passengers with different destinations pay different amounts. Private rides always
 * pay 100%. Rides that are already STARTED are skipped — their fare is locked.
 *
 * Call inside the transaction that changed the pool.
 */
export async function recalculatePoolFares(vehicleId: string, transaction: Transaction | null = null): Promise<void> {
  const poolRides = await RideRequest.findAll({
    where: { vehicleId, status: { [Op.notIn]: ['CANCELLED', 'COMPLETED'] } },
    transaction,
  });
  const poolSize = poolRides.length;

  for (const ride of poolRides) {
    if (isFareLocked(ride.status)) continue;

    // baseFare is always set when a ride is created; the fallback covers rows written by hand.
    const baseFare = ride.baseFare > 0 ? ride.baseFare : calculateBaseFare(ride.pickupZone, ride.destinationZone, ride.seatCount);
    const fare = applyShareRate(baseFare, poolSize, ride.allowSharing);

    await RideRequest.update(
      { baseFare, estimatedFare: fare, poolDiscount: baseFare - fare },
      { where: { id: ride.id }, transaction }
    );
  }
}
