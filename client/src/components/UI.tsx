'use client';
import { usePreferences } from '@/lib/preferences';

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
