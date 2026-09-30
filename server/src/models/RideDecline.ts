import { DataTypes, Model } from 'sequelize';

/**
 * A driver said "no thanks" to a pending request. The request itself stays REQUESTED for every
 * other driver; it just stops showing up for this one. Never shown to passengers.
 */
export class RideDecline extends Model {
  declare id: number;
  declare rideRequestId: string;
  declare driverId: string;
  declare readonly createdAt: Date;
}

export const initRideDecline = (sequelize: any) => {
  RideDecline.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      rideRequestId: { type: DataTypes.UUID, allowNull: false, references: { model: 'RideRequests', key: 'id' } },
      driverId: { type: DataTypes.UUID, allowNull: false, references: { model: 'Users', key: 'id' } },
    },
    {
      sequelize,
      tableName: 'RideDeclines',
      updatedAt: false,
      indexes: [{ unique: true, fields: ['rideRequestId', 'driverId'] }],
    }
  );
};
