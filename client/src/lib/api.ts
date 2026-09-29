// ─── Typed API client ──────────────────────────────────────────────────────
// All calls go through this module so the base URL is always consistent.

const BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, data.error || `HTTP ${res.status}`);
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
  role: Role;
  isOnline?: boolean;
}

export interface Ride {
  id: string;
  pickupZone: string;
  destinationZone: string;
  seatCount: number;
  estimatedFare: number;
  estimatedFareBDT: string;
  status: RideStatus;
  canCancel?: boolean;
  vehicle?: {
    id: string;
    modelName: string;
    licensePlate: string;
    seatCapacity: number;
    occupiedSeats?: number;
  } | null;
  driverId?: string;
  vehicleId?: string;
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
  signup: (name: string, email: string, password: string, role: Role) =>
    request<{ token: string; user: User }>('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ name, email, password, role }),
    }),

  login: (email: string, password: string) =>
    request<{ token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
};

// ─── Passenger APIs ──────────────────────────────────────────────────────────

export const DHAKA_ZONES = [
  'Mirpur', 'Gulshan', 'Dhanmondi', 'Motijheel', 'Uttara',
  'Banani', 'Mohammadpur', 'Rayer Bazar', 'Wari', 'Old Dhaka',
  'Shyamoli', 'Farmgate', 'Tejgaon', 'Badda', 'Khilgaon',
];

export const passengerApi = {
  requestRide: (passengerId: string, pickupZone: string, destinationZone: string, seatCount: number) =>
    request<{ rideRequest: Ride }>('/ride-requests', {
      method: 'POST',
      body: JSON.stringify({ passengerId, pickupZone, destinationZone, seatCount }),
    }).then(res => ({ ride: res.rideRequest })),

  getActiveRides: (passengerId: string) =>
    request<{ rides: Ride[] }>(`/passenger/rides/active?passengerId=${passengerId}`),

  getRide: (rideId: string, passengerId: string) =>
    request<{ ride: Ride }>(`/passenger/rides/${rideId}?passengerId=${passengerId}`),

  getHistory: (passengerId: string) =>
    request<{ rides: Ride[] }>(`/passenger/rides/history?passengerId=${passengerId}`),

  cancelRide: (rideId: string, passengerId: string) =>
    request<{ message: string; status: string }>(`/passenger/rides/${rideId}/cancel`, {
      method: 'PATCH',
      body: JSON.stringify({ passengerId }),
    }),
};

// ─── Driver APIs ─────────────────────────────────────────────────────────────

export const driverApi = {
  // Backend: PUT /driver/:id/status  { isOnline: boolean }
  setOnlineStatus: (driverId: string, isOnline: boolean) =>
    request<{ isOnline: boolean; message: string }>(`/driver/${driverId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ isOnline }),
    // Normalise response: the driver page expects res.user.isOnline
    }).then(r => ({ user: { isOnline: r.isOnline } as User })),

  // Backend returns { requests }, we normalise to { rides }
  getPendingRides: (driverId: string) =>
    request<{ requests: Ride[] }>(`/ride-requests/pending?driverId=${driverId}`)
      .then(r => ({ rides: r.requests.map((req: any) => ({
        ...req,
        estimatedFareBDT: (req.estimatedFare / 100).toFixed(2),
        createdAt: req.createdAt ?? new Date().toISOString(),
        updatedAt: req.updatedAt ?? new Date().toISOString(),
      }))})),

  acceptRide: (rideId: string, driverId: string) =>
    request<{ message: string; ride: Ride }>(`/ride-requests/${rideId}/accept`, {
      method: 'POST',
      body: JSON.stringify({ driverId }),
    }),

  // Backend: GET /driver/rides/active?driverId=...
  getActiveRides: (driverId: string) =>
    request<{ rides: Ride[] }>(`/driver/rides/active?driverId=${driverId}`)
      .then(r => ({ rides: r.rides.map((ride: any) => ({
        ...ride,
        estimatedFareBDT: ride.estimatedFareBDT ?? (ride.estimatedFare / 100).toFixed(2),
        createdAt: ride.createdAt ?? new Date().toISOString(),
        updatedAt: ride.updatedAt ?? new Date().toISOString(),
      }))})),

  // Backend: GET /driver/rides/history?driverId=...
  getHistory: (driverId: string) =>
    request<{ rides: Ride[] }>(`/driver/rides/history?driverId=${driverId}`)
      .then(r => ({ rides: r.rides.map((ride: any) => ({
        ...ride,
        estimatedFareBDT: ride.estimatedFareBDT ?? (ride.estimatedFare / 100).toFixed(2),
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
