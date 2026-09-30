import { Op, Transaction } from 'sequelize';
import { RideRequest } from '../models';
import { TERMINAL_STATUSES } from '../models/RideRequest';
import { calculateBaseFare, pooledFare } from './fareCalculator';
import { priceJourney } from './checkpoints';

/**
 * A ride's fare is FINAL only once the passenger's own journey has ended (COMPLETED, or
 * CANCELLED_IN_TRANSIT at a zone they named). Until then `estimatedFare` is an estimate that follows
 * the pool: there is no lock when the trip starts. See segmentFare() in fareCalculator.ts.
 */
export const isFareFinal = (status: string): boolean => status === 'COMPLETED' || status === 'CANCELLED_IN_TRANSIT';

/**
 * Re-estimates every open passenger's fare on a vehicle after the pool changed.
 *
 *   not started yet (MATCHED / DRIVER_ARRIVED)
 *       ৳100 + distance charge × share rate for the number of rides on the vehicle, to their destination
 *       (pooledFare); poolDiscount = own solo fare − that.
 *   STARTED (on board)
 *       what they would pay if they got off at their destination now, walking the pool's checkpoints:
 *       the stretches already travelled are priced with the passengers who were actually on board,
 *       and the rest of the way with whoever is on board now (priceJourney).
 *
 * Private rides always pay 100%. Finished rides (see isFareFinal) are never touched: their fare is
 * settled by settleJourney() at the moment their own journey ends.
 *
 * Call inside the transaction that changed the pool.
 */
export async function recalculatePoolFares(vehicleId: string, transaction: Transaction | null = null): Promise<void> {
  const poolRides = await RideRequest.findAll({
    where: { vehicleId, status: { [Op.notIn]: [...TERMINAL_STATUSES] } },
    transaction,
  });
  const poolSize = poolRides.length;

  for (const ride of poolRides) {
    // baseFare is always set when a ride is created; the fallback covers rows written by hand.
    const baseFare = ride.baseFare > 0 ? ride.baseFare : calculateBaseFare(ride.pickupZone, ride.destinationZone, ride.seatCount);

    let fare: number;
    let poolDiscount: number;
    const journey = ride.status === 'STARTED' ? await priceJourney(ride, transaction) : null;
    if (journey) {
      fare = journey.fare;
      poolDiscount = journey.poolDiscount;
    } else if (ride.status === 'STARTED') {
      continue; // started before checkpoints existed: keep its stored estimate
    } else {
      fare = pooledFare(ride.pickupZone, ride.destinationZone, ride.seatCount, poolSize, ride.allowSharing);
      poolDiscount = Math.max(0, baseFare - fare);
    }

    await RideRequest.update({ baseFare, estimatedFare: fare, poolDiscount }, { where: { id: ride.id }, transaction });
  }
}
