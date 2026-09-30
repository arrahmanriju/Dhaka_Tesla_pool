import { Op, Transaction } from 'sequelize';
import { sequelize, Vehicle } from '../models';

// ---------------------------------------------------------------------------
// THE ONE PLACE A VEHICLE'S SEATS ARE CLAIMED AND RELEASED
//
// `Vehicle.occupiedSeats` is the single truth about how many seats are taken, whoever is sitting in
// them: an app ride (routes/rideRequest.ts accept, routes/driver.ts, routes/passenger.ts) or a street
// ride joined by QR code (services/qrRides.ts). Every claim and release goes through these two
// functions, so capacity is enforced the same way everywhere and the two flows can never over-book
// the same car. (What the flows do NOT share is anything else: a QR passenger is not a RideRequest,
// so pools, checkpoints, fares and earnings stay separate.)
//
// claimSeats is ONE conditional UPDATE, so checking and claiming cannot be separated by another request:
//
//   UPDATE Vehicles SET occupiedSeats = occupiedSeats + :seats
//   WHERE id = :vehicle AND seatCapacity >= occupiedSeats + :seats
//
// It must run inside the caller's transaction (an IMMEDIATE one, so SQLite's write lock is already held
// and simultaneous claims run one after the other). If it changes no row the seats are not there and
// the caller aborts and rolls back. See "Concurrency Handling" in the README.
// ---------------------------------------------------------------------------

/** Atomically takes `seats` seats. Returns false, changing nothing, when they are not all free. */
export async function claimSeats(vehicleId: string, seats: number, transaction: Transaction): Promise<boolean> {
  if (!Number.isInteger(seats) || seats < 1) throw new Error(`Invalid seat count: ${seats}`);
  const [updated] = await Vehicle.update(
    { occupiedSeats: sequelize.literal(`occupiedSeats + ${seats}`) },
    {
      where: {
        id: vehicleId,
        seatCapacity: { [Op.gte]: sequelize.literal(`occupiedSeats + ${seats}`) },
      },
      transaction,
    }
  );
  return updated === 1;
}

/** Gives `seats` seats back (never below 0). */
export async function releaseSeats(vehicleId: string, seats: number, transaction: Transaction | null): Promise<void> {
  if (!Number.isInteger(seats) || seats < 1) throw new Error(`Invalid seat count: ${seats}`);
  await Vehicle.update(
    { occupiedSeats: sequelize.literal(`MAX(0, occupiedSeats - ${seats})`) },
    { where: { id: vehicleId }, transaction }
  );
}
