# Dhaka Tesla Pool MVP

## Tesla Pooling
This project supports ride-pooling. When drivers search for pending ride requests, they are filtered according to specific rules to ensure rides can be logically shared in a single vehicle.

### Pooling Matching Rule (direction-aware)
A `REQUESTED` ride is offered to a driver, and can be accepted onto their vehicle, when **all** of these hold:
1. **Seats** — the requested `seatCount` is at most the vehicle's free seats (`seatCapacity - occupiedSeats`).
2. **Not declined** — this driver has not declined the request.
3. **Private rides** — a private request (sharing off) needs a vehicle with no other passenger, and a vehicle carrying a private ride takes nobody.
4. **Route** — the request's route is compatible (below) with **every** ride already on the vehicle. The rides that count are those in `MATCHED`, `DRIVER_ARRIVED` **and `STARTED`**: a trip that is already under way still takes passengers (see *Mid-trip pooling*). An empty vehicle accepts any route.

The list the driver sees (`GET /ride-requests/pending`) and the accept route (`POST /ride-requests/:id/accept`) use the same function (`checkPoolJoin` in `server/src/utils/pooling.ts`), so they cannot disagree.

#### Route compatibility — the exact rule
No map service is used. Every zone has a fixed point on a grid (`x` grows east, `y` grows north, **1 unit ≈ 0.5 km**; `ZONE_COORDS` in `server/src/utils/routeDirection.ts`). Fares still use the distance table in `fareCalculator.ts`; the grid is only for direction.

| Zone | (x, y) | Zone | (x, y) |
|---|---|---|---|
| Uttara | (6, 32) | Mohakhali | (11, 11) |
| Mirpur | (4, 17) | Banani | (12, 14) |
| Mohammadpur | (2, 8) | Gulshan | (13, 14) |
| Dhanmondi | (5, 4) | Gulshan 1 | (14, 11) |
| Motijheel | (14, 1) | Badda | (15, 11) |

Take a route already in the pool, **A → B**, and a new request **C → D**. Let `u = B − A`, `v = D − C`, `w = C − A`, and write `u·v = ux·vx + uy·vy` (dot product), `u×w = ux·wy − uy·wx` (cross product), `|u|² = u·u`. The request is compatible with that route when **all four** hold:

1. **Same direction (at most 45° apart)** — `u·v > 0` **and** `2·(u·v)² ≥ |u|²·|v|²`
2. **Pickup inside the corridor** — `C` is at most 4 units (2 km) from the line through A and B: `(u×w)² ≤ 16·|u|²`
3. **The trips overlap** — measured along the road, C is before B and D is after A: `u·w < |u|²` **and** `u·(D − A) > 0`
4. **Not behind a started trip** — only if the route in the pool has `STARTED`: `u·w ≥ 0`. The car has already left A and cannot go back for someone behind it. (There is no live GPS, so "at or past the start of the started trip" is the closest safe test.)

An identical route always passes. The thresholds are the constants `MAX_ANGLE_DEGREES` (45, applied as the `2·dot² ≥ |u|²|v|²` form) and `CORRIDOR_UNITS` (4).

**Worked examples** — Nusrat's trip is **Mohakhali (11,11) → Badda (15,11)**, already `STARTED`: `u = (4,0)`, `|u|² = 16`.

| New request | v | Rule 1 (direction) | Rules 2–4 | Result |
|---|---|---|---|---|
| Mohakhali → Gulshan 1 | (3,0) | `u·v = 12`; `2·144 = 288 ≥ 16·9 = 144` ✓ | `w = (0,0)`: `u×w = 0`, `u·w = 0 < 16`, `u·(D−A) = 12 > 0` ✓ | **compatible** (shorter, same way) |
| Mohakhali → Badda | (4,0) | `u·v = 16`; `2·256 = 512 ≥ 256` ✓ | `w = 0` ✓ | **compatible** (identical) |
| Gulshan 1 → Badda | (1,0) | `u·v = 4`; `32 ≥ 16` ✓ | `w = (3,0)`: `u×w = 0`, `u·w = 12 < 16`, `u·(D−A) = 16 > 0`, `12 ≥ 0` ✓ | **compatible** (picked up part-way) |
| Banani → Gulshan | (1,0) | `u·v = 4`; `32 ≥ 16` ✓ | `w = (1,3)`: `u×w = 12`, `144 ≤ 16·16 = 256` ✓; `u·w = 4 < 16`; `u·(D−A) = 8 > 0` ✓ | **compatible** (parallel road, 1.5 km off) |
| Mohakhali → Gulshan | (2,3) | `u·v = 8`; `2·64 = 128 < 16·13 = 208` ✗ (56°) | — | rejected: direction |
| Mohakhali → Dhanmondi | (−6,−7) | `u·v = −24 < 0` ✗ | — | rejected: opposite way |
| Mohakhali → Uttara / Motijheel | (−5,21) / (3,−10) | ✗ | — | rejected: direction |
| Badda → Mohakhali | (−4,0) | `u·v < 0` ✗ | — | rejected: reverse trip |

Two more, for the other rules: with **Mohakhali → Gulshan 1** in the pool (`u = (3,0)`, `|u|² = 9`), a request **Gulshan 1 → Badda** has `w = (3,0)`, `u·w = 9 = |u|²`, so rule 3 fails (that passenger would be dropped off before this one is picked up). And with a **started Gulshan 1 → Badda** trip (`u = (1,0)`), a request **Mohakhali → Badda** has `w = (−3,0)`, `u·w = −3 < 0`: rule 4 rejects it (it would pass if that trip had not started). Before any trip starts, **Gulshan → Banani** and **Gulshan → Dhanmondi** still do not pool (`u = (−1,0)`, `v = (−8,−10)`, `2·64 = 128 < 164`).

### Mid-trip pooling
A ride that is `STARTED` keeps taking passengers, as long as their route is compatible and a seat is free.

1. Nusrat's ride starts (alone, fare locked at ৳180). Rafiq then requests Mohakhali → Gulshan 1.
2. While any of the driver's rides is `STARTED`, the driver's **Active** tab shows **Riders along your route** and re-reads `GET /ride-requests/pending` every **12 seconds** (plain polling, no websockets; it pauses while the browser tab is hidden). The response also carries `midTrip` (a ride is under way) and `availableSeats`, and each request carries `joinsMidTrip`.
3. The driver taps **Add to trip** (`POST /ride-requests/:id/accept`, the same route as before the trip) or **Decline** (`POST /ride-requests/:id/decline`, driver login required: the request stays open for other drivers and never shows to this driver again).
4. The new passenger becomes `MATCHED` and has their **own** lifecycle: `DRIVER_ARRIVED` → `STARTED` → `COMPLETED`, independent of Nusrat. When someone completes, their seat is freed and the next compatible request can take it.
5. Shirin later requests Mohakhali → Badda: not identical to Rafiq's destination, but the same direction (the check runs against every ride on the vehicle), so she is offered too if a seat is left.

**Fares mid-trip** follow the existing lock rule: Nusrat's `STARTED` fare never changes. A passenger who joins pays the shared rate for the pool they join, from their own base fare: Rafiq joins a pool of 2 → 70% of ৳180 = **৳125**. If Shirin then joins (pool of 3) she pays 55% of ৳180 = **৳100**, and Rafiq, who has not started yet, is re-priced to ৳100; Nusrat stays ৳180. So passengers on the same trip can pay different amounts.

**Lifecycle history.** Every status change writes a permanent `RideEvents` row in the same transaction (who acted, the new status, the pool size, and `ridersOnboard`: how many passengers were already `STARTED` on the vehicle, not counting this one). A `MATCHED` event with `ridersOnboard > 0` is a mid-trip join. Drivers read it at `GET /driver/rides/timeline` (first names only, oldest first); each passenger's own ride (`GET /passenger/rides/:id`, `/active`, `/history`) carries only their own `timeline` and `joinedMidTrip`.

**Privacy.** Joining mid-trip reveals nothing extra: a passenger's responses contain only their own fare, route and history, plus the other passengers' **first names**. They never contain another passenger's fare, route, phone or id. `GET /ride-requests/me` and `/ride-requests/:id/pool-info` now require the passenger's login, like the `/passenger` routes.

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
- **The fare is locked when a ride becomes `STARTED`.** Nothing that happens in the pool afterwards changes what that passenger pays (someone joining mid-trip, see *Mid-trip pooling*, or a later cancellation only re-prices the passengers who have not started yet). Finishing a trip does not re-price anyone.
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
The vehicle's capacity is never exceeded, before or during a trip, even when near-simultaneous requests claim the last seat. Accepting a ride runs in one **immediate** database transaction: it takes SQLite's write lock up front, so two accepts for the same vehicle run one after the other, and the second re-reads the rides on the vehicle (including any `STARTED` one) and re-checks route compatibility under that lock. The seat claim is an **Optimistic Concurrency Atomic Update**: an `UPDATE` increments `occupiedSeats` with a `WHERE` constraint `seatCapacity >= occupiedSeats + requestedSeats`. If it changes 0 rows, capacity was exceeded by a concurrent transaction and the operation aborts before the ride is marked accepted. Mid-trip joining uses this exact same route and seat claim; there is no second copy of the logic.

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
