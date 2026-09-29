'use client';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { AppNav } from '@/components/AppNav';
import { StatusBadge } from '@/components/StatusBadge';
import { LoadingScreen, EmptyState, ErrorBanner, SuccessBanner, Spinner } from '@/components/UI';
import { driverApi, type Ride, type Vehicle } from '@/lib/api';
import { getUser } from '@/lib/auth';

type Tab = 'pending' | 'active' | 'vehicle' | 'history';

export default function DriverDashboard() {
  const router = useRouter();
  const [user, setUser] = useState<ReturnType<typeof getUser>>(null);
  const [tab, setTab] = useState<Tab>('active');
  const [isOnline, setIsOnline] = useState(false);
  const [togglingOnline, setTogglingOnline] = useState(false);

  useEffect(() => {
    const u = getUser();
    if (!u || u.role !== 'DRIVER') { router.replace('/auth'); return; }
    setUser(u);
    setIsOnline(!!(u as any).isOnline);
  }, [router]);

  const handleToggleOnline = async () => {
    if (!user) return;
    setTogglingOnline(true);
    try {
      const res = await driverApi.setOnlineStatus(user.id, !isOnline);
      setIsOnline(res.user.isOnline ?? !isOnline);
    } catch {
      // silently revert
    } finally {
      setTogglingOnline(false);
    }
  };

  if (!user) return <LoadingScreen label="Loading driver dashboard…" />;

  return (
    <div className="dashboard">
      <AppNav />

      {/* Tab bar */}
      <div className="tab-nav-wrapper">
        <div className="tab-nav">
          {([
            { id: 'active',  label: '🚗 Active Rides' },
            { id: 'pending', label: '📋 Pending Requests' },
            { id: 'vehicle', label: '🔧 Vehicle' },
            { id: 'history', label: '🕓 History' },
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
        {/* Online / offline toggle */}
        <div className="online-toggle">
          <div>
            <div className="online-toggle__label">
              {isOnline ? '🟢 You are online' : '⚫ You are offline'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
              {isOnline ? 'Passengers can see you in their search.' : 'Go online to start accepting rides.'}
            </div>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={isOnline}
              onChange={handleToggleOnline}
              disabled={togglingOnline}
              id="driver-online-toggle"
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
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [accepting, setAccepting] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await driverApi.getPendingRides(driverId);
      setRides(res.rides);
    } catch (err: any) {
      setError(err.status ? `Error ${err.status}: ${err.message}` : err.message);
    } finally {
      setLoading(false);
    }
  }, [driverId]);

  useEffect(() => { load(); }, [load]);

  const handleAccept = async (rideId: string) => {
    setAccepting(rideId); setError(''); setSuccessMsg('');
    try {
      await driverApi.acceptRide(rideId, driverId);
      setSuccessMsg('Ride accepted and added to your pool!');
      await load();
    } catch (err: any) {
      setError(err.status ? `Error ${err.status}: ${err.message}` : err.message);
    } finally {
      setAccepting(null);
    }
  };

  if (loading) return <LoadingScreen label="Loading pending requests…" />;

  return (
    <div className="animate-in">
      <div className="section-header">
        <div>
          <h1 className="section-title">Pending Requests</h1>
          <p className="section-desc">Passengers waiting for a driver to accept their ride.</p>
        </div>
        <button className="btn btn--ghost btn--sm" onClick={load} id="refresh-pending">↻ Refresh</button>
      </div>

      {!isOnline && (
        <div className="error-banner" style={{ marginBottom: 16 }}>
          ⚠ You must be online to accept rides.
        </div>
      )}
      {error && <ErrorBanner message={error} />}
      {successMsg && <SuccessBanner message={successMsg} />}

      {rides.length === 0 ? (
        <EmptyState
          icon="🛣️"
          title="No pending requests"
          description="Check back soon — new ride requests will appear here."
        />
      ) : (
        <div className="ride-list">
          {rides.map((ride) => (
            <div key={ride.id} className="ride-card">
              <div className="ride-card__route">
                <span className="ride-card__zone">{ride.pickupZone}</span>
                <span className="ride-card__arrow">→</span>
                <span className="ride-card__zone">{ride.destinationZone}</span>
                <StatusBadge status={ride.status} />
              </div>
              <div className="ride-card__meta">
                <span className="ride-card__meta-item">
                  <strong>{ride.seatCount}</strong> seat{ride.seatCount > 1 ? 's' : ''}
                </span>
                <span className="ride-card__meta-item">
                  Fare: <strong>৳{ride.estimatedFareBDT}</strong>
                </span>
                <span className="ride-card__meta-item" style={{ color: 'var(--text-muted)' }}>
                  {new Date(ride.createdAt).toLocaleTimeString()}
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
                  {accepting === ride.id ? <><Spinner /> Accepting…</> : 'Accept ride ✓'}
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
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await driverApi.getActiveRides(driverId);
      setRides(res.rides);
    } catch (err: any) {
      setError(err.status ? `Error ${err.status}: ${err.message}` : err.message);
    } finally {
      setLoading(false);
    }
  }, [driverId]);

  useEffect(() => { load(); }, [load]);

  const doAction = async (
    rideId: string,
    action: 'arrive' | 'start' | 'complete' | 'cancel'
  ) => {
    setActionLoading(rideId + action); setError(''); setSuccessMsg('');
    try {
      await driverApi[action](rideId, driverId);
      setSuccessMsg(`Ride marked as ${action === 'arrive' ? 'driver arrived' : action}ed.`);
      await load();
    } catch (err: any) {
      setError(err.status ? `Error ${err.status}: ${err.message}` : err.message);
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) return <LoadingScreen label="Loading active rides…" />;

  // Only show EmptyState if load succeeded (no error). If there's an error,
  // the ErrorBanner above already tells the user what went wrong.
  const showEmpty = !error && rides.length === 0;

  return (
    <div className="animate-in">
      <div className="section-header">
        <div>
          <h1 className="section-title">Your Active Pool</h1>
          <p className="section-desc">Manage matched rides and move through the trip lifecycle.</p>
        </div>
        <button className="btn btn--ghost btn--sm" onClick={load} id="refresh-active-driver">↻ Refresh</button>
      </div>

      {error && <ErrorBanner message={error} />}
      {successMsg && <SuccessBanner message={successMsg} />}

      {showEmpty ? (
        <EmptyState
          icon="🚗"
          title="No active rides"
          description="Accept pending requests to build your pool."
        />
      ) : rides.length > 0 ? (
        <div className="ride-list">
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
  // Determine which lifecycle buttons to show based on current state
  const actions: { label: string; action: 'arrive' | 'start' | 'complete' | 'cancel'; cls: string }[] = [];
  if (ride.status === 'MATCHED')        actions.push({ label: '📍 Mark Arrived',    action: 'arrive',   cls: 'btn--warning' });
  if (ride.status === 'DRIVER_ARRIVED') actions.push({ label: '▶ Start Trip',        action: 'start',    cls: 'btn--primary' });
  if (ride.status === 'STARTED')        actions.push({ label: '✅ Complete Trip',    action: 'complete', cls: 'btn--success' });
  if (['MATCHED', 'DRIVER_ARRIVED'].includes(ride.status))
    actions.push({ label: 'Cancel', action: 'cancel', cls: 'btn--danger' });

  return (
    <div className="ride-card">
      <div className="ride-card__route">
        <span className="ride-card__zone">{ride.pickupZone}</span>
        <span className="ride-card__arrow">→</span>
        <span className="ride-card__zone">{ride.destinationZone}</span>
        <StatusBadge status={ride.status} />
      </div>

      <div className="ride-card__meta">
        <span className="ride-card__meta-item">
          <strong>{ride.seatCount}</strong> seat{ride.seatCount > 1 ? 's' : ''}
        </span>
        <span className="ride-card__meta-item">
          Fare: <strong>৳{ride.estimatedFareBDT}</strong>
        </span>
        {ride.vehicle && (
          <span className="ride-card__meta-item">
            🚗 <strong>{ride.vehicle.modelName}</strong>
            &nbsp;·&nbsp;
            {ride.vehicle.occupiedSeats ?? '?'}/{ride.vehicle.seatCapacity} seats
          </span>
        )}
      </div>

      {actions.length > 0 && (
        <div className="ride-card__footer">
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {new Date(ride.updatedAt).toLocaleTimeString()}
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
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [registering, setRegistering] = useState(false);
  const [form, setForm] = useState({ modelName: '', licensePlate: '', seatCapacity: 4 });

  useEffect(() => {
    driverApi.getVehicle(driverId)
      .then((res) => setVehicle(res.vehicle))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [driverId]);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setSuccess(''); setRegistering(true);
    try {
      const res = await driverApi.registerVehicle(
        driverId, form.modelName, form.licensePlate, form.seatCapacity
      );
      setVehicle(res.vehicle);
      setSuccess('Vehicle registered successfully!');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRegistering(false);
    }
  };

  if (loading) return <LoadingScreen label="Loading vehicle info…" />;

  return (
    <div className="animate-in">
      <div className="section-header">
        <div>
          <h1 className="section-title">Your Vehicle</h1>
          <p className="section-desc">Register and manage your Tesla.</p>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}
      {success && <SuccessBanner message={success} />}

      {vehicle ? (
        <div className="card card--raised">
          <div className="card__header">
            <div>
              <div className="card__title">🚗 {vehicle.modelName}</div>
              <div className="card__subtitle">{vehicle.licensePlate}</div>
            </div>
            <span className="badge badge--matched" style={{ fontSize: 12 }}>Active</span>
          </div>
          <div className="card__body">
            <div className="stats-row">
              <div className="stat-card">
                <div className="stat-card__label">Total Capacity</div>
                <div className="stat-card__value">{vehicle.seatCapacity}</div>
              </div>
              <div className="stat-card">
                <div className="stat-card__label">Occupied Seats</div>
                <div className="stat-card__value" style={{ color: vehicle.occupiedSeats > 0 ? 'var(--warning)' : 'var(--text-secondary)' }}>
                  {vehicle.occupiedSeats}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-card__label">Available Seats</div>
                <div className="stat-card__value" style={{ color: 'var(--success)' }}>
                  {vehicle.seatCapacity - vehicle.occupiedSeats}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="card__header">
            <div>
              <div className="card__title">Register a Vehicle</div>
              <div className="card__subtitle">You need a vehicle to accept rides.</div>
            </div>
          </div>
          <div className="card__body">
            <form onSubmit={handleRegister} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div className="form-group">
                <label className="form-label" htmlFor="vehicle-model">Model Name</label>
                <input
                  id="vehicle-model"
                  className="form-control"
                  placeholder="e.g. Tesla Model 3"
                  value={form.modelName}
                  onChange={(e) => setForm({ ...form, modelName: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="vehicle-plate">License Plate</label>
                <input
                  id="vehicle-plate"
                  className="form-control"
                  placeholder="e.g. DHA-1234"
                  value={form.licensePlate}
                  onChange={(e) => setForm({ ...form, licensePlate: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="vehicle-seats">Seat Capacity</label>
                <select
                  id="vehicle-seats"
                  className="form-control"
                  value={form.seatCapacity}
                  onChange={(e) => setForm({ ...form, seatCapacity: Number(e.target.value) })}
                >
                  {[2, 3, 4, 5, 6, 7].map((n) => (
                    <option key={n} value={n}>{n} seats</option>
                  ))}
                </select>
              </div>
              <button
                id="register-vehicle-submit"
                type="submit"
                className="btn btn--primary btn--full"
                disabled={registering}
              >
                {registering ? 'Registering…' : 'Register vehicle'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── History Tab ───────────────────────────────────────────────────────────
function HistoryTab({ driverId }: { driverId: string }) {
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    driverApi.getHistory(driverId)
      .then((res) => setRides(res.rides))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [driverId]);

  if (loading) return <LoadingScreen label="Loading trip history…" />;

  const completed = rides.filter((r) => r.status === 'COMPLETED');
  const totalEarned = completed.reduce((s, r) => s + r.estimatedFare, 0);

  return (
    <div className="animate-in">
      <div className="section-header">
        <div>
          <h1 className="section-title">Trip History</h1>
          <p className="section-desc">All your completed and cancelled trips.</p>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {rides.length > 0 && (
        <div className="stats-row" style={{ marginBottom: 24 }}>
          <div className="stat-card">
            <div className="stat-card__label">Total trips</div>
            <div className="stat-card__value">{rides.length}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card__label">Completed</div>
            <div className="stat-card__value" style={{ color: 'var(--success)' }}>{completed.length}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card__label">Total earned</div>
            <div className="stat-card__value">৳{(totalEarned / 100).toFixed(0)}</div>
          </div>
        </div>
      )}

      {rides.length === 0 ? (
        <EmptyState
          icon="🕓"
          title="No trip history yet"
          description="Completed trips will appear here."
        />
      ) : (
        <div className="ride-list">
          {rides.map((ride) => (
            <div key={ride.id} className="ride-card">
              <div className="ride-card__route">
                <span className="ride-card__zone">{ride.pickupZone}</span>
                <span className="ride-card__arrow">→</span>
                <span className="ride-card__zone">{ride.destinationZone}</span>
                <StatusBadge status={ride.status} />
              </div>
              <div className="ride-card__meta">
                <span className="ride-card__meta-item">
                  <strong>{ride.seatCount}</strong> seat{ride.seatCount > 1 ? 's' : ''}
                </span>
                <span className="ride-card__meta-item">
                  Fare: <strong>৳{ride.estimatedFareBDT}</strong>
                </span>
                <span className="ride-card__meta-item" style={{ color: 'var(--text-muted)' }}>
                  {new Date(ride.updatedAt).toLocaleDateString('en-BD', {
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
