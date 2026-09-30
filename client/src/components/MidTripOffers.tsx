'use client';
import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, SeatCount, Spinner, SuccessBanner } from '@/components/UI';
import { driverApi, type Ride } from '@/lib/api';
import { usePreferences, useFormatApiError } from '@/lib/preferences';

/** How often the driver's page asks for new requests that could join a trip already under way. */
export const MID_TRIP_POLL_MS = 12_000;

/**
 * Requests the driver can add to a trip that has already STARTED: same direction, free seat.
 * Plain polling (no websockets): it re-reads the pending list every MID_TRIP_POLL_MS while the tab
 * is visible, and the driver accepts or declines each one. The server decides what is compatible.
 */
export function MidTripOffers({ driverId, onJoined }: { driverId: string; onJoined: () => void }) {
  const { t, tz, tp } = usePreferences();
  const formatError = useFormatApiError();
  const [offers, setOffers] = useState<Ride[]>([]);
  const [seatsFree, setSeatsFree] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  // A failed background refresh keeps the last list instead of flashing an error every 12 seconds.
  const poll = useCallback(async () => {
    try {
      const res = await driverApi.getPendingRides(driverId);
      setOffers(res.rides);
      setSeatsFree(res.availableSeats);
    } catch {
      /* keep what is on screen */
    }
  }, [driverId]);

  useEffect(() => {
    const first = setTimeout(poll, 0);
    const timer = setInterval(() => { if (!document.hidden) poll(); }, MID_TRIP_POLL_MS);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [poll]);

  const act = async (ride: Ride, action: 'accept' | 'decline') => {
    setBusy(ride.id + action); setError(''); setMessage('');
    try {
      if (action === 'accept') {
        await driverApi.acceptRide(ride.id, driverId);
        setMessage(t('d.offers.accepted'));
        onJoined();
      } else {
        await driverApi.declineRide(ride.id);
        setMessage(t('d.offers.declined'));
      }
      await poll();
    } catch (err) {
      setError(formatError(err as { status?: number; message: string }));
      await poll(); // the list may have changed under us (seat taken, request cancelled)
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card card--raised" id="mid-trip-offers" aria-live="polite" style={{ marginBottom: 16 }}>
      <div className="card__header">
        <div>
          <div className="card__title">🛣️ {t('d.offers.title')}</div>
          <div className="card__subtitle">{t('d.offers.desc', { sec: MID_TRIP_POLL_MS / 1000 })}</div>
        </div>
        <span className="badge badge--matched" style={{ fontSize: 12 }}>{tp('d.offers.seatsFree', seatsFree)}</span>
      </div>
      <div className="card__body">
        {error && <ErrorBanner message={error} />}
        {message && <SuccessBanner message={message} />}
        {offers.length === 0 ? (
          <p className="form-hint" id="mid-trip-none">{t('d.offers.none')}</p>
        ) : (
          <div className="ride-list">
            {offers.map((ride) => (
              <div key={ride.id} className="ride-card" id={`offer-${ride.id}`}>
                <div className="ride-card__route">
                  <span className="ride-card__zone">{tz(ride.pickupZone)}</span>
                  <span className="ride-card__arrow">→</span>
                  <span className="ride-card__zone">{tz(ride.destinationZone)}</span>
                  {ride.joinsMidTrip && <span className="badge badge--matched">{t('d.offers.midTrip')}</span>}
                </div>
                <div className="ride-card__meta">
                  <span className="ride-card__meta-item"><SeatCount n={ride.seatCount} /></span>
                </div>
                <div className="ride-card__footer">
                  <div />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      id={`decline-offer-${ride.id}`}
                      className="btn btn--ghost btn--sm"
                      disabled={busy !== null}
                      onClick={() => act(ride, 'decline')}
                    >
                      {t('d.offers.decline')}
                    </button>
                    <button
                      id={`accept-offer-${ride.id}`}
                      className="btn btn--success btn--sm"
                      disabled={busy !== null}
                      onClick={() => act(ride, 'accept')}
                    >
                      {busy === ride.id + 'accept' ? <><Spinner /> {t('d.offers.accepting')}</> : t('d.offers.accept')}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
