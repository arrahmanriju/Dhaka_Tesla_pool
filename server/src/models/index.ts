import { Sequelize } from 'sequelize';
import path from 'path';
import { User, initUser } from './User';
import { RideRequest, initRideRequest } from './RideRequest';

// Setup Sequelize for SQLite
const storagePath = process.env.DB_STORAGE_PATH || path.join(__dirname, '../../data/database.sqlite');

export const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: storagePath,
  logging: false,
});

initUser(sequelize);
initRideRequest(sequelize);

// Setup Associations
User.hasMany(RideRequest, { foreignKey: 'passengerId', as: 'rideRequests' });
RideRequest.belongsTo(User, { foreignKey: 'passengerId', as: 'passenger' });

export { User, RideRequest };

