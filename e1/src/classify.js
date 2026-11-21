// =============================================================================
// RULE-BASED CONFLICT CLASSIFICATION
// Flowchart step 5 ("Conflict / overlap classification").
// Doc 4.18: identifies acceptable, resource, participant and unresolved critical conflicts.
// Doc 4.17: report order is critical > resource > participant > acceptable.
//
// E1 first collects plain FACTS about a problem (was the event left unplaced?
// do two events share a judge? did E2 say BUSY?). The rules below are checked
// from top to bottom; the first rule that matches decides the category.
// =============================================================================

// Lower number = more serious. Used for sorting.
const SEVERITY = {
  critical: 0,
  resource: 1,
  participant: 2,
  acceptable: 3,
};

const RULES = [
  {
    name: 'Event could not be placed at all',
    matches: (facts) => facts.unplaced,
    category: 'critical',
    status: 'unresolved',
  },
  {
    // E1 should never create this. It is a safety check on the final timetable
    // and on existing schedules that come in from E3.
    name: 'Same venue, judge or resource booked twice at the same time',
    matches: (facts) => facts.overlap
      && (facts.sharedVenue || facts.sharedJudges.length > 0 || facts.sharedResources.length > 0),
    category: 'critical',
    status: 'unresolved',
  },
  {
    // E2 said BUSY, or the preferred venue/date was taken. E1 already moved the
    // event or swapped the judge, so it is solved, but we still report it.
    name: 'Resource was busy and E1 found another option',
    matches: (facts) => facts.busy || facts.moved,
    category: 'resource',
    status: 'resolved',
  },
  {
    name: 'The same students are registered for two overlapping events',
    matches: (facts) => facts.overlap && facts.sharedParticipants.length > 0,
    category: 'participant',
    status: 'warning',
  },
  {
    name: 'Events run in parallel in different venues with nothing shared',
    matches: (facts) => facts.overlap,
    category: 'acceptable',
    status: 'ok',
  },
];

const DEFAULT_FACTS = {
  unplaced: false,
  overlap: false,
  busy: false,
  moved: false,
  sharedVenue: false,
  sharedJudges: [],
  sharedResources: [],
  sharedParticipants: [],
};

// facts -> { category, status, severity }, or null when nothing is wrong.
function classify(facts) {
  const allFacts = { ...DEFAULT_FACTS, ...facts };
  for (const rule of RULES) {
    if (rule.matches(allFacts)) {
      return { category: rule.category, status: rule.status, severity: SEVERITY[rule.category] };
    }
  }
  return null;
}

// Items that appear in both lists.
function itemsInBoth(listA = [], listB = []) {
  const setA = new Set(listA);
  return listB.filter((item) => setA.has(item));
}

// Facts about two placed events that overlap in time.
function pairFacts(eventA, eventB) {
  return {
    overlap: true,
    sharedVenue: eventA.venue === eventB.venue,
    sharedJudges: itemsInBoth(eventA.judgeIds, eventB.judgeIds),
    sharedResources: itemsInBoth(eventA.resources, eventB.resources),
    sharedParticipants: itemsInBoth(eventA.participants, eventB.participants),
  };
}

// Most serious first; within the same category, earliest first.
function rankConflicts(conflicts) {
  return [...conflicts].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity - b.severity;
    const startA = a.start === undefined ? Infinity : a.start;
    const startB = b.start === undefined ? Infinity : b.start;
    return startA - startB;
  });
}

module.exports = { classify, pairFacts, rankConflicts, SEVERITY, RULES };
