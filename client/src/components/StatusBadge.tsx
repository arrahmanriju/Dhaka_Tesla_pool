'use client';
import type { RideStatus } from '@/lib/api';
import { usePreferences } from '@/lib/preferences';
import type { TranslationKey } from '@/lib/translations';

const PULSE_STATES: RideStatus[] = ['REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED'];

export function StatusBadge({ status }: { status: RideStatus }) {
  const { t } = usePreferences();
  const isPulse = PULSE_STATES.includes(status);
  return (
    <span className={`badge badge--${status.toLowerCase()}`}>
      <span className={`badge__dot${isPulse ? ' badge__dot--pulse' : ''}`} />
      {t(`status.${status}`)}
    </span>
  );
}

// ─── Status Timeline ───────────────────────────────────────────────────────
// The tracker for an accepted ride: Matched → Driver Arrived → Started → Completed.
// Before a driver accepts it shows a waiting message; a cancelled ride shows a clear notice.
const STEPS: { status: RideStatus; label: TranslationKey; icon: string }[] = [
  { status: 'MATCHED',        label: 'timeline.matched',       icon: '🔗' },
  { status: 'DRIVER_ARRIVED', label: 'timeline.driverArrived', icon: '📍' },
  { status: 'STARTED',        label: 'timeline.started',       icon: '🛺' },
  { status: 'COMPLETED',      label: 'timeline.completed',     icon: '✅' },
];

const ORDER: Record<string, number> = {
  REQUESTED: 0, MATCHED: 1, DRIVER_ARRIVED: 2, STARTED: 3, COMPLETED: 4, CANCELLED: -1, CANCELLED_IN_TRANSIT: -1,
};

export function StatusTimeline({
  status,
  cancellationZone,
  chargedFare,
}: {
  status: RideStatus;
  /** Where the passenger left the ride (CANCELLED_IN_TRANSIT) */
  cancellationZone?: string | null;
  /** What they were charged for the part they travelled */
  chargedFare?: number;
}) {
  const { t, tz } = usePreferences();
  if (status === 'CANCELLED_IN_TRANSIT') {
    return (
      <div className="info-banner" id="ride-left-mid-trip-message" role="status" style={{ justifyContent: 'center' }}>
        {t('timeline.cancelledInTransit', { zone: cancellationZone ? tz(cancellationZone) : '—', fare: chargedFare ?? 0 })}
      </div>
    );
  }
  if (status === 'CANCELLED') {
    return (
      <div className="error-banner" id="ride-cancelled-message" role="status" style={{ justifyContent: 'center' }}>
        {t('timeline.cancelled')}
      </div>
    );
  }

  const currentIdx = ORDER[status] ?? 0;

  return (
    <>
      {status === 'REQUESTED' && (
        <div className="info-banner" id="ride-waiting-message" role="status" aria-live="polite">
          ⏳ {t('timeline.waiting')}
        </div>
      )}
      <ol className="status-timeline" aria-label={t('rs.progress')}>
        {STEPS.map((step, i) => {
          const stepIdx = ORDER[step.status]!;
          const isDone = stepIdx < currentIdx || status === 'COMPLETED';
          const isActive = step.status === status && status !== 'COMPLETED';
          return (
            <li
              key={step.status}
              className="status-timeline__item"
              aria-current={isActive ? 'step' : undefined}
              data-step={step.status}
              data-state={isDone ? 'done' : isActive ? 'active' : 'pending'}
            >
              <div className="status-step">
                <div
                  className={[
                    'status-step__dot',
                    isDone ? 'status-step__dot--done' : '',
                    isActive ? 'status-step__dot--active' : '',
                  ].join(' ')}
                >
                  {isDone ? '✓' : step.icon}
                </div>
                <span
                  className={[
                    'status-step__label',
                    isDone ? 'status-step__label--done' : '',
                    isActive ? 'status-step__label--active' : '',
                  ].join(' ')}
                >
                  {t(step.label)}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div className={`status-connector${isDone ? ' status-connector--done' : ''}`} />
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}
