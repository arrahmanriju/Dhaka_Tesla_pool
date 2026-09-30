import { Op, Transaction } from 'sequelize';
import { RideRequest, User, WalletTransaction, sequelize } from '../models';

// ---------------------------------------------------------------------------
// SIMULATED PAYMENT (no real gateway)
//
// Each ride carries a payment method chosen when it is requested:
//   'cash'    the passenger pays the driver in cash
//   'wallet'  the passenger pays from their TeslaPay wallet balance
//
// A ride's paymentStatus:
//   NOT_DUE   the passenger's journey has not ended (or the ride never started): nothing to pay
//   CASH_DUE  cash ride, journey ended: `paymentAmount` is what they owe the driver. The wallet is untouched.
//   PAID      wallet ride, journey ended: the wallet was debited by exactly `paymentAmount`
//   FAILED    wallet ride, journey ended, but the balance could not cover the fare. Nothing was
//             debited and the balance did not change (it can never go negative).
//
// WHAT HAPPENS NEXT after FAILED (MVP): the ride is still COMPLETED / CANCELLED_IN_TRANSIT and the
// fare is still owed. It is FLAGGED FOR CASH SETTLEMENT: `paymentAmount` records what is due, and the
// driver sees "payment failed" and collects that amount in cash. There is no retry, top-up or debt
// account in this MVP. (A real system would retry the wallet after a top-up or turn this into a debt.)
//
// The amount is the FINAL, segment-based fare (utils/fareCalculator.ts segmentFare), settled by
// utils/journeySettlement.ts. Money is whole taka, like every fare.
// ---------------------------------------------------------------------------
export type PaymentMethod = 'cash' | 'wallet';
export type PaymentStatus = 'NOT_DUE' | 'CASH_DUE' | 'PAID' | 'FAILED';

export const PAYMENT_METHODS: PaymentMethod[] = ['cash', 'wallet'];
export const PAYMENT_STATUSES: PaymentStatus[] = ['NOT_DUE', 'CASH_DUE', 'PAID', 'FAILED'];
export const DEFAULT_PAYMENT_METHOD: PaymentMethod = 'cash';

export const isPaymentMethod = (v: unknown): v is PaymentMethod => typeof v === 'string' && (PAYMENT_METHODS as string[]).includes(v);

/**
 * Collects the fare of a ride whose journey has just ended. Call it inside the transaction that ended
 * the ride, AFTER its final fare is stored (`fare` is that final fare).
 *
 * The wallet debit is one atomic conditional UPDATE: the balance is reduced only where it is at least
 * the fare, so it can never go negative even with simultaneous debits. If it changes no row the
 * payment is recorded as FAILED and the ride itself is left as it is (the passenger did travel).
 */
export async function collectPayment(
  ride: { id: string; passengerId: string; paymentMethod: string },
  fare: number,
  transaction: Transaction | null = null
): Promise<PaymentStatus> {
  let status: PaymentStatus;

  if (ride.paymentMethod === 'wallet') {
    const [debited] = await User.update(
      { walletBalance: sequelize.literal(`walletBalance - ${Math.trunc(fare)}`) },
      { where: { id: ride.passengerId, walletBalance: { [Op.gte]: fare } }, transaction }
    );
    if (debited === 1) {
      const user = await User.findByPk(ride.passengerId, { attributes: ['walletBalance'], transaction });
      await WalletTransaction.create(
        { userId: ride.passengerId, rideRequestId: ride.id, type: 'DEBIT', amount: fare, balanceAfter: user!.walletBalance },
        { transaction }
      );
      status = 'PAID';
    } else {
      status = 'FAILED';
    }
  } else {
    status = 'CASH_DUE'; // cash: record what is owed, never touch the wallet
  }

  await RideRequest.update({ paymentStatus: status, paymentAmount: fare }, { where: { id: ride.id }, transaction });
  return status;
}
