import { Sequelize } from 'sequelize';
import path from 'path';
import { User, initUser } from './User';
import { Vehicle, initVehicle } from './Vehicle';
import { RideRequest, initRideRequest } from './RideRequest';
import { PasswordReset, initPasswordReset } from './PasswordReset';
import { DriverProfile, initDriverProfile } from './DriverProfile';
import { RideEvent, initRideEvent } from './RideEvent';
import { RideDecline, initRideDecline } from './RideDecline';
import { PoolCheckpoint, initPoolCheckpoint } from './PoolCheckpoint';
import { WalletTransaction, initWalletTransaction } from './WalletTransaction';
import { QRRideSession, QRRideParticipant, DriverBonus, initQRRide } from './QRRide';

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
initRideEvent(sequelize);
initRideDecline(sequelize);
initPoolCheckpoint(sequelize);
initWalletTransaction(sequelize);
initQRRide(sequelize);

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
RideRequest.hasMany(RideEvent, { foreignKey: 'rideRequestId', as: 'events' });
RideEvent.belongsTo(RideRequest, { foreignKey: 'rideRequestId' });

RideRequest.hasMany(PoolCheckpoint, { foreignKey: 'rideRequestId', onDelete: 'CASCADE' });
Vehicle.hasMany(PoolCheckpoint, { foreignKey: 'vehicleId', onDelete: 'CASCADE' });

User.hasMany(WalletTransaction, { foreignKey: 'userId', onDelete: 'CASCADE' });
RideRequest.hasMany(WalletTransaction, { foreignKey: 'rideRequestId', onDelete: 'CASCADE' });

Vehicle.hasMany(QRRideSession, { foreignKey: 'vehicleId', onDelete: 'CASCADE' });
QRRideSession.hasMany(QRRideParticipant, { foreignKey: 'sessionId', as: 'participants', onDelete: 'CASCADE' });
User.hasMany(QRRideParticipant, { foreignKey: 'passengerId', onDelete: 'CASCADE' });
QRRideSession.hasMany(DriverBonus, { foreignKey: 'sessionId', onDelete: 'CASCADE' });
QRRideParticipant.hasMany(DriverBonus, { foreignKey: 'participantId', onDelete: 'CASCADE' });
User.hasMany(DriverBonus, { foreignKey: 'driverId', onDelete: 'CASCADE' });

export { User, Vehicle, RideRequest, PasswordReset, DriverProfile, RideEvent, RideDecline, PoolCheckpoint, WalletTransaction, QRRideSession, QRRideParticipant, DriverBonus };

