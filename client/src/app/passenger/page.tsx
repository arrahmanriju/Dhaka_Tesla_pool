'use client';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { AppNav } from '@/components/AppNav';
import { StatusBadge, StatusTimeline } from '@/components/StatusBadge';
import { LoadingScreen, EmptyState, ErrorBanner, SuccessBanner } from '@/components/UI';
import { passengerApi, DHAKA_ZONES, type Ride, ApiError } from '@/lib/api';
import { getUser } from '@/lib/auth';

type Tab = 'request' | 'active' | 'history';

export default function PassengerDashboard() {
  const router = useRouter();
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

  if (!user) return <LoadingScreen label="Loading your dashboard…" />;

  return (
    <div className="dashboard">
      <AppNav />

      {/* Tab bar */}
      <div className="tab-nav-wrapper">
        <div className="tab-nav">
          {([
            { id: 'active',  label: '🚦 Active Rides' },
            { id: 'request', label: '➕ Request Ride' },
            { id: 'history', label: '🕓 History' },
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
  const [pickup, setPickup] = useState('');
  const [destination, setDestination] = useState('');
  const [seats, setSeats] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<Ride | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pickup === destination) { setError('Pickup and destination cannot be the same zone.'); return; }
    setError(''); setLoading(true);
    try {
      const res = await passengerApi.requestRide(passengerId, pickup, destination, seats);
      setSuccess(res.ride);
    } catch (err: any) {
      if (err instanceof ApiError) {
        setError(`Error ${err.status}: ${err.message}`);
      } else {
        setError(err.message || 'An unexpected error occurred');
      }
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="animate-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <SuccessBanner message="Ride requested successfully! Waiting for a driver to match." />
        <div className="ride-card">
          <div className="ride-card__route">
            <span className="ride-card__zone">{success.pickupZone}</span>
            <span className="ride-card__arrow">→</span>
            <span className="ride-card__zone">{success.destinationZone}</span>
          </div>
          <div className="fare-display" style={{ marginBottom: 16 }}>
            <div>
              <div className="fare-display__label">Estimated Fare</div>
              <div className="fare-display__amount">৳{success.estimatedFareBDT}</div>
              <div className="fare-display__sub">For {success.seatCount} seat{success.seatCount > 1 ? 's' : ''}</div>
            </div>
            <StatusBadge status={success.status} />
          </div>
          <button className="btn btn--secondary btn--sm" onClick={() => setSuccess(null)}>
            Request another ride
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-in">
      <div className="section-header">
        <div>
          <h1 className="section-title">Request a Pool Ride</h1>
          <p className="section-desc">Choose your zones and we'll match you with a Tesla heading that way.</p>
        </div>
      </div>

      <div className="card">
        <div className="card__body">
          {error && <ErrorBanner message={error} />}
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20, marginTop: error ? 16 : 0 }}>
            <div className="form-group">
              <label className="form-label" htmlFor="pickup-zone">Pickup Zone</label>
              <select
                id="pickup-zone"
                className="form-control"
                value={pickup}
                onChange={(e) => setPickup(e.target.value)}
                required
              >
                <option value="">Select pickup zone…</option>
                {DHAKA_ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="dest-zone">Destination Zone</label>
              <select
                id="dest-zone"
                className="form-control"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                required
              >
                <option value="">Select destination zone…</option>
                {DHAKA_ZONES.filter((z) => z !== pickup).map((z) => (
                  <option key={z} value={z}>{z}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="seat-count">Seats Needed</label>
              <select
                id="seat-count"
                className="form-control"
                value={seats}
                onChange={(e) => setSeats(Number(e.target.value))}
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>{n} seat{n > 1 ? 's' : ''}</option>
                ))}
              </select>
            </div>

            <button
              id="request-ride-submit"
              type="submit"
              className="btn btn--primary btn--full"
              disabled={loading || !pickup || !destination}
            >
              {loading ? 'Requesting…' : 'Request ride →'}
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
    if (!confirm('Cancel this ride?')) return;
    setCancelling(rideId); setCancelSuccess('');
    try {
      await passengerApi.cancelRide(rideId, passengerId);
      setCancelSuccess('Ride cancelled.');
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCancelling(null);
    }
  };

  if (loading) return <LoadingScreen label="Loading your rides…" />;

  return (
    <div className="animate-in">
      <div className="section-header">
        <div>
          <h1 className="section-title">Active Rides</h1>
          <p className="section-desc">Live status of your current rides.</p>
        </div>
        <button className="btn btn--ghost btn--sm" onClick={load} id="refresh-active">↻ Refresh</button>
      </div>

      {error && <ErrorBanner message={error} />}
      {cancelSuccess && <SuccessBanner message={cancelSuccess} />}

      {rides.length === 0 ? (
        <EmptyState
          icon="🛣️"
          title="No active rides"
          description="You don't have any rides in progress right now."
          action={
            <button className="btn btn--primary" onClick={() => onNavigate('request')}>
              Request a ride
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
  return (
    <div className="ride-card">
      <div className="ride-card__route">
        <span className="ride-card__zone">{ride.pickupZone}</span>
        <span className="ride-card__arrow">→</span>
        <span className="ride-card__zone">{ride.destinationZone}</span>
        <StatusBadge status={ride.status} />
      </div>

      {/* Timeline */}
      <StatusTimeline status={ride.status} />

      <div className="ride-card__meta" style={{ marginTop: 16 }}>
        <span className="ride-card__meta-item">
          <strong>{ride.seatCount}</strong> seat{ride.seatCount > 1 ? 's' : ''}
        </span>
        <span className="ride-card__meta-item">
          Fare: <strong>৳{ride.estimatedFareBDT}</strong>
        </span>
        {ride.vehicle && (
          <span className="ride-card__meta-item">
            🚗 <strong>{ride.vehicle.modelName}</strong> · {ride.vehicle.licensePlate}
          </span>
        )}
      </div>

      {ride.canCancel && (
        <div className="ride-card__footer">
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {new Date(ride.createdAt).toLocaleTimeString()}
          </span>
          <button
            id={`cancel-ride-${ride.id}`}
            className="btn btn--danger btn--sm"
            onClick={() => onCancel(ride.id)}
            disabled={cancelling}
          >
            {cancelling ? 'Cancelling…' : 'Cancel ride'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── History Tab ───────────────────────────────────────────────────────────
function HistoryTab({ passengerId }: { passengerId: string }) {
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    passengerApi.getHistory(passengerId)
      .then((res) => setRides(res.rides))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [passengerId]);

  if (loading) return <LoadingScreen label="Loading history…" />;

  const completed = rides.filter((r) => r.status === 'COMPLETED');
  const totalFare = completed.reduce((sum, r) => sum + r.estimatedFare, 0);

  return (
    <div className="animate-in">
      <div className="section-header">
        <div>
          <h1 className="section-title">Ride History</h1>
          <p className="section-desc">All completed and cancelled rides.</p>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {rides.length > 0 && (
        <div className="stats-row" style={{ marginBottom: 24 }}>
          <div className="stat-card">
            <div className="stat-card__label">Total rides</div>
            <div className="stat-card__value">{rides.length}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card__label">Completed</div>
            <div className="stat-card__value" style={{ color: 'var(--success)' }}>{completed.length}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card__label">Total spent</div>
            <div className="stat-card__value">৳{(totalFare / 100).toFixed(0)}</div>
          </div>
        </div>
      )}

      {rides.length === 0 ? (
        <EmptyState
          icon="🕓"
          title="No ride history yet"
          description="Your completed and cancelled rides will appear here."
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
