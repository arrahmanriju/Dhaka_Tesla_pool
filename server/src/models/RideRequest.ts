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

// ---------------------------------------------------------------------------
// Pool compatibility: two requests are pool-compatible if they share the same
// pickup zone AND the same destination zone.
//
// We intentionally keep this simple (exact zone match) rather than using
// geographic routing. This is easy to understand, test, and extend later.
// ---------------------------------------------------------------------------
export function areZonesCompatible(
  existingDestination: string,
  newDestination: string
): boolean {
  // Exact match only — same destination zone required to share a pool.
  return existingDestination === newDestination;
}

/**
 * Ride status state machine:
 *   REQUESTED → MATCHED → DRIVER_ARRIVED → STARTED → COMPLETED
 *                    ↓            ↓           ↓
 *                CANCELLED    CANCELLED   CANCELLED
 *
 * Allowed transitions:
 *   REQUESTED     → MATCHED        (driver accepts the ride)
 *   MATCHED       → DRIVER_ARRIVED (driver marks arrived at pickup)
 *   DRIVER_ARRIVED→ STARTED        (driver starts the trip)
 *   STARTED       → COMPLETED      (driver completes the trip)
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
  | 'CANCELLED';

export const RIDE_STATUS_VALUES: RideStatus[] = [
  'REQUESTED',
  'MATCHED',
  'DRIVER_ARRIVED',
  'STARTED',
  'COMPLETED',
  'CANCELLED',
];

/**
 * Pool-joinable states: a driver can pool a new passenger onto a trip that
 * is in one of these states. Once the trip has STARTED no new passengers
 * are added.
 *
 * We include STARTED here so the pool-compatibility query finds it;
 * the accept route then checks r.status === 'STARTED' and rejects.
 */
export const POOL_JOINABLE_STATUSES: RideStatus[] = ['MATCHED', 'DRIVER_ARRIVED', 'STARTED'];

/** Returns null if the transition is allowed; an error string if not. */
export function validateTransition(from: RideStatus, to: RideStatus): string | null {
  const allowed: Record<RideStatus, RideStatus[]> = {
    REQUESTED:      ['MATCHED', 'CANCELLED'],
    MATCHED:        ['DRIVER_ARRIVED', 'CANCELLED'],
    DRIVER_ARRIVED: ['STARTED', 'CANCELLED'],
    STARTED:        ['COMPLETED'],
    COMPLETED:      [],
    CANCELLED:      [],
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

  /** Full fare before pool discount — integer paisa. Set at creation; never changes. */
  public baseFare!: number;

  /**
   * Final fare charged to this passenger — integer paisa.
   * Recalculated whenever pool membership changes:
   *   - When a second passenger joins → reduced by POOL_DISCOUNT
   *   - When solo again (co-passenger cancelled) → reverted to baseFare
   */
  public estimatedFare!: number;

  /** Pool discount applied to this passenger — integer paisa. 0 when riding alone. */
  public poolDiscount!: number;

  public status!: RideStatus;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

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
        type: DataTypes.INTEGER, // paisa — set at creation, never changes
        allowNull: false,
        defaultValue: 0,
      },
      estimatedFare: {
        type: DataTypes.INTEGER, // paisa — recalculated when pool changes
        allowNull: false,
        defaultValue: 0,
      },
      poolDiscount: {
        type: DataTypes.INTEGER, // paisa discount applied to this passenger
        allowNull: false,
        defaultValue: 0,
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
    }
  );
};
