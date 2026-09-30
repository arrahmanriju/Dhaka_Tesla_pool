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

**Fares mid-trip** are priced by segments, see *Fare Model*: each passenger pays the full cost of the stretches they ride alone, and an even share of the cost plus a flat ৳20 driver bonus for the stretches when others are on board, so a passenger who boards mid-trip only pays the shared price from where they boarded.

**Lifecycle history.** Every status change writes a permanent `RideEvents` row in the same transaction (who acted, the new status, the pool size, and `ridersOnboard`: how many passengers were already `STARTED` on the vehicle, not counting this one). A `MATCHED` event with `ridersOnboard > 0` is a mid-trip join. Drivers read it at `GET /driver/rides/timeline` (first names only, oldest first); each passenger's own ride (`GET /passenger/rides/:id`, `/active`, `/history`) carries only their own `timeline` and `joinedMidTrip`.

**Privacy.** Joining mid-trip reveals nothing extra: a passenger's responses contain only their own fare, route and history, plus the other passengers' **first names**. They never contain another passenger's fare, route, phone or id. `GET /ride-requests/me` and `/ride-requests/:id/pool-info` now require the passenger's login, like the `/passenger` routes.

### Fare Model — checkpoint-based segment pricing
Passengers who share a Tesla split the cost of the stretches they actually share, and the driver earns more in total. Fares are **whole taka (integers, never paisa)**, with an exact rounding rule (below). There is no fare lock at `STARTED` any more: a passenger's fare is **settled when their own journey ends**.

**Checkpoints.** A `PoolCheckpoint` (zone, timestamp, active-passenger count) is written whenever the number of passengers on a vehicle changes during a trip:

| Event | Checkpoint | Count |
|---|---|---|
| A ride `STARTED` with nobody else on board | at its **pickup zone** (`TRIP_STARTED`) | 1 |
| A passenger boards mid-trip (their ride `STARTED` while others are on board) | at the zone where they **boarded** (`PASSENGER_JOINED`) | previous + 1 |
| A passenger leaves mid-trip (`CANCELLED_IN_TRANSIT`) | at their **cancellation zone** (`PASSENGER_LEFT`) | previous − 1 |
| A passenger reaches their destination (`COMPLETED`) | at their **destination** (`PASSENGER_DROPPED_OFF`) | previous − 1 |

The last row is not in the original list of events, but a drop-off changes who is on board exactly like a cancellation does, so the next stretch has to be priced with one fewer passenger. The count is the number of rides on the vehicle that are `STARTED`. `runId` groups one continuous run of a vehicle: it begins when someone boards an empty vehicle and ends when the count returns to 0; a later trip is a new run and is never mixed in.

**The formula.** When a passenger's own journey ends (`COMPLETED` or `CANCELLED_IN_TRANSIT`), walk the checkpoints from where **they** boarded to where **they** got off. Each consecutive pair is a segment `zoneA → zoneB`, with `n` = the count at its first checkpoint (how many are on board, this passenger included).

- **`tripCost`** of a route = `৳100 + distanceKm × ৳20 × seats`: what the passenger pays riding alone (Gulshan → Dhanmondi, 10 km, 1 seat: 100 + 200 = **৳300**). When the journey is cut into segments, that cost is spread over the journey **by distance**: a segment of `segKm` km gets `segKm / journeyKm` of it (`journeyKm` is the sum of the segment distances), so the pieces always add up to the whole.
- **`n = 1`** (alone on the segment): `segmentFare = tripCost of the segment`, unchanged.
- **`n ≥ 2`**: `segmentFare = ceil(tripCost of the segment / n) + ৳20`. The cost is split evenly and **rounded up to the next whole taka** (see the rounding rule), **then** a flat ৳20 driver bonus is added per passenger, the same for everybody sharing that segment (per passenger, not per seat; a 0 km hop earns none).
- **`fare = Σ segmentFare`** over the segments they were on board for.
- `poolDiscount = soloFare − fare` (never below 0), where `soloFare` is the whole journey's tripCost: what pooling saved on the stretches they travelled.
- A private ride (sharing off) skips all of this: it is always the flat `tripCost` of its route (see *Private rides*).

**Rounding rule — a shared split is rounded UP, for everybody on the segment.** Money is whole taka (integers, never paisa), and `tripCost / n` is often not a whole number (260 / 3 = 86.67). When it isn't, the split is **rounded up to the next whole taka, and every passenger sharing that segment pays that same rounded-up amount** (never "two pay 86 and one pays 87"), plus the ৳20 bonus: `ceil(tripCost / n) + 20`. The few extra fractions of a taka that this adds up to are **kept by the driver as additional profit**. It is applied in one place, the split calculation in `fareCalculator.ts` (`calculateSplit`), which every fare goes through: the quote before a ride, the running estimate, a completed ride's walk, and the stayers after a cancellation. It uses integer arithmetic only, so a fare is always a whole number and nothing can drift.

A **solo** segment is not split, so nothing is rounded up. One detail: when the ৳100 base is spread over a journey by distance, a solo segment's share can itself be a fraction (236.25), so the solo segments of a journey are rounded together (nearest whole taka, halves up, on their running total). That keeps a passenger who rides alone the whole way at exactly their trip cost, however many checkpoints cut the journey.

**Worked example — the rounding.** A route Gulshan → midpoint → Dhanmondi. Person 1 rides alone to the midpoint (segment tripCost 40); the remaining leg costs 260.

| Step | Calculation | Pays |
|---|---|---|
| Person 1 alone, first leg | tripCost 40, no split | **৳40** |
| Person 2 joins at the midpoint, 2 share the remaining leg | 260 / 2 + 20 = 130 + 20 (divides evenly) | **৳150** each |
| Person 1's total | 40 + 150 | **৳190** |
| Person 3 joins the same leg, 3 share it | 260 / 3 = 86.67 → **87** (up) + 20 | **৳107** each (not 106.67) |
| **Revenue for the ride** | 40 + 107 × 3 | **৳361** |

Without rounding it would be 40 + 260 + 3 × 20 = ৳360: the extra **৳1** is the driver's rounding remainder (3 × 87 = 261 collected for a leg that cost 260). This scenario is in `roundingRule.test.ts`, which also checks that the total collected is always a whole number. (The zone table cannot produce a first leg of ৳40, since every trip costs at least the ৳100 base, so those segment costs are given directly to the split function. On the real zones Gulshan → Mohakhali → Dhanmondi the leg Mohakhali → Dhanmondi does cost exactly 100 + 8 × 20 = ৳260: two riders joining there pay ৳150 each and three pay ৳107 each, and the test runs that through the API.)

**Worked example — Gulshan → Dhanmondi (10 km, tripCost ৳300).** The same route with different numbers of riders on board the whole way:

| Riders on board | Calculation | Each pays | The driver earns |
|---|---|---|---|
| 1 (solo) | tripCost | **৳300** | ৳300 |
| 2 | 300 / 2 + 20 = 150 + 20 | **৳170** | ৳340 |
| 3 | 300 / 3 + 20 = 100 + 20 | **৳120** | ৳360 |
| 4 | 300 / 4 + 20 = 75 + 20 | **৳95** | ৳380 |

**A fourth passenger for only part of the route.** Three riders go Gulshan → Dhanmondi and the pool changes at **Mohakhali** (Gulshan–Mohakhali 3 km, Mohakhali–Dhanmondi 8 km). The zone table is not additive (3 + 8 = 11 km, against 10 km direct), so a rider who goes the whole way, now with a checkpoint at Mohakhali in their journey, is priced over 11 km: tripCost = 100 + 11 × 20 = **৳320**, and a 3 km segment gets 3/11 of it, an 8 km segment 8/11.

| | Segment | Exact amount | Charge |
|---|---|---|---|
| **Fourth boards at Mohakhali.** Each of the 3 full-route riders | Gulshan → Mohakhali, 3 on board | 3/11 × 320 = 87.27; / 3 = 29.09 → 30 (up); + 20 | 50 |
| | Mohakhali → Dhanmondi, 4 on board | 8/11 × 320 = 232.73; / 4 = 58.18 → 59 (up); + 20 | 79 |
| | **fare** = 50 + 79 | | **৳129** |
| The fourth (8 km only, tripCost 100 + 160 = 260) | Mohakhali → Dhanmondi, 4 on board | 260 / 4 + 20 = 65 + 20 | **৳85** |
| **Fourth rides from Gulshan and leaves at Mohakhali.** Each of the 3 others | Gulshan → Mohakhali, 4 on board | 87.27 / 4 = 21.82 → 22 (up); + 20 | 42 |
| | Mohakhali → Dhanmondi, 3 on board | 232.73 / 3 = 77.58 → 78 (up); + 20 | 98 |
| | **fare** = 42 + 98 | | **৳140** |
| The fourth (3 km only, tripCost 100 + 60 = 160) | Gulshan → Mohakhali, 4 on board | 160 / 4 + 20 = 40 + 20 | **৳60** |

The partial-route rider pays much less than a full-route rider (85 and 60, against 129 and 140), and the full-route riders pay differently from the plain 3-rider fare of ৳120, because the checkpoint at Mohakhali cuts their journey into two segments, each carrying the ৳20 bonus. The driver earns 3 × 129 + 85 = ৳472 in the first case and 3 × 140 + 60 = ৳480 in the second. (These are checked in `pricingModel.test.ts`.)

**Worked example — solo for one hop, then pooled for the next.** Zone distances: Uttara–Mirpur **9 km**, Mirpur–Dhanmondi **7 km**. Nusrat rides Uttara → Dhanmondi and starts alone; Rafiq is accepted mid-trip and boards at Mirpur, going to Dhanmondi; both are dropped at Dhanmondi (Nusrat first).

| Checkpoint | Zone | On board |
|---|---|---|
| Nusrat's trip starts | Uttara | 1 |
| Rafiq boards | Mirpur | 2 |
| Nusrat is dropped | Dhanmondi | 1 |
| Rafiq is dropped | Dhanmondi | 0 |

| | Segment | Exact amount | Charge |
|---|---|---|---|
| **Nusrat** (journeyKm 9 + 7 = 16, tripCost 100 + 320 = ৳420) | Uttara → Mirpur, alone | 9/16 × 420 = 236.25 | **৳236** |
| | Mirpur → Dhanmondi, 2 on board | 7/16 × 420 = 183.75; / 2 = 91.875 → 92 (up); + 20 | **৳112** |
| | **fare** = 236 + 112 = **৳348** | (alone all the way: ৳420) | pooling saved ৳72 |
| **Rafiq** (journeyKm 7, tripCost 100 + 140 = ৳240) | Mirpur → Dhanmondi, 2 on board | 240 / 2 + 20 | **৳140** |
| | **fare** = **৳140** | (alone: ৳240) | pooling saved ৳100 |

The driver earns ৳348 + ৳140 = **৳488**. Before Rafiq boards, Nusrat's running fare is the solo ৳420; once he boards it drops to ৳348.

**A passenger who was pooled from the start** pays the shared price for the whole trip: if Nusrat and Rafiq both board at Mohakhali for Badda (4 km, tripCost 100 + 80 = ৳180), each pays 180 / 2 + 20 = **৳110** (three on board: 180 / 3 + 20 = **৳80**). A 0 km stretch (the moment between two people boarding in the same zone) costs nothing.

**Leaving mid-trip — a different rule from every other fare.** A passenger who leaves a started ride (`CANCELLED_IN_TRANSIT`) does **not** pay a walked, distance-based fare. They pay **half of the fare they were quoted**:

- `cancellationFare = quotedFare / 2`, to the nearest whole taka, halves up (113 / 2 = 56.5 → ৳57).
- `quotedFare` is the pooled fare for their whole route that they were shown **when they boarded**, frozen at that moment (`RideRequest.quotedFare`, set when the driver starts their ride). It is what they saw before anything changed mid-trip. A passenger who boarded alone was quoted the solo fare; one who boarded with others matched was quoted the pooled fare. Their running `estimatedFare` keeps following the pool; the quote does not. (A ride that started before this rule has no stored quote and falls back to its running estimate.)
- This is a **deliberate, customer-friendly leniency policy**, not a price: it is flat, it ignores how far they travelled, and it does not walk the checkpoints the way a completed ride does. Do not read it as a pro-rated fare (the earlier pro-rated cancellation formula is gone).
- **Everyone else is priced as usual, with no special adjustment.** The cancellation still creates a checkpoint (`PASSENGER_LEFT`, count − 1), so the stretches after it have one fewer passenger, and each passenger who stays is priced by the ordinary segment walk over their real checkpoints. Their fare is simply whatever that walk gives.

**Worked example — Gulshan → Dhanmondi, tripCost ৳300, two pooled, one leaves at the midpoint.** Suppose the midpoint splits the route 5 km + 5 km (each half has tripCost 150):

| | Calculation | Pays |
|---|---|---|
| Both, pooled for the whole trip (quoted) | 300 / 2 + 20 | **৳170** each (৳340 together) |
| The passenger who leaves at the midpoint | 170 / 2 | **৳85** |
| The passenger who stays: Gulshan → midpoint, 2 on board | 150 / 2 + 20 = 95 | |
| The passenger who stays: midpoint → Dhanmondi, alone | 150 (no split, no bonus) | |
| | 95 + 150 | **৳245** |
| **Driver's revenue** | 85 + 245 | **৳330** (against ৳340 if nobody had left) |

This is checked with the real code in `cancellationPricing.test.ts`. The zone table has **no zone that is exactly halfway** between two others (a zone between Gulshan and Dhanmondi always adds a detour: Gulshan–Mohakhali 3 km + Mohakhali–Dhanmondi 8 km = 11, not 10), so that test hands `segmentFare` a small 5 km + 5 km network instead. On real zones the same rule is verified end to end through the API in `midTripCancellation.test.ts`, using Uttara → Mirpur → Dhanmondi (9 + 7 = 16 km, the one route where the table adds up): Nusrat and Rafiq both ride Uttara → Dhanmondi, tripCost 100 + 16 × 20 = ৳420, quoted 420 / 2 + 20 = **৳230** each; Rafiq leaves at Mirpur and pays 230 / 2 = **৳115**; Nusrat's walk is Uttara → Mirpur with 2 on board (9/16 × 420 = 236.25, / 2 = 118.125 → 119 (up), + 20 = 139) plus Mirpur → Dhanmondi alone (7/16 × 420 = 183.75 → 184) = **৳323**; the driver earns ৳438 (the two were quoted ৳460).

Because the distances in the zone table are not additive, a passenger who stays on board after someone leaves at an intermediate zone is priced over the checkpoint route, which can be longer than the direct one (see the assumptions below): they may pay noticeably more than the fare they were quoted.

**What the fare is before the journey ends.** `estimatedFare` is an estimate, and `fareFinal` (in the API) is `false` until the passenger's own journey ends:
- *Not on board yet* (`MATCHED`, `DRIVER_ARRIVED`): what they would pay if the pool now on the vehicle stayed together for the whole route, `tripCost / pool size + ৳20`. The **Request Ride** page shows the price alone and with 2 and 3 passengers (`GET /ride-requests/estimate` returns `baseFare`, `fare`, `poolFare` and `tiers`).
- *On board* (`STARTED`): the checkpoint walk so far, plus the rest of the way to their destination with whoever is on board now. It is refreshed whenever someone boards or gets off.
- *Ended*: the final, settled fare. Nothing that happens afterwards changes it (`recalculatePoolFares` never touches a finished ride).

**Rules and assumptions**
- Each passenger is priced from **their own** pickup, exit and boarding time; pooled passengers can pay different amounts. The driver earns the **sum of what their passengers pay**.
- **Stated assumptions.** (1) A hop through an intermediate zone is priced with the zone table, which is not geometric, so it can differ from the direct distance (Mirpur–Mohammadpur 5 km + Mohammadpur–Dhanmondi 3 km = 8 km, against Mirpur–Dhanmondi 7 km). (2) Every shared split is rounded up to a whole taka for all its passengers (see the rounding rule), so the driver can earn a few taka more than cost plus bonuses; every charge and every fare is a whole number. (3) A ride that started before checkpoints existed has no boarding checkpoint and simply keeps the fare it already had.
- `baseFare` stays the passenger's own **solo fare for the whole route** (`100 + distanceKm × 20 × seats`), set at request time; `poolDiscount` is what pooling saved (`baseFare − estimate` before the journey ends, `soloFare − fare` on the stretches travelled after it).
- **A cancellation mid-route changes the stayer's journey.** The checkpoint at the cancellation zone cuts the remaining passenger's journey there, and a route through a zone can be longer than the direct one, so their journey is priced over that longer distance. That is the existing segment formula behaving as documented, not a cancellation adjustment, but it can make a stayer's fare much higher than the pooled fare they were quoted.
- The ৳20 bonus is charged on **every shared segment that covers distance**, so a journey cut into several shared segments pays it several times, and a very short shared segment can cost slightly more than riding it alone (`poolDiscount` is then 0, never negative). The ৳100 base is no longer a separate, never-discounted charge: it is part of `tripCost`, so it is split and spread with the rest.
- **Private rides (sharing off) always pay the flat trip cost** and are never pooled (see *Private rides*).

**What each side sees**
- **Passenger** — only their own fare, e.g. `৳110 (shared, you save ৳70)`. While on board it is marked *≈ estimate*; once their journey ends it shows *✓ Final fare*, with **how it was worked out** (`fareBreakdown`: each stretch's km, passengers on board, driver bonus and charge). The breakdown deliberately leaves out **zone names**: the checkpoints between a passenger's boarding and exit are where *other* passengers boarded or got off.
- **Driver** — the **total earnings for the ride** on the Active tab (`GET /driver/rides/active` returns `poolSize` and `totalEarnings`, a running estimate) and each passenger's settled fare, cancellation zone and pre-exit estimate in the pool history.
- API money fields (`baseFare`, `estimatedFare`, `poolDiscount`, `fare`, `totalEarnings`) are whole taka; rides carry `fareFinal`, and a passenger's own ride also carries `poolSize` and `fareBreakdown`.

#### Worked Example — the seed data
`npm run seed` creates Jashim (driver, **Bullet**, 3 seats) and Nusrat, Rafiq and Shirin, who each request **Mohakhali → Badda** (4 km: solo ৳180). Log in as Jashim, go online and accept them one by one (before the trip starts everyone is quoted as if the pool stays together):

| Jashim accepts | Each passenger pays (quote) | Jashim earns |
|---|---|---|
| Nusrat | ৳180 | ৳180 |
| + Rafiq | 180 / 2 + 20 = ৳110 each (saves ৳70) | ৳220 |
| + Shirin | 180 / 3 + 20 = ৳80 each (saves ৳100) | ৳240 |
| Shirin cancels | back to ৳110 each | ৳220 |
| Nusrat's trip starts (alone in the car) | Nusrat's running fare is ৳180 until Rafiq boards | — |

#### Upgrading an existing database
Fares used to be stored as integer paisa with a flat ৳30 pool discount. On startup the server converts stored fares to whole taka once (dividing by 100 and rounding to ৳5), re-prices any pool that has not started, and records this in the database's `user_version` so it never runs twice. A copy of the database file is saved next to it first (`database.sqlite.pre-taka-migration.bak`). The new `PoolCheckpoints` table is created automatically at startup; rides that were already `STARTED` before the upgrade have no boarding checkpoint, so they keep the fare they had. The cancellation columns (including `RideRequests.quotedFare`, the fare frozen when a passenger boards; a ride that was already `STARTED` before it has no stored quote and, if its passenger leaves, is charged half of its running estimate) are added by an idempotent startup migration (`RideEvents.lockedFare`, from an earlier version of this work, is renamed `fullTripEstimate`).

### Private rides (Allow sharing off)
The Request Ride form has an **Allow sharing** switch, **on by default** (pooling is unchanged while it is on). Switched off, the request is a **private ride** (`allowSharing: false`, main app flow only; the QR street-ride flow is separate and untouched):

1. **Flat price.** The fare is always the flat `tripCost` of the route: Gulshan → Dhanmondi is exactly **৳300** (`100 + 10 km × 20 × seats`), at the request, while matched, on the trip and when it completes. The segment, split, ৳20 bonus and rounding logic is skipped for it altogether (`pooledFare` and `priceJourney` return the flat price; `recalculatePoolFares` never touches it). `poolDiscount` is 0 and its bill has no stretches. (Leaving mid-trip still follows the cancellation rule: half of the quoted ৳300.)
2. **Never a pooling opportunity.** Passengers never see each other's requests, and a private ride never appears in another passenger's lists or joins their pool. For drivers: it is **not offered to a driver who already has a passenger** (pre-trip or mid-trip: `checkPoolJoin` refuses it against any non-empty vehicle), and a vehicle carrying a private ride, matched or started, **takes nobody** (the accept is refused with `VEHICLE_IS_PRIVATE` and the request is not in the pending list). It *is* offered to a driver whose vehicle is empty: that is how it gets a driver at all.
3. **Capacity is only the baseline.** No multi-passenger pooling logic runs for it, but the atomic seat claim still does: the vehicle must have the seats the ride asked for (a 3-seat request on a 2-seat car, or a full car, is refused), so it can never overbook, even when two private requests are accepted at the same moment (exactly one wins).
4. **Fixed for the ride's lifetime.** `allowSharing` is set when the ride is requested and can never change: no route edits it (a value sent with another action is ignored, and there is no edit route), and the model refuses any update to it, one at a time or in bulk, for a `REQUESTED`, `MATCHED` or `STARTED` ride alike. A shared ride cannot be turned private either.

Tests: `privateRides.test.ts`.

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
- **Fare — half of the quote, a deliberate leniency policy.** The passenger pays **half of the fare they were quoted when they boarded** (`quotedFare / 2`, nearest taka, halves up), whatever the distance travelled: a flat, customer-friendly rule, not a pro-rated or distance-based price, and different from how a completed ride is priced (see *Fare Model*). `estimatedFare` becomes that charge, `poolDiscount` is 0, and the fare breakdown carries `cancellation: { rule: 'HALF_OF_QUOTED_FARE', quotedFare }` with no stretches. The cancellation zone is still recorded as a **checkpoint** (`PASSENGER_LEFT`, passengers on board − 1), exactly as before.
- **Worked example** — Nusrat rides **Uttara → Dhanmondi** alone (quoted ৳420); Rafiq boards at Mirpur. Nusrat is dropped at **Mohammadpur**: she pays **420 / 2 = ৳210**, not the ৳348 she was on track for to Dhanmondi (that estimate is kept in the history as `fullTripEstimate`). Riding alone and leaving at Mirpur costs the same ৳210, wherever she leaves. Two pooled passengers who were each quoted ৳230, with one leaving, are worked in *Fare Model* (৳115 for the leaver).
- **Everyone else is priced as usual, with no special adjustment** — each passenger who stays is priced by the ordinary segment walk over their real checkpoints. The cancellation only lowers the count on board for the stretches after it (their running estimate is refreshed), while stretches already travelled keep the split that applied when they were travelled. Rafiq above ends at 102 (162.5 / 2 = 81.25 → 82, + 20) + 98 (97.5 alone) = **৳200**: exactly what the walk gives, with or without the cancellation rule.
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

- **Worked example** — Nusrat (wallet ৳1000) and Rafiq (cash ৳500 wallet, unused) share the Uttara → Dhanmondi trip from the fare example: Nusrat's final fare is **৳348**, so her balance becomes 1000 − 348 = **৳652** (`PAID`, `paymentAmount` 348); Rafiq's is **৳140**, recorded as `CASH_DUE` and his wallet stays ৳500. If Nusrat had left at Mohammadpur instead, she would be debited half of the ৳420 she was quoted alone: **৳210**.
- **Insufficient balance — what happens next (MVP).** The debit is one atomic conditional update (`walletBalance` is reduced only where it is at least the fare), so it can never overdraw, even with simultaneous debits. If it does not apply, the payment is marked `FAILED`, no ledger row is written, and the fare is **flagged for cash settlement**: the ride stays `COMPLETED` / `CANCELLED_IN_TRANSIT` (the passenger did travel), `paymentAmount` records what is due, the passenger's card says *Wallet payment failed: pay ৳X in cash to the driver*, and the driver's card says *Wallet payment failed: collect ৳X in cash*. There is no retry, top-up or debt account in this MVP; a real system would retry after a top-up or record a debt. An exact balance pays and leaves ৳0; one taka short fails.
- **Who sees what** — a passenger reads only their **own** balance and ledger at `GET /passenger/wallet` (the caller comes from the login token; someone else's `passengerId` is a 403, no login a 401, a driver's login a 403) and their own ride's `paymentMethod`, `paymentStatus`, `paymentAmount`. **Drivers never see a wallet balance**: their responses carry a ride's `paymentMethod` and `paymentStatus` (paid / cash to collect / failed) and the amount owed, nothing else.
- **Seed** — `npm run seed` gives Nusrat ৳1000 (pays by wallet), Rafiq ৳500 (pays cash) and Shirin **৳120** (wallet; small on purpose: a solo ৳180 fare fails and shows the cash-settlement path, while a shared ৳80 or ৳110 fare is within her balance).
- **Existing databases** — `Users.walletBalance` (default 0) and `RideRequests.paymentMethod / paymentStatus / paymentAmount` (cash, `NOT_DUE`) are added by an idempotent startup migration, which now runs before the paisa → taka migration reads rides; `WalletTransactions` is created by `sync()`.

## Ride Status Page (Passenger)

The passenger's **Active Rides** tab is the ride status page. Once a driver accepts the ride it shows:

- **Driver & vehicle** — the driver's name and photo (a placeholder when they have none), their phone number with a tap-to-call button (`tel:` link), and the vehicle as `Bullet · DTP-0001` (nickname · Tesla ID).
- **Pool** — `Shared ride · 1 other passenger` or `Just you`, seats taken (`2 of 3 seats taken`), and the other passengers by **first name only**.
- **Progress** — a step tracker, Matched → Driver Arrived → Started → Completed, with the current step highlighted; a waiting message while the ride is still `REQUESTED`; and a clear notice when it is `CANCELLED`.
- **Payment** — how the ride is paid and its status (*Pay ৳X in cash*, *Paid ৳X from your wallet*, *Wallet payment failed*), for their own ride only.
- **Fare** — the passenger's own fare only, e.g. `৳110 (shared, you save ৳70)`, marked *≈ estimate* while on board and *✓ Final fare* once their journey has ended, with the breakdown of how it was worked out.
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
