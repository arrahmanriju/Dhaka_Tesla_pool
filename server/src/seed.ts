import bcrypt from 'bcryptjs';
import { sequelize, User, Vehicle, DriverProfile } from './models';
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
      phone: '01711000000',
      email: 'jashim@test.com',
      password: defaultPassword,
      role: 'DRIVER',
    });
    console.log('Created driver Jashim');

    // 2. Onboard Jashim: profile first (its auto-increment id becomes his Tesla ID),
    //    then his vehicle "Bullet".
    const jashimProfile = await DriverProfile.create({
      userId: jashim.id,
      homeZone: 'Banani',
      nid: '1234567890', // demo value only
    });
    await Vehicle.create({
      driverId: jashim.id,
      modelName: 'Bullet',
      seatCapacity: 3,
      licensePlate: jashimProfile.driverCode, // the Tesla ID doubles as the vehicle identifier
    });
    console.log(`Onboarded driver Jashim: vehicle Bullet (3 seats), Banani, ${jashimProfile.driverCode}`);

    // 3. Create Passengers
    const passengers = ['Nusrat', 'Rafiq', 'Shirin'];
    for (const [i, name] of passengers.entries()) {
      await User.create({
        name,
        phone: `0171100000${i + 1}`,
        email: `${name.toLowerCase()}@test.com`,
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
