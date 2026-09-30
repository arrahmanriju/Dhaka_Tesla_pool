'use client';
import { usePreferences } from '@/lib/preferences';
import type { Ride } from '@/lib/api';
import type { TranslationKey } from '@/lib/translations';

/**
 * What the DRIVER sees about a ride's payment: only whether it succeeded (paid), is cash to collect,
 * or failed and needs cash. Never a wallet balance: the API does not send one to drivers.
 */
export function PaymentStatusTag({ ride }: { ride: Pick<Ride, 'paymentMethod' | 'paymentStatus' | 'paymentAmount' | 'estimatedFare'> }) {
  const { t } = usePreferences();
  const status = ride.paymentStatus;
  if (!status || status === 'NOT_DUE') return null;
  const cls = status === 'FAILED' ? 'badge badge--cancelled' : status === 'PAID' ? 'badge badge--completed' : 'badge badge--matched';
  return (
    <span className={cls} data-payment-status={status} style={{ fontSize: 11 }}>
      {t(`pay.driver.${status}` as TranslationKey, { amount: ride.paymentAmount ?? ride.estimatedFare })}
    </span>
  );
}
