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
    request<{ ride: Ride }>('/ride-request', {
      method: 'POST',
      body: JSON.stringify({ passengerId, pickupZone, destinationZone, seatCount }),
    }),

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
  setOnlineStatus: (driverId: string, isOnline: boolean) =>
    request<{ user: User }>('/driver/status', {
      method: 'PATCH',
      body: JSON.stringify({ driverId, isOnline }),
    }),

  getPendingRides: (driverId: string) =>
    request<{ rides: Ride[] }>(`/ride-request/pending?driverId=${driverId}`),

  acceptRide: (rideId: string, driverId: string) =>
    request<{ message: string; ride: Ride }>(`/ride-request/${rideId}/accept`, {
      method: 'PATCH',
      body: JSON.stringify({ driverId }),
    }),

  getActiveRides: (driverId: string) =>
    request<{ rides: Ride[] }>(`/driver/active?driverId=${driverId}`),

  getHistory: (driverId: string) =>
    request<{ rides: Ride[] }>(`/driver/history?driverId=${driverId}`),

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

  getVehicle: (driverId: string) =>
    request<{ vehicle: Vehicle | null }>(`/vehicle?driverId=${driverId}`),
};
