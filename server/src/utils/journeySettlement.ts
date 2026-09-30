import { Transaction } from 'sequelize';
import { RideRequest } from '../models';
import { priceJourney } from './checkpoints';
import { SegmentFare } from './fareCalculator';

/**
 * Settles a passenger's fare at the moment their own journey ends. Call it inside the transaction
 * that ended the ride, AFTER its exit checkpoint (the drop-off) has been recorded. A passenger who leaves
 * mid-trip is not settled here: they pay half of their quoted fare (cancellationFare in fareCalculator.ts).
 *
 * Walks the pool's checkpoints from where they boarded to where they got off (priceJourney), stores
 * the result as the ride's final fare and returns the breakdown. `poolDiscount` becomes what pooling
 * saved on exactly the stretches they travelled. A ride that never got a boarding checkpoint (it
 * started before checkpoints existed) keeps the fare it already had and returns null.
 *
 * `previousEstimate` is the fare they were on track to pay (to their original destination) just
 * before this journey ended, kept in the history so the difference is visible.
 */
export async function settleJourney(
  ride: { id: string; destinationZone: string; seatCount: number; allowSharing: boolean; estimatedFare: number },
  transaction: Transaction | null = null
): Promise<{ bill: (SegmentFare & { zones: string[] }) | null; previousEstimate: number }> {
  const previousEstimate = ride.estimatedFare;
  const priced = await priceJourney(ride, transaction);
  if (!priced || !priced.exited) return { bill: null, previousEstimate };
  await RideRequest.update(
    { estimatedFare: priced.fare, poolDiscount: priced.poolDiscount },
    { where: { id: ride.id }, transaction }
  );
  return { bill: priced, previousEstimate };
}
