import { DataTypes, Model } from 'sequelize';


export class User extends Model {
  declare id: string;
  declare name: string;
  declare email: string | null;
  declare phone: string | null;
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
      // Optional. SQLite UNIQUE allows many NULLs, so unset emails never collide.
      email: {
        type: DataTypes.STRING,
        allowNull: true,
        unique: true,
        validate: {
          isEmail: true,
        },
      },
      // Canonical Bangladesh mobile number (01XXXXXXXXX). Required at signup (see
      // routes/auth.ts); nullable here so accounts created before phone numbers
      // existed keep working.
      phone: {
        type: DataTypes.STRING,
        allowNull: true,
        unique: true,
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
