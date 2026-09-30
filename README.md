# Dhaka Tesla Pool MVP

## Tesla Pooling
This project supports ride-pooling. When drivers search for pending ride requests, they are filtered according to specific rules to ensure rides can be logically shared in a single vehicle.

### MVP Pooling Matching Rule
To determine whether a new ride request can be added to an existing vehicle's pool, the following conditions must be met:
1. The request status must be `REQUESTED` (not yet accepted by anyone).
2. The requested `seatCount` must be less than or equal to the vehicle's remaining available seats (`seatCapacity - occupiedSeats`).
3. If the vehicle already has active pooled requests, the new request **MUST** have the exact same `pickupZone` and `destinationZone` to be eligible to share the pool (simplified matching, no map routing).
4. The pool must not have reached the `STARTED` status (no new passengers can join once the trip begins).
5. If the vehicle's pool is currently empty, any route is considered valid.

### Fare Model
Passengers who share a Tesla each pay a **smaller share of their own fare**, and the driver earns more in total. Fares are **whole taka (integers, never paisa), rounded to the nearest ৳5**.

`passengerFare = baseFare × shareRate`

- **baseFare** is the passenger's *own* fare for their own pickup → destination when riding alone: `100 + distanceKm × 20 × seatCount`. It is set when the ride is requested and never changes. (Mohakhali → Badda is 4 km, so ৳180.)
- **shareRate** depends on how many passengers are in the pool (including this one):

| Passengers in the pool | Each pays | Driver earns (base ৳100) | Driver earns (base ৳180) |
|---|---|---|---|
| 1 | 100% | ৳100 | ৳180 |
| 2 | 70% | ৳70 + ৳70 = **৳140** | ৳125 + ৳125 = **৳250** |
| 3 | 55% | ৳55 × 3 = **৳165** | ৳100 × 3 = **৳300** |

  (A base of ৳100 gives exactly ৳70 and ৳55. ৳180 × 70% = ৳126 → **৳125** and ৳180 × 55% = ৳99 → **৳100** after rounding to the nearest ৳5, halves round up.) A pool larger than 3 keeps the 3-passenger rate.
- The driver's earnings for a ride are the **sum of what its passengers pay**.

**Rules**
- **Each passenger is priced from their own base fare.** Pooled passengers can have different destinations: Nusrat (Mohakhali → Badda, base ৳180) and Rafiq (Mohakhali → Gulshan, base ৳160) pay ৳125 and ৳110 when they share, and the driver earns ৳235.
- **Everyone is re-priced whenever the pool changes**: when a passenger is accepted onto the vehicle, when a passenger cancels, and when the driver cancels a passenger. The savings are stored as `poolDiscount` (`baseFare − estimatedFare`).
- **The fare is locked when a ride becomes `STARTED`.** Nothing that happens in the pool afterwards changes what that passenger pays (no one can join a started trip, and a later cancellation only re-prices the passengers who have not started yet). Finishing a trip does not re-price anyone.
- **Private rides (sharing off) always pay 100%** and are never pooled.

**What each side sees**
- **Passenger** — only their own fare, e.g. `৳125 (shared, you save ৳55)`; it refreshes on its own while the ride is open and shows 🔒 *Fare locked* once the trip starts. The **Request Ride** page shows the price alone and what it drops to with 2 and 3 passengers (`GET /ride-requests/estimate` returns `baseFare`, `fare`, `poolFare` and `tiers`). A private ride, or a booking that fills the whole car, has no drop.
- **Driver** — the **total earnings for the ride** on the Active tab (`GET /driver/rides/active` returns `poolSize` and `totalEarnings`).
- API money fields (`baseFare`, `estimatedFare`, `poolDiscount`, `fare`, `totalEarnings`) are whole taka; rides carry `fareLocked`, and a passenger's own ride also carries `poolSize` and `shareRatePercent`.

#### Worked Example — the seed data
`npm run seed` creates Jashim (driver, **Bullet**, 3 seats) and Nusrat, Rafiq and Shirin, who each request **Mohakhali → Badda** (base ৳180). Log in as Jashim, go online and accept them one by one:

| Jashim accepts | Each passenger pays | Jashim earns |
|---|---|---|
| Nusrat | ৳180 | ৳180 |
| + Rafiq | ৳125 each (saves ৳55) | ৳250 |
| + Shirin | ৳100 each (saves ৳80) | ৳300 |
| Shirin cancels | back to ৳125 each | ৳250 |
| Nusrat's trip starts | Nusrat's ৳125 is locked | — |

#### Upgrading an existing database
Fares used to be stored as integer paisa with a flat ৳30 pool discount. On startup the server converts stored fares to whole taka once (dividing by 100 and rounding to ৳5), re-prices any pool that has not started, and records this in the database's `user_version` so it never runs twice. A copy of the database file is saved next to it first (`database.sqlite.pre-taka-migration.bak`).

### Concurrency Guarantee
To ensure the vehicle's capacity is never exceeded when near-simultaneous claims are made for the last seat, we rely on a database transaction with an **Optimistic Concurrency Atomic Update**.
When a ride is accepted, an atomic `UPDATE` query increments `occupiedSeats`, but with a `WHERE` constraint enforcing `seatCapacity >= occupiedSeats + requestedSeats`. If this returns 0 affected rows, it indicates capacity was exceeded by a concurrent transaction, and the operation safely aborts before marking the ride request as accepted.

## Passenger Cancellation Policy

Passengers may cancel their ride only while it is in one of these states:

| Status | Passenger can cancel? | Reason |
|---|---|---|
| `REQUESTED` | ✅ Yes | No driver has committed yet. Zero cost. |
| `MATCHED` | ✅ Yes | Driver assigned but not yet physically en-route. Passenger can still back out. |
| `DRIVER_ARRIVED` | ❌ No | Driver has made the physical trip to the pickup point. Cancelling here unfairly penalises the driver. |
| `STARTED` | ❌ No | Trip is in progress. Cannot cancel. |
| `COMPLETED` | ❌ No | Terminal state — cannot undo. |
| `CANCELLED` | ❌ No | Already cancelled. |

## Ride Status Page (Passenger)

The passenger's **Active Rides** tab is the ride status page. Once a driver accepts the ride it shows:

- **Driver & vehicle** — the driver's name and photo (a placeholder when they have none), their phone number with a tap-to-call button (`tel:` link), and the vehicle as `Bullet · DTP-0001` (nickname · Tesla ID).
- **Pool** — `Shared ride · 1 other passenger` or `Just you`, seats taken (`2 of 3 seats taken`), and the other passengers by **first name only**.
- **Progress** — a step tracker, Matched → Driver Arrived → Started → Completed, with the current step highlighted; a waiting message while the ride is still `REQUESTED`; and a clear notice when it is `CANCELLED`.
- **Fare** — the passenger's own fare only, e.g. `৳70 (shared, you save ৳30)`, with a **🔒 Fare locked** label once the ride has `STARTED`.
- **Cancel** — the button appears only while the passenger may cancel (`REQUESTED` or `MATCHED`; see the cancellation table above).

The page **polls `GET /passenger/rides/:id` every 5 seconds** (plain polling, no websockets), so the passenger sees someone joining or leaving, the driver arriving and fare changes without reloading. Polling stops for good once the ride is `COMPLETED` or `CANCELLED`, and pauses while the browser tab is hidden. There is no live GPS tracking.

**What the API will and will not tell a passenger**

| | Shown | Never shown |
|---|---|---|
| Driver | name, photo URL, Tesla ID | — |
| Driver phone | only while the ride is in progress (`MATCHED`, `DRIVER_ARRIVED`, `STARTED`) | while it is still `REQUESTED`; after the ride is completed or cancelled |
| Other passengers | first name | phone number, fare, destination, surname, ids |
| Fare | the passenger's own | anyone else's |

## Passenger Data Isolation

A passenger can only reach their own rides. Every `/passenger/rides` route (active, history, one ride, cancel) requires a login and acts as the **logged-in passenger**: the caller is identified by their token, never by an id they send. A `passengerId` that is not the caller's, or a ride that belongs to someone else, gets **403**; a ride that does not exist gets **404**; no login gets **401**; a driver's login is refused (403). The routes were tightened together with the ride status details above, because a forgeable id would now expose a driver's phone number and co-passengers' names.
