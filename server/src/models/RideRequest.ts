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
] as const;

export type DhakaZone = typeof DHAKA_ZONES[number];

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
  public estimatedFare!: number;         // integer paisa (100 paisa = 1 BDT)
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
      estimatedFare: {
        type: DataTypes.INTEGER,  // paisa
        allowNull: false,
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
