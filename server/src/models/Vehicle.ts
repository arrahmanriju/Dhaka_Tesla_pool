import { DataTypes, Model } from 'sequelize';

export class Vehicle extends Model {
  declare id: string;
  declare driver_id: string;
  declare name: string;
  declare capacity: number;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

export const initVehicle = (sequelize: any) => {
  Vehicle.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      driver_id: {
        type: DataTypes.UUID,
        allowNull: false,
        unique: true, // 1-to-1 mapping for MVP
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      capacity: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
    },
    {
      sequelize,
      tableName: 'Vehicles',
    }
  );
};
