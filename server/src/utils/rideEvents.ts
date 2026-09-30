import { Op, Transaction } from 'sequelize';
import { RideEvent, RideRequest } from '../models';
import { RideStatus, TERMINAL_STATUSES } from '../models/RideRequest';

/**
 * Appends one row to the ride's lifecycle history. Call it inside the transaction that changed the
 * ride's status, AFTER the change, so the pool counts describe the vehicle as it is now.
 */
export async function recordRideEvent(
  ride: { id: string; passengerId: string; vehicleId?: string | null },
  status: RideStatus,
  fromStatus: RideStatus | null,
  actor: { id: string; role: 'PASSENGER' | 'DRIVER' } | null,
  transaction: Transaction | null = null
): Promise<void> {
  let poolSize = 0;
  let ridersOnboard = 0;
  if (ride.vehicleId) {
    const onVehicle = await RideRequest.findAll({
      where: { vehicleId: ride.vehicleId, status: { [Op.notIn]: [...TERMINAL_STATUSES] } },
      attributes: ['id', 'status'],
      transaction,
    });
    poolSize = onVehicle.length;
    ridersOnboard = onVehicle.filter((r: any) => r.status === 'STARTED' && r.id !== ride.id).length;
  }

  await RideEvent.create(
    {
      rideRequestId: ride.id,
      passengerId: ride.passengerId,
      vehicleId: ride.vehicleId ?? null,
      status,
      fromStatus,
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? null,
      poolSize,
      ridersOnboard,
    },
    { transaction }
  );
}

/** A passenger who was matched while another passenger was already travelling joined mid-trip. */
export const joinedMidTrip = (e: { status: string; ridersOnboard: number }): boolean =>
  e.status === 'MATCHED' && e.ridersOnboard > 0;
