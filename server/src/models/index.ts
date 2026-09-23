import { Sequelize } from 'sequelize';
import path from 'path';

// Setup Sequelize for SQLite
const storagePath = process.env.DB_STORAGE_PATH || path.join(__dirname, '../../data/database.sqlite');

export const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: storagePath,
  logging: false,
});
