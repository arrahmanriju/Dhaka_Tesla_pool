import { DataTypes, Model } from 'sequelize';

/**
 * A one-time password-reset code sent to a user's phone.
 * Only a hash of the code is stored; rows are deleted once used, replaced when a
 * new code is requested, and ignored after `expiresAt` or too many wrong guesses.
 */
export class PasswordReset extends Model {
  declare id: string;
  declare userId: string;
  declare codeHash: string;
  declare expiresAt: Date;
  declare attempts: number;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

export const initPasswordReset = (sequelize: any) => {
  PasswordReset.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      userId: { type: DataTypes.UUID, allowNull: false },
      codeHash: { type: DataTypes.STRING, allowNull: false },
      expiresAt: { type: DataTypes.DATE, allowNull: false },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { sequelize, tableName: 'PasswordResets' }
  );
};
