'use client';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { AppNav } from '@/components/AppNav';
import { StatusBadge, StatusTimeline } from '@/components/StatusBadge';
import { LoadingScreen, EmptyState, ErrorBanner, SuccessBanner, SeatCount } from '@/components/UI';
import { passengerApi, DHAKA_ZONES, type Ride, ApiError } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { usePreferences } from '@/lib/preferences';

type Tab = 'request' | 'active' | 'history';

export default function PassengerDashboard() {
  const router = useRouter();
  const { t } = usePreferences();
  const [user, setUser] = useState<ReturnType<typeof getUser>>(null);
  const [tab, setTab] = useState<Tab>('active');

  useEffect(() => {
    const u = getUser();
    if (!u || u.role !== 'PASSENGER') {
      router.replace('/auth');
      return;
    }
    setUser(u);
  }, [router]);

  if (!user) return <LoadingScreen label={t('loading.passenger')} />;

  return (
    <div className="dashboard">
      <AppNav />

      {/* Tab bar */}
      <div className="tab-nav-wrapper">
        <div className="tab-nav">
          {([
            { id: 'active',  label: `🚦 ${t('p.tab.active')}` },
            { id: 'request', label: `➕ ${t('p.tab.request')}` },
            { id: 'history', label: `🕓 ${t('p.tab.history')}` },
          ] as { id: Tab; label: string }[]).map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              className={`tab-nav__item${tab === t.id ? ' tab-nav__item--active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="dashboard__body">
        {tab === 'request'  && <RequestRideTab  passengerId={user.id} />}
        {tab === 'active'   && <ActiveRidesTab  passengerId={user.id} onNavigate={setTab} />}
        {tab === 'history'  && <HistoryTab      passengerId={user.id} />}
      </div>
    </div>
  );
}

// ─── Request Ride Tab ──────────────────────────────────────────────────────
function RequestRideTab({ passengerId }: { passengerId: string }) {
  const { t, tp, tz } = usePreferences();
  const [pickup, setPickup] = useState('');
  const [destination, setDestination] = useState('');
  const [seats, setSeats] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<Ride | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pickup === destination) { setError(t('p.req.sameZone')); return; }
    setError(''); setLoading(true);
    try {
      const res = await passengerApi.requestRide(passengerId, pickup, destination, seats);
      setSuccess(res.ride);
    } catch (err: any) {
      if (err instanceof ApiError) {
        setError(t('common.errorWithStatus', { status: err.status, message: err.message }));
      } else {
        setError(err.message || t('p.req.unexpected'));
      }
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="animate-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <SuccessBanner message={t('p.req.success')} />
        <div className="ride-card">
          <div className="ride-card__route">
            <span className="ride-card__zone">{tz(success.pickupZone)}</span>
            <span className="ride-card__arrow">→</span>
            <span className="ride-card__zone">{tz(success.destinationZone)}</span>
          </div>
          <div className="fare-display" style={{ marginBottom: 16 }}>
            <div>
              <div className="fare-display__label">{t('p.req.estFare')}</div>
              <div className="fare-display__amount">৳{success.estimatedFareBDT}</div>
              <div className="fare-display__sub">{tp('p.req.forSeats', success.seatCount)}</div>
            </div>
            <StatusBadge status={success.status} />
          </div>
          <button className="btn btn--secondary btn--sm" onClick={() => setSuccess(null)}>
            {t('p.req.another')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-in">
      <div className="section-header">
        <div>
          <h1 className="section-title">{t('p.req.title')}</h1>
          <p className="section-desc">{t('p.req.desc')}</p>
        </div>
      </div>

      <div className="card">
        <div className="card__body">
          {error && <ErrorBanner message={error} />}
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20, marginTop: error ? 16 : 0 }}>
            <div className="form-group">
              <label className="form-label" htmlFor="pickup-zone">{t('p.req.pickup')}</label>
              <select
                id="pickup-zone"
                className="form-control"
                value={pickup}
                onChange={(e) => setPickup(e.target.value)}
                required
              >
                <option value="">{t('p.req.pickupPh')}</option>
                {DHAKA_ZONES.map((z) => <option key={z} value={z}>{tz(z)}</option>)}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="dest-zone">{t('p.req.dest')}</label>
              <select
                id="dest-zone"
                className="form-control"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                required
              >
                <option value="">{t('p.req.destPh')}</option>
                {DHAKA_ZONES.filter((z) => z !== pickup).map((z) => (
                  <option key={z} value={z}>{tz(z)}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="seat-count">{t('p.req.seats')}</label>
              <select
                id="seat-count"
                className="form-control"
                value={seats}
                onChange={(e) => setSeats(Number(e.target.value))}
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>{tp('seats', n)}</option>
                ))}
              </select>
            </div>

            <button
              id="request-ride-submit"
              type="submit"
              className="btn btn--primary btn--full"
              disabled={loading || !pickup || !destination}
            >
              {loading ? t('p.req.submitting') : t('p.req.submit')}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ─── Active Rides Tab ──────────────────────────────────────────────────────
function ActiveRidesTab({
  passengerId,
  onNavigate,
}: {
  passengerId: string;
  onNavigate: (tab: Tab) => void;
}) {
  const { t } = usePreferences();
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelSuccess, setCancelSuccess] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await passengerApi.getActiveRides(passengerId);
      setRides(res.rides);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [passengerId]);

  useEffect(() => { load(); }, [load]);

  const handleCancel = async (rideId: string) => {
    if (!confirm(t('p.active.confirmCancel'))) return;
    setCancelling(rideId); setCancelSuccess('');
    try {
      await passengerApi.cancelRide(rideId, passengerId);
      setCancelSuccess(t('p.active.cancelled'));
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCancelling(null);
    }
  };

  if (loading) return <LoadingScreen label={t('loading.rides')} />;

  return (
    <div className="animate-in">
      <div className="section-header">
        <div>
          <h1 className="section-title">{t('p.active.title')}</h1>
          <p className="section-desc">{t('p.active.desc')}</p>
        </div>
        <button className="btn btn--ghost btn--sm" onClick={load} id="refresh-active">{t('common.refresh')}</button>
      </div>

      {error && <ErrorBanner message={error} />}
      {cancelSuccess && <SuccessBanner message={cancelSuccess} />}

      {rides.length === 0 ? (
        <EmptyState
          icon="🛣️"
          title={t('p.active.emptyTitle')}
          description={t('p.active.emptyDesc')}
          action={
            <button className="btn btn--primary" onClick={() => onNavigate('request')}>
              {t('p.active.emptyAction')}
            </button>
          }
        />
      ) : (
        <div className="ride-list">
          {rides.map((ride) => (
            <ActiveRideCard
              key={ride.id}
              ride={ride}
              onCancel={handleCancel}
              cancelling={cancelling === ride.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ActiveRideCard({
  ride,
  onCancel,
  cancelling,
}: {
  ride: Ride;
  onCancel: (id: string) => void;
  cancelling: boolean;
}) {
  const { t, tp, tz, locale } = usePreferences();
  const hasDiscount = (ride.poolDiscount ?? 0) > 0;
  const baseFareBDT = ride.baseFare ? (ride.baseFare / 100).toFixed(2) : null;

  return (
    <div className="ride-card">
      <div className="ride-card__route">
        <span className="ride-card__zone">{tz(ride.pickupZone)}</span>
        <span className="ride-card__arrow">→</span>
        <span className="ride-card__zone">{tz(ride.destinationZone)}</span>
        <StatusBadge status={ride.status} />
        {ride.isSharedRide && (
          <span
            className="badge badge--matched"
            style={{ fontSize: 11, marginLeft: 6 }}
            title={tp('p.active.sharedTitle', ride.coPassengers ?? 0)}
          >
            {tp('p.active.shared', ride.coPassengers ?? 0)}
          </span>
        )}
      </div>

      {/* Timeline */}
      <StatusTimeline status={ride.status} />

      <div className="ride-card__meta" style={{ marginTop: 16 }}>
        <span className="ride-card__meta-item">
          <SeatCount n={ride.seatCount} />
        </span>

        {/* Fare — show original and discounted if pool discount applied */}
        <span className="ride-card__meta-item">
          {hasDiscount && baseFareBDT ? (
            <>
              <span style={{ textDecoration: 'line-through', color: 'var(--text-muted)', marginRight: 4 }}>
                ৳{baseFareBDT}
              </span>
              <strong style={{ color: 'var(--success)' }}>৳{ride.estimatedFareBDT}</strong>
              <span style={{ fontSize: 11, color: 'var(--success)', marginLeft: 4 }}>
                {t('common.poolDiscount', { amount: ride.poolDiscountBDT ?? 0 })}
              </span>
            </>
          ) : (
            <>{t('common.fare')} <strong>৳{ride.estimatedFareBDT}</strong></>
          )}
        </span>

        {/* Driver info */}
        {ride.driverName && (
          <span className="ride-card__meta-item">
            👤 {t('p.active.driver')} <strong>{ride.driverName}</strong>
          </span>
        )}

        {ride.vehicle && (
          <span className="ride-card__meta-item">
            🛺 <strong>{ride.vehicle.modelName}</strong> · {ride.vehicle.licensePlate}
          </span>
        )}
      </div>

      {ride.canCancel && (
        <div className="ride-card__footer">
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {new Date(ride.createdAt).toLocaleTimeString(locale)}
          </span>
          <button
            id={`cancel-ride-${ride.id}`}
            className="btn btn--danger btn--sm"
            onClick={() => onCancel(ride.id)}
            disabled={cancelling}
          >
            {cancelling ? t('p.active.cancelling') : t('p.active.cancelRide')}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── History Tab ───────────────────────────────────────────────────────────
function HistoryTab({ passengerId }: { passengerId: string }) {
  const { t, tz, locale } = usePreferences();
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    passengerApi.getHistory(passengerId)
      .then((res) => setRides(res.rides))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [passengerId]);

  if (loading) return <LoadingScreen label={t('loading.history')} />;

  const completed = rides.filter((r) => r.status === 'COMPLETED');
  const totalFare = completed.reduce((sum, r) => sum + r.estimatedFare, 0);

  return (
    <div className="animate-in">
      <div className="section-header">
        <div>
          <h1 className="section-title">{t('p.history.title')}</h1>
          <p className="section-desc">{t('p.history.desc')}</p>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {rides.length > 0 && (
        <div className="stats-row" style={{ marginBottom: 24 }}>
          <div className="stat-card">
            <div className="stat-card__label">{t('p.history.total')}</div>
            <div className="stat-card__value">{rides.length}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card__label">{t('common.completed')}</div>
            <div className="stat-card__value" style={{ color: 'var(--success)' }}>{completed.length}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card__label">{t('p.history.spent')}</div>
            <div className="stat-card__value">৳{(totalFare / 100).toFixed(0)}</div>
          </div>
        </div>
      )}

      {rides.length === 0 ? (
        <EmptyState
          icon="🕓"
          title={t('p.history.emptyTitle')}
          description={t('p.history.emptyDesc')}
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
                  {t('common.fare')} <strong>৳{ride.estimatedFareBDT}</strong>
                  {(ride.poolDiscount ?? 0) > 0 && (
                    <span style={{ fontSize: 11, color: 'var(--success)', marginLeft: 4 }}>
                      {t('p.history.poolDiscount', { amount: ride.poolDiscountBDT ?? 0 })}
                    </span>
                  )}
                </span>
                <span className="ride-card__meta-item" style={{ color: 'var(--text-muted)' }}>
                  {new Date(ride.updatedAt).toLocaleDateString(locale, {
                    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
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
