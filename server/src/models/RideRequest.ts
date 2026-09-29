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

export class RideRequest extends Model {
  public id!: string;
  public passengerId!: string;
  public pickupZone!: string;
  public destinationZone!: string;
  public seatCount!: number;
  public estimatedFare!: number; // Stored in integer paisa (100 paisa = 1 BDT)
  public status!: 'PENDING' | 'ACCEPTED' | 'COMPLETED' | 'CANCELLED';
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
        references: {
          model: 'Users',
          key: 'id',
        },
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
        validate: {
          min: 1,
        },
      },
      estimatedFare: {
        type: DataTypes.INTEGER, // paisa
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('PENDING', 'ACCEPTED', 'COMPLETED', 'CANCELLED'),
        allowNull: false,
        defaultValue: 'PENDING',
      },
    },
    {
      sequelize,
      tableName: 'RideRequests',
    }
  );
};
