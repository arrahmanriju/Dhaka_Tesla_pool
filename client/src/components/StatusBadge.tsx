'use client';
import type { RideStatus } from '@/lib/api';

const LABELS: Record<RideStatus, string> = {
  REQUESTED: 'Requested',
  MATCHED: 'Matched',
  DRIVER_ARRIVED: 'Driver Arrived',
  STARTED: 'In Progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

const PULSE_STATES: RideStatus[] = ['REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED'];

export function StatusBadge({ status }: { status: RideStatus }) {
  const isPulse = PULSE_STATES.includes(status);
  return (
    <span className={`badge badge--${status.toLowerCase()}`}>
      <span className={`badge__dot${isPulse ? ' badge__dot--pulse' : ''}`} />
      {LABELS[status]}
    </span>
  );
}

// ─── Status Timeline ───────────────────────────────────────────────────────
const STEPS: { status: RideStatus; label: string; icon: string }[] = [
  { status: 'REQUESTED',     label: 'Requested',  icon: '📋' },
  { status: 'MATCHED',       label: 'Matched',    icon: '🔗' },
  { status: 'DRIVER_ARRIVED',label: 'Arrived',    icon: '📍' },
  { status: 'STARTED',       label: 'Started',    icon: '🚗' },
  { status: 'COMPLETED',     label: 'Done',       icon: '✅' },
];

const ORDER: Record<string, number> = {
  REQUESTED: 0, MATCHED: 1, DRIVER_ARRIVED: 2, STARTED: 3, COMPLETED: 4, CANCELLED: -1,
};

export function StatusTimeline({ status }: { status: RideStatus }) {
  if (status === 'CANCELLED') {
    return (
      <div className="error-banner" style={{ justifyContent: 'center' }}>
        ✕ Ride Cancelled
      </div>
    );
  }

  const currentIdx = ORDER[status] ?? 0;

  return (
    <div className="status-timeline">
      {STEPS.map((step, i) => {
        const stepIdx = ORDER[step.status];
        const isDone = stepIdx < currentIdx;
        const isActive = step.status === status;
        return (
          <div key={step.status} style={{ display: 'flex', flex: 1, alignItems: 'flex-start' }}>
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
                {step.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={`status-connector${isDone || isActive ? ' status-connector--done' : ''}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
