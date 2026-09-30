'use client';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AppNav } from '@/components/AppNav';
import { StatusBadge } from '@/components/StatusBadge';
import { LoadingScreen, EmptyState, ErrorBanner, SuccessBanner, Spinner, SeatCount } from '@/components/UI';
import { driverApi, ApiError, type Ride, type Vehicle } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { usePreferences, useFormatApiError } from '@/lib/preferences';

type Tab = 'pending' | 'active' | 'vehicle' | 'history';

/** How often the active tab re-reads the pool, so earnings follow passengers joining or leaving. */
const EARNINGS_REFRESH_MS = 10_000;

export default function DriverDashboard() {
  const router = useRouter();
  const { t } = usePreferences();
  const [user, setUser] = useState<ReturnType<typeof getUser>>(null);
  const [tab, setTab] = useState<Tab>('active');
  const [isOnline, setIsOnline] = useState(false);
  const [togglingOnline, setTogglingOnline] = useState(false);
  // null = not known yet (or the check failed; the server enforces the rule either way)
  const [onboarded, setOnboarded] = useState<boolean | null>(null);

  useEffect(() => {
    const u = getUser();
    if (!u || u.role !== 'DRIVER') { router.replace('/auth'); return; }
    setUser(u);
    setIsOnline(!!(u as any).isOnline);
    driverApi.getOnboarding().then((s) => setOnboarded(s.onboarded)).catch(() => setOnboarded(null));
  }, [router]);

  const handleToggleOnline = async () => {
    if (!user) return;
    if (!isOnline && onboarded === false) return; // must finish onboarding first
    setTogglingOnline(true);
    try {
      const res = await driverApi.setOnlineStatus(user.id, !isOnline);
      setIsOnline(res.user.isOnline ?? !isOnline);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ONBOARDING_REQUIRED') setOnboarded(false);
      // otherwise: silently revert
    } finally {
      setTogglingOnline(false);
    }
  };

  if (!user) return <LoadingScreen label={t('loading.driver')} />;

  return (
    <div className="dashboard">
      <AppNav />

      {/* Tab bar */}
      <div className="tab-nav-wrapper">
        <div className="tab-nav">
          {([
            { id: 'active',  label: `🛺 ${t('d.tab.active')}` },
            { id: 'pending', label: `📋 ${t('d.tab.pending')}` },
            { id: 'vehicle', label: `🔧 ${t('d.tab.vehicle')}` },
            { id: 'history', label: `🕓 ${t('d.tab.history')}` },
          ] as { id: Tab; label: string }[]).map((t) => (
            <button
              key={t.id}
              id={`driver-tab-${t.id}`}
              className={`tab-nav__item${tab === t.id ? ' tab-nav__item--active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="dashboard__body">
        {/* A driver can't go online until onboarding (vehicle, NID, home zone) is done */}
        {onboarded === false && (
          <div className="notice-card" id="onboarding-banner" role="status">
            <div>
              <div className="notice-card__title">{t('d.onboard.bannerTitle')}</div>
              <div className="notice-card__desc">{t('d.onboard.bannerDesc')}</div>
            </div>
            <Link href="/driver/onboarding" id="onboarding-cta" className="btn btn--primary btn--sm">
              {t('d.onboard.cta')}
            </Link>
          </div>
        )}

        {/* Online / offline toggle */}
        <div className="online-toggle">
          <div>
            <div className="online-toggle__label">
              {isOnline ? t('d.online') : t('d.offline')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
              {isOnline ? t('d.onlineDesc') : onboarded === false ? t('d.onboard.toggleHint') : t('d.offlineDesc')}
            </div>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={isOnline}
              onChange={handleToggleOnline}
              disabled={togglingOnline || (!isOnline && onboarded === false)}
              id="driver-online-toggle"
              aria-label={t('d.onlineToggle')}
            />
            <span className="toggle-switch__slider" />
          </label>
        </div>

        {tab === 'pending' && <PendingRequestsTab driverId={user.id} isOnline={isOnline} />}
        {tab === 'active'  && <ActiveRidesTab     driverId={user.id} />}
        {tab === 'vehicle' && <VehicleTab         driverId={user.id} />}
        {tab === 'history' && <HistoryTab         driverId={user.id} />}
      </div>
    </div>
  );
}

// ─── Pending Requests Tab ──────────────────────────────────────────────────
function PendingRequestsTab({ driverId, isOnline }: { driverId: string; isOnline: boolean }) {
  const router = useRouter();
  const { t, tz, locale } = usePreferences();
  const formatError = useFormatApiError();
  const [rides, setRides] = useState<Ride[]>([]);
  const [noVehicle, setNoVehicle] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [accepting, setAccepting] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await driverApi.getPendingRides(driverId);
      setRides(res.rides);
      setNoVehicle(res.noVehicle);
    } catch (err: any) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [driverId, formatError]);

  useEffect(() => { load(); }, [load]);

  const handleAccept = async (rideId: string) => {
    setAccepting(rideId); setError(''); setSuccessMsg('');
    try {
      await driverApi.acceptRide(rideId, driverId);
      setSuccessMsg(t('d.pending.accepted'));
      await load();
    } catch (err: any) {
      setError(formatError(err));
    } finally {
      setAccepting(null);
    }
  };

  if (loading) return <LoadingScreen label={t('loading.pending')} />;

  return (
    <div className="animate-in">
      <div className="section-header">
        <div>
          <h1 className="section-title">{t('d.pending.title')}</h1>
          <p className="section-desc">{t('d.pending.desc')}</p>
        </div>
        <button className="btn btn--ghost btn--sm" onClick={load} id="refresh-pending">{t('common.refresh')}</button>
      </div>

      {!isOnline && !noVehicle && (
        <div className="error-banner" style={{ marginBottom: 16 }}>
          {t('d.pending.mustBeOnline')}
        </div>
      )}
      {error && <ErrorBanner message={error} />}
      {successMsg && <SuccessBanner message={successMsg} />}

      {noVehicle ? (
        <EmptyState
          icon="🔧"
          title={t('d.pending.noVehicleTitle')}
          description={t('d.pending.noVehicleDesc')}
          action={
            <button className="btn btn--primary" id="pending-register-vehicle" onClick={() => router.push('/driver/onboarding')}>
              {t('d.pending.noVehicleAction')}
            </button>
          }
        />
      ) : rides.length === 0 ? (
        <EmptyState
          icon="🛣️"
          title={t('d.pending.emptyTitle')}
          description={t('d.pending.emptyDesc')}
        />
      ) : (
        <div className="ride-list">
          {rides.map((ride) => (
            <div key={ride.id} className="ride-card">
              <div className="ride-card__route">
                <span className="ride-card__zone">{tz(ride.pickupZone)}</span>
                <span className="ride-card__arrow">→</span>
                <span className="ride-card__zone">{tz(ride.destinationZone)}</span>
                <StatusBadge status={ride.status} />
              </div>
              <div className="ride-card__meta">
                <span className="ride-card__meta-item">
                  <SeatCount n={ride.seatCount} />
                </span>
                <span className="ride-card__meta-item">
                  {t('common.fare')} <strong>৳{ride.estimatedFare}</strong>
                </span>
                <span className="ride-card__meta-item" style={{ color: 'var(--text-muted)' }}>
                  {new Date(ride.createdAt).toLocaleTimeString(locale)}
                </span>
              </div>
              <div className="ride-card__footer">
                <div />
                <button
                  id={`accept-ride-${ride.id}`}
                  className="btn btn--success btn--sm"
                  disabled={!isOnline || accepting === ride.id}
                  onClick={() => handleAccept(ride.id)}
                >
                  {accepting === ride.id ? <><Spinner /> {t('d.pending.accepting')}</> : t('d.pending.accept')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Active Rides Tab ──────────────────────────────────────────────────────
function ActiveRidesTab({ driverId }: { driverId: string }) {
  const { t, tp } = usePreferences();
  const formatError = useFormatApiError();
  const [rides, setRides] = useState<Ride[]>([]);
  // What the passengers in this pool pay in total = what the driver earns for the ride
  const [totalEarnings, setTotalEarnings] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState('');

  // `silent` refreshes in the background: no spinner, and a failed refresh is ignored.
  const load = useCallback(async (silent = false) => {
    if (!silent) { setLoading(true); setError(''); }
    try {
      const res = await driverApi.getActiveRides(driverId);
      setRides(res.rides);
      setTotalEarnings(res.totalEarnings);
    } catch (err: any) {
      if (!silent) setError(formatError(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [driverId, formatError]);

  useEffect(() => { load(); }, [load]);

  // Earnings change when a passenger joins or leaves the pool (until the trip starts).
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) load(true); }, EARNINGS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const doAction = async (
    rideId: string,
    action: 'arrive' | 'start' | 'complete' | 'cancel'
  ) => {
    setActionLoading(rideId + action); setError(''); setSuccessMsg('');
    try {
      await driverApi[action](rideId, driverId);
      setSuccessMsg(t(`d.active.done.${action}`));
      await load();
    } catch (err: any) {
      setError(formatError(err));
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) return <LoadingScreen label={t('loading.activeRides')} />;

  // Only show EmptyState if load succeeded (no error). If there's an error,
  // the ErrorBanner above already tells the user what went wrong.
  const showEmpty = !error && rides.length === 0;

  return (
    <div className="animate-in">
      <div className="section-header">
        <div>
          <h1 className="section-title">{t('d.active.title')}</h1>
          <p className="section-desc">{t('d.active.desc')}</p>
        </div>
        <button className="btn btn--ghost btn--sm" onClick={() => load()} id="refresh-active-driver">{t('common.refresh')}</button>
      </div>

      {error && <ErrorBanner message={error} />}
      {successMsg && <SuccessBanner message={successMsg} />}

      {showEmpty ? (
        <EmptyState
          icon="🛺"
          title={t('d.active.emptyTitle')}
          description={t('d.active.emptyDesc')}
        />
      ) : rides.length > 0 ? (
        <div className="ride-list">
          {/* Total earnings for this ride: the sum of what the passengers in the pool pay */}
          <div className="earnings-card" id="ride-earnings" aria-live="polite">
            <div>
              <div className="earnings-card__label">{t('d.active.earningsTitle')}</div>
              <div className="earnings-card__amount">৳{totalEarnings}</div>
              <div className="earnings-card__sub">
                {tp('d.active.earningsFrom', rides.length)}
                {rides.every((r) => r.fareLocked) && ` · 🔒 ${t('fare.locked')}`}
              </div>
            </div>
            <p className="earnings-card__note">{t('d.active.earningsNote')}</p>
          </div>
          {rides.map((ride) => (
            <ActiveDriverRideCard
              key={ride.id}
              ride={ride}
              onAction={doAction}
              actionLoading={actionLoading}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ActiveDriverRideCard({
  ride,
  onAction,
  actionLoading,
}: {
  ride: Ride;
  onAction: (id: string, a: 'arrive' | 'start' | 'complete' | 'cancel') => void;
  actionLoading: string | null;
}) {
  const { t, tz, locale } = usePreferences();
  // Determine which lifecycle buttons to show based on current state
  const actions: { label: string; action: 'arrive' | 'start' | 'complete' | 'cancel'; cls: string }[] = [];
  if (ride.status === 'MATCHED')        actions.push({ label: t('d.active.act.arrive'),   action: 'arrive',   cls: 'btn--warning' });
  if (ride.status === 'DRIVER_ARRIVED') actions.push({ label: t('d.active.act.start'),    action: 'start',    cls: 'btn--primary' });
  if (ride.status === 'STARTED')        actions.push({ label: t('d.active.act.complete'), action: 'complete', cls: 'btn--success' });
  if (['MATCHED', 'DRIVER_ARRIVED'].includes(ride.status))
    actions.push({ label: t('common.cancel'), action: 'cancel', cls: 'btn--danger' });

  return (
    <div className="ride-card">
      <div className="ride-card__route">
        <span className="ride-card__zone">{tz(ride.pickupZone)}</span>
        <span className="ride-card__arrow">→</span>
        <span className="ride-card__zone">{tz(ride.destinationZone)}</span>
        <StatusBadge status={ride.status} />
      </div>

      <div className="ride-card__meta">
        <span className="ride-card__meta-item">
          <SeatCount n={ride.seatCount} />
        </span>
        <span className="ride-card__meta-item">
          {t('common.fare')} <strong>৳{ride.estimatedFare}</strong>
        </span>
        {ride.vehicle && (
          <span className="ride-card__meta-item">
            🛺 <strong>{ride.vehicle.modelName}</strong>
            &nbsp;·&nbsp;
            {t('d.active.seatsUsed', { used: ride.vehicle.occupiedSeats ?? '?', total: ride.vehicle.seatCapacity })}
          </span>
        )}
      </div>

      {actions.length > 0 && (
        <div className="ride-card__footer">
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {new Date(ride.updatedAt).toLocaleTimeString(locale)}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            {actions.map((a) => (
              <button
                key={a.action}
                id={`driver-${a.action}-${ride.id}`}
                className={`btn ${a.cls} btn--sm`}
                disabled={actionLoading !== null}
                onClick={() => onAction(ride.id, a.action)}
              >
                {actionLoading === ride.id + a.action ? <Spinner /> : a.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Vehicle Tab ───────────────────────────────────────────────────────────
function VehicleTab({ driverId }: { driverId: string }) {
  const { t } = usePreferences();
  const router = useRouter();
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    driverApi.getVehicle(driverId)
      .then((res) => setVehicle(res.vehicle))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [driverId]);

  if (loading) return <LoadingScreen label={t('loading.vehicle')} />;

  return (
    <div className="animate-in">
      <div className="section-header">
        <div>
          <h1 className="section-title">{t('d.vehicle.title')}</h1>
          <p className="section-desc">{t('d.vehicle.desc')}</p>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {vehicle ? (
        <div className="card card--raised">
          <div className="card__header">
            <div>
              <div className="card__title">🛺 {vehicle.modelName}</div>
              <div className="card__subtitle">{t('d.vehicle.teslaId')}: {vehicle.licensePlate}</div>
            </div>
            <span className="badge badge--matched" style={{ fontSize: 12 }}>{t('d.vehicle.active')}</span>
          </div>
          <div className="card__body">
            <div className="stats-row">
              <div className="stat-card">
                <div className="stat-card__label">{t('d.vehicle.capacity')}</div>
                <div className="stat-card__value">{vehicle.seatCapacity}</div>
              </div>
              <div className="stat-card">
                <div className="stat-card__label">{t('d.vehicle.occupied')}</div>
                <div className="stat-card__value" style={{ color: vehicle.occupiedSeats > 0 ? 'var(--warning)' : 'var(--text-secondary)' }}>
                  {vehicle.occupiedSeats}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-card__label">{t('d.vehicle.available')}</div>
                <div className="stat-card__value" style={{ color: 'var(--success)' }}>
                  {vehicle.seatCapacity - vehicle.occupiedSeats}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <EmptyState
          icon="🛺"
          title={t('d.vehicle.noneTitle')}
          description={t('d.vehicle.noneDesc')}
          action={
            <button className="btn btn--primary" id="vehicle-start-onboarding" onClick={() => router.push('/driver/onboarding')}>
              {t('d.onboard.cta')}
            </button>
          }
        />
      )}
    </div>
  );
}

// ─── History Tab ───────────────────────────────────────────────────────────
function HistoryTab({ driverId }: { driverId: string }) {
  const { t, tz, locale } = usePreferences();
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    driverApi.getHistory(driverId)
      .then((res) => setRides(res.rides))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [driverId]);

  if (loading) return <LoadingScreen label={t('loading.trips')} />;

  const completed = rides.filter((r) => r.status === 'COMPLETED');
  const totalEarned = completed.reduce((s, r) => s + r.estimatedFare, 0);

  return (
    <div className="animate-in">
      <div className="section-header">
        <div>
          <h1 className="section-title">{t('d.history.title')}</h1>
          <p className="section-desc">{t('d.history.desc')}</p>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {rides.length > 0 && (
        <div className="stats-row" style={{ marginBottom: 24 }}>
          <div className="stat-card">
            <div className="stat-card__label">{t('d.history.total')}</div>
            <div className="stat-card__value">{rides.length}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card__label">{t('common.completed')}</div>
            <div className="stat-card__value" style={{ color: 'var(--success)' }}>{completed.length}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card__label">{t('d.history.earned')}</div>
            <div className="stat-card__value">৳{totalEarned}</div>
          </div>
        </div>
      )}

      {rides.length === 0 ? (
        <EmptyState
          icon="🕓"
          title={t('d.history.emptyTitle')}
          description={t('d.history.emptyDesc')}
        />
      ) : (
        <div className="ride-list">
          {rides.map((ride) => (
            <div key={ride.id} className="ride-card">
              <div className="ride-card__route">
                <span className="ride-card__zone">{tz(ride.pickupZone)}</span>
                <span className="ride-card__arrow">→</span>
                <span className="ride-card__zone">{tz(ride.destinationZone)}</span>
                <StatusBadge status={ride.status} />
              </div>
              <div className="ride-card__meta">
                <span className="ride-card__meta-item">
                  <SeatCount n={ride.seatCount} />
                </span>
                <span className="ride-card__meta-item">
                  {t('common.fare')} <strong>৳{ride.estimatedFare}</strong>
                </span>
                <span className="ride-card__meta-item" style={{ color: 'var(--text-muted)' }}>
                  {new Date(ride.updatedAt).toLocaleDateString(locale, {
                    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                  })}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
