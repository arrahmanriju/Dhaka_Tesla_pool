import { DataTypes, Model } from 'sequelize';
import { DHAKA_ZONES } from './RideRequest';

// ---------------------------------------------------------------------------
// STREET RIDES BY QR CODE (for drivers with no smartphone: the driver never logs in and takes no action)
//
// Deliberately much simpler than the app's ride lifecycle: there is no driver app to report
// DRIVER_ARRIVED or STARTED, so a passenger is simply RIDING until they say they have arrived.
// These tables are separate from RideRequests on purpose: a street passenger is not a RideRequest, so
// pools, checkpoints, fares and earnings of the two flows never mix. The only thing shared is the
// vehicle's seat count (utils/seats.ts), because a seat is a seat.
// ---------------------------------------------------------------------------

export type QRSessionStatus = 'OPEN' | 'CLOSED';
/** ALL_ARRIVED: every passenger marked their own arrival. TIMEOUT: nobody closed it, so it was closed automatically. */
export type QRCloseReason = 'ALL_ARRIVED' | 'TIMEOUT';
/** RIDING -> ARRIVED (the passenger said so) or AUTO_COMPLETED (the session timed out first). */
export type QRParticipantStatus = 'RIDING' | 'ARRIVED' | 'AUTO_COMPLETED';

/** One journey of a vehicle with street passengers. At most one is OPEN per vehicle (a unique index enforces it). */
export class QRRideSession extends Model {
  declare id: string;
  declare vehicleId: string;
  declare status: QRSessionStatus;
  declare openedAt: Date;
  declare closedAt: Date | null;
  declare closeReason: QRCloseReason | null;
  /** Counts joins and exits in the order they happened, so fares can walk them without relying on timestamps. */
  declare eventSeq: number;
  declare readonly createdAt: Date;
}

export class QRRideParticipant extends Model {
  declare id: string;
  declare sessionId: string;
  declare passengerId: string;
  /** 1, 2, 3 ... in the order they joined: shown to the others as "Passenger 1", "Passenger 2" */
  declare passengerNumber: number;
  declare pickupZone: string;
  declare destinationZone: string;
  declare seatCount: number;
  declare status: QRParticipantStatus;
  declare joinedAt: Date;
  declare joinSeq: number;
  declare exitedAt: Date | null;
  declare exitSeq: number | null;
  /** Solo fare for pickup -> destination (whole taka), set at joining */
  declare baseFare: number;
  /** Final segment fare and what pooling saved, set when the passenger's own journey ends (whole taka) */
  declare finalFare: number | null;
  declare poolDiscount: number | null;
  /** Always 'cash' for street rides: see services/qrRides.ts */
  declare paymentMethod: 'cash';
  declare paymentStatus: 'NOT_DUE' | 'CASH_DUE';
  declare paymentAmount: number | null;
}

/** Credited to the driver's record for each passenger beyond the first in a session. Append-only. */
export class DriverBonus extends Model {
  declare id: number;
  declare driverId: string;
  declare sessionId: string;
  declare participantId: string;
  declare amount: number;
  declare readonly createdAt: Date;
}

export const initQRRide = (sequelize: any) => {
  QRRideSession.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      vehicleId: { type: DataTypes.UUID, allowNull: false, references: { model: 'Vehicles', key: 'id' } },
      status: { type: DataTypes.ENUM('OPEN', 'CLOSED'), allowNull: false, defaultValue: 'OPEN' },
      openedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      closedAt: { type: DataTypes.DATE, allowNull: true },
      closeReason: { type: DataTypes.ENUM('ALL_ARRIVED', 'TIMEOUT'), allowNull: true },
      eventSeq: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { sequelize, tableName: 'QRRideSessions' }
  );

  QRRideParticipant.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      sessionId: { type: DataTypes.UUID, allowNull: false, references: { model: 'QRRideSessions', key: 'id' } },
      passengerId: { type: DataTypes.UUID, allowNull: false, references: { model: 'Users', key: 'id' } },
      passengerNumber: { type: DataTypes.INTEGER, allowNull: false },
      pickupZone: { type: DataTypes.ENUM(...DHAKA_ZONES), allowNull: false },
      destinationZone: { type: DataTypes.ENUM(...DHAKA_ZONES), allowNull: false },
      seatCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, validate: { min: 1 } },
      status: { type: DataTypes.ENUM('RIDING', 'ARRIVED', 'AUTO_COMPLETED'), allowNull: false, defaultValue: 'RIDING' },
      joinedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      joinSeq: { type: DataTypes.INTEGER, allowNull: false },
      exitedAt: { type: DataTypes.DATE, allowNull: true },
      exitSeq: { type: DataTypes.INTEGER, allowNull: true },
      baseFare: { type: DataTypes.INTEGER, allowNull: false, validate: { isInt: true } },
      finalFare: { type: DataTypes.INTEGER, allowNull: true, validate: { isInt: true } },
      poolDiscount: { type: DataTypes.INTEGER, allowNull: true, validate: { isInt: true } },
      paymentMethod: { type: DataTypes.ENUM('cash'), allowNull: false, defaultValue: 'cash' },
      paymentStatus: { type: DataTypes.ENUM('NOT_DUE', 'CASH_DUE'), allowNull: false, defaultValue: 'NOT_DUE' },
      paymentAmount: { type: DataTypes.INTEGER, allowNull: true, validate: { isInt: true } },
    },
    {
      sequelize,
      tableName: 'QRRideParticipants',
      // a passenger is in a session once
      indexes: [{ unique: true, fields: ['sessionId', 'passengerId'] }],
    }
  );

  DriverBonus.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      driverId: { type: DataTypes.UUID, allowNull: false, references: { model: 'Users', key: 'id' } },
      sessionId: { type: DataTypes.UUID, allowNull: false, references: { model: 'QRRideSessions', key: 'id' } },
      // unique: a passenger can only ever earn the driver one bonus
      participantId: { type: DataTypes.UUID, allowNull: false, unique: true, references: { model: 'QRRideParticipants', key: 'id' } },
      amount: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 0, isInt: true } },
    },
    { sequelize, tableName: 'DriverBonuses', updatedAt: false }
  );
};
