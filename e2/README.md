# Engine 2 – Resource Availability & Allocation Engine

**College Event Proposal, Approval and Timetable Generation System**  
*Owner:* Saish Kelvekar (Team 4, Operating Systems Engine)  
*Technology Stack:* Plain Node.js (Node 20+), zero mandatory runtime dependencies, optional `pg` driver for PostgreSQL integration.

---

## 1. Scope & Requirements Covered

Engine 2 is the **authoritative gatekeeper** of college resources (venues, faculty judges, coordinators, and equipment). It guarantees that a physical or human resource is never allocated to two overlapping events.

* **FR-03 (Resource Allocation):** Gatekeeper for assigning judges, venues, coordinators, and equipment.
* **NFR-02 (Integrity):** Zero double-booking after commit (100% guarantee).
* **NFR-07 (Concurrency & Robustness):** Zero deadlocks and zero lost updates under concurrent requests.

---

## 2. What Works

1. **Deadlock-Free Lock Manager:**
   - One dedicated asynchronous mutex per resource with strict FIFO queue order (starvation-free).
   - Lexicographical sorting of unique resource IDs prior to acquisition eliminates Coffman's circular wait condition.
   - Configurable lock acquisition timeouts (returns `RETRY` if lock acquisition times out).
   - Strict LIFO reverse-order lock unwinding inside a `finally` block ensures exception safety.
2. **Two-Phase Reservation Protocol:**
   - **Phase 1 (`reserve`):** All-or-nothing hold across multiple resources with configurable TTL (`holdTimeoutMs`). Uncommitted holds automatically expire.
   - **Phase 2 (`commit`):** Idempotent commit transition. Invokes E3 persistence hook (`save`). Automatically rolls back reservation if persistence fails.
3. **Safe Release Lifecycle (`release`):**
   - Dropping a `RESERVED` hold cancels the hold immediately without touching E3.
   - Releasing a `COMMITTED` booking invokes E3's `remove` hook. If deletion fails in E3, E2 retains the allocation and returns `FAILED` to prevent state divergence.
4. **Availability Checker (`isFree`):**
   - Fast, un-locked, read-only availability checks for UI queries.
   - Half-open interval semantics $[start, end)$ allowing contiguous bookings (e.g. 10:00–11:00 and 11:00–12:00 do not clash).
5. **Universal Adapters:**
   - `e2/adapters/e1_adapter.js`: Polymorphic adapter handling both single `resource_id` (handbook 4.19) and array `resourceIds` (`e1/src/index.js`), with deterministic `alloc_id` generation.
   - `e2/adapters/e3_adapter.js`: Hybrid persistence adapter supporting direct PostgreSQL queries or graceful in-memory stub fallback.
6. **HTTP REST API Server (`server.js`):**
   - Implements `POST /api/reserve`, `POST /api/commit`, `POST /api/release`, `GET /api/resources/availability`, and `GET /health`.
   - Ingests seed resources and existing allocations before accepting requests.

---

## 3. What Is Pending (External Team Dependencies)

* **Engine 3 Persistence Functions:** Engine 3's database schema defines the `allocation` table, but `e3/src/repositories/repositories.js` has not yet implemented `saveAllocation()`, `removeAllocation()`, and `loadAllocations()`. E2 currently uses `e2/adapters/e3_adapter.js` with fallback to `e2/e3_stub.js` until E3 exports these methods.
* **Engine 4 Availability Integration:** E4 has defined the endpoint contract `GET /api/resources/availability`, but the frontend event proposal screen has not yet wired this call.

---

## 4. Directory Structure

```text
e2/
├── adapters/
│   ├── e1_adapter.js       # Adapter bridging E1 solver calls to E2
│   └── e3_adapter.js       # Adapter bridging E2 persistence to E3 PostgreSQL
├── test/
│   ├── adapters.test.js    # 8 checks verifying E1 & E3 adapter contracts
│   ├── concurrency.test.js # Stress test: 200 concurrent requests, anti-deadlock verification
│   └── run_all.js          # Master test runner executing all suites
├── demo.js                 # Standalone interactive walkthrough script
├── e2_engine.js            # Core engine: Mutex, LockManager, AvailabilityChecker, ReservationManager
├── e3_stub.js              # In-memory persistence stub with fault injection
├── server.js               # HTTP REST server & bootstrap loader
├── test_e2.js              # Unit test suite passing 36 specification checks
├── test_server.js          # HTTP server test suite passing 6 endpoint checks
├── EXPLAINER.md            # Detailed plain-English explanation for viva defense
├── INTEGRATION_NOTES.md    # Multi-engine discovery and interface mismatch audit
├── package.json            # Node.js project manifest and test scripts
└── README.md               # Engine documentation (this file)
```

---

## 5. How to Run

### Run All Tests
```bash
npm test
```
*Runs all 50 checks across unit, server, adapter, and concurrency stress suites in ~0.3 seconds.*

### Run Unit Tests (36 Checks)
```bash
node test_e2.js
```

### Run Server Tests (6 Checks)
```bash
node test_server.js
```

### Run Concurrency Stress Test (200 Concurrent Requests)
```bash
node test/concurrency.test.js
```

### Run Standalone Demo
```bash
node demo.js
```

### Start the REST API Server
```bash
node server.js
```
*Listens on port 4002 (or `PORT` environment variable).*

---

## 6. HTTP API Reference

### 1. `POST /api/reserve`
* **Body:**
  ```json
  {
    "eventId": "evt-101",
    "resourceIds": ["venue:Main Hall", "judge:1", "res:projector"],
    "start": 540,
    "end": 660,
    "holdTimeoutMs": 30000
  }
  ```
* **Success Response (200):**
  ```json
  {
    "status": "RESERVED",
    "eventId": "evt-101",
    "resourceIds": ["judge:1", "res:projector", "venue:Main Hall"],
    "start": 540,
    "end": 660
  }
  ```
* **Clash Response (200):**
  ```json
  {
    "status": "BUSY",
    "resource": "venue:Main Hall",
    "busyUntil": 660
  }
  ```

### 2. `POST /api/commit`
* **Body:** `{ "eventId": "evt-101" }`
* **Response (200):** `{ "status": "COMMITTED", "eventId": "evt-101" }`

### 3. `POST /api/release`
* **Body:** `{ "eventId": "evt-101" }`
* **Response (200):** `{ "status": "RELEASED", "eventId": "evt-101" }`

### 4. `GET /api/resources/availability`
* **Query Parameters:**
  * Single resource (E4 format): `?resource_id=venue:Main Hall&start=540&end=660`
  * Multi-resource format: `?resources=venue:Main Hall,judge:1&start=540&end=660`
* **Response (200):**
  * When free: `{ "free": true }`
  * When busy: `{ "free": false, "resource": "venue:Main Hall", "busyUntil": 660, "reason": "BUSY" }`
