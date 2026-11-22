// =============================================================================
// E1 – TIMETABLE GENERATION & OPTIMIZATION
//
// generateTimetable(events, options) runs the E1 flowchart from the Sprint 1 doc
// using the three agreed algorithms:
//   dsatur.js     DSATUR graph colouring      -> which event to schedule first
//   sweepLine.js  sweep-line + interval tree  -> is a slot free? which events overlap?
//   classify.js   rule-based classification   -> critical / resource / acceptable
//
//   Step 1  Read events (+ existing schedules from E3)
//
// Students register only AFTER the timetable is published, so E1 never
// uses registrations: they play no part in DSATUR or in slot selection.
//   Step 2  DSATUR order: most constrained event first
//   Step 3  For each event, check candidate slots with interval trees
//   Step 4  Ask E2 to reserve. BUSY -> mark slot unavailable, try another judge
//           or the next slot. No slot left at all -> critical conflict.
//   Step 5  Sweep-line over the finished timetable, classify and rank conflicts
//   Step 6  Return the timetable; the caller stores it through E3
//
// Inside E1 a moment in time is one number: minutes from 00:00 on day 0
// (the "base date"). Day 2 at 14:00 = 2 * 1440 + 840. Easy to compare, and
// it is what E2's reserve() expects.
// =============================================================================
const path = require('path');
const { buildConflictGraph, dsatur } = require('./dsatur');
const { IntervalTree, findOverlaps } = require('./sweepLine');
const { classify, pairFacts, rankConflicts } = require('./classify');

// Default settings; any of them can be passed in `options`.
// Venues and judges are placeholders until E3 provides the real tables.
const DEFAULTS = {
  dayStart: 9 * 60,   // 09:00
  dayEnd: 18 * 60,    // 18:00
  step: 15,           // try start times every 15 minutes
  horizonDays: 30,    // how many days E1 may use
  venues: ['Main Hall', 'Auditorium', 'Seminar Hall', 'Lab 1', 'Lab 2', 'Lab 3'],
  judges: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `judge-${n}`, name: `Judge ${n}` })),
};

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_DAY = MINUTES_PER_DAY * 60 * 1000;

// ---------------------------------------------------------------------------
// Small date/time helpers (UTC, so daylight saving never shifts a day)
// ---------------------------------------------------------------------------

function isValidDate(text) {
  return typeof text === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(text) && !isNaN(Date.parse(`${text}T00:00:00Z`));
}

function dateToDay(date, baseDate) {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${baseDate}T00:00:00Z`)) / MS_PER_DAY);
}

function dayToDate(day, baseDate) {
  return new Date(Date.parse(`${baseDate}T00:00:00Z`) + day * MS_PER_DAY).toISOString().slice(0, 10);
}

function toClock(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function fromClock(clock) {
  const [hours, minutes] = clock.split(':').map(Number);
  return hours * 60 + minutes;
}

// absolute minute -> { date: '2026-11-25', clock: '09:30' }
function describe(minute, baseDate) {
  const day = Math.floor(minute / MINUTES_PER_DAY);
  return { date: dayToDate(day, baseDate), clock: toClock(minute - day * MINUTES_PER_DAY) };
}

// ---------------------------------------------------------------------------
// Step 1: input
// ---------------------------------------------------------------------------

// Free text from the E4 form -> clean list.
// "Projector, 2 mics; sound system and stage" -> ['projector', 'mics', 'sound system', 'stage']
// The quantity is dropped because E2 books each resource as one unit.
function parseResources(input) {
  const parts = Array.isArray(input) ? input : String(input || '').split(/[,;\n]|\band\b/i);
  const resources = [];
  for (const part of parts) {
    const name = String(part).trim().toLowerCase().replace(/^\d+\s*(x\s*)?/, '').replace(/\s+/g, ' ').trim();
    if (name && !resources.includes(name)) resources.push(name);
  }
  return resources;
}

// An event as E4 stores it -> the fields E1 needs.
function normaliseEvent(event) {
  let duration = Number(event.durationMinutes ?? event.duration);
  if (isNaN(duration)) duration = Math.round(Number(event.durationHours) * 60);

  const id = event.id ?? event.eventId;
  return {
    id,
    name: event.name || `Event ${id}`,
    duration,
    judgesRequired: Number(event.judgesRequired) || 0,
    preferredVenue: (event.preferredVenue || '').trim(),
    preferredDate: isValidDate(event.preferredDate) ? event.preferredDate : '',
    resources: parseResources(event.resourcesRequired ?? event.resources),
  };
}

// Day 0: the given start date, else today (or an earlier preferred date).
function chooseBaseDate(startDate, events) {
  if (isValidDate(startDate)) return startDate;
  const today = new Date().toISOString().slice(0, 10);
  const earliest = events.map((e) => e.preferredDate).filter(Boolean).sort()[0];
  return earliest && earliest < today ? earliest : today;
}

// ---------------------------------------------------------------------------
// Bookings: one interval tree per venue / judge / resource
// ---------------------------------------------------------------------------

// Keys are used for the trees and as resource ids sent to E2.
const venueKey = (venue) => `venue:${venue}`;
const judgeKey = (judgeId) => `judge:${judgeId}`;
const resourceKey = (resource) => `res:${resource}`;

class Bookings {
  constructor(judges) {
    this.trees = new Map();
    this.judges = judges;
    this.judgeMinutes = new Map(judges.map((j) => [String(j.id), 0])); // to share work fairly
  }

  tree(key) {
    if (!this.trees.has(key)) this.trees.set(key, new IntervalTree());
    return this.trees.get(key);
  }

  // The booking blocking [start, end) for this key, or null when free.
  clash(key, start, end) {
    return this.tree(key).firstOverlap(start, end);
  }

  allFree(keys, start, end) {
    return keys.every((key) => this.clash(key, start, end) === null);
  }

  // `count` free judges, least busy first, or null if there are not enough.
  freeJudges(count, start, end, excluded) {
    if (count === 0) return [];
    const free = this.judges
      .map((j) => String(j.id))
      .filter((id) => !excluded.has(id) && this.clash(judgeKey(id), start, end) === null);
    if (free.length < count) return null;
    free.sort((a, b) => (this.judgeMinutes.get(a) - this.judgeMinutes.get(b)) || a.localeCompare(b));
    return free.slice(0, count);
  }

  book(placement) {
    const interval = { id: placement.eventId, start: placement.startAbs, end: placement.endAbs };
    const keys = [
      venueKey(placement.venue),
      ...placement.judgeIds.map(judgeKey),
      ...placement.resources.map(resourceKey),
    ];
    for (const key of keys) this.tree(key).insert({ ...interval });
    for (const judgeId of placement.judgeIds) {
      this.judgeMinutes.set(judgeId, (this.judgeMinutes.get(judgeId) || 0) + interval.end - interval.start);
    }
  }
}

// ---------------------------------------------------------------------------
// E2 connection (doc 4.19: E1 -> E2 checkAndReserve)
// ---------------------------------------------------------------------------

// e2/e2.js currently cannot be loaded: its last line says `GPUShaderModule.exports`
// instead of `module.exports`. Until E2 fixes it, E1 uses this stand-in, which
// follows the same rule as E2's reserve(): if any item has an overlapping
// booking answer BUSY, otherwise book all of them.
class E2StandIn {
  constructor() { this.resources = new Map(); }
  addResource(id) { this.resources.set(id, { bookings: [] }); }
  async reserve(eventId, resourceIds, start, end) {
    const ordered = [...resourceIds].sort();
    for (const id of ordered) {
      const clash = this.resources.get(id).bookings.find((b) => b.start < end && start < b.end);
      if (clash) return { status: 'BUSY', resource: id, busyUntil: clash.end };
    }
    for (const id of ordered) this.resources.get(id).bookings.push({ eventId, start, end, state: 'RESERVED' });
    return { status: 'RESERVED', eventId };
  }
}

// What E1 calls. `engine` is E2's ResourceEngine (or the stand-in).
class E2Client {
  constructor(engine, source = 'custom', loadError = null) {
    this.engine = engine;
    this.source = source;
    this.loadError = loadError;
  }

  // { eventId, resourceIds, start, end } -> { status: 'RESERVED' } or { status: 'BUSY', resource, busyUntil }
  async checkAndReserve({ eventId, resourceIds, start, end }) {
    for (const id of resourceIds) {
      if (!this.engine.resources.has(id)) this.engine.addResource(id); // E2 needs resources registered first
    }
    return this.engine.reserve(eventId, resourceIds, start, end);
  }
}

function connectToE2() {
  try {
    const { ResourceEngine } = require(path.join(__dirname, '..', '..', 'e2', 'e2.js'));
    return new E2Client(new ResourceEngine(), 'e2');
  } catch (err) {
    return new E2Client(new E2StandIn(), 'local-stub', err.message);
  }
}

// ---------------------------------------------------------------------------
// Steps 3 and 4: find a slot for one event
// ---------------------------------------------------------------------------

// Try one candidate (day, venue, start time).
// Returns { placement }, or { venueBusyUntil } when the venue is taken, or {}.
async function trySlot(run, event, eventIndex, day, venue, time, busyReplies) {
  const { bookings, e2 } = run;
  const start = day * MINUTES_PER_DAY + time;
  const end = start + event.duration;

  // Step 3: E1's own interval-tree checks.
  const venueClash = bookings.clash(venueKey(venue), start, end);
  if (venueClash) return { venueBusyUntil: venueClash.end - day * MINUTES_PER_DAY };
  if (!bookings.allFree(event.resources.map(resourceKey), start, end)) return {};

  // Step 4: pick judges and ask E2. Loop, because a busy judge can be swapped
  // for another one without moving the event.
  const excludedJudges = new Set();
  while (true) {
    const judgeIds = bookings.freeJudges(event.judgesRequired, start, end, excludedJudges);
    if (judgeIds === null) return {}; // not enough judges now -> next slot

    const reply = await e2.checkAndReserve({
      eventId: event.id,
      resourceIds: [venueKey(venue), ...judgeIds.map(judgeKey), ...event.resources.map(resourceKey)],
      start,
      end,
    });
    if (reply.status === 'RESERVED') {
      return { placement: { eventId: event.id, name: event.name, venue, day, startAbs: start, endAbs: end, judgeIds,
                            resources: event.resources, group: run.groupOf[eventIndex] } };
    }

    // BUSY is not critical. Remember it (reported as a resolved resource conflict) and retry.
    busyReplies.push({ resource: reply.resource, at: start });
    const busyId = String(reply.resource);
    if (busyId.startsWith('judge:')) {
      excludedJudges.add(busyId.slice('judge:'.length)); // same slot, another judge
      continue;
    }
    // Venue or resource busy: mark this slot unavailable, then try the next one.
    bookings.tree(busyId).insert({ id: `busy-in-e2-${start}-${busyId}`, start, end: Math.max(end, reply.busyUntil || end) });
    if (busyId.startsWith('venue:')) {
      return { venueBusyUntil: Math.max(time + run.settings.step, (reply.busyUntil || 0) - day * MINUTES_PER_DAY) };
    }
    return {};
  }
}

async function findSlotOnDay(run, event, eventIndex, day, venues, busyReplies) {
  const { dayStart, dayEnd, step } = run.settings;
  const latestStart = dayEnd - event.duration;

  // DSATUR group: if an event of the same colour is already on this day, try
  // its start time first so compatible events run in parallel.
  const groupStart = run.groupStarts.get(`${run.groupOf[eventIndex]}@${day}`);
  if (groupStart !== undefined && groupStart <= latestStart) {
    for (const venue of venues) {
      const attempt = await trySlot(run, event, eventIndex, day, venue, groupStart, busyReplies);
      if (attempt.placement) return attempt.placement;
    }
  }

  // Earliest time first. venueBusyUntil skips a venue until it is free again.
  const venueBusyUntil = new Map();
  for (let time = dayStart; time <= latestStart; time += step) {
    for (const venue of venues) {
      if ((venueBusyUntil.get(venue) || 0) > time) continue;
      const attempt = await trySlot(run, event, eventIndex, day, venue, time, busyReplies);
      if (attempt.placement) return attempt.placement;
      if (attempt.venueBusyUntil !== undefined) venueBusyUntil.set(venue, attempt.venueBusyUntil);
    }
  }
  return null;
}

// Preferred date first (then later days, then earlier days), preferred venue first.
async function findSlot(run, event, eventIndex, busyReplies) {
  const preferredDay = event.preferredDate ? dateToDay(event.preferredDate, run.baseDate) : 0;
  const days = [];
  for (let day = Math.max(0, preferredDay); day <= run.lastDay; day++) days.push(day);
  for (let day = 0; day < preferredDay; day++) days.push(day);

  const venueOrder = event.preferredVenue
    ? [[event.preferredVenue], run.venues.filter((v) => v !== event.preferredVenue)]
    : [run.venues];

  for (const day of days) {
    for (const venues of venueOrder) {
      const placement = await findSlotOnDay(run, event, eventIndex, day, venues, busyReplies);
      if (placement) return placement;
    }
  }
  return null;
}

function reasonCannotSchedule(event, settings, judgeCount) {
  if (!(event.duration > 0)) return 'Duration is missing or invalid.';
  if (event.duration > settings.dayEnd - settings.dayStart) {
    return `Duration ${event.duration} min is longer than the day window ${toClock(settings.dayStart)}-${toClock(settings.dayEnd)}.`;
  }
  if (event.judgesRequired > judgeCount) return `Needs ${event.judgesRequired} judges but only ${judgeCount} are available.`;
  return null;
}

// Place one event and return the conflicts it caused.
async function scheduleEvent(run, event, eventIndex) {
  const conflicts = [];
  const busyReplies = [];
  let placement = null;

  let reason = reasonCannotSchedule(event, run.settings, run.judges.length);
  if (!reason) {
    placement = await findSlot(run, event, eventIndex, busyReplies);
    if (!placement) reason = `No free venue, judge and resource combination in ${run.lastDay + 1} day(s).`;
  }

  for (const reply of busyReplies) {
    const when = describe(reply.at, run.baseDate);
    conflicts.push({ ...classify({ busy: true }), type: 'E2_BUSY', eventId: event.id, eventName: event.name,
      resource: reply.resource, start: reply.at,
      detail: `${reply.resource} was busy at ${when.date} ${when.clock}; E1 tried another option.` });
  }

  if (!placement) {
    // Every option was tried: only now is it critical.
    conflicts.push({ ...classify({ unplaced: true }), type: 'UNPLACED', eventId: event.id, eventName: event.name, detail: reason });
    return { placement: null, conflicts, unplaced: { eventId: event.id, name: event.name, reason } };
  }

  run.bookings.book(placement);
  const groupKey = `${placement.group}@${placement.day}`;
  if (!run.groupStarts.has(groupKey)) run.groupStarts.set(groupKey, placement.startAbs - placement.day * MINUTES_PER_DAY);

  // Did it miss its preferred venue or date?
  const placedDate = dayToDate(placement.day, run.baseDate);
  const changes = [];
  if (event.preferredVenue && placement.venue !== event.preferredVenue) changes.push(`venue ${event.preferredVenue} -> ${placement.venue}`);
  if (event.preferredDate && placedDate !== event.preferredDate) changes.push(`date ${event.preferredDate} -> ${placedDate}`);
  if (changes.length > 0) {
    conflicts.push({ ...classify({ moved: true }), type: 'PREFERENCE_MOVED', eventId: event.id, eventName: event.name,
      start: placement.startAbs, detail: `Preferred slot was taken; moved (${changes.join(', ')}).` });
  }
  return { placement, conflicts, unplaced: null };
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

async function generateTimetable(rawEvents, options = {}) {
  const startedAt = performance.now();
  const settings = { ...DEFAULTS, ...options };
  const e2 = settings.e2 || connectToE2();
  const judges = settings.judges.map((j) => (typeof j === 'string' ? { id: j, name: j } : j));

  // ---- Step 1: input ----
  const events = rawEvents.map(normaliseEvent);
  const venues = [...settings.venues];
  for (const event of events) {
    if (event.preferredVenue && !venues.includes(event.preferredVenue)) venues.push(event.preferredVenue);
  }
  const baseDate = chooseBaseDate(settings.startDate, events);
  let lastDay = settings.horizonDays - 1;
  for (const event of events) {
    if (event.preferredDate) lastDay = Math.max(lastDay, dateToDay(event.preferredDate, baseDate));
  }

  const bookings = new Bookings(judges);
  const placements = [];
  // Existing (published) schedules keep their slots: book them in E1 and in E2.
  for (const entry of settings.existing || []) {
    const day = dateToDay(entry.date, baseDate);
    const placement = { ...entry, day,
      startAbs: day * MINUTES_PER_DAY + fromClock(entry.start), endAbs: day * MINUTES_PER_DAY + fromClock(entry.end),
      judgeIds: (entry.judgeIds || []).map(String), resources: parseResources(entry.resources), existing: true };
    bookings.book(placement);
    await e2.checkAndReserve({ eventId: placement.eventId, start: placement.startAbs, end: placement.endAbs,
      resourceIds: [venueKey(placement.venue), ...placement.judgeIds.map(judgeKey), ...placement.resources.map(resourceKey)] });
    placements.push(placement);
  }

  // ---- Step 2: DSATUR ----
  // Two events are joined in the conflict graph when they need the same
  // resource or the same preferred venue on the same date. (No students:
  // they register only after the timetable is published.)
  const graph = buildConflictGraph(events, (event) => [
    ...event.resources.map(resourceKey),
    ...(event.preferredVenue && event.preferredDate ? [`${venueKey(event.preferredVenue)}@${event.preferredDate}`] : []),
  ]);
  // On a full DSATUR tie: more judges first, then longer, then with a preferred date, then input order.
  const tieBreak = (i, j) => {
    const a = events[i];
    const b = events[j];
    if (a.judgesRequired !== b.judgesRequired) return b.judgesRequired - a.judgesRequired;
    if (a.duration !== b.duration) return b.duration - a.duration;
    if (Boolean(a.preferredDate) !== Boolean(b.preferredDate)) return a.preferredDate ? -1 : 1;
    return i - j;
  };
  const { colour: groupOf, order } = dsatur(graph, tieBreak);

  // ---- Steps 3 and 4: place events, most constrained first ----
  const run = { settings, e2, judges, venues, baseDate, lastDay, bookings, groupOf, groupStarts: new Map() };
  const conflicts = [];
  const unplaced = [];
  for (const eventIndex of order) {
    const outcome = await scheduleEvent(run, events[eventIndex], eventIndex);
    conflicts.push(...outcome.conflicts);
    if (outcome.placement) placements.push(outcome.placement);
    if (outcome.unplaced) unplaced.push(outcome.unplaced);
  }

  // ---- Step 5: sweep-line over the timetable, then classify ----
  const intervals = placements.map((p) => ({ ...p, id: p.eventId, start: p.startAbs, end: p.endAbs }));
  for (const [first, second] of findOverlaps(intervals)) {
    const facts = pairFacts(first, second);
    const result = classify(facts);
    let detail = 'Runs in parallel in a different venue.';
    if (result.category === 'critical') detail = 'Same venue, judge or resource booked twice.';
    conflicts.push({ ...result, type: 'OVERLAP', eventIds: [first.eventId, second.eventId],
      eventNames: [first.name, second.name], start: Math.max(first.start, second.start), detail });
  }
  const ranked = rankConflicts(conflicts).map((conflict) => {
    const reported = { ...conflict, start: undefined };
    if (conflict.start !== undefined) {
      const when = describe(conflict.start, baseDate);
      reported.date = when.date;
      reported.time = when.clock;
    }
    return reported;
  });

  // ---- Step 6: result in the shape E4 shows ----
  const judgeNames = new Map(judges.map((j) => [String(j.id), j.name]));
  const entries = [...placements]
    .sort((a, b) => (a.startAbs - b.startAbs) || String(a.venue).localeCompare(String(b.venue)))
    .map((p) => ({
      eventId: p.eventId,
      name: p.name,
      venue: p.venue,
      date: describe(p.startAbs, baseDate).date,
      start: describe(p.startAbs, baseDate).clock,
      end: describe(p.endAbs, baseDate).clock,
      judges: p.judgeIds.map((id) => judgeNames.get(id) || id).join(', '),
      judgeIds: p.judgeIds,
      resources: p.resources,
      group: p.group ?? null,
      existing: Boolean(p.existing),
    }));

  const count = (category) => ranked.filter((c) => c.category === category).length;
  const summary = {
    events: events.length,
    placed: placements.filter((p) => !p.existing).length,
    unplaced: unplaced.length,
    critical: count('critical'),
    resource: count('resource'),
    acceptable: count('acceptable'),
    groups: new Set(groupOf).size,
    e2: e2.source,
    e2LoadError: e2.loadError || undefined,
    ms: performance.now() - startedAt,
  };
  return { entries, conflicts: ranked, unplaced, summary };
}

module.exports = { generateTimetable, parseResources, E2Client, E2StandIn, DEFAULTS };
