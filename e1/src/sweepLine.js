// =============================================================================
// SWEEP-LINE + INTERVAL TREE  (doc 4.18, flowchart steps 2 and 3)
//
// Part 1, INTERVAL TREE: stores time intervals and answers
//     "Which stored intervals overlap the time range [start, end)?"
// E1 keeps one tree per venue, judge and resource, and asks it
// "is anything booked at this time?" before trying a slot.
//   - It is a binary search tree ordered by interval START time.
//   - Every node also remembers `maxEnd`: the latest END time in its subtree.
//     That lets a search skip a whole subtree that cannot reach our time.
//   - It does not rebalance itself. That keeps it easy to read, and each tree
//     only holds one venue's / judge's / resource's bookings, so it stays small.
// Intervals are half-open [start, end): an event ending at 10:00 does NOT
// clash with one starting at 10:00.
//
// Part 2, SWEEP-LINE: finds every pair of overlapping intervals.
// E1 runs it over the finished timetable; each pair is then classified.
// Imagine a vertical line moving from early to late across a timeline,
// stopping at each interval's start:
//   - "Active" intervals are the ones the line is currently inside.
//   - At a new interval, first drop active intervals that already ended;
//     every interval still active overlaps the new one.
//   - Then the new interval becomes active too.
// Sorting costs O(n log n); after that each interval is compared only with
// the few events running at the same time, not with every other event.
// =============================================================================

// ----------------------------- Part 1: interval tree -----------------------------

class TreeNode {
  constructor(interval) {
    this.interval = interval; // { id, start, end }
    this.left = null;         // intervals that start earlier
    this.right = null;        // intervals that start at the same time or later
    this.maxEnd = interval.end;
  }
}

// Do two half-open intervals overlap?
function intervalsOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

// Order used by the tree. Start time first; end and id only break ties so
// that two different intervals never look identical.
function compareIntervals(a, b) {
  if (a.start !== b.start) return a.start - b.start;
  if (a.end !== b.end) return a.end - b.end;
  return String(a.id).localeCompare(String(b.id));
}

// Recalculate a node's maxEnd from itself and its two children.
function updateMaxEnd(node) {
  let maxEnd = node.interval.end;
  if (node.left && node.left.maxEnd > maxEnd) maxEnd = node.left.maxEnd;
  if (node.right && node.right.maxEnd > maxEnd) maxEnd = node.right.maxEnd;
  node.maxEnd = maxEnd;
}

function insertNode(node, interval) {
  if (node === null) return new TreeNode(interval);
  if (compareIntervals(interval, node.interval) < 0) {
    node.left = insertNode(node.left, interval);
  } else {
    node.right = insertNode(node.right, interval);
  }
  updateMaxEnd(node);
  return node;
}

function smallestNode(node) {
  while (node.left !== null) node = node.left;
  return node;
}

// Standard binary-search-tree delete, then fix maxEnd on the way back up.
function removeNode(node, interval) {
  if (node === null) return null;
  const order = compareIntervals(interval, node.interval);
  if (order < 0) {
    node.left = removeNode(node.left, interval);
  } else if (order > 0) {
    node.right = removeNode(node.right, interval);
  } else {
    // Found it.
    if (node.left === null) return node.right;
    if (node.right === null) return node.left;
    // Two children: copy in the next interval (smallest on the right), then delete that one.
    const successor = smallestNode(node.right);
    node.interval = successor.interval;
    node.right = removeNode(node.right, successor.interval);
  }
  updateMaxEnd(node);
  return node;
}

class IntervalTree {
  constructor() {
    this.root = null;
    this.size = 0;
  }

  insert(interval) {
    this.root = insertNode(this.root, interval);
    this.size += 1;
    return interval;
  }

  // Removes exactly this interval. Returns true if it was in the tree.
  remove(interval) {
    if (!this.contains(interval)) return false;
    this.root = removeNode(this.root, interval);
    this.size -= 1;
    return true;
  }

  contains(interval) {
    let node = this.root;
    while (node !== null) {
      const order = compareIntervals(interval, node.interval);
      if (order === 0) return true;
      node = order < 0 ? node.left : node.right;
    }
    return false;
  }

  // Returns ONE interval that overlaps [start, end), or null if the time is free.
  // This is the question E1 asks most often ("is this venue free at 10:00-11:00?").
  firstOverlap(start, end) {
    let node = this.root;
    while (node !== null) {
      // If something on the left ends after our start, an overlap (if any) is
      // guaranteed to be found on the left, so go left.
      if (node.left !== null && node.left.maxEnd > start) {
        node = node.left;
        continue;
      }
      if (intervalsOverlap(node.interval.start, node.interval.end, start, end)) {
        return node.interval;
      }
      // Everything on the right starts at or after this node. If this node
      // already starts after our end, nothing on the right can overlap.
      if (node.interval.start >= end) return null;
      node = node.right;
    }
    return null;
  }

  // Returns EVERY interval that overlaps [start, end).
  overlaps(start, end) {
    const found = [];
    const visit = (node) => {
      if (node === null) return;
      // Nothing in this subtree ends after our start, so nothing here can overlap.
      if (node.maxEnd <= start) return;
      visit(node.left);
      if (intervalsOverlap(node.interval.start, node.interval.end, start, end)) {
        found.push(node.interval);
      }
      // The right side starts even later; only look there if this node starts before our end.
      if (node.interval.start < end) visit(node.right);
    };
    visit(this.root);
    return found;
  }
}


// ----------------------------- Part 2: sweep-line --------------------------------

function sortByStartTime(intervals) {
  return [...intervals].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return a.end - b.end;
  });
}

// intervals: [{ id, start, end, ...anything else }]
// returns:   [[intervalA, intervalB], ...] for every pair that overlaps in time
function findOverlaps(intervals) {
  const sorted = sortByStartTime(intervals);
  const activeTree = new IntervalTree(); // the doc's "interval tree of active intervals"
  let activeList = [];                   // same intervals, kept as a list so we can expire them
  const overlappingPairs = [];

  for (const current of sorted) {
    // 1. Drop intervals that finished at or before the current start time.
    const stillActive = [];
    for (const active of activeList) {
      if (active.end <= current.start) {
        activeTree.remove(active);
      } else {
        stillActive.push(active);
      }
    }
    activeList = stillActive;

    // 2. Ask the tree which active intervals overlap the current one.
    for (const other of activeTree.overlaps(current.start, current.end)) {
      overlappingPairs.push([other, current]);
    }

    // 3. The current interval is now active as well.
    activeTree.insert(current);
    activeList.push(current);
  }
  return overlappingPairs;
}

module.exports = { IntervalTree, findOverlaps };
