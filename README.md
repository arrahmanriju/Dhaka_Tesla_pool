# Dhaka Tesla Pool MVP

## Tesla Pooling
This project supports ride-pooling. When drivers search for pending ride requests, they are filtered according to specific rules to ensure rides can be logically shared in a single vehicle.

### MVP Pooling Matching Rule
To determine whether a new ride request can be added to an existing vehicle's pool, the following conditions must be met:
1. The request status must be `PENDING`.
2. The requested `seatCount` must be less than or equal to the vehicle's remaining available seats (`seatCapacity - occupiedSeats`).
3. If the vehicle already has active/accepted pooled requests, the new request **MUST** have the exact same `destinationZone` to be eligible to share the vehicle. 
4. If the vehicle's pool is currently empty, any destination is considered valid.

### Concurrency Guarantee
To ensure the vehicle's capacity is never exceeded when near-simultaneous claims are made for the last seat, we rely on a database transaction with an **Optimistic Concurrency Atomic Update**.
When a ride is accepted, an atomic `UPDATE` query increments `occupiedSeats`, but with a `WHERE` constraint enforcing `seatCapacity >= occupiedSeats + requestedSeats`. If this returns 0 affected rows, it indicates capacity was exceeded by a concurrent transaction, and the operation safely aborts before marking the ride request as accepted.
