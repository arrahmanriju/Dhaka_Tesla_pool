import { DataTypes, Model } from 'sequelize';

export class Vehicle extends Model {
  declare id: string;
  declare driverId: string;
  declare modelName: string;
  declare seatCapacity: number;
  declare licensePlate: string;
  declare isActive: boolean;
  declare occupiedSeats: number;
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
      driverId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'Users',
          key: 'id',
        },
      },
      modelName: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      seatCapacity: {
        type: DataTypes.INTEGER,
        allowNull: false,
        validate: {
          min: 1, // Validation: capacity must be positive integer
        },
      },
      licensePlate: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
      },
      isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        allowNull: false,
      },
      occupiedSeats: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
        validate: {
          min: 0,
        },
      },
    },
    {
      sequelize,
      tableName: 'Vehicles',
    }
  );
};
