// In-memory store behind a small interface. E3 (PostgreSQL) replaces this later.
function createStore() {
  const state = { events: [], nextEventId: 1, timetable: null, audit: [] };
  return {
    state,
    addEvent(fields, ownerId) {
      const ev = { id: state.nextEventId++, ...fields, status: 'Submitted', ownerId,
                   registrations: [],
                   createdAt: new Date().toISOString() };
      state.events.push(ev);
      return ev;
    },
    getEvent: (id) => state.events.find((e) => e.id === id),
    logAudit(entry) {
      state.audit.unshift({ at: new Date().toISOString(), ...entry });
      if (state.audit.length > 200) state.audit.pop();
    },
  };
}

module.exports = { createStore };
