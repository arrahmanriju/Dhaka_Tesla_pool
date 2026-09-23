import bcrypt from 'bcryptjs';
import { sequelize, User, Vehicle } from './models';
import dotenv from 'dotenv';

dotenv.config();

async function seed() {
  try {
    console.log('Syncing database...');
    // Force true drops the tables if they exist, resetting the DB state for testing
    await sequelize.sync({ force: true });
    
    console.log('Database synced. Seeding data...');

    const defaultPassword = await bcrypt.hash('password123', 10);

    // 1. Create Driver Jashim
    const jashim = await User.create({
      name: 'Jashim',
      password: defaultPassword,
      role: 'DRIVER',
    });
    console.log('Created driver Jashim');

    // 2. Create Vehicle "Bullet" for Jashim
    await Vehicle.create({
      driver_id: jashim.id,
      name: 'Bullet',
      capacity: 3,
    });
    console.log('Created vehicle Bullet (3 seats) for Jashim');

    // 3. Create Passengers
    const passengers = ['Nusrat', 'Rafiq', 'Shirin'];
    for (const name of passengers) {
      await User.create({
        name,
        password: defaultPassword,
        role: 'PASSENGER',
      });
      console.log(`Created passenger ${name}`);
    }

    console.log('✅ Seeding completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  }
}

seed();
