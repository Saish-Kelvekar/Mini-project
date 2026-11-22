# Engine 2 Integration Notes & Interface Audit

**Author:** Saish Kelvekar (Team 4, Operating Systems Engine)  
**System:** College Event Proposal, Approval and Timetable Generation System  
**Date:** November 2026  

---

## 1. Executive Summary

This document records the architectural discovery and interface verification between **Engine 2 (Resource Availability & Allocation)** and the other three engines (**E1 Timetable Optimization**, **E3 Data & Transaction Management**, and **E4 Access Control & Web Interface**).

All findings are based on direct inspection of the repository source code and the team handbook (sections 4.12, 4.18, 4.19, 4.20, 4.21).

---

## 2. Interface Audit & Findings

### A. Engine 1 (Timetable Generation & Optimization) $\to$ Engine 2

* **Handbook Specification (sections 4.12 & 4.19):**
  * Invocation: `checkAndReserve({ resource_type, resource_id, start, end, event_id })`
  * Expected Return: `{ free: true, alloc_id }` or `{ free: false, reason }`
  * Calling pattern: Evaluated per-resource, one resource ID at a time.
* **Actual Code Discovery (`e1/src/index.js` lines 177–214):**
  * Invocation: `e2.checkAndReserve({ eventId, resourceIds, start, end })`
  * Arguments:
    * `eventId`: String or number identifier (e.g. `1`, `'evt-1'`).
    * `resourceIds`: Array of string tokens formatted with resource domain prefixes:
      * Venues: `'venue:Main Hall'`, `'venue:Lab 1'`
      * Judges: `'judge:judge-1'`, `'judge:judge-2'`
      * Equipment/Resources: `'res:projector'`, `'res:mics'`
    * `start` & `end`: Plain integer numbers representing minutes from 00:00 on day 0 (the base date). For example, day 2 at 14:00 is represented as `2 * 1440 + 840 = 3720`.
  * Expected Return:
    * On success: `{ status: 'RESERVED', eventId }`
    * On clash: `{ status: 'BUSY', resource: clashedId, busyUntil: clashEndTime }`
    * Handled non-critically: E1 catches `BUSY`, logs a resolved resource conflict, and re-slots with an alternate judge or venue.
  * Engine Registry Assumption:
    * In `e1/src/index.js` lines 208–210, E1's `E2Client` directly checks `this.engine.resources.has(id)` and calls `this.engine.addResource(id)` if the resource is not yet in the pool.
* **Resolution in E2:**
  * Created `e2/adapters/e1_adapter.js` with polymorphic parameter parsing.
  * Supports BOTH the single `resource_id` / `event_id` handbook signature and the array-based `resourceIds` / `eventId` signature.
  * Returns `{ free: true, alloc_id, status: 'RESERVED', eventId }` on success, and `{ free: false, status: 'BUSY', resource, busyUntil, reason }` on conflict, satisfying both callers.
  * `alloc_id` generation: Deterministically computed as `alloc_${eventId}_${sanitizedResources}_${start}`.

---

### B. Engine 2 $\to$ Engine 3 (Event Transaction & Data Management)

* **Handbook Specification:**
  * Documented schema: `RESOURCE (resource_id, type, name, capacity, user_id)` and `ALLOCATION (alloc_id, event_id, resource_id, start_time, end_time, UNIQUE(resource_id, start_time))`.
  * Function hooks: `saveAllocation()` and `getResourceData()` inside transactions.
* **Actual Code Discovery (`e3/` directory):**
  * Schema in `e3/schema.sql`:
    * Table 4: `resource (resource_id SERIAL PK, type VARCHAR(20) CHECK (type IN ('Venue', 'Equipment')), name VARCHAR(100) NOT NULL, capacity INT)`.
    * Table 10: `schedule_slot` with PostgreSQL `btree_gist` temporal exclusion constraint:
      ```sql
      EXCLUDE USING gist (
          version_id WITH =,
          venue_id   WITH =,
          tsrange(start_time, end_time) WITH &&
      )
      ```
    * Table 11: `allocation` for equipment with temporal exclusion constraint:
      ```sql
      EXCLUDE USING gist (
          version_id  WITH =,
          resource_id WITH =,
          tsrange(start_time, end_time) WITH &&
      )
      ```
  * Repository Functions in `e3/src/repositories/repositories.js`:
    * `getVenues()` queries venue resources.
    * `addSlot()` and `getSchedule()` persist schedule slots.
    * **MISSING IN E3:** E3 does NOT implement or export `saveAllocation()`, `removeAllocation()`, or `loadAllocations()`. The `allocation` table is created in DDL and only used in raw SQL tests in `e3/tests/booking.test.js`.
  * Database Client: `e3/src/config/db.js` exports `getPool()` (node-postgres `pg.Pool`), `query()`, `withTransaction()`.
  * Timestamp Representation: PostgreSQL `TIMESTAMP WITHOUT TIME ZONE` formatted as `"YYYY-MM-DD HH:mm:ss"`. Node types parser keeps them as raw strings.
* **Resolution in E2:**
  * Implemented `e2/adapters/e3_adapter.js` with full persistence operations (`save`, `remove`, `loadAllocations`, `loadResources`).
  * If the PostgreSQL pool is active, it executes parameterized SQL against `allocation` and `resource`.
  * If offline or in testing mode without a running database, it safely delegates to `e2/e3_stub.js` (in-memory persistence stub) without crashing.
* **Contract of Functions E3 Must Formally Export:**
  To complete full two-way integration with E2, E3 should export the following repository functions:
  1. `saveAllocation({ eventId, resourceIds, start, end, versionId = 1 }, client)`: Persists equipment reservations into `allocation`.
  2. `removeAllocation(eventId, client)`: Deletes allocations for released events.
  3. `loadAllocations(versionId = null, client)`: Queries committed allocations to populate E2's in-memory state on startup.
  4. `getAllResources(client)`: Queries all resources (both `'Venue'` and `'Equipment'`).

---

### C. Engine 4 (Secure Access & Web Interface) $\to$ Engine 2

* **Handbook Specification:**
  * Endpoint: `GET /api/resources/availability?type=&resource_id=&start=&end=`
  * Response: HTTP 200 `{ free: true/false, reason }`, read-only query.
* **Actual Code Discovery (`e4/` directory):**
  * E4 has implemented JWT authentication, role-permission matrix (`server/src/permissions.js`), and event proposal CRUD.
  * The availability check is not yet integrated into the frontend form; `server/src/app.js` contains stubs for timetable publishing and judge assignments (`/schedule/me`).
* **Resolution in E2:**
  * Implemented `GET /api/resources/availability` in `e2/server.js`.
  * Accepts single resource query: `?resource_id=venue:Lab 1&start=...&end=...` (E4 handbook shape).
  * Accepts multi-resource query: `?resources=venue:Lab 1,judge:1,res:projector&start=...&end=...` (E2 multi-resource shape).
  * Calls `engine.isFree()`, which is strictly read-only: never locks, never reserves, and executes in sub-millisecond time.

---

## 3. Discovered Architectural Mismatches & Risks

### Issue 1: E3 Unique Constraint vs. Exclusion Constraint Flaw (Handbook 4.12)
* **Risk:** The handbook mentions `UNIQUE(resource_id, start_time)` for E3. A simple unique index on start time does **NOT** prevent overlapping bookings. For instance:
  * Event A: 10:00 to 12:00 (`start_time = 10:00`)
  * Event B: 11:00 to 13:00 (`start_time = 11:00`)
  Both rows have distinct `start_time` values (10:00 vs 11:00), so `UNIQUE(resource_id, start_time)` would silently allow double-booking!
* **Recommendation:** Team 4 members must note that E3's current `schema.sql` correctly uses PostgreSQL `btree_gist` temporal exclusion constraints (`tsrange(start_time, end_time) WITH &&`). The handbook text in 4.12 must be updated to reference `EXCLUDE USING gist` rather than `UNIQUE(resource_id, start_time)`.

### Issue 2: Single-Resource vs. Multi-Resource Atomic Allocation
* **Risk:** Handbook 4.19 specifies single-resource requests (`resource_id`). If a scheduler requests three resources sequentially across three calls, an intermediate failure leaves the system in a half-reserved state.
* **Resolution:** E2 enforces all-or-nothing multi-resource atomic reservation (`engine.reserve(eventId, [res1, res2, res3], start, end)`). Either all resources are acquired, or zero are held.

### Issue 3: Missing NFR-07 in Traceability Matrix
* **Risk:** Non-Functional Requirement NFR-07 (Zero deadlocks and zero lost updates under concurrent load) is implemented in E2 via lexicographical mutex ordering and in-flight guards, but is omitted from some team traceability tables.
* **Recommendation:** Saish Kelvekar should update section 4.21 and the traceability matrix to map NFR-07 directly to Engine 2's Lock Manager.

### Issue 4: E1 Hardcoded `e2/e2.js` Test Dependency
* **Risk:** In `e1/test/engine.test.js` line 118, the test reads `e2/e2.js` directly with `fs.readFileSync` and performs string replacement on `GPUShaderModule.exports`.
* **Note:** The obsolete `e2.js` has been superseded by `e2_engine.js`. If E1 runs without the stand-in fallback, E1's `connectToE2` will safely switch to `local-stub` as designed in `e1/src/index.js` lines 215–221.

### Issue 5: Root Repository Typos
* **Finding:** The root repository contains both a stub `README.md` and a duplicate `READM.md`. As per instructions, these top-level files were left completely untouched.
