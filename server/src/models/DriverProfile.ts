import { DataTypes, Model } from 'sequelize';

/** "DTP-0001" from the auto-increment id. Padding only grows past 4 digits, never truncates. */
export const formatDriverCode = (id: number) => `DTP-${String(id).padStart(4, '0')}`;

/**
 * Onboarding record for a driver. A driver is "onboarded" once a row exists here.
 *
 * `id` is an AUTOINCREMENT integer, and the public driver ID (`driverCode`, e.g. DTP-0001)
 * is derived from it. The database hands out each id exactly once — even to two drivers
 * onboarding at the same instant, and even after rows are deleted — so IDs can never
 * collide the way COUNT(*)+1 could. Nothing is stored twice, so nothing can drift.
 *
 * The vehicle nickname and seat capacity live on the driver's Vehicle row (used by pooling).
 *
 * `nid` is sensitive: it is only ever returned (masked) to the driver who owns it and must
 * never be added to a passenger-facing response.
 */
export class DriverProfile extends Model {
  declare id: number;
  declare userId: string;
  declare homeZone: string;
  declare nid: string;
  declare profilePicture: string | null;
  declare readonly driverCode: string;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

export const initDriverProfile = (sequelize: any) => {
  DriverProfile.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
        unique: true, // one profile per driver
        references: { model: 'Users', key: 'id' },
        onDelete: 'CASCADE',
      },
      homeZone: { type: DataTypes.STRING, allowNull: false },
      nid: { type: DataTypes.STRING, allowNull: false, unique: true },
      // File name inside the uploads directory, or null when no picture was given.
      profilePicture: { type: DataTypes.STRING, allowNull: true },
      driverCode: {
        type: DataTypes.VIRTUAL,
        get(this: Model) {
          return formatDriverCode(this.getDataValue('id') as number);
        },
      },
    },
    { sequelize, tableName: 'DriverProfiles' }
  );
};
