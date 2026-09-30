import { Op, Transaction } from 'sequelize';
import { RideRequest } from '../models';
import { TERMINAL_STATUSES } from '../models/RideRequest';

/**
 * ONE anonymisation rule for the whole app, the same as the QR street-ride flow: people in one car are only
 * ever "Passenger 1", "Passenger 2", ... in the order they joined. A driver or a co-passenger never sees a
 * real name (not even a first name) or an internal user id, in any view or in the ride timeline.
 *
 * The number is fixed when the driver accepts the ride (RideRequest.poolNumber) and never changes, so a label
 * stays the same passenger for the whole trip even after someone else leaves. It is the next number after
 * the highest one still in the car, and starts again at 1 when the car is empty, so the numbers are
 * sequential within one pool. A ride that has not been accepted yet has no number.
 */
export const passengerLabel = (poolNumber: number | null | undefined): string | null =>
  poolNumber ? `Passenger ${poolNumber}` : null;

/** The number the next passenger accepted onto this vehicle gets. Call inside the accept transaction. */
export async function nextPoolNumber(vehicleId: string, transaction: Transaction | null = null): Promise<number> {
  const highest = await RideRequest.max('poolNumber', {
    where: { vehicleId, status: { [Op.notIn]: [...TERMINAL_STATUSES] } },
    transaction,
  });
  return (typeof highest === 'number' ? highest : 0) + 1;
}
