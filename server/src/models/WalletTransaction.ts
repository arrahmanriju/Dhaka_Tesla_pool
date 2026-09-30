import { DataTypes, Model } from 'sequelize';

/**
 * The TeslaPay wallet ledger (simulated, no real gateway): one row per movement of money, written in
 * the same transaction as the balance change and never updated or deleted.
 *
 *   DEBIT   a ride's final fare taken from the passenger's wallet (amount is positive; balanceAfter
 *           is what was left). At most one DEBIT per ride: the unique index on `rideRequestId`
 *           makes the charge idempotent.
 *
 * Money is whole taka, like fares (see fareCalculator.ts).
 */
export type WalletTransactionType = 'DEBIT';

export class WalletTransaction extends Model {
  declare id: number;
  declare userId: string;
  declare rideRequestId: string;
  declare type: WalletTransactionType;
  declare amount: number;
  declare balanceAfter: number;
  declare readonly createdAt: Date;
}

export const initWalletTransaction = (sequelize: any) => {
  WalletTransaction.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      userId: { type: DataTypes.UUID, allowNull: false, references: { model: 'Users', key: 'id' } },
      rideRequestId: { type: DataTypes.UUID, allowNull: false, unique: true, references: { model: 'RideRequests', key: 'id' } },
      type: { type: DataTypes.ENUM('DEBIT'), allowNull: false },
      amount: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 0 } },
      balanceAfter: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 0 } },
    },
    { sequelize, tableName: 'WalletTransactions', updatedAt: false }
  );
};
