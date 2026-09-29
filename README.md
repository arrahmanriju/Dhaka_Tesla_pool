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

### Fare Calculation Formula
Fares are calculated and stored in integer paisa (BDT × 100). The formula per passenger segment is:
`passengerFare = baseFare + distanceCharge - poolDiscount`

- **baseFare**: Fixed at 100 BDT per segment.
- **distanceCharge**: `distanceKm × 20 BDT × seatCount`.
- **poolDiscount**: Applied if and only if the pool size (total distinct passengers in the vehicle) is ≥ 2. The discount is fixed at 30 BDT per passenger.
- **Recalculation**: When a second passenger joins the pool, the first passenger's fare is automatically recalculated and reduced by 30 BDT. If a passenger cancels, leaving someone alone in the pool, the remaining passenger's discount is removed.

#### Worked Example
Consider Nusrat and Rafiq travelling from Gulshan to Banani (2 km).
**Nusrat books alone (1 seat):**
- `baseFare` = 100 BDT
- `distanceCharge` = 2 km × 20 BDT × 1 = 40 BDT
- `poolDiscount` = 0
- **Total Fare** = 140 BDT (14,000 paisa)

**Rafiq joins the same pool (1 seat):**
- Nusrat's fare is recalculated downward: `100 + 40 - 30` = 110 BDT (11,000 paisa)
- Rafiq's fare: `100 + 40 - 30` = 110 BDT (11,000 paisa)

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

## Passenger Data Isolation

A passenger can never view or modify another passenger's ride. The `findOwnedRide` helper in `routes/passenger.ts` performs an ownership check, and deliberately returns a generic **404** (not 403) for rides belonging to other passengers. This prevents an attacker from confirming whether a given ride ID even exists.
