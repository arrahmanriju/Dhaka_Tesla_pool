import { DataTypes, Model } from 'sequelize';


export class User extends Model {
  declare id: string;
  declare name: string;
  declare email: string;
  declare role: 'DRIVER' | 'PASSENGER';
  declare password: string;
  declare isOnline: boolean;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

export const initUser = (sequelize: any) => {
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
      },
      email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        validate: {
          isEmail: true,
        },
      },
      role: {
        type: DataTypes.ENUM('DRIVER', 'PASSENGER'),
        allowNull: false,
      },
      password: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      isOnline: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
    },
    {
      sequelize,
      tableName: 'Users',
    }
  );
};
