// ─── Typed API client ──────────────────────────────────────────────────────
// All calls go through this module so the base URL is always consistent.
import { clearAuth, getToken } from './auth';

const BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Machine-readable reason from the server, e.g. NID_TAKEN. */
    public code?: string,
    /** Per-field messages from the server, keyed by form field. */
    public fields?: Record<string, string>
  ) {
    super(message);
  }
}

/** Turns a server-relative path such as /uploads/x.png into a full URL. */
export const assetUrl = (path: string) => `${BASE}${path}`;

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      // Endpoints that hold private data (driver onboarding) identify the caller by this token.
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A 401 from /auth/* is just "wrong credentials" — show it on the form instead of reloading.
    if (res.status === 401 && !path.startsWith('/auth/') && typeof window !== 'undefined') {
      clearAuth();
      window.location.href = '/auth';
    }
    throw new ApiError(res.status, data.error || `HTTP ${res.status}`, data.code, data.fields);
  }
  return data as T;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type Role = 'PASSENGER' | 'DRIVER';

export type RideStatus =
  | 'REQUESTED'
  | 'MATCHED'
  | 'DRIVER_ARRIVED'
  | 'STARTED'
  | 'COMPLETED'
  | 'CANCELLED';

export interface User {
  id: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  role: Role;
  isOnline?: boolean;
}

export interface OnboardingProfile {
  /** Public driver ID, e.g. DTP-0001 */
  driverCode: string;
  nickname: string | null;
  seatCapacity: number | null;
  homeZone: string;
  /** NID with all but the last 4 digits hidden — the full number is never sent back. */
  nidMasked: string;
  profilePictureUrl: string | null;
}

export interface OnboardingState {
  driver: { name: string; phone: string | null };
  zones: string[];
  onboarded: boolean;
  profile: OnboardingProfile | null;
  existingVehicle: { nickname: string; seatCapacity: number } | null;
}

export interface OnboardingInput {
  nickname: string;
  seatCapacity: number;
  homeZone: string;
  nid: string;
  /** `data:image/png;base64,…` or `data:image/jpeg;base64,…` */
  profilePicture?: string;
}

export interface RideRequestInput {
  pickupZone: string;
  destinationZone: string;
  seatCount: number;
  allowSharing: boolean;
}

/** What one passenger pays when `passengers` people share the ride (whole taka). */
export interface FareTier {
  passengers: number;
  ratePercent: number;
  fare: number;
}

/** All money is whole taka, a multiple of ৳5. */
export interface FareEstimate {
  /** Their own full fare (pickup → destination) */
  baseFare: number;
  /** The price riding alone — what a private ride always costs */
  fare: number;
  /** The price once one other passenger joins; null for a private ride or a booking that fills the car */
  poolFare: number | null;
  /** The (lower) price with 2 and with 3 passengers; empty for a private ride */
  tiers: FareTier[];
}

/** The driver of an accepted ride, as the passenger sees them. `phone` is only sent while the ride is in progress. */
export interface RideDriver {
  name: string | null;
  phone: string | null;
  photoUrl: string | null;
  teslaId: string | null;
}

/** Who else is on the vehicle: first names only — never a phone number, fare or destination. */
export interface RidePool {
  isShared: boolean;
  poolSize: number;
  otherPassengers: { firstName: string }[];
  seatsTaken: number;
  seatCapacity: number;
}

export interface Ride {
  id: string;
  pickupZone: string;
  destinationZone: string;
  seatCount: number;
  /** false = private ride, never pooled */
  allowSharing?: boolean;
  /** This passenger's own fare when riding alone (whole taka) */
  baseFare?: number;
  /** What this passenger pays right now (whole taka); drops as others join, final once STARTED */
  estimatedFare: number;
  /** What sharing saves this passenger (whole taka). 0 when riding alone or private. */
  poolDiscount?: number;
  /** true once the trip has started: the fare can no longer change */
  fareLocked?: boolean;
  /** Passengers currently in the pool, including this one */
  poolSize?: number;
  /** Percentage of their own base fare this passenger pays (100 / 70 / 55) */
  shareRatePercent?: number;
  status: RideStatus;
  canCancel?: boolean;
  vehicle?: {
    id: string;
    modelName: string;
    licensePlate: string;
    seatCapacity: number;
    occupiedSeats?: number;
    /** The vehicle's nickname, e.g. "Bullet" */
    nickname?: string;
    /** The driver's Tesla ID, e.g. "DTP-0001" */
    teslaId?: string;
  } | null;
  /** Set once a driver has accepted; null while the ride is still REQUESTED */
  driver?: RideDriver | null;
  /** Set while the ride is open and on a vehicle; null before it is matched and once it is over */
  pool?: RidePool | null;
  driverId?: string;
  vehicleId?: string;
  /** Driver's display name — shown to passenger only when matched */
  driverName?: string | null;
  /** Number of other passengers sharing this vehicle (no PII) */
  coPassengers?: number;
  /** True when 2+ passengers share this vehicle */
  isSharedRide?: boolean;
  poolDiscountApplied?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Vehicle {
  id: string;
  modelName: string;
  licensePlate: string;
  seatCapacity: number;
  occupiedSeats: number;
  driverId: string;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

export const authApi = {
  /** `phone` is required; `email` is optional and omitted when blank. */
  signup: (name: string, phone: string, email: string, password: string, role: Role) =>
    request<{ token: string; user: User }>('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ name, phone, email: email || undefined, password, role }),
    }),

  login: (phone: string, password: string) =>
    request<{ token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ phone, password }),
    }),

  /** Sends a reset code by SMS. `devCode` is only present on non-production servers. */
  forgotPassword: (phone: string) =>
    request<{ message: string; expiresInMinutes: number; devCode?: string }>('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    }),

  resetPassword: (phone: string, code: string, newPassword: string) =>
    request<{ message: string }>('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ phone, code, newPassword }),
    }),
};

// ─── Passenger APIs ──────────────────────────────────────────────────────────

export const passengerApi = {
  /** Zones and seat limits the server accepts — the dropdown is built from this, never hard-coded. */
  getRideOptions: () =>
    request<{ zones: string[]; minSeats: number; maxSeats: number }>('/ride-requests/zones'),

  /** Fare preview for the form. Computed by the server so it always matches the fare that gets stored. */
  estimateFare: (input: RideRequestInput) => {
    const q = new URLSearchParams({
      pickupZone: input.pickupZone,
      destinationZone: input.destinationZone,
      seatCount: String(input.seatCount),
      allowSharing: String(input.allowSharing),
    });
    return request<FareEstimate>(`/ride-requests/estimate?${q}`);
  },

  /** The passenger is identified by the login token; name and phone stay on the account. */
  requestRide: (input: RideRequestInput) =>
    request<{ rideRequest: Ride }>('/ride-requests', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then(res => ({ ride: res.rideRequest })),

  // The passenger is identified by the login token: these routes only ever return, or act on,
  // the logged-in passenger's own rides (403 for anyone else's).
  getActiveRides: () => request<{ rides: Ride[] }>('/passenger/rides/active'),

  /** One ride by id — the ride status page polls this every 5 seconds until the ride is finished. */
  getRide: (rideId: string) => request<{ ride: Ride }>(`/passenger/rides/${rideId}`),

  getHistory: () => request<{ rides: Ride[] }>('/passenger/rides/history'),

  cancelRide: (rideId: string) =>
    request<{ message: string; status: string }>(`/passenger/rides/${rideId}/cancel`, { method: 'PATCH' }),
};

// ─── Driver APIs ─────────────────────────────────────────────────────────────

export const driverApi = {
  getOnboarding: () => request<OnboardingState>('/driver/onboarding'),

  submitOnboarding: (input: OnboardingInput) =>
    request<{ message: string; profile: OnboardingProfile }>('/driver/onboarding', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // Backend: PUT /driver/:id/status  { isOnline: boolean }
  setOnlineStatus: (driverId: string, isOnline: boolean) =>
    request<{ isOnline: boolean; message: string }>(`/driver/${driverId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ isOnline }),
    // Normalise response: the driver page expects res.user.isOnline
    }).then(r => ({ user: { isOnline: r.isOnline } as User })),

  // Backend returns { requests }, we normalise to { rides }.
  // The backend answers 404 when the driver has no active vehicle yet. That is a normal
  // state for a new driver, not a failure, so it is reported as `noVehicle` instead.
  getPendingRides: (driverId: string) =>
    request<{ requests: Ride[] }>(`/ride-requests/pending?driverId=${driverId}`)
      .then(r => ({ noVehicle: false, rides: r.requests.map((req: any) => ({
        ...req,
        createdAt: req.createdAt ?? new Date().toISOString(),
        updatedAt: req.updatedAt ?? new Date().toISOString(),
      }))}))
      .catch(err => {
        if (err instanceof ApiError && err.status === 404) return { noVehicle: true, rides: [] as Ride[] };
        throw err;
      }),

  acceptRide: (rideId: string, driverId: string) =>
    request<{ message: string; ride: Ride }>(`/ride-requests/${rideId}/accept`, {
      method: 'POST',
      body: JSON.stringify({ driverId }),
    }),

  // Backend: GET /driver/rides/active?driverId=...
  // `totalEarnings` is the whole taka the passengers in this pool pay (what the driver earns).
  getActiveRides: (driverId: string) =>
    request<{ rides: Ride[]; poolSize: number; totalEarnings: number }>(`/driver/rides/active?driverId=${driverId}`)
      .then(r => ({
        poolSize: r.poolSize,
        totalEarnings: r.totalEarnings,
        rides: r.rides.map((ride: any) => ({
          ...ride,
          createdAt: ride.createdAt ?? new Date().toISOString(),
          updatedAt: ride.updatedAt ?? new Date().toISOString(),
        })),
      })),

  // Backend: GET /driver/rides/history?driverId=...
  getHistory: (driverId: string) =>
    request<{ rides: Ride[] }>(`/driver/rides/history?driverId=${driverId}`)
      .then(r => ({ rides: r.rides.map((ride: any) => ({
        ...ride,
        createdAt: ride.createdAt ?? new Date().toISOString(),
        updatedAt: ride.updatedAt ?? new Date().toISOString(),
      }))})),

  arrive: (rideId: string, driverId: string) =>
    request<{ ride: Ride }>(`/driver/rides/${rideId}/arrive`, {
      method: 'PATCH',
      body: JSON.stringify({ driverId }),
    }),

  start: (rideId: string, driverId: string) =>
    request<{ ride: Ride }>(`/driver/rides/${rideId}/start`, {
      method: 'PATCH',
      body: JSON.stringify({ driverId }),
    }),

  complete: (rideId: string, driverId: string) =>
    request<{ ride: Ride }>(`/driver/rides/${rideId}/complete`, {
      method: 'PATCH',
      body: JSON.stringify({ driverId }),
    }),

  cancel: (rideId: string, driverId: string) =>
    request<{ ride: Ride }>(`/driver/rides/${rideId}/cancel`, {
      method: 'PATCH',
      body: JSON.stringify({ driverId }),
    }),

  getPassengers: (rideId: string, driverId: string) =>
    request<{ passengers: Array<{ passengerId: string; seatCount: number; status: RideStatus }> }>(
      `/driver/rides/${rideId}/passengers?driverId=${driverId}`
    ),

  registerVehicle: (driverId: string, modelName: string, licensePlate: string, seatCapacity: number) =>
    request<{ vehicle: Vehicle }>('/vehicle', {
      method: 'POST',
      body: JSON.stringify({ driverId, modelName, licensePlate, seatCapacity }),
    }),

  // Backend: GET /vehicle/driver/:driverId  (returns 404 if no vehicle, treat as null)
  getVehicle: (driverId: string) =>
    request<{ vehicle: Vehicle }>(`/vehicle/driver/${driverId}`)
      .then(r => ({ vehicle: r.vehicle }))
      .catch(err => {
        // 404 means no vehicle registered yet — that's a valid empty state
        if (err instanceof ApiError && err.status === 404) return { vehicle: null };
        throw err;
      }),
};
