/**
 * A street ride shown on the Active Ride page (the same card as an app ride). Run with `npm test`.
 *
 * Rule under test: the adapter gives the card everything it shows for a street ride (route, fare, cash, the
 * others as "Passenger N") and nothing that assumes a driver: no driver, no driver-arrival step, and no
 * ordinary cancel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { QRSession } from './api';
import { qrSessionToRide } from './qrRide';

const session = (over: Partial<QRSession> = {}): QRSession => ({
  id: 's1',
  status: 'OPEN',
  openedAt: '2026-01-01T10:00:00Z',
  closedAt: null,
  closeReason: null,
  autoCloseAfterMinutes: 90,
  vehicle: { vehicleCode: 'DTP-0001', nickname: 'Bullet', seatCapacity: 4, seatsFree: 1 },
  you: {
    passengerNumber: 2,
    pickupZone: 'Gulshan',
    destinationZone: 'Motijheel',
    seatCount: 1,
    status: 'RIDING',
    joinedAt: '2026-01-01T10:05:00Z',
    exitedAt: null,
    baseFare: 150,
    fare: 110,
    fareFinal: false,
    poolDiscount: 40,
    fareBreakdown: { baseCharge: 100, segments: [], poolDiscount: 40 } as unknown as QRSession['you']['fareBreakdown'],
    payment: { method: 'cash', status: 'NOT_DUE', amount: null },
  },
  passengers: [
    { label: 'Passenger 1', isYou: false, status: 'RIDING' },
    { label: 'Passenger 2', isYou: true, status: 'RIDING' },
    { label: 'Passenger 3', isYou: false, status: 'RIDING' },
    { label: 'Passenger 4', isYou: false, status: 'ARRIVED' },
  ],
  ...over,
});

test('route, fare and cash payment are this passenger\'s own', () => {
  const ride = qrSessionToRide(session());
  assert.equal(ride.pickupZone, 'Gulshan');
  assert.equal(ride.destinationZone, 'Motijheel');
  assert.equal(ride.estimatedFare, 110);
  assert.equal(ride.poolDiscount, 40);
  assert.equal(ride.fareFinal, false);
  assert.equal(ride.paymentMethod, 'cash');
  assert.equal(ride.source, 'QR');
  assert.equal(ride.qrPassengerNumber, 2);
});

test('the others are "Passenger N", only those still riding, and never this passenger', () => {
  const pool = qrSessionToRide(session()).pool!;
  assert.deepEqual(pool.otherPassengers.map((p) => p.firstName), ['Passenger 1', 'Passenger 3']);
  assert.equal(pool.isShared, true);
  assert.equal(pool.seatsTaken, 3); // 4 seats, 1 free
  assert.equal(pool.seatCapacity, 4);
});

test('a lone passenger is "just you"', () => {
  const alone = session({ passengers: [{ label: 'Passenger 1', isYou: true, status: 'RIDING' }] });
  const pool = qrSessionToRide(alone).pool!;
  assert.equal(pool.isShared, false);
  assert.deepEqual(pool.otherPassengers, []);
});

test('no driver is tracked: no driver, no cancel, no leave-mid-trip', () => {
  const ride = qrSessionToRide(session());
  assert.equal(ride.driver, null);
  assert.equal(ride.canCancel, false);
  assert.equal(ride.canCancelInTransit, false);
});

test('the vehicle is shown by nickname and Tesla ID', () => {
  const ride = qrSessionToRide(session());
  assert.equal(ride.vehicle?.nickname, 'Bullet');
  assert.equal(ride.vehicle?.teslaId, 'DTP-0001');
});

test('cash owed after arriving is passed through', () => {
  const done = session();
  done.you.payment = { method: 'cash', status: 'CASH_DUE', amount: 110 };
  const ride = qrSessionToRide(done);
  assert.equal(ride.paymentStatus, 'CASH_DUE');
  assert.equal(ride.paymentAmount, 110);
});
