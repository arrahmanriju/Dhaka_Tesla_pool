import { DataTypes, Model } from 'sequelize';
import { RideStatus, RIDE_STATUS_VALUES } from './RideRequest';

/**
 * One row per status change of a ride, written in the same transaction as the change and never
 * updated or deleted: the permanent lifecycle history.
 *
 *   status          the status the ride moved TO (REQUESTED for the request itself)
 *   fromStatus      the status it moved from (null for the request itself)
 *   poolSize        rides on the vehicle that are not finished, right after the change (0 before matching)
 *   ridersOnboard   rides on the vehicle that are STARTED (already travelling), not counting this one.
 *                   A MATCHED event with ridersOnboard > 0 is a passenger who joined mid-trip.
 *   cancellationZone, chargedFare, fullTripEstimate   chargedFare and fullTripEstimate are on COMPLETED and
 *                   CANCELLED_IN_TRANSIT; cancellationZone only on the latter: where the passenger left,
 *                   the final segment fare they were charged, and the estimate they were on track for to their original destination.
 */
export class RideEvent extends Model {
  declare id: number;
  declare rideRequestId: string;
  declare passengerId: string;
  declare vehicleId: string | null;
  declare status: RideStatus;
  declare fromStatus: RideStatus | null;
  declare actorId: string | null;
  declare actorRole: 'PASSENGER' | 'DRIVER' | null;
  declare poolSize: number;
  declare ridersOnboard: number;
  declare cancellationZone: string | null;
  declare chargedFare: number | null;
  declare fullTripEstimate: number | null;
  declare readonly createdAt: Date;
}

export const initRideEvent = (sequelize: any) => {
  RideEvent.init(
    {
      // Auto-increment, so events sort in the exact order they happened even within one millisecond.
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      rideRequestId: { type: DataTypes.UUID, allowNull: false, references: { model: 'RideRequests', key: 'id' } },
      passengerId: { type: DataTypes.UUID, allowNull: false },
      vehicleId: { type: DataTypes.UUID, allowNull: true },
      status: { type: DataTypes.ENUM(...RIDE_STATUS_VALUES), allowNull: false },
      fromStatus: { type: DataTypes.ENUM(...RIDE_STATUS_VALUES), allowNull: true },
      actorId: { type: DataTypes.UUID, allowNull: true },
      actorRole: { type: DataTypes.ENUM('PASSENGER', 'DRIVER'), allowNull: true },
      poolSize: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      ridersOnboard: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      cancellationZone: { type: DataTypes.STRING, allowNull: true },
      chargedFare: { type: DataTypes.INTEGER, allowNull: true },
      fullTripEstimate: { type: DataTypes.INTEGER, allowNull: true },
    },
    { sequelize, tableName: 'RideEvents', updatedAt: false }
  );
};
