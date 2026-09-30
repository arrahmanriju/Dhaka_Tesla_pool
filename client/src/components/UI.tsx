'use client';
import { usePreferences } from '@/lib/preferences';
import type { Ride } from '@/lib/api';

export function Spinner({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  return <span className={`spinner${size === 'lg' ? ' spinner--lg' : ''}`} />;
}

export function LoadingScreen({ label }: { label?: string }) {
  const { t } = usePreferences();
  return (
    <div className="loading-container">
      <Spinner size="lg" />
      <p>{label ?? t('loading.default')}</p>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon}</div>
      <p className="empty-state__title">{title}</p>
      {description && <p className="empty-state__desc">{description}</p>}
      {action}
    </div>
  );
}

/**
 * What a page shows when its data could NOT be loaded. Used instead of the empty state: "no rides yet"
 * would be wrong when the truth is "we could not check". Always explains what happened in plain words
 * and offers a way to try again.
 */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = usePreferences();
  return (
    <div className="empty-state" role="alert" id="load-error">
      <div className="empty-state__icon">⚠️</div>
      <p className="empty-state__title">{t('err.loadTitle')}</p>
      <p className="empty-state__desc">{message}</p>
      {onRetry && (
        <button className="btn btn--primary" onClick={onRetry} id="load-error-retry">
          {t('err.retry')}
        </button>
      )}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="error-banner">
      <span>⚠</span>
      {message}
    </div>
  );
}

export function SuccessBanner({ message }: { message: string }) {
  return <div className="success-banner">✓ {message}</div>;
}

/** Bold seat count followed by a localised unit, e.g. "<b>2</b> seats" / "<b>2</b>টি সিট". */
export function SeatCount({ n }: { n: number }) {
  const { tp } = usePreferences();
  return (
    <>
      <strong>{n}</strong>
      {tp('seatUnit', n)}
    </>
  );
}

/**
 * A passenger's OWN fare, e.g. "৳70 (shared, you save ৳30)". It follows the ride as people join
 * or leave the pool, and shows a lock once the trip has started and the fare is final.
 */
export function PassengerFare({ ride }: { ride: Ride }) {
  const { t } = usePreferences();
  const saved = ride.poolDiscount ?? 0;
  const isPrivate = ride.allowSharing === false;
  const open = ride.status !== 'STARTED' && ride.status !== 'COMPLETED' && ride.status !== 'CANCELLED' && ride.status !== 'CANCELLED_IN_TRANSIT';
  // A passenger who left mid-route is charged for the part they travelled: no "you save" note on that amount.
  const leftEarly = ride.status === 'CANCELLED_IN_TRANSIT';
  return (
    <span className="fare-line" aria-live="polite">
      <strong className={saved > 0 ? 'fare-line__amount fare-line__amount--saved' : 'fare-line__amount'}>৳{ride.estimatedFare}</strong>
      {isPrivate ? (
        <span className="fare-line__note">{t('fare.private')}</span>
      ) : leftEarly ? null : saved > 0 ? (
        <span className="fare-line__note fare-line__note--saved">{t('fare.shared', { saved })}</span>
      ) : open ? (
        <span className="fare-line__note">{t('fare.mayDrop')}</span>
      ) : null}
      {/* Final only once the passenger's own journey has ended; before that it follows who is in the car */}
      {(ride.fareFinal ?? (ride.status === 'COMPLETED' || leftEarly)) ? (
        <span className="fare-line__lock" title={t('fare.lockedTitle')}>✓ {t('fare.locked')}</span>
      ) : ride.status === 'STARTED' ? (
        <span className="fare-line__note" title={t('fare.estimateTitle')}>≈</span>
      ) : null}
    </span>
  );
}
