import { Sequelize } from 'sequelize';
import path from 'path';
import { User, initUser } from './User';
import { Vehicle, initVehicle } from './Vehicle';

// Setup Sequelize for SQLite
const storagePath = process.env.DB_STORAGE_PATH || path.join(__dirname, '../../data/database.sqlite');

export const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: storagePath,
  logging: false,
});

initUser(sequelize);
initVehicle(sequelize);

// Define associations
User.hasOne(Vehicle, { foreignKey: 'driver_id' });
Vehicle.belongsTo(User, { foreignKey: 'driver_id' });

export { User, Vehicle };


