'use client';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { AppNav } from '@/components/AppNav';
import { StatusBadge } from '@/components/StatusBadge';
import { RideStatusCard } from '@/components/RideStatusCard';
import { StreetRideTab } from '@/components/StreetRide';
import { LoadingScreen, EmptyState, ErrorBanner, ErrorState, SuccessBanner, SeatCount, PassengerFare } from '@/components/UI';
import { passengerApi, qrApi, type FareEstimate, type PaymentMethod, type Ride, type User, ApiError } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { qrSessionToRide } from '@/lib/qrRide';
import { usePreferences, useFormatApiError } from '@/lib/preferences';

type Tab = 'request' | 'active' | 'history' | 'street';

export default function PassengerDashboard() {
  const router = useRouter();
  const { t } = usePreferences();
  const [user, setUser] = useState<ReturnType<typeof getUser>>(null);
  const [tab, setTab] = useState<Tab>('active');
  // Shown on the status tab right after a ride is requested.
  const [justRequested, setJustRequested] = useState(false);
  // Shown on the status tab right after joining a street ride
  const [justJoinedStreet, setJustJoinedStreet] = useState(false);
  // A link like /passenger?code=BULLET (a QR that holds a link) opens the Street Ride tab with the code filled in
  const [streetCode, setStreetCode] = useState('');

  useEffect(() => {
    const u = getUser();
    if (!u || u.role !== 'PASSENGER') {
      router.replace('/auth');
      return;
    }
    setUser(u);
    const code = new URLSearchParams(window.location.search).get('code');
    if (code) { setStreetCode(code); setTab('street'); }
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
            { id: 'street',  label: `🛺 ${t('p.tab.street')}` },
            { id: 'history', label: `🕓 ${t('p.tab.history')}` },
          ] as { id: Tab; label: string }[]).map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              className={`tab-nav__item${tab === t.id ? ' tab-nav__item--active' : ''}`}
              onClick={() => { setJustRequested(false); setJustJoinedStreet(false); setTab(t.id); }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="dashboard__body">
        {tab === 'request'  && (
          <RequestRideTab
            user={user}
            onCreated={() => { setJustRequested(true); setTab('active'); }}
            onViewActive={() => setTab('active')}
          />
        )}
        {tab === 'active'   && (
          <ActiveRidesTab onNavigate={setTab} justRequested={justRequested} justJoinedStreet={justJoinedStreet} />
        )}
        {tab === 'street'   && <StreetRideTab initialCode={streetCode} onJoined={() => { setJustJoinedStreet(true); setTab('active'); }} onViewActive={() => setTab('active')} />}
        {tab === 'history'  && <HistoryTab />}
      </div>
    </div>
  );
}

// ─── Request Ride Tab ──────────────────────────────────────────────────────
// Name and phone come from the logged-in account, so the form only asks for the trip itself.
// The fare preview is computed by the server (same formula as the stored fare) and refreshed
// whenever the form changes.
function RequestRideTab({
  user,
  onCreated,
  onViewActive,
}: {
  user: User;
  onCreated: () => void;
  onViewActive: () => void;
}) {
  const { t, tp, tz } = usePreferences();
  const formatError = useFormatApiError();
  const [zones, setZones] = useState<string[]>([]);
  // The zone dropdown is built from the server: loading -> ready, or failed (with a retry, never a dead empty list)
  const [zonesStatus, setZonesStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [zonesTry, setZonesTry] = useState(0);
  const [maxSeats, setMaxSeats] = useState(3);
  const [pickup, setPickup] = useState('');
  const [destination, setDestination] = useState('');
  const [seats, setSeats] = useState(1);
  const [allowSharing, setAllowSharing] = useState(true);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  // The passenger's own wallet balance, shown next to the payment choice
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  // Each estimate is stored with the form values it was computed for, so an answer for
  // an older form state is simply ignored (and "calculating" is derived, not stored).
  const [result, setResult] = useState<{ key: string; estimate: FareEstimate | null } | null>(null);
  const [hasActiveRide, setHasActiveRide] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Zone list (from the server) and whether the passenger already has a ride in progress.
  useEffect(() => {
    passengerApi.getRideOptions()
      .then((o) => { setZones(o.zones); setMaxSeats(o.maxSeats); setZonesStatus('ready'); })
      .catch(() => setZonesStatus('failed'));
    passengerApi.getActiveRides()
      .then((r) => setHasActiveRide(r.rides.length > 0))
      .catch(() => { /* the server enforces the rule either way */ });
    passengerApi.getWallet().then((w) => setWalletBalance(w.balance)).catch(() => { /* shown only when known */ });
  }, [user.id, zonesTry]);

  // Live fare estimate, refreshed (debounced) whenever the form changes.
  const canEstimate = !!pickup && !!destination && pickup !== destination;
  const key = `${pickup}|${destination}|${seats}|${allowSharing}`;
  useEffect(() => {
    if (!canEstimate) return;
    let stale = false;
    const timer = setTimeout(() => {
      passengerApi.estimateFare({ pickupZone: pickup, destinationZone: destination, seatCount: seats, allowSharing })
        .then((estimate) => { if (!stale) setResult({ key, estimate }); })
        .catch(() => { if (!stale) setResult({ key, estimate: null }); });
    }, 250);
    return () => { stale = true; clearTimeout(timer); };
  }, [canEstimate, key, pickup, destination, seats, allowSharing]);

  const current = canEstimate && result?.key === key ? result : null;
  const estimate = current?.estimate ?? null;
  const estimating = canEstimate && !current;
  const estimateError = !!current && current.estimate === null;

  const handlePickup = (zone: string) => {
    setPickup(zone);
    if (zone === destination) setDestination('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    if (!pickup || !destination) return;
    if (pickup === destination) { setError(t('p.req.sameZone')); return; }
    setError(''); setLoading(true);
    try {
      await passengerApi.requestRide({ pickupZone: pickup, destinationZone: destination, seatCount: seats, allowSharing, paymentMethod });
      onCreated(); // the ride now shows on the status tab
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ACTIVE_RIDE_EXISTS') {
        setHasActiveRide(true);
        setError('');
      } else {
        setError(formatError(err)); // plain words, never a status code
      }
      setLoading(false);
    }
  };

  const seatOptions = Array.from({ length: maxSeats }, (_, i) => i + 1);

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
          {hasActiveRide && (
            <div style={{ marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
              <ErrorBanner message={t('p.req.hasActive')} />
              <button type="button" className="btn btn--secondary btn--sm" onClick={onViewActive}>
                {t('p.req.viewActive')}
              </button>
            </div>
          )}
          {error && <ErrorBanner message={error} />}
          {zonesStatus === 'loading' && <p className="form-hint" id="zones-loading">{t('loading.zones')}</p>}
          {zonesStatus === 'failed' && (
            <ErrorState
              message={t('p.req.zonesError')}
              onRetry={() => { setZonesStatus('loading'); setZonesTry((n) => n + 1); }}
            />
          )}
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20, marginTop: error ? 16 : 0 }}>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
              {t('p.req.bookingAs', { name: user.name, phone: user.phone ?? '' })}
            </p>

            <div className="form-group">
              <label className="form-label" htmlFor="pickup-zone">{t('p.req.pickup')}</label>
              <select
                id="pickup-zone"
                className="form-control"
                value={pickup}
                onChange={(e) => handlePickup(e.target.value)}
                required
              >
                <option value="">{t('p.req.pickupPh')}</option>
                {zones.map((z) => <option key={z} value={z}>{tz(z)}</option>)}
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
                {zones.filter((z) => z !== pickup).map((z) => (
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
                required
              >
                {seatOptions.map((n) => (
                  <option key={n} value={n}>{tp('seats', n)}</option>
                ))}
              </select>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{t('p.req.seatsHint')}</div>
            </div>

            <div className="online-toggle">
              <div style={{ flex: 1 }}>
                <label className="online-toggle__label" htmlFor="allow-sharing">{t('p.req.share')}</label>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {allowSharing ? t('p.req.shareOn') : t('p.req.shareOff')}
                </div>
              </div>
              <label className="toggle-switch">
                <input
                  id="allow-sharing"
                  type="checkbox"
                  checked={allowSharing}
                  onChange={(e) => setAllowSharing(e.target.checked)}
                />
                <span className="toggle-switch__slider" />
              </label>
            </div>

            {/* How the passenger pays: cash to the driver, or the simulated TeslaPay wallet */}
            <div className="form-group">
              <label className="form-label" htmlFor="payment-method">{t('pay.method')}</label>
              <select
                id="payment-method"
                className="form-control"
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
              >
                <option value="cash">{t('pay.cash')}</option>
                <option value="wallet">{t('pay.wallet')}</option>
              </select>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }} id="payment-hint">
                {paymentMethod === 'wallet' ? t('pay.hint.wallet') : t('pay.hint.cash')}
                {walletBalance !== null && <> · <strong>{t('pay.balance', { balance: walletBalance })}</strong></>}
              </div>
            </div>

            {/* Fare preview */}
            <div className="fare-display" id="fare-estimate" aria-live="polite">
              <div>
                <div className="fare-display__label">{t('p.req.estFare')}</div>
                {estimate ? (
                  <>
                    <div className="fare-display__amount">৳{estimate.fare}</div>
                    <div className="fare-display__sub">{tp('p.req.forSeats', seats)}</div>
                  </>
                ) : (
                  <div className="fare-display__sub">
                    {estimating ? t('p.req.estimating') : estimateError ? t('p.req.estimateError') : t('p.req.estimateHint')}
                  </div>
                )}
              </div>
            </div>

            {/* Why the price can drop: what you would pay as others join */}
            {estimate && (
              <div className="fare-tiers" id="fare-tiers">
                {estimate.tiers.length > 0 ? (
                  <>
                    <div className="fare-tiers__title">{t('p.req.dropsTitle')}</div>
                    <ul className="fare-tiers__list">
                      <li>{t('p.req.aloneTier', { fare: estimate.fare })}</li>
                      {estimate.tiers.map((tier) => (
                        <li key={tier.passengers}>{t('p.req.tier', { n: tier.passengers, fare: tier.fare })}</li>
                      ))}
                    </ul>
                    <p className="fare-tiers__note">{t('p.req.dropsNote')}</p>
                  </>
                ) : (
                  <p className="fare-tiers__note">{allowSharing ? t('p.req.fullCar') : t('p.req.privateNote')}</p>
                )}
              </div>
            )}

            <button
              id="request-ride-submit"
              type="submit"
              className="btn btn--primary btn--full"
              disabled={loading || hasActiveRide || zonesStatus !== 'ready' || !pickup || !destination || !estimate}
            >
              {loading ? t('p.req.submitting') : t('p.req.submit')}
            </button>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, textAlign: 'center' }}>{t('p.req.noPayment')}</p>
          </form>
        </div>
      </div>
    </div>
  );
}

// ─── Active Rides Tab (the ride status page) ───────────────────────────────
function ActiveRidesTab({
  onNavigate,
  justRequested,
  justJoinedStreet,
}: {
  onNavigate: (tab: Tab) => void;
  justRequested: boolean;
  justJoinedStreet: boolean;
}) {
  const { t } = usePreferences();
  const formatError = useFormatApiError();
  const [rides, setRides] = useState<Ride[]>([]);
  // The street ride (joined by QR code) the passenger is on now, shown with the same card as an app ride
  const [streetRide, setStreetRide] = useState<Ride | null>(null);
  // The list itself could not be loaded (as opposed to a failed action on a ride, which uses `error`)
  const [loadError, setLoadError] = useState('');
  // Bumped on every reload so each ride card starts again from the fresh data.
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelSuccess, setCancelSuccess] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError(''); setLoadError('');
    try {
      const [res, street] = await Promise.all([passengerApi.getActiveRides(), qrApi.mine()]);
      setRides(res.rides);
      setStreetRide(street.session ? qrSessionToRide(street.session) : null);
      setVersion((v) => v + 1);
    } catch (err) {
      setLoadError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [formatError]);

  useEffect(() => { load(); }, [load]);

  // Each ride card keeps itself up to date (every 5 seconds) until the ride is completed or cancelled.
  const handleCancel = async (rideId: string) => {
    if (!confirm(t('p.active.confirmCancel'))) return;
    setCancelling(rideId); setCancelSuccess(''); setError('');
    try {
      await passengerApi.cancelRide(rideId);
      setCancelSuccess(t('p.active.cancelled'));
    } catch (err) {
      setError(formatError(err));
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
        <button className="btn btn--ghost btn--sm" onClick={() => load()} id="refresh-active">{t('common.refresh')}</button>
      </div>

      {error && <ErrorBanner message={error} />}
      {justRequested && <SuccessBanner message={t('p.req.success')} />}
      {justJoinedStreet && streetRide && <SuccessBanner message={t('qr.joinedActive')} />}
      {cancelSuccess && <SuccessBanner message={cancelSuccess} />}

      {loadError ? (
        <ErrorState message={loadError} onRetry={() => load()} />
      ) : rides.length === 0 && !streetRide ? (
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
          {streetRide && (
            <RideStatusCard
              key={`street-${streetRide.id}-${version}`}
              initial={streetRide}
              onCancel={handleCancel}
              cancelling={false}
              // Their own trip ended (I've arrived, or it timed out): nothing left to show here, it is in History now
              street={{ onEnded: () => onNavigate('history') }}
            />
          )}
          {rides.map((ride) => (
            <RideStatusCard
              key={`${ride.id}-${version}`}
              initial={ride}
              onCancel={handleCancel}
              cancelling={cancelling === ride.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── History Tab ───────────────────────────────────────────────────────────
function HistoryTab() {
  const { t, tz, locale } = usePreferences();
  const formatError = useFormatApiError();
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true); setError('');
    passengerApi.getHistory()
      .then((res) => setRides(res.rides))
      .catch((err) => setError(formatError(err)))
      .finally(() => setLoading(false));
  }, [formatError]);

  useEffect(() => { load(); }, [load]);

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

      {error && <ErrorState message={error} onRetry={load} />}

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
            <div className="stat-card__value">৳{totalFare}</div>
          </div>
        </div>
      )}

      {error ? null : rides.length === 0 ? (
        <EmptyState
          icon="🕓"
          title={t('p.history.emptyTitle')}
          description={t('p.history.emptyDesc')}
        />
      ) : (
        <div className="ride-list">
          {rides.map((ride) => (
            <div key={`${ride.source ?? 'APP'}-${ride.id}`} className="ride-card" data-source={ride.source ?? 'APP'}>
              <div className="ride-card__route">
                <span className="ride-card__zone">{tz(ride.pickupZone)}</span>
                <span className="ride-card__arrow">→</span>
                <span className="ride-card__zone">{tz(ride.destinationZone)}</span>
                <StatusBadge status={ride.status} />
                {/* Which flow this trip came from, so a street ride is never mistaken for an app ride */}
                <span className={`badge ${ride.source === 'QR' ? 'badge--matched' : 'badge--completed'}`} style={{ fontSize: 11 }} id={`source-${ride.id}`}>
                  {ride.source === 'QR' ? `🛺 ${t('p.history.sourceQR')}` : `📱 ${t('p.history.sourceApp')}`}
                </span>
              </div>
              <div className="ride-card__meta">
                <span className="ride-card__meta-item">
                  <SeatCount n={ride.seatCount} />
                </span>
                <span className="ride-card__meta-item">
                  {t('common.fare')} <PassengerFare ride={ride} />
                </span>
                <span className="ride-card__meta-item" style={{ color: 'var(--text-muted)' }}>
                  {new Date(ride.updatedAt).toLocaleDateString(locale, {
                    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
                  })}
                </span>
              </div>
              {ride.source === 'QR' && ride.qr && (
                <div className="ride-block" id={`qr-details-${ride.id}`}>
                  <div className="ride-block__line">
                    🛺 {ride.qr.vehicleNickname} · {ride.qr.vehicleCode}
                    {' · '}{t('qr.hist.joined', { time: new Date(ride.qr.joinedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) })}
                    {ride.qr.exitedAt && <>{' · '}{t(ride.qr.autoCompleted ? 'qr.status.AUTO_COMPLETED' : 'qr.hist.arrived', { time: new Date(ride.qr.exitedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) })}</>}
                  </div>
                  {ride.paymentStatus === 'CASH_DUE' && (
                    <div className="ride-block__line">💵 {t('qr.payCash', { amount: ride.paymentAmount ?? ride.estimatedFare })}</div>
                  )}
                  {ride.qr.driverBonus > 0 && (
                    <div className="ride-block__line">{t('qr.hist.bonus', { amount: ride.qr.driverBonus })}</div>
                  )}
                  {ride.qr.autoCompleted && <div className="ride-block__line">{t('qr.autoNote')}</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
