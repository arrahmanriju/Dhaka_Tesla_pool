'use client';
import { useEffect, useState } from 'react';
import { driverApi, type PoolEvent } from '@/lib/api';
import { usePreferences } from '@/lib/preferences';
import type { TranslationKey } from '@/lib/translations';

/**
 * The pool's history for the driver: who was requested, accepted, picked up and dropped, and who
 * joined after the trip had already started. Re-read whenever `refreshKey` changes.
 * Passengers are shown by first name only.
 */
export function PoolTimeline({ refreshKey }: { refreshKey: unknown }) {
  const { t, tz, locale } = usePreferences();
  const [events, setEvents] = useState<PoolEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    driverApi.getTimeline().then((r) => { if (!cancelled) setEvents(r.events); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [refreshKey]);

  if (events.length === 0) return null;

  const label = (e: PoolEvent) =>
    e.status === 'CANCELLED_IN_TRANSIT'
      ? t('d.timeline.CANCELLED_IN_TRANSIT', {
          name: e.passengerLabel ?? 'Passenger',
          zone: e.cancellationZone ? tz(e.cancellationZone) : '—',
          fare: e.chargedFare ?? 0,
          estimate: e.fullTripEstimate ?? 0,
        })
      : e.joinedMidTrip
      ? t('d.timeline.MATCHED_MID', { name: e.passengerLabel ?? 'Passenger', n: e.ridersOnboard })
      : t(`d.timeline.${e.status}` as TranslationKey, { name: e.passengerLabel ?? 'Passenger' });

  return (
    <section className="card" id="pool-timeline" style={{ marginTop: 16 }}>
      <div className="card__header"><div className="card__title">🕓 {t('d.timeline.title')}</div></div>
      <div className="card__body">
        <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
          {[...events].reverse().slice(0, 30).map((e) => (
            <li key={e.id} style={{ fontSize: 13 }}>
              <span style={{ color: 'var(--text-muted)' }}>{new Date(e.at).toLocaleTimeString(locale)}</span>
              {' · '}{label(e)}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
