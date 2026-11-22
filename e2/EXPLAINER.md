# Engine 2 Technical Explainer & Viva Defense Guide

**Candidate:** Saish Kelvekar (Team 4)  
**Engine:** Engine 2 – Resource Availability & Allocation Engine  
**Domain:** Operating Systems, Concurrency Control, Deadlock Prevention, Distributed Transactions  

---

## 1. High-Level Architecture & Purpose

### Why Engine 2 Exists
In a college event management system, physical venues (auditoriums, labs), human evaluators (faculty judges), and technical equipment (projectors, audio consoles) are **strictly non-shareable resources** during an event's active time. 
If two events run at the same venue at 10:00 AM, physical chaos ensues. If a judge is assigned to two stages simultaneously, one stage is blocked.

Engine 2 is the **authoritative gatekeeper** of all resources. Its sole mission is to ensure:
1. **Zero Double-Booking (NFR-02):** A resource is never allocated to two overlapping events.
2. **Zero Deadlocks (NFR-07):** Concurrent scheduling requests never freeze or hang the system.
3. **Atomic Multi-Resource Allocation:** An event gets **all** required resources or **none** (all-or-nothing atomicity).
4. **Decoupled Architecture:** Scheduling optimization algorithms (E1), persistent transactions (E3), and web access (E4) remain completely decoupled from in-memory concurrency controls.

---

## 2. Core Concepts: Operating Systems in Action

Before explaining individual lines of code, here are the five OS principles Engine 2 implements:

### A. Mutual Exclusion (Mutex)
When checking if a venue is free and placing a reservation, there is a time gap between reading existing bookings and writing the new booking. Without mutual exclusion, two threads checking at the exact same millisecond would both see "free" and both write a booking, causing a **lost update / race condition**. Engine 2 associates an asynchronous Mutex with every resource.

### B. Deadlock Elimination (Coffman's Circular Wait Prevention)
A deadlock occurs when Request 1 holds Resource A and waits for Resource B, while Request 2 holds Resource B and waits for Resource A. Both wait forever.
Engine 2 eliminates deadlocks using **Dijkstra's Resource Hierarchy Principle**:
* Every resource ID is converted to a string and deduplicated.
* Resource IDs are **lexicographically sorted** (`A` before `B`, `B` before `C`).
* A request acquiring locks on `['R3', 'R1', 'R2']` is forced to lock `R1` first, then `R2`, then `R3`.
* Circular wait is mathematically impossible because all processes request shared resources in the exact same global order.

### C. Exception-Safe Lock Unwinding (LIFO Release in Finally)
Locks are released in reverse order of acquisition (`R3`, then `R2`, then `R1`) inside a `finally` block. Regardless of whether a check succeeds, detects a clash, or throws an unhandled error, locks are guaranteed to be released, preventing orphaned locks.

### D. Two-Phase Reservation Protocol (Reserve $\to$ Hold $\to$ Commit)
* **Phase 1 (Reserve):** The scheduler tests and places a temporary hold on the resources with a Time-To-Live (TTL). The resources are temporarily marked `RESERVED`.
* **Phase 2 (Commit):** Once the full timetable is verified, the scheduler commits the reservation. E2 calls E3 to persist the booking in PostgreSQL and marks it `COMMITTED`.
* **Expiry / Rollback (Release):** If the scheduler crashes or rejects the proposal, the hold timer automatically sweeps and expires the uncommitted reservation, releasing the resources without manual intervention.

---

## 3. Code Walkthrough: Class-by-Class & Line-by-Line

### Class 1: `Mutex` (in `e2_engine.js`)

```javascript
class Mutex {
  constructor({ lockTimeoutMs = 5000 } = {}) {
    this.locked = false;
    this.queue = [];
    this.lockTimeoutMs = lockTimeoutMs;
  }
```
* `this.locked`: Boolean indicating if a task currently owns the lock.
* `this.queue`: Array of waiting tasks. Implements a **FIFO (First-In, First-Out)** queue. This guarantees **fairness** and prevents **thread starvation** (no request is indefinitely bypassed).
* `this.lockTimeoutMs`: Maximum time a request will wait in the queue before timing out (prevents infinite blocking).

#### `acquire(timeoutMs)`
```javascript
  acquire(timeoutMs = this.lockTimeoutMs) {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }
```
* Fast path: If the mutex is free, immediately lock it and resolve synchronously.
* Contention path: If already locked, create a pending `Promise` and push `{ resolve, reject, timedOut }` into `this.queue`.
* Timeout protection: A `setTimeout` triggers if acquisition takes longer than `timeoutMs`, marking `timedOut = true`, splicing the entry out of the queue, and rejecting with `'Lock acquisition timeout'`.

#### `release()`
```javascript
  release() {
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next.timer) clearTimeout(next.timer);
      if (!next.timedOut) {
        next.resolve();
        return;
      }
    }
    this.locked = false;
  }
```
* Shifts the next waiter from the FIFO queue.
* Clears any active timeout timer.
* If the waiter has not timed out, calls `next.resolve()`, transferring lock ownership directly to that task without releasing `locked = false`.
* If no waiters remain in queue, resets `this.locked = false`.

---

### Class 2: `ResourceEngine` (in `e2_engine.js`)

#### State Variables
* `this.resources`: A `Map` storing all registered resources (`id -> { id, name, type, capacity, mutex, bookings }`).
* `this.inFlight`: A `Set` of active `eventId`s currently undergoing reserve, commit, or release. Prevents race conditions on the same event across concurrent requests.
* `this.holdTimers`: A `Map` of active `setTimeout` handles for uncommitted reservations.
* `this.holdTimeoutMs`: Default TTL for uncommitted reservations (default: 30,000 ms).
* `this.e3`: Injected persistence adapter for Engine 3.

#### Resource Pool Management
* `addResource(id, metadata)`: Normalises `id` to string, instantiates a dedicated `Mutex` and an empty `bookings` array. If already present, updates metadata.
* `hasResource(id)`: Checks if a resource exists in the pool.
* `listResources()`: Returns metadata array of all resources.

#### Normalization & Sorting
```javascript
  _normalizeIds(resourceIds) {
    if (!Array.isArray(resourceIds)) return [];
    return [...new Set(resourceIds.map(id => String(id).trim()))].sort();
  }
```
* `String(id).trim()`: Normalises all inputs (ensures `1` and `"1"` refer to the same resource).
* `new Set(...)`: Deduplicates IDs in case the caller passed `['Lab 1', 'Lab 1']`.
* `.sort()`: **Crucial for deadlock prevention**. Lexicographically sorts unique resource IDs so every request acquires locks in identical order.

#### Lock Acquisition & Release
* `_acquireLocks(orderedIds)`: Iterates through the sorted IDs, calls `res.mutex.acquire()`, and tracks held IDs. If an error occurs, catches it, releases all currently held locks, and rethrows.
* `_releaseLocks(heldIds)`: Iterates backwards from `heldIds.length - 1` down to `0`, releasing mutexes in strict reverse order (LIFO).

#### Overlap Check Function
```javascript
  overlaps(bookings, start, end, excludeEventId = null) {
    const now = Date.now();
    for (const b of bookings) {
      if (excludeEventId && b.eventId === excludeEventId) continue;
      if (b.state === 'RESERVED' && b.expiresAt && b.expiresAt <= now) continue;
      if (b.start < end && start < b.end) {
        return b;
      }
    }
    return null;
  }
```
* **Half-Open Intervals $[start, end)$:** Standard OS time interval semantics.
* Mathematical overlap formula: `b.start < end && start < b.end`.
  * If Event A ends at 11:00 and Event B starts at 11:00, `b.start < end` is true ($10 < 12$), but `start < b.end` is false ($11 < 11$ is false). They touch, but **do not overlap**.
* Expired hold filter: Any uncommitted reservation whose `expiresAt <= now` is skipped.

#### The `reserve()` Method (Phase 1: Two-Phase Hold)
1. **Validation:** Checks that `eventId` is non-empty, `resourceIds` is a valid array, and `start < end` with numeric types. If invalid, returns `{ status: 'REJECTED' }`.
2. **Pool Existence:** Validates that every requested resource exists. Returns `{ status: 'NOT_FOUND' }` if missing.
3. **In-Flight Guard:** If another thread is actively operating on `normEventId`, returns `{ status: 'REJECTED' }`. Adds `normEventId` to `this.inFlight`.
4. **Lock Acquisition:** Calls `_acquireLocks(orderedIds)`.
5. **Conflict Evaluation:** Iterates through every resource and tests `overlaps()`. If any resource is taken, returns `{ status: 'BUSY', resource: clashId, busyUntil: clash.end }`.
6. **All-or-Nothing Placement:** If all resources are free, creates a booking with `state: 'RESERVED'`, sets an expiry timer (`this.holdTimers`), and pushes the booking into all resources.
7. **Finally Block:** Releases all held mutexes in reverse order and removes `normEventId` from `this.inFlight`.

#### The `commit()` Method (Phase 2: Persistent Commit)
1. **In-Flight Guard:** Prevents concurrent modifications on the event.
2. **State Inspection:** Finds existing bookings for `normEventId`.
   * If none found: Returns `{ status: 'NOT_FOUND' }`.
   * If already committed: Returns `{ status: 'COMMITTED' }` (**idempotent execution**).
   * If hold expired: Cleans up and returns `{ status: 'NOT_FOUND' }`.
3. **Locking:** Acquires mutexes on the booked resources.
4. **Persistence Hook (E3):** Calls `await this.e3.save(record)`.
   * **Rollback on Error:** If `save()` fails (e.g. database error), E2 immediately deletes the `RESERVED` booking, clears hold timers, and returns `{ status: 'FAILED' }`.
5. **Transition:** If `save()` succeeds, updates booking states from `'RESERVED'` to `'COMMITTED'`, clears the TTL timer, and returns `{ status: 'COMMITTED' }`.

#### The `release()` Method
1. Finds bookings for `normEventId`.
2. If bookings are in `'RESERVED'` state: Simply drops them and clears the timer.
3. If bookings are in `'COMMITTED'` state: Calls `await this.e3.remove(normEventId)`.
   * If `remove()` fails: Retains the in-memory allocation and returns `{ status: 'FAILED' }` to prevent data divergence between E2 and E3.
   * If `remove()` succeeds: Drops the bookings and returns `{ status: 'RELEASED' }`.

#### The `isFree()` Method (Read-Only)
* Strictly read-only query.
* Never acquires locks and never creates reservations.
* Returns `{ free: true }` or `{ free: false, reason: 'BUSY', busyUntil }`.
* Can produce a slightly stale answer if a concurrent write is in progress, but provides maximum throughput for UI availability checks (dirty reads acceptable; authoritative decisions always take the lock).

---

### Class 3: `E1Adapter` (in `adapters/e1_adapter.js`)
* Bridges between the team handbook specification and the live code implementation of Engine 1.
* Handles both single `resource_id` and array `resourceIds`.
* Formats timestamps to plain numbers via `parseTimeValue`.
* Generates deterministic `alloc_id` strings: `alloc_${eventId}_${sanitizedResources}_${start}`.
* Automatically creates missing resources in the pool to support dynamic solver placement.

---

### Class 4: `E3Adapter` (in `adapters/e3_adapter.js`)
* Interacts with Engine 3's PostgreSQL database.
* Translates numeric time values to PostgreSQL `TIMESTAMP WITHOUT TIME ZONE` strings (`"YYYY-MM-DD HH:mm:ss"`).
* Executes atomic SQL transactions across `allocation` and `resource` tables.
* Implements automatic fallback to `E3PersistenceStub` if PostgreSQL is offline or in isolated test mode.

---

## 4. Viva Defense Questions & Answers (Cheat Sheet for Saish)

### Q1: Why did you implement concurrency control in Node.js memory instead of relying solely on PostgreSQL row-level locks?
**Answer:**  
"Engine 1's timetable solver runs iterative algorithms (DSATUR and sweep-line) that test hundreds of candidate slots per second. If every candidate test required opening a database connection, executing `SELECT ... FOR UPDATE`, and rolling back, network latency and database connection pool exhaustion would cripple performance (violating NFR-01's 2-second SLA). By keeping the lock manager and availability checker in Node.js memory, resource checks execute in microseconds. Once a slot is decided, the two-phase commit persists the final allocation to PostgreSQL."

### Q2: How do you prove that Engine 2 will never deadlock under concurrent requests?
**Answer:**  
"A deadlock requires four Coffman conditions: Mutual Exclusion, Hold and Wait, No Preemption, and Circular Wait. We mathematically eliminate the **Circular Wait** condition using Dijkstra's Resource Hierarchy. Before acquiring any mutex, Engine 2 normalises, deduplicates, and sorts the resource IDs lexicographically (`A < B < C`). Regardless of the order in which resources are requested by clients, every thread acquires locks in the exact same global sequence. Therefore, a cycle in the resource allocation graph can never form."

### Q3: What happens if a scheduler reserves a venue and then crashes before committing?
**Answer:**  
"Engine 2 implements uncommitted hold expiry (Rule 7). When `reserve()` succeeds, it sets a Time-To-Live timer (`holdTimeoutMs`, default 30s). If `commit()` is not received before the TTL expires, Engine 2's `_expireHold()` method automatically deletes the reservation and clears the hold. Future availability checks will immediately see the venue as free again. No resources are permanently leaked."

### Q4: Why is `commit()` designed to be idempotent?
**Answer:**  
"In distributed systems and microservice architectures, network timeouts or retries can cause a client to send the same `commit(eventId)` message twice. If `commit()` were not idempotent, the second call might treat the already-committed booking as a clash or return an error. Engine 2 checks if the event is already in the `COMMITTED` state and immediately returns success without re-executing persistence hooks or throwing an error."

### Q5: Why does `isFree()` not acquire mutex locks?
**Answer:**  
"Engine 4 needs to display real-time venue availability on the coordinator's web screen. If `isFree()` acquired mutexes, read-only UI queries would contend with and delay active scheduling operations in Engine 1. In OS terminology, `isFree()` is an un-locked reader (dirty read). It gives an immediate sub-millisecond answer for UI guidance, while the authoritative reservation is always guaranteed under the mutex lock in `reserve()`."

### Q6: What happens if Engine 3's database goes down during a commit?
**Answer:**  
"Engine 2 enforces strict transactional rollback (Rule 5). In `commit()`, if the injected `e3.save()` hook throws an error, E2 catches the exception, completely purges the `RESERVED` booking from all resources, cancels the hold timer, and returns `{ status: 'FAILED' }`. The system does not leave orphan in-memory reservations that cannot be saved to disk."
