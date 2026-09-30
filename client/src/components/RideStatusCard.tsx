'use client';
import { useCallback, useEffect, useState } from 'react';
import { passengerApi, assetUrl, ApiError, type Ride } from '@/lib/api';
import { usePreferences, useFormatApiError } from '@/lib/preferences';
import type { TranslationKey } from '@/lib/translations';
import { StatusBadge, StatusTimeline } from './StatusBadge';
import { PassengerFare, SeatCount } from './UI';

/** How often an open ride re-reads itself. Plain polling: no websockets, and no live GPS. */
export const RIDE_POLL_MS = 5000;

const isFinished = (status: Ride['status']) =>
  status === 'COMPLETED' || status === 'CANCELLED' || status === 'CANCELLED_IN_TRANSIT';
const isInProgress = (status: Ride['status']) =>
  status === 'MATCHED' || status === 'DRIVER_ARRIVED' || status === 'STARTED';

/** One-line description of where the ride is (REQUESTED and CANCELLED have their own banners). */
const STATUS_MESSAGE: Partial<Record<Ride['status'], TranslationKey>> = {
  MATCHED: 'rs.msg.MATCHED',
  DRIVER_ARRIVED: 'rs.msg.DRIVER_ARRIVED',
  STARTED: 'rs.msg.STARTED',
  COMPLETED: 'rs.msg.COMPLETED',
};

/** Bangladesh mobile numbers are stored as 01XXXXXXXXX; the international form dials from any phone. */
export const telHref = (phone: string) => `tel:${/^01\d{9}$/.test(phone) ? `+88${phone}` : phone}`;

function DriverAvatar({ photoUrl }: { photoUrl: string | null }) {
  const [failed, setFailed] = useState(false);
  if (photoUrl && !failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="avatar avatar--sm" src={assetUrl(photoUrl)} alt="" onError={() => setFailed(true)} />;
  }
  // The photo is optional: show a neutral placeholder instead.
  return <div className="avatar avatar--sm" aria-hidden="true" id="driver-avatar-placeholder">👤</div>;
}

/**
 * The passenger's ride status page for one ride.
 *
 * Shows, once a driver has accepted: the driver (name, photo, tap-to-call phone) and vehicle
 * ("Bullet · DTP-0001"); the pool ("Shared ride · 1 other passenger", seats taken, the others by
 * first name); the step tracker; the passenger's own fare (with a lock once the trip starts); and a
 * cancel button only while cancelling is allowed.
 *
 * The ride re-reads itself every 5 seconds so the passenger sees someone joining or leaving, the
 * driver arriving and fare changes. Polling stops for good once the ride is COMPLETED or CANCELLED.
 */
export function RideStatusCard({
  initial,
  onCancel,
  cancelling,
}: {
  initial: Ride;
  /** Asks the server to cancel; the card then re-reads the ride so it shows CANCELLED. */
  onCancel: (rideId: string) => Promise<void>;
  cancelling: boolean;
}) {
  const { t, tp, tz, locale } = usePreferences();
  const formatError = useFormatApiError();
  // The ride can no longer be read (removed, or not this passenger's): say so instead of "reconnecting" forever
  const [gone, setGone] = useState(false);
  const [ride, setRide] = useState<Ride>(initial);
  const [updatedAt, setUpdatedAt] = useState(() => new Date());
  const [connectionLost, setConnectionLost] = useState(false);
  const finished = isFinished(ride.status);

  // Reads the ride once. Returns false when the ride can no longer be read (gone or not ours).
  const fetchLatest = useCallback(async (): Promise<boolean> => {
    try {
      const res = await passengerApi.getRide(initial.id);
      setRide(res.ride);
      setUpdatedAt(new Date());
      setConnectionLost(false);
      return true;
    } catch (err) {
      const unreadable = err instanceof ApiError && (err.status === 403 || err.status === 404);
      if (unreadable) setGone(true);
      setConnectionLost(true);
      return !unreadable;
    }
  }, [initial.id]);

  useEffect(() => {
    if (finished) return; // COMPLETED or CANCELLED: nothing more will change, so stop polling
    let stopped = false;
    let inFlight = false;

    const poll = async () => {
      if (stopped || inFlight || document.hidden) return;
      inFlight = true;
      const canContinue = await fetchLatest();
      inFlight = false;
      if (!canContinue) stopped = true;
    };
    const timer = setInterval(poll, RIDE_POLL_MS);
    const onVisible = () => { if (!document.hidden) poll(); }; // catch up right away after a background tab
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [finished, fetchLatest]);

  const handleCancel = async () => {
    await onCancel(ride.id);
    await fetchLatest(); // show CANCELLED straight away instead of waiting for the next poll
  };

  // Leaving a ride that has already started: the passenger names the zone where they are dropped off.
  const [leaving, setLeaving] = useState(false);
  const [zones, setZones] = useState<string[]>([]);
  const [leaveZone, setLeaveZone] = useState('');
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [leaveError, setLeaveError] = useState('');

  const openLeave = async () => {
    setLeaving(true); setLeaveError('');
    if (zones.length === 0) {
      try { setZones((await passengerApi.getRideOptions()).zones); } catch { /* the server still validates the zone */ }
    }
  };

  const confirmLeave = async () => {
    if (!leaveZone) { setLeaveError(t('rs.leave.choose')); return; }
    setLeaveBusy(true); setLeaveError('');
    try {
      await passengerApi.cancelInTransit(ride.id, leaveZone);
      setLeaving(false);
      await fetchLatest(); // shows the outcome: where they left and what they were charged
    } catch (err) {
      setLeaveError(formatError(err)); // plain words, never a status code
    } finally {
      setLeaveBusy(false);
    }
  };

  const { driver, pool, vehicle } = ride;
  const statusMessage = STATUS_MESSAGE[ride.status];
  const updated = updatedAt.toLocaleTimeString(locale);

  return (
    <article className="ride-card ride-status" id={`ride-status-${ride.id}`} data-status={ride.status}>
      <div className="ride-card__route">
        <span className="ride-card__zone">{tz(ride.pickupZone)}</span>
        <span className="ride-card__arrow">→</span>
        <span className="ride-card__zone">{tz(ride.destinationZone)}</span>
        <StatusBadge status={ride.status} />
        {ride.allowSharing === false && (
          <span className="badge badge--matched" style={{ fontSize: 11, marginLeft: 6 }}>
            {t('p.active.private')}
          </span>
        )}
      </div>

      {/* Matched → Driver Arrived → Started → Completed (and the messages for waiting / cancelled) */}
      <StatusTimeline
        status={ride.status}
        cancellationZone={ride.cancellationZone ?? null}
        chargedFare={ride.estimatedFare}
      />
      {statusMessage && (
        <p className="ride-status__message" id="ride-status-message" role="status" aria-live="polite">
          {t(statusMessage)}
        </p>
      )}

      {/* Driver & vehicle: only once a driver has accepted (and not on a cancelled ride) */}
      {driver && ride.status !== 'CANCELLED' && ride.status !== 'CANCELLED_IN_TRANSIT' && (
        <section className="ride-block" aria-label={t('rs.driverVehicle')} id="ride-driver">
          <h3 className="ride-block__title">{t('rs.driverVehicle')}</h3>
          <div className="driver-row">
            <DriverAvatar photoUrl={driver.photoUrl} />
            <div className="driver-row__info">
              <div className="driver-row__name" id="driver-name">{driver.name}</div>
              {vehicle && (
                <div className="driver-row__vehicle" id="driver-vehicle">
                  🛺 {vehicle.nickname ?? vehicle.modelName} · {vehicle.teslaId ?? vehicle.licensePlate}
                </div>
              )}
              {driver.phone && (
                <div className="driver-row__phone" id="driver-phone" dir="ltr">{driver.phone}</div>
              )}
            </div>
            {driver.phone ? (
              <a
                className="btn btn--secondary btn--sm call-btn"
                id="call-driver"
                href={telHref(driver.phone)}
                aria-label={t('rs.callLabel', { name: driver.name ?? '', phone: driver.phone })}
              >
                📞 {t('rs.callDriver')}
              </a>
            ) : (
              isInProgress(ride.status) && <span className="form-hint">{t('rs.noPhone')}</span>
            )}
          </div>
        </section>
      )}

      {/* Pool: shared or just you, seats taken, the others by first name only */}
      {pool && (
        <section className="ride-block" aria-label={t('rs.pool')} id="ride-pool">
          <h3 className="ride-block__title">{t('rs.pool')}</h3>
          <div className="ride-block__line" id="pool-summary">
            {pool.isShared ? tp('rs.sharedRide', pool.otherPassengers.length) : t('rs.justYou')}
          </div>
          <div className="ride-block__line" id="pool-seats">
            {t('rs.seatsTaken', { taken: pool.seatsTaken, capacity: pool.seatCapacity })}
          </div>
          {ride.joinedMidTrip && (
            <div className="ride-block__line" id="pool-joined-mid-trip">{t('rs.joinedMidTrip')}</div>
          )}
          {pool.otherPassengers.length > 0 && (
            <div className="ride-block__line" id="pool-others">
              {t('rs.ridingWith')}: <strong>{pool.otherPassengers.map((p) => p.firstName).join(', ')}</strong>
            </div>
          )}
        </section>
      )}

      <div className="ride-card__meta" style={{ marginTop: 16 }}>
        <span className="ride-card__meta-item">
          <SeatCount n={ride.seatCount} />
        </span>
        {/* This passenger's OWN fare only, e.g. "৳70 (shared, you save ৳30)", with a lock once STARTED */}
        <span className="ride-card__meta-item" id="ride-fare">
          {t('common.fare')} <PassengerFare ride={ride} />
        </span>
      </div>

      {/* Payment: how this ride is paid and whether it has been (this passenger's own ride only) */}
      {ride.paymentStatus && (
        <div className="ride-block__line" id="ride-payment" data-payment-status={ride.paymentStatus} style={{ marginTop: 8 }}>
          {ride.paymentMethod === 'wallet' ? '💳' : '💵'} {ride.paymentMethod === 'wallet' ? t('pay.wallet') : t('pay.cash')}
          {' · '}
          {t(`pay.status.${ride.paymentStatus}` as TranslationKey, { amount: ride.paymentAmount ?? ride.estimatedFare })}
        </div>
      )}

      {/* How the fare was (or would be) worked out: ৳100 plus each stretch at the rate for who was on board */}
      {ride.fareBreakdown && ride.fareBreakdown.segments.some((s) => s.distanceKm > 0) && (
        <section className="ride-block" id="ride-fare-breakdown" aria-label={t('rs.bill.title')}>
          <h3 className="ride-block__title">{t('rs.bill.title')}</h3>
          {ride.fareBreakdown.segments
            .filter((s) => s.distanceKm > 0)
            .map((s, i) => (
              <div key={i} className="ride-block__line">
                {t(s.driverBonus > 0 ? 'rs.bill.segmentShared' : 'rs.bill.segmentAlone', { km: s.distanceKm, n: s.passengers, bonus: s.driverBonus })} = ৳{s.charge}
              </div>
            ))}
          <div className="ride-block__line"><strong>{t('rs.bill.total')}: ৳{ride.estimatedFare}</strong></div>
          {(ride.fareBreakdown.poolDiscount ?? 0) > 0 && (
            <div className="ride-block__line">{t('rs.bill.saved', { saved: ride.fareBreakdown.poolDiscount ?? 0 })}</div>
          )}
        </section>
      )}

      <div className="ride-card__footer">
        <span className="ride-status__updated" id="ride-updated" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {finished
            ? t('rs.final')
            : gone
              ? t('rs.gone')
              : connectionLost
              ? t('rs.reconnecting')
              : `${t('rs.updated', { time: updated })} · ${t('rs.autoRefresh')}`}
        </span>
        {/* Only while cancelling is allowed (before the driver arrives) */}
        {ride.canCancel && (
          <button
            id={`cancel-ride-${ride.id}`}
            className="btn btn--danger btn--sm"
            onClick={handleCancel}
            disabled={cancelling}
          >
            {cancelling ? t('p.active.cancelling') : t('p.active.cancelRide')}
          </button>
        )}
        {/* Once the trip has started the ordinary cancel is gone, but the passenger can still get off part-way */}
        {ride.canCancelInTransit && !leaving && (
          <button id={`leave-ride-${ride.id}`} className="btn btn--danger btn--sm" onClick={openLeave}>
            {t('rs.leave.button')}
          </button>
        )}
      </div>

      {ride.canCancelInTransit && leaving && (
        <section className="ride-block" id={`leave-panel-${ride.id}`} aria-label={t('rs.leave.title')}>
          <h3 className="ride-block__title">{t('rs.leave.title')}</h3>
          <p className="form-hint">{t('rs.leave.hint')}</p>
          <select
            id={`leave-zone-${ride.id}`}
            className="form-control"
            value={leaveZone}
            onChange={(e) => setLeaveZone(e.target.value)}
            disabled={leaveBusy}
          >
            <option value="">{t('rs.leave.choose')}</option>
            {zones.filter((z) => z !== ride.pickupZone && z !== ride.destinationZone).map((z) => (
              <option key={z} value={z}>{tz(z)}</option>
            ))}
          </select>
          {leaveError && <div className="error-banner" role="alert" style={{ marginTop: 8 }}>{leaveError}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn btn--ghost btn--sm" onClick={() => setLeaving(false)} disabled={leaveBusy}>
              {t('rs.leave.keep')}
            </button>
            <button id={`confirm-leave-${ride.id}`} className="btn btn--danger btn--sm" onClick={confirmLeave} disabled={leaveBusy}>
              {leaveBusy ? t('rs.leave.leaving') : t('rs.leave.confirm')}
            </button>
          </div>
        </section>
      )}
    </article>
  );
}
