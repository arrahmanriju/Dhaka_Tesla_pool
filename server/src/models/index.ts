import { Sequelize } from 'sequelize';
import path from 'path';
import { User, initUser } from './User';
import { Vehicle, initVehicle } from './Vehicle';
import { RideRequest, initRideRequest } from './RideRequest';
import { PasswordReset, initPasswordReset } from './PasswordReset';
import { DriverProfile, initDriverProfile } from './DriverProfile';

// Setup Sequelize for SQLite
export const storagePath = process.env.DB_STORAGE_PATH || path.join(__dirname, '../../data/database.sqlite');

export const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: storagePath,
  logging: false,
});

initUser(sequelize);
initVehicle(sequelize);
initRideRequest(sequelize);
initPasswordReset(sequelize);
initDriverProfile(sequelize);

// Setup Associations
User.hasMany(PasswordReset, { foreignKey: 'userId', onDelete: 'CASCADE' });
User.hasOne(DriverProfile, { foreignKey: 'userId', onDelete: 'CASCADE' });
DriverProfile.belongsTo(User, { foreignKey: 'userId' });
PasswordReset.belongsTo(User, { foreignKey: 'userId' });

User.hasMany(Vehicle, { foreignKey: 'driverId' });
Vehicle.belongsTo(User, { foreignKey: 'driverId' });

User.hasMany(RideRequest, { foreignKey: 'passengerId', as: 'rideRequests' });
RideRequest.belongsTo(User, { foreignKey: 'passengerId', as: 'passenger' });

// driverId on RideRequest — set when the ride is MATCHED
User.hasMany(RideRequest, { foreignKey: 'driverId', as: 'assignedRides' });
RideRequest.belongsTo(User, { foreignKey: 'driverId', as: 'driver' });

Vehicle.hasMany(RideRequest, { foreignKey: 'vehicleId', as: 'poolRequests' });
RideRequest.belongsTo(Vehicle, { foreignKey: 'vehicleId', as: 'vehicle' });
export { User, Vehicle, RideRequest, PasswordReset, DriverProfile };

