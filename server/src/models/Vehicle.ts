import { DataTypes, Model } from 'sequelize';
import { VEHICLE_CODE_PATTERN, generateVehicleCode } from '../utils/vehicleCode';

export class Vehicle extends Model {
  declare id: string;
  declare driverId: string;
  declare modelName: string;
  declare seatCapacity: number;
  declare licensePlate: string;
  /** Public code on the QR sticker, and typed by hand as a fallback (see utils/vehicleCode.ts). Unique. */
  declare vehicleCode: string;
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
      // Public, unique, typeable: the QR sticker's content and the fallback ID. Generated automatically
      // when a vehicle is created without one.
      vehicleCode: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        validate: { is: VEHICLE_CODE_PATTERN },
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
      hooks: {
        // Every vehicle gets a public code, however it is created (onboarding, the vehicle API, the seed).
        beforeValidate: async (vehicle: Vehicle) => {
          if (vehicle.vehicleCode) return;
          for (let attempt = 0; attempt < 20; attempt++) {
            const code = generateVehicleCode();
            if ((await Vehicle.count({ where: { vehicleCode: code } })) === 0) {
              vehicle.vehicleCode = code;
              return;
            }
          }
          throw new Error('Could not generate a unique vehicle code');
        },
      },
    }
  );
};
