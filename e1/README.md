# E1 – Timetable Generation & Optimization

Plain Node.js, no dependencies. Implements the three E1 algorithms from Team4 Sprint 1 (section 4.18) and the E1 flowchart.

## Files
Only four source files, one per algorithm plus the entry file. Each starts with a comment saying what it does.

| File | What it does |
|---|---|
| `src/index.js` | `generateTimetable()`: runs the E1 flowchart steps 1 to 6, keeps the bookings, and calls E2. Start here. |
| `src/dsatur.js` | DSATUR graph colouring: which event to schedule first, and which events form compatible groups. |
| `src/sweepLine.js` | Interval tree ("is this venue/judge free at this time?") and the sweep-line that finds every overlapping pair. |
| `src/classify.js` | Rule-based conflict classification (critical / resource / acceptable) and ranking. |

Tests: `test/algorithms.test.js` (the three algorithms) and `test/engine.test.js` (whole engine, E2 retries, 500-event load test).

## The three algorithms (doc 4.18)
- **DSATUR graph colouring.** Events are nodes; an edge means "cannot run at the same time" (shared named resource, or same preferred venue on the same date; never students, see below). DSATUR always picks the event whose neighbours already use the most different colours, i.e. the one with the fewest options left, so the hardest events get a slot first. Events with the same colour form a compatible group, and E1 tries to start them at the same time.
- **Sweep-line + interval tree.** Intervals sorted by start time; a line moves left to right, keeps the active intervals in an interval tree, drops them when they end, and reports every overlap. The same interval tree is used while placing events to check venues, judges and resources.
- **Rule-based classification.** Rules in order: unplaced or double-booked -> **critical**; E2 BUSY or preferred slot taken -> **resource** (resolved); anything else -> **acceptable**. Ranked critical > resource > acceptable.

## Students and registrations
Students register only **after** the timetable is published, so E1 never reads registrations: they add no edges to the DSATUR graph and play no part in choosing slots. If a student later registers for an event that overlaps one they already have, the website only shows a warning (E4's job; the check is the same half-open overlap rule E1 uses).

## Flow
1. Input events and existing schedules (published entries, standing in for E3).
2. DSATUR order and groups.
3. For each event: candidate slots on the preferred date first, preferred venue first, earliest start first. The interval trees skip busy candidates.
4. Ask E2 `checkAndReserve` for venue + judges + resources. **BUSY is not critical**: E1 marks that slot unavailable, tries another judge, then the next slot, and re-checks with E2.
5. Only when no feasible slot, venue, judge and resource combination is left is the event logged as an unresolved **critical** conflict and left unplaced.
6. Sweep-line over the result, classify and rank conflicts. The caller stores the result (E4's in-memory store until E3 exists).

Coordinators never enter times; E1 picks them inside the day window (default 09:00–18:00, 15-minute steps, 30-day horizon, see `DEFAULTS` in `src/index.js`). The venues and judges in `DEFAULTS` are placeholders until E3 has those tables.

The interval tree is a plain (non-self-balancing) binary search tree to keep it easy to read. Each tree only holds one venue's, judge's or resource's bookings, so it stays small and the 500-event test still runs in about 0.15 s.

Output: `{ entries: [{ eventId, name, venue, date, start, end, judges, judgeIds, resources, group }], conflicts: [...ranked], unplaced, summary }`.

## E2 note
`e2/e2.js` ends with `GPUShaderModule.exports=...` instead of `module.exports=...`, so it throws on `require`. `src/index.js` (`connectToE2`) tries the real E2 first and falls back to a small stand-in (`E2StandIn`) with the same `reserve()` contract; `summary.e2` says which one ran. A test loads E2 with the export line corrected in memory and confirms E1 works with it unchanged.

## Run
```bash
cd e1 && npm test        # 19 tests: interval tree, sweep-line, DSATUR, classification, engine, 500-event load test
```
Load test (doc 4.20 / NFR-01): 500 events, 10 venues, 25 judges finishes in ~0.15 s (limit 2 s).

## How E4 can call it (for the E4 owner; E1 does not change E4)
`generateTimetable` is async and returns the entries in the same shape E4's Timetable page already shows
(`venue, date, start, end, judges`), plus `conflicts`, `unplaced` and `summary`. A drop-in for the
placeholder handler in `e4/server/src/app.js` could look like this:

```js
const { generateTimetable } = require('../../../e1/src');

app.post('/timetable/generate', guard('POST /timetable/generate'), async (req, res, next) => {
  try {
    const events = store.state.events.filter((e) => e.status !== 'Published');
    if (!events.length) return res.status(409).json({ error: 'No submitted events to schedule.' });
    const prev = store.state.timetable;
    const existing = prev && prev.published ? prev.entries : [];   // already-published slots stay booked
    const result = await generateTimetable(events, { existing });  // options: judges, venues, startDate, ...
    const placed = new Set(result.entries.map((en) => en.eventId));
    events.forEach((e) => { if (placed.has(e.id)) e.status = 'Scheduled'; });
    store.state.timetable = { version: prev ? prev.version : 0, published: false, ...result };
    res.json({ timetable: store.state.timetable });
  } catch (err) { next(err); }
});
```
Input fields E1 reads from each event: `id, name, durationMinutes, judgesRequired, preferredVenue,
preferredDate, resourcesRequired` (free text or array).
Options: `judges: [{ id, name }]`, `venues`, `startDate`, `horizonDays`, `dayStart`, `dayEnd`, `step`,
`existing` (placed entries from E3), `e2` (an `E2Client` wrapping an E2 engine).
`summary.critical > 0` means some events could not be placed; E3/E4 can use it to block publishing (doc: 409).
