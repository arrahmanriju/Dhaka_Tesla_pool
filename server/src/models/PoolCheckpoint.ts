import { DataTypes, Model } from 'sequelize';

/**
 * A checkpoint is a moment when the number of passengers on a vehicle changed during a trip:
 * the zone where it happened, when, and how many passengers are on board from there on.
 * Fares are worked out by walking the checkpoints (see segmentFare in utils/fareCalculator.ts).
 *
 *   TRIP_STARTED          a ride STARTED with nobody else on board: first checkpoint at its pickup zone, count 1
 *   PASSENGER_JOINED      a ride STARTED while others were on board (it boarded mid-trip):
 *                         checkpoint at the zone where it boarded, count = previous + 1
 *   PASSENGER_LEFT        a passenger left mid-trip (CANCELLED_IN_TRANSIT): checkpoint at their
 *                         cancellation zone, count = previous - 1
 *   PASSENGER_DROPPED_OFF a passenger reached their destination (COMPLETED): checkpoint at the
 *                         destination zone, count = previous - 1. (Not in the original list of
 *                         events, but it changes who is on board just like a cancellation, so the
 *                         next stretch must be priced with one fewer passenger.)
 *
 * `runId` groups the checkpoints of one continuous run of a vehicle: it starts when the first
 * passenger boards an empty vehicle and ends when the count returns to 0. Rows are only ever added.
 */
export type CheckpointKind = 'TRIP_STARTED' | 'PASSENGER_JOINED' | 'PASSENGER_LEFT' | 'PASSENGER_DROPPED_OFF';

export const CHECKPOINT_KINDS: CheckpointKind[] = ['TRIP_STARTED', 'PASSENGER_JOINED', 'PASSENGER_LEFT', 'PASSENGER_DROPPED_OFF'];

export class PoolCheckpoint extends Model {
  declare id: number;
  declare runId: string;
  declare vehicleId: string;
  declare zone: string;
  declare passengerCount: number;
  declare kind: CheckpointKind;
  /** The ride whose boarding or exit created this checkpoint */
  declare rideRequestId: string;
  declare readonly createdAt: Date;
}

export const initPoolCheckpoint = (sequelize: any) => {
  PoolCheckpoint.init(
    {
      // Auto-increment: checkpoints sort in the exact order they happened, even within a millisecond.
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      runId: { type: DataTypes.UUID, allowNull: false },
      vehicleId: { type: DataTypes.UUID, allowNull: false, references: { model: 'Vehicles', key: 'id' } },
      zone: { type: DataTypes.STRING, allowNull: false },
      passengerCount: { type: DataTypes.INTEGER, allowNull: false },
      kind: { type: DataTypes.ENUM(...CHECKPOINT_KINDS), allowNull: false },
      rideRequestId: { type: DataTypes.UUID, allowNull: false, references: { model: 'RideRequests', key: 'id' } },
    },
    { sequelize, tableName: 'PoolCheckpoints', updatedAt: false }
  );
};
