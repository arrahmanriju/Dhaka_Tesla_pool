import { DataTypes, Model } from 'sequelize';
import { sequelize } from './index';

export class User extends Model {
  public id!: string;
  public name!: string;
  public role!: 'DRIVER' | 'PASSENGER';
  public password!: string;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

User.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true, // using name as a unique identifier for simplicity in MVP (acting like username)
    },
    role: {
      type: DataTypes.ENUM('DRIVER', 'PASSENGER'),
      allowNull: false,
    },
    password: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'Users',
  }
);
