# Dhaka Tesla Pool MVP

## Tesla Pooling
This project supports ride-pooling. When drivers search for pending ride requests, they are filtered according to specific rules to ensure rides can be logically shared in a single vehicle.

### Pooling Matching Rule (direction-aware)
A `REQUESTED` ride is offered to a driver, and can be accepted onto their vehicle, when **all** of these hold:
1. **Seats** — the requested `seatCount` is at most the vehicle's free seats (`seatCapacity - occupiedSeats`).
2. **Not declined** — this driver has not declined the request.
3. **Private rides** — a private request (sharing off) needs a vehicle with no other passenger, and a vehicle carrying a private ride takes nobody.
4. **Route** — the request fits the rides already on the vehicle (`MATCHED`, `DRIVER_ARRIVED`, `STARTED`), using **Rule A** for rides that have not started and the stricter **Rule B** if any ride is `STARTED` (a trip under way still takes passengers, see *Mid-trip pooling*). An empty vehicle accepts any route.

A request that fails any of these is **filtered out**: it is not in `GET /ride-requests/pending` (so it never shows in the Pending Requests tab or the mid-trip "Riders along your route" panel) and `POST /ride-requests/:id/accept` refuses it with 409. Both use the same function (`checkPoolJoin` in `server/src/utils/pooling.ts`), so they cannot disagree.

#### The zone grid
No map service is used. Every zone has a fixed point on a grid (`x` grows east, `y` grows north, **1 unit ≈ 0.5 km**; `ZONE_COORDS` in `server/src/utils/routeDirection.ts`). Fares still use the distance table in `fareCalculator.ts`; the grid is only for direction.

| Zone | (x, y) | Zone | (x, y) |
|---|---|---|---|
| Uttara | (6, 32) | Mohakhali | (11, 11) |
| Mirpur | (4, 17) | Banani | (12, 14) |
| Mohammadpur | (2, 8) | Gulshan | (13, 14) |
| Dhanmondi | (5, 4) | Gulshan 1 | (14, 11) |
| Motijheel | (14, 1) | Badda | (15, 11) |

Notation: `u·v = ux·vx + uy·vy` (dot product), `u×w = ux·wy − uy·wx` (cross product), `|u|² = u·u`. **"Same direction"** always means the angle between two routes is at most 45°: `u·v > 0` **and** `2·(u·v)² ≥ |u|²·|v|²`. **"Within d units of the line"** for a road with direction `u` and a point at offset `w` from its start means `(u×w)² ≤ d²·|u|²`.

#### Rule A — rides that have not started
For a route already in the pool, **A → B**, and a new request **C → D** (`u = B − A`, `v = D − C`, `w = C − A`), all three must hold, against **every** such ride:
1. **Same direction** — angle between `u` and `v` at most 45°.
2. **Pickup in the corridor** — `C` within 4 units (2 km) of the line through A and B: `(u×w)² ≤ 16·|u|²`.
3. **The trips overlap** — `u·w < |u|²` **and** `u·(D − A) > 0` (C is before B, D is after A).

An identical route always passes. Before any trip starts, **Gulshan → Banani** and **Gulshan → Dhanmondi** do not pool (`u = (−1,0)`, `v = (−8,−10)`, `2·64 = 128 < 164`), while **Mohakhali → Badda** and **Mohakhali → Gulshan 1** do.

#### Rule B — a trip under way (at least one ride is `STARTED`)
There is no live GPS, so the vehicle's road is worked out from the passengers on board (the `STARTED` rides):

- **P, the current position** = the pickup zone of the **most recently started** onboard ride. The car has at least reached the last place it picked someone up. (Order comes from the `STARTED` event in the lifecycle history.)
- **F, the final destination** = the destination of an onboard ride that is **farthest from P** (squared grid distance; the first wins a tie).
- `u = F − P` is the road still ahead. For a request **C → D**: `v = D − C`, `w = C − P`.

A request is offered only if **both (a) and (b)** hold:

**(a) The pickup is on the road ahead, with no significant detour**
- a1. not behind the car: `u·w ≥ 0`
- a2. not at or past the end: `u·w < |u|²`
- a3. at most 2 units (**1 km**) from the line P → F: `(u×w)² ≤ 4·|u|²`

**(b) The destination continues the same way as the passengers on board**
- b1. same direction (≤ 45°) as **every** onboard passenger's own route (their pickup → destination)
- b2. within 4 units (**2 km**) of the line P → F, whether before F or beyond it: `(u×(D − P))² ≤ 16·|u|²`

The constants are `ONBOARD_PICKUP_CORRIDOR_UNITS` (2), `ONBOARD_DESTINATION_CORRIDOR_UNITS` (4) and `CORRIDOR_UNITS` (4, Rule A); the 45° is built into the `2·dot² ≥ |u|²|v|²` form. Rides in `MATCHED` / `DRIVER_ARRIVED` on the same vehicle are additionally checked with Rule A.

**Worked examples for Rule B** — Nusrat (Mohakhali → Badda) is `STARTED` alone: `P = (11,11)`, `F = (15,11)`, `u = (4,0)`, `|u|² = 16`.

| New request | Check | Result |
|---|---|---|
| Mohakhali → Gulshan 1 | `v = (3,0)`: `u·v = 12`, `288 ≥ 144` ✓. `w = (0,0)`: `0 ≤ 0 < 16` ✓, offset 0 ✓. `D−P = (3,0)`: offset 0 ✓ | **shown** (shorter, same way) |
| Mohakhali → Badda | identical | **shown** |
| Gulshan 1 → Badda | `v = (1,0)` ✓. `w = (3,0)`: `u·w = 12`, `0 ≤ 12 < 16` ✓, offset 0 ✓ | **shown** (picked up part-way) |
| Banani → Gulshan | `v = (1,0)` ✓. `w = (1,3)`: `u·w = 4` ✓ but `u×w = 12`, `144 > 4·16 = 64` ✗ (1.5 km off) | hidden: detour (it *is* allowed before the trip starts, Rule A) |
| Mohakhali → Gulshan | `v = (2,3)`: `u·v = 8`, `128 < 16·13 = 208` ✗ (56°) | hidden: direction |
| Mohakhali → Dhanmondi | `v = (−6,−7)`: `u·v = −24 < 0` ✗ | hidden: opposite way |
| Badda → Gulshan 1 | `v = (−1,0)`: `u·v < 0` ✗ | hidden: reverse |

More cases (for the other checks):
- **Behind the car (a1):** Rafiq boards at Gulshan 1 and his ride starts. Now `P = (14,11)`, `F = (15,11)`, `u = (1,0)`. **Mohakhali → Badda** has `w = (−3,0)`, `u·w = −3 < 0` → hidden. **Gulshan 1 → Badda** (`w = 0`) is still shown.
- **Past the end (a2):** only Rafiq (Mohakhali → Gulshan 1) is on board, `u = (3,0)`, `|u|² = 9`. **Gulshan 1 → Badda** has `w = (3,0)`, `u·w = 9 = |u|²` → hidden (he is dropped off where this rider would be picked up).
- **Destination drifts (b2):** Nusrat rides **Mohakhali → Banani**: `P = (11,11)`, `u = (1,3)`, `|u|² = 10`. **Mohakhali → Uttara** has `v = (−5,21)`, `u·v = 58`, `2·3364 = 6728 ≥ 10·466 = 4660` (within 45° ✓), but `u×(D−P) = 1·21 − 3·(−5) = 36`, `1296 > 16·10 = 160` → hidden: it leaves the road even though it starts on it.

### Mid-trip pooling
A ride that is `STARTED` keeps taking passengers, as long as their route is compatible and a seat is free.

1. Nusrat's ride starts (alone). Rafiq then requests a ride along the same road. Only requests that pass Rule B are listed: the rest never reach the driver.
2. While any of the driver's rides is `STARTED`, the driver's **Pending Requests** tab (and the **Riders along your route** panel on the Active tab) re-reads `GET /ride-requests/pending` every **12 seconds** (plain polling, no websockets; it pauses while the browser tab is hidden). The response also carries `midTrip` (a ride is under way) and `availableSeats`, and each request carries `joinsMidTrip`.
3. The driver taps **Add to trip** (`POST /ride-requests/:id/accept`, the same route as before the trip) or **Decline** (`POST /ride-requests/:id/decline`, driver login required: the request stays open for other drivers and never shows to this driver again).
4. The new passenger becomes `MATCHED` and has their **own** lifecycle: `DRIVER_ARRIVED` → `STARTED` (this is when they board) → `COMPLETED`, independent of Nusrat. When someone completes, their seat is freed and the next compatible request can take it.
5. Shirin later requests the same way but to a different destination: the same direction (the check runs against every ride on the vehicle), so she is offered too if a seat is left.

**Fares mid-trip** are priced by segments, see *Fare Model*: each passenger pays full price for the stretches they ride alone and the discounted price for the stretches when others are on board, so a passenger who boards mid-trip only pays the shared rate from where they boarded.

**Lifecycle history.** Every status change writes a permanent `RideEvents` row in the same transaction (who acted, the new status, the pool size, and `ridersOnboard`: how many passengers were already `STARTED` on the vehicle, not counting this one). A `MATCHED` event with `ridersOnboard > 0` is a mid-trip join. Drivers read it at `GET /driver/rides/timeline` (first names only, oldest first); each passenger's own ride (`GET /passenger/rides/:id`, `/active`, `/history`) carries only their own `timeline` and `joinedMidTrip`.

**Privacy.** Joining mid-trip reveals nothing extra: a passenger's responses contain only their own fare, route and history, plus the other passengers' **first names**. They never contain another passenger's fare, route, phone or id. `GET /ride-requests/me` and `/ride-requests/:id/pool-info` now require the passenger's login, like the `/passenger` routes.

### Fare Model — checkpoint-based segment pricing
Passengers who share a Tesla pay less **for the stretches they actually share**, and the driver earns more in total. Fares are **whole taka (integers, never paisa), rounded to the nearest ৳5**. There is no fare lock at `STARTED` any more: a passenger's fare is **settled when their own journey ends**.

**Checkpoints.** A `PoolCheckpoint` (zone, timestamp, active-passenger count) is written whenever the number of passengers on a vehicle changes during a trip:

| Event | Checkpoint | Count |
|---|---|---|
| A ride `STARTED` with nobody else on board | at its **pickup zone** (`TRIP_STARTED`) | 1 |
| A passenger boards mid-trip (their ride `STARTED` while others are on board) | at the zone where they **boarded** (`PASSENGER_JOINED`) | previous + 1 |
| A passenger leaves mid-trip (`CANCELLED_IN_TRANSIT`) | at their **cancellation zone** (`PASSENGER_LEFT`) | previous − 1 |
| A passenger reaches their destination (`COMPLETED`) | at their **destination** (`PASSENGER_DROPPED_OFF`) | previous − 1 |

The last row is not in the original list of events, but a drop-off changes who is on board exactly like a cancellation does, so the next stretch has to be priced with one fewer passenger. The count is the number of rides on the vehicle that are `STARTED`. `runId` groups one continuous run of a vehicle: it begins when someone boards an empty vehicle and ends when the count returns to 0; a later trip is a new run and is never mixed in.

**The formula.** When a passenger's own journey ends (`COMPLETED` or `CANCELLED_IN_TRANSIT`), walk the checkpoints from where **they** boarded to where **they** got off. Each consecutive pair is a segment `zoneA → zoneB`, with `n` = the count at its first checkpoint:

- `distanceCharge = distanceKm(zoneA → zoneB) × ৳20 × seats`
- `charge = distanceCharge × shareRate(n)`, with `shareRate`: **1 passenger 100%**, **2 → 70%**, **3 or more → 55%** (so the discount only applies when `n > 1`; a private ride is always 100%)
- **`fare = ৳100 base fare (once) + Σ charge`**, rounded to the nearest ৳5 (halves up)
- `poolDiscount = (৳100 + Σ distanceCharge, rounded) − fare`: what pooling saved on the stretches they travelled

The ৳100 base fare is charged once and is **never discounted**. Two checkpoints in the same zone are 0 km apart and cost nothing. Distances come from the zone table in `fareCalculator.ts`, so hopping via a zone costs the sum of the hops (see the assumptions below).

**Worked example — solo for one hop, then pooled for the next.** Zone distances: Uttara–Mirpur **9 km**, Mirpur–Dhanmondi **7 km**. Nusrat rides Uttara → Dhanmondi and starts alone; Rafiq is accepted mid-trip and boards at Mirpur, going to Dhanmondi; both are dropped at Dhanmondi (Nusrat first).

| Checkpoint | Zone | On board |
|---|---|---|
| Nusrat's trip starts | Uttara | 1 |
| Rafiq boards | Mirpur | 2 |
| Nusrat is dropped | Dhanmondi | 1 |
| Rafiq is dropped | Dhanmondi | 0 |

| | Segment | Distance charge | On board | Charge |
|---|---|---|---|---|
| **Nusrat** | Uttara → Mirpur | 9 × 20 = ৳180 | 1 → 100% | **৳180** |
| | Mirpur → Dhanmondi | 7 × 20 = ৳140 | 2 → 70% | **৳98** |
| | **fare** = 100 + 180 + 98 = 378 → **৳380** | (alone all the way: 100 + 320 = ৳420) | | pooling saved ৳40 |
| **Rafiq** | Mirpur → Dhanmondi | 7 × 20 = ৳140 | 2 → 70% | **৳98** |
| | **fare** = 100 + 98 = 198 → **৳200** | (alone: 100 + 140 = ৳240) | | pooling saved ৳40 |

The driver earns ৳380 + ৳200 = **৳580**. Before Rafiq boards, Nusrat's running fare is the solo ৳420; once he boards it drops to ৳380.

**A passenger who was pooled from the start** pays the discount for the whole trip: if Nusrat and Rafiq both board at Mohakhali for Badda (4 km, ৳80 distance charge), each pays 100 + 80 × 70% = 156 → **৳155** (three on board: 100 + 44 = 144 → **৳145**). A 0 km stretch (the moment between two people boarding in the same zone) costs nothing.

**Leaving mid-trip is just another checkpoint.** If Nusrat asks to be dropped at Mohammadpur (Mirpur–Mohammadpur 5 km) after Rafiq boarded: her segments are Uttara → Mirpur ৳180 alone + Mirpur → Mohammadpur ৳100 × 70% = ৳70, so she pays 100 + 180 + 70 = **৳350**, not the ৳380 she was on track for. Rafiq, who rides on to Dhanmondi, then pays for Mirpur → Mohammadpur (৳70, shared) and Mohammadpur → Dhanmondi (3 km, ৳60, now alone): 100 + 70 + 60 = **৳230**.

**What the fare is before the journey ends.** `estimatedFare` is an estimate, and `fareFinal` (in the API) is `false` until the passenger's own journey ends:
- *Not on board yet* (`MATCHED`, `DRIVER_ARRIVED`): what they would pay if the pool now on the vehicle stayed together for the whole route, `100 + distanceCharge × shareRate(pool size)`. The **Request Ride** page shows the price alone and with 2 and 3 passengers (`GET /ride-requests/estimate` returns `baseFare`, `fare`, `poolFare` and `tiers`).
- *On board* (`STARTED`): the checkpoint walk so far, plus the rest of the way to their destination with whoever is on board now. It is refreshed whenever someone boards or gets off.
- *Ended*: the final, settled fare. Nothing that happens afterwards changes it (`recalculatePoolFares` never touches a finished ride).

**Rules and assumptions**
- Each passenger is priced from **their own** pickup, exit and boarding time; pooled passengers can pay different amounts. The driver earns the **sum of what their passengers pay**.
- **Stated assumptions.** (1) A hop through an intermediate zone is priced with the zone table, which is not geometric, so it can differ from the direct distance (Mirpur–Mohammadpur 5 km + Mohammadpur–Dhanmondi 3 km = 8 km, against Mirpur–Dhanmondi 7 km). (2) Rounding is done once, on the total, so a segment's `charge` is exact and only the fare is rounded. (3) A ride that started before checkpoints existed has no boarding checkpoint and simply keeps the fare it already had.
- `baseFare` stays the passenger's own **solo fare for the whole route** (`100 + distanceKm × 20 × seats`), set at request time; `poolDiscount` is what pooling saved (`baseFare − estimate` before the journey ends, `soloFare − fare` on the stretches travelled after it).
- **Private rides (sharing off) always pay 100%** and are never pooled.

**What each side sees**
- **Passenger** — only their own fare, e.g. `৳155 (shared, you save ৳25)`. While on board it is marked *≈ estimate*; once their journey ends it shows *✓ Final fare*, with **how it was worked out** (`fareBreakdown`: the ৳100 base and each stretch's km, passengers on board, rate and charge). The breakdown deliberately leaves out **zone names**: the checkpoints between a passenger's boarding and exit are where *other* passengers boarded or got off.
- **Driver** — the **total earnings for the ride** on the Active tab (`GET /driver/rides/active` returns `poolSize` and `totalEarnings`, a running estimate) and each passenger's settled fare, cancellation zone and pre-exit estimate in the pool history.
- API money fields (`baseFare`, `estimatedFare`, `poolDiscount`, `fare`, `totalEarnings`) are whole taka; rides carry `fareFinal`, and a passenger's own ride also carries `poolSize`, `shareRatePercent` and `fareBreakdown`.

#### Worked Example — the seed data
`npm run seed` creates Jashim (driver, **Bullet**, 3 seats) and Nusrat, Rafiq and Shirin, who each request **Mohakhali → Badda** (4 km: solo ৳180). Log in as Jashim, go online and accept them one by one (before the trip starts everyone is quoted as if the pool stays together):

| Jashim accepts | Each passenger pays (quote) | Jashim earns |
|---|---|---|
| Nusrat | ৳180 | ৳180 |
| + Rafiq | 100 + 56 = ৳155 each (saves ৳25) | ৳310 |
| + Shirin | 100 + 44 = ৳145 each (saves ৳35) | ৳435 |
| Shirin cancels | back to ৳155 each | ৳310 |
| Nusrat's trip starts (alone in the car) | Nusrat's running fare is ৳180 until Rafiq boards | — |

#### Upgrading an existing database
Fares used to be stored as integer paisa with a flat ৳30 pool discount. On startup the server converts stored fares to whole taka once (dividing by 100 and rounding to ৳5), re-prices any pool that has not started, and records this in the database's `user_version` so it never runs twice. A copy of the database file is saved next to it first (`database.sqlite.pre-taka-migration.bak`). The new `PoolCheckpoints` table is created automatically at startup; rides that were already `STARTED` before the upgrade have no boarding checkpoint, so they keep the fare they had. The cancellation columns are added by an idempotent startup migration (`RideEvents.lockedFare`, from an earlier version of this work, is renamed `fullTripEstimate`).

### Concurrency Handling

**The problem.** Jashim's Bullet has one seat left. Rafiq's request and Shirin's request are both compatible, and two accept calls arrive at the same instant. A naive server reads "1 seat free" twice, says yes twice, and Bullet ends up carrying 4 people in 3 seats. This section explains exactly how the code prevents that, where else the same idea is used, and what would have to change at a larger scale.

#### How two accepts for the last seat are resolved
All of it is in `POST /ride-requests/:id/accept` (`server/src/routes/rideRequest.ts`), and the mid-trip join uses this same route, so there is one copy of the logic.

1. **One transaction that takes the write lock first.** The accept runs inside `sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE })`, which sends `BEGIN IMMEDIATE`. SQLite allows only one writer at a time, and `IMMEDIATE` grabs that write lock at the very start instead of when the first write happens. So two accepts cannot interleave: the second one waits until the first has committed or rolled back, and only then starts reading.
2. **Read the pool inside the lock.** Because it waits its turn, the second accept sees the vehicle *after* the first one finished: the new passenger is already on board and `occupiedSeats` is already updated. The "may this passenger join?" check (`checkPoolJoin`: private rides, route direction, mid-trip road ahead) therefore runs against the true current pool, not a stale copy.
3. **The seat claim is a single conditional `UPDATE`.** This is the actual guard:

   ```sql
   UPDATE Vehicles SET occupiedSeats = occupiedSeats + :seats
   WHERE id = :vehicle AND seatCapacity >= occupiedSeats + :seats
   ```

   The condition and the increment are one statement, so there is no gap between "check" and "act". If the number of rows changed is **0**, the seats were not there: the code throws `CAPACITY_EXCEEDED`, the whole transaction rolls back (nothing is half-applied), and the caller gets **409 "Not enough seats available."** The rejected request stays `REQUESTED`, so another driver can still take it.
4. **The request itself is claimed atomically.** The same transaction runs `UPDATE RideRequests SET status = 'MATCHED', ... WHERE id = :ride AND status = 'REQUESTED'`. If two *drivers* accept the same request, only one update changes a row; the other gets `ALREADY_TAKEN` (409) and its seat claim is rolled back with it.
5. **Everything commits together**: seat count, ride status, fare re-estimate and the history event, or none of it.

Two things make this hold up: the write lock makes the accepts run one after the other, and the conditional `UPDATE` keeps capacity correct even if the lock were ever taken away. Which of two simultaneous requests wins is simply whoever gets the lock first; the other is refused cleanly. This is proven by tests that fire both requests at once with `Promise.all`: `pooling.test.ts` case F, and in `midTripPooling.test.ts` two mid-trip requests racing for the last seat and for the last two seats (exactly one 200 and one 409, `occupiedSeats` never above capacity).

#### The same idea, everywhere a race would cause harm

| Situation | What guarantees it |
|---|---|
| Two street-ride passengers (QR flow) racing for the last seat, or the app flow and the street flow sharing one car | Both flows claim seats through the same `claimSeats()` (`utils/seats.ts`): the same single conditional `UPDATE`, inside an `IMMEDIATE` transaction; a partial unique index allows only one `OPEN` street session per vehicle |
| A passenger must not have two active rides (two taps on *Request*) | `POST /ride-requests` checks and inserts in one `IMMEDIATE` transaction, and a **partial unique index** on `RideRequests(passengerId) WHERE status IN ('REQUESTED','MATCHED','DRIVER_ARRIVED','STARTED')` is the database-level backstop; the loser gets 409 `ACTIVE_RIDE_EXISTS` |
| The driver completes a ride at the moment the passenger leaves it | Both use an `IMMEDIATE` transaction and a conditional update `WHERE status = 'STARTED'`; whoever runs second changes 0 rows and gets 409, so the seat is released once and the exit checkpoint is recorded once |
| A wallet must never go negative, and a ride must be charged once | The debit is `UPDATE Users SET walletBalance = walletBalance - :fare WHERE id = :user AND walletBalance >= :fare`; 0 rows means `FAILED`, not a negative balance. The ledger has a **unique** index on `rideRequestId`, so a second debit for the same ride cannot exist |
| A driver declines the same request twice | Unique index on `RideDecline(rideRequestId, driverId)`, and `findOrCreate` |
| Two drivers onboard at once and get the same Tesla ID or NID | Database `AUTOINCREMENT` and `UNIQUE` constraints; onboarding writes are also queued in-process and retried on `SQLITE_BUSY` (`routes/onboarding.ts`) |

#### What the SQLite setup means in practice, and its limits
- **One writer for the whole database file, not one per vehicle.** Accepts for *different* vehicles also queue behind each other. That is fine for an MVP, and it is why correctness needs no application-level locking.
- **Waiting has a limit.** Each Sequelize transaction opens its own connection, and the sqlite3 driver waits at most about **1 second** for the lock. Under heavy load a request can fail with `SQLITE_BUSY`, which the API returns as a JSON 500 that the app shows as "Something went wrong on our side, try again". The seat is never over-booked in that case; the request just did not run.
- **Capacity is guarded by the conditional `UPDATE`, not by a schema `CHECK`.** There is no `CHECK (occupiedSeats BETWEEN 0 AND seatCapacity)` on the `Vehicles` table today.
- **Known gap: pre-trip cancellations.** The passenger and driver *cancel* routes for a ride that has not started use ordinary (deferred) transactions and update the ride without a `WHERE status = ...` guard. If a passenger and the driver cancel the same ride at the same moment, both could release the seat (the release is floored at 0 with `MAX(0, ...)`, so it cannot go negative, but it could free a seat someone else holds). Making these two routes `IMMEDIATE` with a conditional update, as the complete/leave routes already are, would close it.
- **The pending list is advisory.** `GET /ride-requests/pending` reads without a lock, so it can show a request that another driver takes a moment later. That is harmless: the accept above is what decides.

#### What I would change at larger scale
The design (short transaction, conditional update, unique constraints) is already the right shape; what changes is the database and a few edges.

1. **Move from one SQLite file to PostgreSQL.** Writes are no longer serialised database-wide, and locking becomes **row-level**: two accepts for the *same* vehicle still queue, but accepts for different vehicles run in parallel. The conditional `UPDATE ... WHERE seatCapacity >= occupiedSeats + :seats` works unchanged (Postgres locks the row, and a waiting update re-checks the `WHERE` against the committed value). If the pool needs to be read and checked first, take the row lock explicitly with `SELECT ... FROM vehicles WHERE id = :vehicle FOR UPDATE` at the start of the transaction, which is the Postgres equivalent of `BEGIN IMMEDIATE` but scoped to one vehicle.
2. **Add the constraints the database can enforce itself:** `CHECK (occupied_seats >= 0 AND occupied_seats <= seat_capacity)` so a bug can never over-book, and keep the partial unique index (Postgres supports it as is).
3. **Retry instead of failing.** Under load Postgres can abort a transaction (deadlock `40P01`, serialization failure `40001`). Wrap the accept in a short bounded retry, and give clients an idempotency key so a retried tap cannot claim two seats.
4. **A connection pool, and no in-process state.** SQLite opens a connection per transaction; Postgres needs a pool (and PgBouncer at scale). The onboarding write queue lives in one Node process and would not protect several API servers; the unique constraints already do, so the queue can go.
5. **No distributed lock for seats.** With one authoritative database, a Redis or ZooKeeper lock adds a second thing that can fail or expire mid-request and is not needed: the row lock plus the conditional update is stronger. A distributed lock (or Postgres advisory locks, `pg_advisory_xact_lock(vehicle)`) only earns its place for work that spans services or must not run twice at all, such as a payout job, and there it should guard the *job*, not the seat count.
6. **Scale reads and dispatch separately.** The pending list currently loads every waiting request and filters it in application code. At scale that becomes an indexed, geo-partitioned query, and offering one request to one driver at a time (`SELECT ... FOR UPDATE SKIP LOCKED` on a queue table) would stop many drivers from racing for it in the first place. A high-traffic city could also be sharded by region so each shard has one writer.
7. **Keep testing it the same way.** The `Promise.all` race tests already in the suite are the right shape; against Postgres they would run with real parallel connections and would be the first thing to run after the migration.

## Passenger Cancellation Policy

Passengers may cancel their ride only while it is in one of these states:

| Status | Passenger can cancel? | Reason |
|---|---|---|
| `REQUESTED` | ✅ Yes | No driver has committed yet. Zero cost. |
| `MATCHED` | ✅ Yes | Driver assigned but not yet physically en-route. Passenger can still back out. |
| `DRIVER_ARRIVED` | ❌ No | Driver has made the physical trip to the pickup point. Cancelling here unfairly penalises the driver. |
| `STARTED` | ⚠️ Not a normal cancel | Trip is in progress. The ordinary cancel is refused, but the passenger can **leave part-way** at a zone they name: see *Leaving a ride mid-trip* below. It ends as `CANCELLED_IN_TRANSIT`. |
| `COMPLETED` | ❌ No | Terminal state — cannot undo. |
| `CANCELLED` | ❌ No | Already cancelled. |
| `CANCELLED_IN_TRANSIT` | ❌ No | Already left the ride. |

### Leaving a ride mid-trip (`CANCELLED_IN_TRANSIT`)
A passenger whose ride is `STARTED` can get off part-way with `PATCH /passenger/rides/:id/cancel-in-transit` and `{ "cancellationZone": "Mohammadpur" }`. The ride ends as **`CANCELLED_IN_TRANSIT`**, a terminal status separate from `CANCELLED`: they were picked up and travelled part of the route, so it stays in their history and the driver's as a real part-trip with a fare, unlike a request that never happened.

- **Cancellation zone (required)** — the nearest predefined zone where they are dropped off, from the same zone list as everywhere else. It cannot be the pickup zone, or the destination zone (at the destination the driver completes the trip). A missing or unknown zone is a 400 and nothing changes.
- **Fare — not a special formula.** The cancellation zone is recorded as a **checkpoint** (`PASSENGER_LEFT`, passengers on board − 1) and the journey is priced by the same segment walk as any other: `fare = ৳100 + Σ segment charges` from where they boarded to the cancellation zone (see *Fare Model*). They pay only for the segments they actually travelled, each at the rate for who was on board. `estimatedFare` becomes that final charge and `poolDiscount` what pooling saved on those stretches.
- **Worked example** — Nusrat rides **Uttara → Dhanmondi**, Rafiq boards at Mirpur. Nusrat is dropped at **Mohammadpur**: Uttara → Mirpur 9 km × 20 = ৳180 alone; Mirpur → Mohammadpur 5 km × 20 = ৳100 × 70% = ৳70 with Rafiq on board. **Fare = 100 + 180 + 70 = ৳350** (she was on track for ৳380 to Dhanmondi). Riding alone the same exit at Mirpur costs 100 + 180 = **৳280**. If she leaves at the zone where Rafiq boards (Mirpur), the shared stretch is 0 km and costs nothing: ৳280.
- **Nobody else is charged or refunded** — a stated assumption, also in the code: each passenger is priced only from the segments *they* travelled. Passengers still on board simply carry on with one fewer passenger, so their **later** stretches are priced at the lower share rate (their running estimate is refreshed), while stretches already travelled keep the rate that applied when they were travelled. Rafiq above ends at 100 + 70 + 60 = **৳230**.
- **The seat is released at once**, in the same transaction, so `GET /ride-requests/pending` shows the free seat straight away and the request passes the same route filter as before, with no re-match. (The vehicle's position for that filter is taken from the riders still on board, see Rule B.)
- **Audit trail** — a `RideEvents` row (permanent) records `CANCELLED_IN_TRANSIT`, the actor (the passenger), the time, `cancellationZone`, `chargedFare` and `fullTripEstimate` (what they were on track to pay to their original destination), and the `PoolCheckpoints` row records the zone and new head count. `GET /driver/rides/timeline` shows it beside the other passengers' unchanged events; each passenger's own `timeline`/history carries only their own. The other passengers never see who left, where, or what they paid.
- **Who and when** — only the ride's owner (404 no such ride, 403 someone else's, 401 not logged in, a driver's login is refused). Only a `STARTED` ride: `COMPLETED`, an earlier status or an already-cancelled ride gets 409. The check and the update are one conditional step inside an immediate transaction, and the driver's *complete* is conditional the same way, so completing and leaving at the same moment cannot both succeed, record two exits or release the seat twice.

## Payment (simulated)

There is **no real gateway**. Each ride has a payment method and, for wallet rides, the fare is taken from a simulated **TeslaPay** balance.

- **Method** — `paymentMethod` is `cash` (default) or `wallet`, chosen when the ride is requested (`POST /ride-requests`, field `paymentMethod`; anything else is a 400). The **Request Ride** form has a payment picker that shows the passenger's own balance.
- **Wallet** — every user has a `walletBalance` in **whole taka**. (The request said "integer paisa, consistent with how fares are stored", but fares are stored as whole taka since the paisa → taka migration, so the wallet uses the same unit: a balance and a fare can be compared and subtracted directly.) The balance can never go negative.
- **When it is charged** — when a passenger's **own journey ends**: the driver completes their ride (`COMPLETED`) or they leave mid-trip (`CANCELLED_IN_TRANSIT`). The amount is that ride's **final segment-based fare** (see *Fare Model*), the same number that is stored as `estimatedFare` and shown in the breakdown. A ride cancelled before it started never charges anything.

| `paymentStatus` | Meaning |
|---|---|
| `NOT_DUE` | The journey has not ended (or the ride never started): nothing to pay yet |
| `PAID` | Wallet ride: the wallet was debited by exactly `paymentAmount` (and a `WalletTransactions` ledger row records it, with the balance left) |
| `CASH_DUE` | Cash ride: `paymentAmount` is what the passenger owes the driver. **The wallet is never touched.** |
| `FAILED` | Wallet ride, but the balance was lower than the fare. **Nothing was debited**, the balance is unchanged, and the ride still ends normally |

- **Worked example** — Nusrat (wallet ৳1000) and Rafiq (cash ৳500 wallet, unused) share the Uttara → Dhanmondi trip from the fare example: Nusrat's final fare is **৳380**, so her balance becomes 1000 − 380 = **৳620** (`PAID`, `paymentAmount` 380); Rafiq's is **৳200**, recorded as `CASH_DUE` and his wallet stays ৳500. If Nusrat had left at Mohammadpur instead, she would be debited **৳350**.
- **Insufficient balance — what happens next (MVP).** The debit is one atomic conditional update (`walletBalance` is reduced only where it is at least the fare), so it can never overdraw, even with simultaneous debits. If it does not apply, the payment is marked `FAILED`, no ledger row is written, and the fare is **flagged for cash settlement**: the ride stays `COMPLETED` / `CANCELLED_IN_TRANSIT` (the passenger did travel), `paymentAmount` records what is due, the passenger's card says *Wallet payment failed: pay ৳X in cash to the driver*, and the driver's card says *Wallet payment failed: collect ৳X in cash*. There is no retry, top-up or debt account in this MVP; a real system would retry after a top-up or record a debt. An exact balance pays and leaves ৳0; one taka short fails.
- **Who sees what** — a passenger reads only their **own** balance and ledger at `GET /passenger/wallet` (the caller comes from the login token; someone else's `passengerId` is a 403, no login a 401, a driver's login a 403) and their own ride's `paymentMethod`, `paymentStatus`, `paymentAmount`. **Drivers never see a wallet balance**: their responses carry a ride's `paymentMethod` and `paymentStatus` (paid / cash to collect / failed) and the amount owed, nothing else.
- **Seed** — `npm run seed` gives Nusrat ৳1000 (pays by wallet), Rafiq ৳500 (pays cash) and Shirin **৳120** (wallet; small on purpose, so a ৳145 fare fails and shows the cash-settlement path).
- **Existing databases** — `Users.walletBalance` (default 0) and `RideRequests.paymentMethod / paymentStatus / paymentAmount` (cash, `NOT_DUE`) are added by an idempotent startup migration, which now runs before the paisa → taka migration reads rides; `WalletTransactions` is created by `sync()`.

## Street rides by QR code (drivers without a smartphone)

A **separate, additional** flow for drivers who have no smartphone. The driver **never logs in and never does anything**: every step is triggered by a passenger. The normal app flow (requested → matched → started → completed, pooling, wallet payments) is untouched.

**How it works**
1. Every vehicle has a public **`vehicleCode`**: the **QR sticker's content** and the **typeable fallback** for a passenger who cannot scan. **For a vehicle whose driver has a Tesla ID (every onboarded driver) the vehicle code *is* the Tesla ID**, e.g. `DTP-0001`: the same value the app shows as *Tesla ID* on the driver's Vehicle tab and on a passenger's ride card, so the code a person sees is exactly the code the lookup accepts. (It comes from the driver profile's id and is copied into the vehicle's plate at onboarding; a startup migration keeps an onboarded active vehicle's code equal to it.) A vehicle with no driver profile gets a random 6-character code from an alphabet without look-alikes (`4KQ7M2`). Codes are unique. Input ignores case, spaces and underscores, and **a hyphen is optional**: `DTP-0001`, `dtp-0001`, `DTP0001` and `dtp 0001` all find the same vehicle. The seeded Bullet is `DTP-0001` (its QR code is its Tesla ID).
2. A passenger opens **Street Ride**, scans or types the code and sees the vehicle and whether a ride is already open. Then they choose their own pickup and destination from the normal zone list.
   - If the vehicle has **no `OPEN` session**, joining **creates one**. If it has one, they **join it** with their own destination. There is **no compatibility check**: the driver and passenger agreed on the street. Only **capacity** is enforced.
3. When they get off they tap **I've arrived** (nobody else can do it for them and there is no driver confirmation anywhere). When **every** passenger has, the session becomes `CLOSED`.
4. If nobody closes it, it is closed automatically (see the time limit below).
5. **The Street Ride page only ever shows a ride the passenger is still on.** As soon as their own trip ends (they tap *I've arrived*, or the session times out or closes) the page resets to the normal "scan or enter a vehicle code" state, ready for a new ride, with no "this ride has ended" message left behind. (This applies the moment *their own* leg ends, even if others are still riding, so they can start another ride straight away.) After tapping *I've arrived* the app takes them to **History**, where the finished trip now is.

**Street rides in the ride history.** A finished street trip appears in the passenger's existing ride history (`GET /passenger/rides/history`, the same list and screen as app rides), in **one list sorted by when each trip ended, newest first**. Every row has a **`source`**: `APP` (a 📱 *App ride* label) or `QR` (a 🛺 *Street ride (QR)* label), so a trip is never mistaken for the other flow. A QR row has the same fields as an app row (zones, `estimatedFare` = the final fare, `poolDiscount`, `paymentMethod` `cash` and `paymentStatus` `CASH_DUE` with `paymentAmount`, `createdAt` = when they joined, `updatedAt` = when their trip ended) plus a **`qr`** object: `vehicleCode` and nickname, `passengerNumber`, `autoCompleted` (the session timed out before they confirmed), `joinedAt` / `exitedAt`, the session's `sessionStatus` / `sessionClosedAt` / `sessionCloseReason`, and **`driverBonus`**, the bonus *their* joining earned the driver (৳10 for a second or later passenger, ৳0 for the first). Only the passenger's own trips are ever returned; co-passengers do not appear. A trip appears as soon as the passenger's own leg is done, and an app-only history looks exactly as before, plus the `source: "APP"` label.

**Data.** `QRRideSession` (vehicle, `OPEN`/`CLOSED`, opened/closed times, close reason), `QRRideParticipant` (the passenger's own pickup and destination zone, `joinedAt`, status `RIDING` → `ARRIVED` or `AUTO_COMPLETED`, fare and cash amount) and `DriverBonus` (the driver's bonus ledger). There are no `DRIVER_ARRIVED` / `STARTED` states: there is no driver app to report them. Endpoints (all a logged-in **passenger**): `GET /qr/vehicles/:code`, `POST /qr/join`, `GET /qr/sessions/mine` (the ride the passenger is on **now**, or `null`), `GET /qr/sessions/:id`, `POST /qr/sessions/:id/arrived`; `GET /qr/bonus` is the driver's own bonus record.

**Fares** use the same formula as the app (see *Fare Model*): **৳100 base fare once + each stretch's distance charge at the share rate for how many were on board** (100% alone, 70% with 2, 55% with 3, so the pool discount only applies while the car is shared). The "checkpoints" are simply this session's **joins and exits, in order** (a join is at the passenger's pickup zone, an exit at their destination zone). A running estimate is shown while riding; the fare is final when the passenger's own journey ends. `baseFare` is their solo fare (`100 + km × 20 × seats`) and `poolDiscount` what pooling saved.

**Worked example — two passengers, different destinations.** Zone distances: Uttara–Mirpur **9 km**, Mirpur–Dhanmondi **7 km** (so Uttara → Dhanmondi is 16 km). Nusrat rides **Uttara → Dhanmondi**; Rafiq rides **Uttara → Mirpur**.

| Event | Where | On board after |
|---|---|---|
| Nusrat scans the code and joins (opens the session) | Uttara | 1 |
| Rafiq scans the same code and joins (**driver bonus ৳10**) | Uttara | 2 |
| Rafiq taps *I've arrived* | Mirpur | 1 |
| Nusrat taps *I've arrived* → session `CLOSED` | Dhanmondi | 0 |

| | Stretch | Distance charge | On board | Charge |
|---|---|---|---|---|
| **Nusrat** | Uttara → Mirpur | 9 × 20 = ৳180 | 2 → 70% | **৳126** |
| | Mirpur → Dhanmondi | 7 × 20 = ৳140 | 1 → 100% | **৳140** |
| | **fare** = 100 + 126 + 140 = 366 → **৳365** | (alone all the way: 100 + 320 = ৳420) | | saved ৳55 |
| **Rafiq** | Uttara → Mirpur | 9 × 20 = ৳180 | 2 → 70% | **৳126** |
| | **fare** = 100 + 126 = 226 → **৳225** | (alone: 100 + 180 = ৳280) | | saved ৳55 |

Nusrat owes **৳365** and Rafiq **৳225**, both **in cash**; together ৳590. While both are riding the estimates are Nusrat ৳325 and Rafiq ৳225, and the moment between two people joining in the same zone is a 0 km stretch that costs nothing.

**Driver bonus.** A fixed **৳10** (`DRIVER_BONUS_PER_EXTRA_PASSENGER`) is credited to the vehicle's driver in the `DriverBonus` ledger for every passenger **beyond the first** in a session (one passenger alone earns none; three earn ৳20). It is written in the same transaction as the join and can only exist once per passenger. The driver reads it at `GET /qr/bonus` with their own login (or an admin tool can), passengers never can.

**Payment is cash only** and the wallet is never touched. Why (also in the code): the driver has no app and no wallet account, so there is nobody to credit and nothing on their side to confirm a transfer. The passenger pays the driver in cash at the end and the app only records the amount owed (`CASH_DUE`). A request to pay by wallet is refused.

**The time limit — 90 minutes.** There is no driver to close a stale session, so any session `OPEN` for more than **90 minutes** (`QR_SESSION_TIMEOUT_MINUTES`, an environment setting) is closed automatically with reason `TIMEOUT`, and every passenger who never confirmed becomes **`AUTO_COMPLETED`**: they are charged as if they had arrived at their destination, their seat is released, and the passenger sees why. I chose 90 because it is longer than any realistic trip across Dhaka even in bad traffic, yet short enough that a forgotten session does not keep a car "occupied" through the next trip. It is measured from when the session **opened**, as specified, so someone who joins at minute 85 has 5 minutes; a rolling "since last activity" limit would be fairer to late joiners and is a small change. When several passengers are auto-completed their exits are ordered **shortest trip first** (ties: who joined first), so a passenger with a nearby destination is not charged for riding on to a far one and back. Sweeping happens on **every street-ride request** (so it needs no timer to be correct) and once a minute in the server.

**Anonymized passengers.** Like the app flow, passengers in one car see each other only as **"Passenger 1", "Passenger 2"** (join order) with whether they are still riding: never names, phones, ids, routes or fares, even though they are physically together. A passenger's fare breakdown has no zone names (they would show where the others got on and off), and passengers never see the driver's identity. Only a passenger *in* a session can read it (403 otherwise).

**Kept apart from the app flow.** A street passenger is **not** a `RideRequest`: pools, checkpoints, fares, earnings and the pending list of the app flow never include them, and an app ride completing never closes or charges a street session. The **only shared state is the vehicle's seat count**, on purpose, because a seat is a seat: both flows claim and release seats through the same two functions (`claimSeats` / `releaseSeats` in `utils/seats.ts`), so a car with an app ride holding 2 of 3 seats leaves one for a street passenger and can never be over-booked across both. Each flow releases only what it claimed. A passenger cannot be in an app ride and a street ride at once (the street join is refused if they have an active app ride, and a passenger can only be in one street ride).

**Concurrency.** Joining runs in one `IMMEDIATE` transaction with the shared atomic seat claim (see *Concurrency Handling*), so two passengers racing for the last seat cannot both get it, and two first passengers scanning together open **one** session between them (a partial unique index allows at most one `OPEN` session per vehicle). Joining is refused with `SESSION_CLOSED` if the passenger sends the id of a ride that has closed since they scanned, rather than quietly opening a different one.

**Assumptions and limits**
- Passengers still need an account (their identity is the login); only the *driver* is offline. The vehicle code itself is not a secret: all it lets someone do is join a ride in that car.
- "I've arrived" means arrival **at the passenger's own destination zone**; a passenger who gets off somewhere else early is charged for the full trip they entered (a "get off here" zone, like the app's mid-trip leave, is a natural extension).
- The passenger's own word ends their leg, and cash is settled in person; disputes are outside the app.
- If a vehicle is used by both flows at once, route compatibility is not checked between them (only seats).

## Ride Status Page (Passenger)

The passenger's **Active Rides** tab is the ride status page. Once a driver accepts the ride it shows:

- **Driver & vehicle** — the driver's name and photo (a placeholder when they have none), their phone number with a tap-to-call button (`tel:` link), and the vehicle as `Bullet · DTP-0001` (nickname · Tesla ID).
- **Pool** — `Shared ride · 1 other passenger` or `Just you`, seats taken (`2 of 3 seats taken`), and the other passengers by **first name only**.
- **Progress** — a step tracker, Matched → Driver Arrived → Started → Completed, with the current step highlighted; a waiting message while the ride is still `REQUESTED`; and a clear notice when it is `CANCELLED`.
- **Payment** — how the ride is paid and its status (*Pay ৳X in cash*, *Paid ৳X from your wallet*, *Wallet payment failed*), for their own ride only.
- **Fare** — the passenger's own fare only, e.g. `৳155 (shared, you save ৳25)`, marked *≈ estimate* while on board and *✓ Final fare* once their journey has ended, with the breakdown of how it was worked out.
- **Cancel** — the button appears only while the passenger may cancel (`REQUESTED` or `MATCHED`; see the cancellation table above).
- **Leave ride here** — once the ride is `STARTED` the ordinary cancel is gone, but the passenger can pick the zone where they are dropped off and leave part-way (see *Leaving a ride mid-trip*).

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
