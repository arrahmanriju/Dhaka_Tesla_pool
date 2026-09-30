import { DataTypes, Model } from 'sequelize';

export const DHAKA_ZONES = [
  'Gulshan',
  'Banani',
  'Dhanmondi',
  'Uttara',
  'Mirpur',
  'Motijheel',
  'Mohammadpur',
  'Badda',
  'Mohakhali',
  'Gulshan 1',
] as const;

export type DhakaZone = typeof DHAKA_ZONES[number];

/** A single ride request can book 1–3 seats (the largest Tesla in the fleet has 3). */
export const MIN_SEATS_PER_RIDE = 1;
export const MAX_SEATS_PER_RIDE = 3;

/** Statuses that count as "the passenger has a ride in progress" (everything but the terminal states). */
export const ACTIVE_RIDE_STATUSES = ['REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED'] as const;

/**
 * Ride status state machine:
 *   REQUESTED → MATCHED → DRIVER_ARRIVED → STARTED → COMPLETED
 *                    ↓            ↓           ↓
 *                CANCELLED    CANCELLED   CANCELLED_IN_TRANSIT
 *
 * Allowed transitions:
 *   REQUESTED     → MATCHED        (driver accepts the ride)
 *   MATCHED       → DRIVER_ARRIVED (driver marks arrived at pickup)
 *   DRIVER_ARRIVED→ STARTED        (driver starts the trip)
 *   STARTED       → COMPLETED      (driver completes the trip)
 *   STARTED       → CANCELLED_IN_TRANSIT (passenger leaves mid-route, at a zone they name)
 *   REQUESTED     → CANCELLED      (passenger or driver cancels before match)
 *   MATCHED       → CANCELLED      (driver or passenger cancels after match)
 *   DRIVER_ARRIVED→ CANCELLED      (rare edge case — e.g. no-show)
 *
 * Invalid transitions are rejected with HTTP 409.
 */
export type RideStatus =
  | 'REQUESTED'
  | 'MATCHED'
  | 'DRIVER_ARRIVED'
  | 'STARTED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'CANCELLED_IN_TRANSIT';

export const RIDE_STATUS_VALUES: RideStatus[] = [
  'REQUESTED',
  'MATCHED',
  'DRIVER_ARRIVED',
  'STARTED',
  'COMPLETED',
  'CANCELLED',
  'CANCELLED_IN_TRANSIT',
];

/**
 * Pool-joinable states: the rides on a vehicle that a new passenger has to be compatible with.
 * STARTED is included on purpose: a trip that is already under way can still take passengers whose
 * route runs the same way (see utils/pooling.ts and utils/routeDirection.ts).
 */
export const POOL_JOINABLE_STATUSES: RideStatus[] = ['MATCHED', 'DRIVER_ARRIVED', 'STARTED'];

/**
 * Statuses a ride can never leave. CANCELLED_IN_TRANSIT is different from CANCELLED: the passenger
 * was picked up and travelled part of the route, so it is a real (part-)trip in the history, with a
 * pro-rated fare, not a request that never happened.
 */
export const TERMINAL_STATUSES: RideStatus[] = ['COMPLETED', 'CANCELLED', 'CANCELLED_IN_TRANSIT'];

/** Returns null if the transition is allowed; an error string if not. */
export function validateTransition(from: RideStatus, to: RideStatus): string | null {
  const allowed: Record<RideStatus, RideStatus[]> = {
    REQUESTED:      ['MATCHED', 'CANCELLED'],
    MATCHED:        ['DRIVER_ARRIVED', 'CANCELLED'],
    DRIVER_ARRIVED: ['STARTED', 'CANCELLED'],
    STARTED:        ['COMPLETED', 'CANCELLED_IN_TRANSIT'],
    COMPLETED:      [],
    CANCELLED:      [],
    CANCELLED_IN_TRANSIT: [],
  };

  const allowed_targets = allowed[from] ?? [];
  if (!allowed_targets.includes(to)) {
    return `Cannot transition from ${from} to ${to}.`;
  }
  return null;
}

export class RideRequest extends Model {
  public id!: string;
  public passengerId!: string;
  public driverId!: string | null;       // populated when MATCHED
  public vehicleId!: string | null;      // populated when MATCHED

  public pickupZone!: string;
  public destinationZone!: string;
  public seatCount!: number;

  /** false = private ride: never pooled with other passengers. */
  public allowSharing!: boolean;

  /**
   * This passenger's OWN fare when riding alone (their pickup → destination) — whole taka.
   * Set at creation; never changes.
   */
  public baseFare!: number;

  /**
   * What this passenger pays — whole taka.
   *   estimatedFare = trip cost / riders on board + ৳20 driver bonus (trip cost alone), stretch by stretch
   * An ESTIMATE that follows the pool (see utils/poolFares.ts) until the passenger's own journey ends,
   * when it is settled from the pool's checkpoints and becomes final (COMPLETED / CANCELLED_IN_TRANSIT,
   * see segmentFare in utils/fareCalculator.ts). A private ride (allowSharing = false) always pays the full trip cost.
   */
  public estimatedFare!: number;

  /** What this passenger saves by sharing (baseFare − estimatedFare) — whole taka. 0 when riding alone. */
  public poolDiscount!: number;

  /**
   * The pooled fare for the passenger's whole route that they were quoted when they boarded (whole taka),
   * frozen at that moment: null until the ride STARTS. It is what a mid-trip cancellation is based on
   * (half of it, see cancellationFare in utils/fareCalculator.ts). `estimatedFare` keeps following the pool.
   */
  public quotedFare!: number | null;

  /** Where the passenger left the ride, when it ended CANCELLED_IN_TRANSIT. `estimatedFare` is then half of `quotedFare`. */
  public cancellationZone!: string | null;

  /** How the passenger pays: 'cash' (to the driver) or 'wallet' (TeslaPay). Chosen when the ride is requested. */
  public paymentMethod!: string;
  /** NOT_DUE until the journey ends, then CASH_DUE / PAID / FAILED (see utils/payments.ts). */
  public paymentStatus!: string;
  /** The final fare that was owed or charged (whole taka); null until the journey ends. */
  public paymentAmount!: number | null;

  public status!: RideStatus;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

/** Why an attempt to change `allowSharing` is refused (see the hooks in initRideRequest). */
export const ALLOW_SHARING_FIXED = 'allowSharing is fixed when the ride is requested and cannot be changed afterwards.';

export const initRideRequest = (sequelize: any) => {
  RideRequest.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      passengerId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'Users', key: 'id' },
      },
      driverId: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'Users', key: 'id' },
      },
      vehicleId: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'Vehicles', key: 'id' },
      },
      pickupZone: {
        type: DataTypes.ENUM(...DHAKA_ZONES),
        allowNull: false,
      },
      destinationZone: {
        type: DataTypes.ENUM(...DHAKA_ZONES),
        allowNull: false,
      },
      seatCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        validate: { min: 1 },
      },
      allowSharing: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      baseFare: {
        type: DataTypes.INTEGER, // whole taka — set at creation, never changes
        allowNull: false,
        defaultValue: 0,
        validate: { isInt: true }, // whole taka only: SQLite would store 12.5 in an INTEGER column
      },
      estimatedFare: {
        type: DataTypes.INTEGER, // whole taka — an estimate until the journey ends, then final
        allowNull: false,
        defaultValue: 0,
        validate: { isInt: true },
      },
      poolDiscount: {
        type: DataTypes.INTEGER, // whole taka saved by sharing (baseFare − estimatedFare)
        allowNull: false,
        defaultValue: 0,
        validate: { isInt: true },
      },
      quotedFare: {
        type: DataTypes.INTEGER,
        allowNull: true,
        validate: { isInt: true, min: 0 },
      },
      cancellationZone: {
        type: DataTypes.ENUM(...DHAKA_ZONES),
        allowNull: true,
      },
      paymentMethod: {
        type: DataTypes.ENUM('cash', 'wallet'),
        allowNull: false,
        defaultValue: 'cash',
      },
      paymentStatus: {
        type: DataTypes.ENUM('NOT_DUE', 'CASH_DUE', 'PAID', 'FAILED'),
        allowNull: false,
        defaultValue: 'NOT_DUE',
      },
      paymentAmount: {
        type: DataTypes.INTEGER, // whole taka, set when the journey ends
        allowNull: true,
        validate: { isInt: true },
      },
      status: {
        type: DataTypes.ENUM(...RIDE_STATUS_VALUES),
        allowNull: false,
        defaultValue: 'REQUESTED',
      },
    },
    {
      sequelize,
      tableName: 'RideRequests',
      hooks: {
        // `allowSharing` is decided once, when the ride is requested, and is fixed for its lifetime: a matched
        // or started ride can never be switched between private and shared, by any route or any direct update.
        beforeUpdate: (ride: any) => {
          if (ride.changed('allowSharing')) throw new Error(ALLOW_SHARING_FIXED);
        },
        beforeBulkUpdate: (options: any) => {
          if (options.attributes && 'allowSharing' in options.attributes) throw new Error(ALLOW_SHARING_FIXED);
        },
      },
    }
  );
};
