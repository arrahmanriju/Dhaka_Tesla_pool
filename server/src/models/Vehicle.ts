import { DataTypes, Model } from 'sequelize';

export class Vehicle extends Model {
  public id!: string;
  public driverId!: string;
  public modelName!: string;
  public seatCapacity!: number;
  public licensePlate!: string;
  public isActive!: boolean;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
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
    },
    {
      sequelize,
      tableName: 'Vehicles',
    }
  );
};
