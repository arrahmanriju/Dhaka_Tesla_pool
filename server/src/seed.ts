import bcrypt from 'bcryptjs';
import { sequelize, User, Vehicle, DriverProfile, RideRequest } from './models';
import { ensureOneActiveRideIndex, markFaresInTaka } from './migrations';
import { calculateBaseFare } from './utils/fareCalculator';
import dotenv from 'dotenv';

dotenv.config();

async function seed() {
  try {
    console.log('Syncing database...');
    // Force true drops the tables if they exist, resetting the DB state for testing
    await sequelize.sync({ force: true });
    await ensureOneActiveRideIndex();
    await markFaresInTaka(); // fares in this database are whole taka

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
    const passengerIds: string[] = [];
    for (const [i, name] of passengers.entries()) {
      const passenger = await User.create({
        name,
        phone: `0171100000${i + 1}`,
        email: `${name.toLowerCase()}@test.com`,
        password: defaultPassword,
        role: 'PASSENGER',
      });
      passengerIds.push(passenger.id);
      console.log(`Created passenger ${name}`);
    }

    // 4. The pool-fare story: all three want Mohakhali → Badda (a 3-seat Tesla, Jashim's Bullet).
    //    Each request starts at the solo fare; log in as Jashim, go online and accept them one
    //    by one to watch the fare split:  ৳180 alone → ৳125 each with 2 → ৳100 each with 3.
    const soloFare = calculateBaseFare('Mohakhali', 'Badda', 1);
    for (const passengerId of passengerIds) {
      await RideRequest.create({
        passengerId,
        pickupZone: 'Mohakhali',
        destinationZone: 'Badda',
        seatCount: 1,
        allowSharing: true,
        baseFare: soloFare,
        estimatedFare: soloFare,
        poolDiscount: 0,
        status: 'REQUESTED',
      });
    }
    console.log(`Created 3 ride requests Mohakhali → Badda at ৳${soloFare} each (Nusrat, Rafiq, Shirin)`);

    console.log('✅ Seeding completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  }
}

seed();
