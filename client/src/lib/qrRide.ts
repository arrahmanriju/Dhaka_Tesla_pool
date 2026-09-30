import type { QRSession, Ride } from './api';

/**
 * A street ride the passenger is on, in the shape of an ordinary ride, so the app's Active Ride card can
 * show it. There is no driver in this flow: `driver` stays empty, and `status` is only ever "in progress"
 * (the card, told it is a street ride, hides the driver steps and says so). Co-passengers are "Passenger N".
 */
export function qrSessionToRide(session: QRSession): Ride {
  const { you, vehicle } = session;
  const others = session.passengers.filter((p) => !p.isYou && p.status === 'RIDING');
  const capacity = vehicle.seatCapacity ?? 0;
  const seatsTaken = vehicle.seatsFree == null ? you.seatCount + others.length : capacity - vehicle.seatsFree;

  return {
    id: session.id,
    pickupZone: you.pickupZone,
    destinationZone: you.destinationZone,
    seatCount: you.seatCount,
    allowSharing: true,
    baseFare: you.baseFare,
    estimatedFare: you.fare ?? you.baseFare,
    poolDiscount: you.poolDiscount ?? 0,
    fareFinal: you.fareFinal,
    fareBreakdown: you.fareBreakdown,
    status: 'STARTED',
    canCancel: false,
    canCancelInTransit: false,
    driver: null,
    vehicle: vehicle.seatCapacity == null ? null : {
      id: session.id,
      modelName: vehicle.nickname ?? '',
      licensePlate: vehicle.vehicleCode ?? '',
      seatCapacity: capacity,
      nickname: vehicle.nickname ?? undefined,
      teslaId: vehicle.vehicleCode ?? undefined,
    },
    pool: {
      isShared: others.length > 0,
      poolSize: others.length + 1,
      otherPassengers: others.map((p) => ({ label: p.label, number: Number(p.label.replace(/\D/g, '')) })),
      yourNumber: you.passengerNumber,
      seatsTaken,
      seatCapacity: capacity,
    },
    paymentMethod: 'cash',
    paymentStatus: you.payment.status,
    paymentAmount: you.payment.amount,
    createdAt: you.joinedAt,
    updatedAt: you.joinedAt,
    source: 'QR',
  };
}
