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

### Concurrency Guarantee
The vehicle's capacity is never exceeded, before or during a trip, even when near-simultaneous requests claim the last seat. Accepting a ride runs in one **immediate** database transaction: it takes SQLite's write lock up front, so two accepts for the same vehicle run one after the other, and the second re-reads the rides on the vehicle (including any `STARTED` one) and re-checks route compatibility under that lock. The seat claim is an **Optimistic Concurrency Atomic Update**: an `UPDATE` increments `occupiedSeats` with a `WHERE` constraint `seatCapacity >= occupiedSeats + requestedSeats`. If it changes 0 rows, capacity was exceeded by a concurrent transaction and the operation aborts before the ride is marked accepted. Mid-trip joining uses this exact same route and seat claim; there is no second copy of the logic.

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
