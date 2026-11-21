// =============================================================================
// DSATUR GRAPH COLOURING
// Doc section 4.18: "Prioritises constrained events and forms compatible event groups."
// Runs before placement, and decides the ORDER in which events get a slot.
//
// The conflict graph:
//   - Every event is a node.
//   - Two events are joined by an edge when they must NOT run at the same time:
//       * they share a registered student, or
//       * they need the same named resource (e.g. the only projector), or
//       * they want the same venue on the same date.
//
// Colouring: give every event a colour (a number 0, 1, 2, ...) so that joined
// events never get the same colour. Events with the same colour can safely run
// in parallel, so each colour is a "compatible group".
//
// DSATUR ("degree of saturation") decides which event to colour next:
//   saturation = how many DIFFERENT colours its neighbours already have.
// An event with high saturation has few options left, so it is the most
// constrained, and we handle it first. Ties are broken by degree (number of
// neighbours) and then by a custom rule (more judges, longer duration, ...).
// The order in which DSATUR picks events is the order E1 schedules them.
// =============================================================================

// events:  any list
// keysOf:  function(event) -> list of strings. Two events that share a key get an edge.
//          Example keys: "student:s1", "res:projector".
// returns: neighbours[i] = Set of indexes of events that clash with event i
function buildConflictGraph(events, keysOf) {
  const neighbours = events.map(() => new Set());

  // Group events by key first ("which events need the projector?"). This is
  // much faster than comparing every pair of events.
  const eventsByKey = new Map();
  events.forEach((event, index) => {
    for (const key of new Set(keysOf(event))) {
      if (!eventsByKey.has(key)) eventsByKey.set(key, []);
      eventsByKey.get(key).push(index);
    }
  });

  // Every two events that share a key are neighbours.
  for (const group of eventsByKey.values()) {
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        neighbours[group[a]].add(group[b]);
        neighbours[group[b]].add(group[a]);
      }
    }
  }
  return neighbours;
}

// Is event `candidate` more constrained than the current `best`?
function isMoreConstrained(candidate, best, neighbours, neighbourColours, tieBreak) {
  const candidateSaturation = neighbourColours[candidate].size;
  const bestSaturation = neighbourColours[best].size;
  if (candidateSaturation !== bestSaturation) return candidateSaturation > bestSaturation;

  const candidateDegree = neighbours[candidate].size;
  const bestDegree = neighbours[best].size;
  if (candidateDegree !== bestDegree) return candidateDegree > bestDegree;

  return tieBreak(candidate, best) < 0;
}

// The uncoloured event with the highest saturation (the DSATUR rule).
function pickNextEvent(colourOf, neighbours, neighbourColours, tieBreak) {
  let best = -1;
  for (let event = 0; event < colourOf.length; event++) {
    if (colourOf[event] !== -1) continue; // already coloured
    if (best === -1 || isMoreConstrained(event, best, neighbours, neighbourColours, tieBreak)) {
      best = event;
    }
  }
  return best;
}

// Lowest colour number that no neighbour is using.
function smallestFreeColour(usedColours) {
  let colour = 0;
  while (usedColours.has(colour)) colour += 1;
  return colour;
}

// neighbours: from buildConflictGraph
// tieBreak(i, j): negative when event i should go before event j (used only on full ties)
// returns: { colour, order, colourCount }
//   colour[i] = group number of event i
//   order     = event indexes in the order DSATUR picked them (most constrained first)
function dsatur(neighbours, tieBreak = (i, j) => i - j) {
  const eventCount = neighbours.length;
  const colourOf = new Array(eventCount).fill(-1);                // -1 = not coloured yet
  const neighbourColours = neighbours.map(() => new Set());       // colours seen next to each event
  const order = [];

  for (let step = 0; step < eventCount; step++) {
    const event = pickNextEvent(colourOf, neighbours, neighbourColours, tieBreak);
    const colour = smallestFreeColour(neighbourColours[event]);
    colourOf[event] = colour;
    order.push(event);

    // Tell the neighbours about the new colour; this raises their saturation.
    for (const neighbour of neighbours[event]) {
      neighbourColours[neighbour].add(colour);
    }
  }

  let colourCount = 0;
  for (const colour of colourOf) colourCount = Math.max(colourCount, colour + 1);
  return { colour: colourOf, order, colourCount };
}

module.exports = { buildConflictGraph, dsatur };
