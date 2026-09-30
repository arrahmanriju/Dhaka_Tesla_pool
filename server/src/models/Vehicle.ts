import { DataTypes, Model } from 'sequelize';
import { VEHICLE_CODE_PATTERN, generateVehicleCode } from '../utils/vehicleCode';
import { DriverProfile } from './DriverProfile';

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
        // Every vehicle gets a public code, however it is created (onboarding, the vehicle API, the seed):
        // its driver's Tesla ID if the driver has one, otherwise a random code. The caller's transaction is
        // used for the lookups, so a profile created a moment ago in the same transaction is seen.
        beforeValidate: async (vehicle: Vehicle, options: any) => {
          if (vehicle.vehicleCode) return;
          // Sequelize also runs this hook on the partial object it builds for a bulk Vehicle.update (every seat
          // claim and release). That object has no driver, and an update must never touch the code: only a real
          // creation, which always has a driver, gets one.
          if (!vehicle.driverId) return;
          const transaction = options?.transaction ?? null;
          const profile = await DriverProfile.findOne({ where: { userId: vehicle.driverId }, transaction });
          if (profile && (await Vehicle.count({ where: { vehicleCode: profile.driverCode }, transaction })) === 0) {
            vehicle.vehicleCode = profile.driverCode; // "DTP-0001": the same ID shown as "Tesla ID" elsewhere
            return;
          }
          for (let attempt = 0; attempt < 20; attempt++) {
            const code = generateVehicleCode();
            if ((await Vehicle.count({ where: { vehicleCode: code }, transaction })) === 0) {
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
