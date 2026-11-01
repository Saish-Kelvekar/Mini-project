const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { users, publicUser } = require('./users');
const { MATRIX } = require('./permissions');
const { createStore } = require('./store');
const { validateEvent } = require('./validate');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';

function createApp() {
  const app = express();
  const store = createStore();
  app.use(express.json());

  // --- Auth + role enforcement (NFR-04): 401 = not authenticated, 403 = wrong role ---
  const guard = (key) => (req, res, next) => {
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'Sign in to continue.' });

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      return res.status(401).json({ error: 'Your session is invalid or has expired. Sign in again.' });
    }

    const allowed = MATRIX[key] || []; // not in matrix => denied for everyone
    if (!allowed.includes(payload.role)) {
      store.logAudit({ user: payload.name, role: payload.role, action: key, result: 'DENIED (role)' });
      return res.status(403).json({ error: 'Your role is not allowed to do this.' });
    }
    req.user = payload;
    next();
  };

  app.post('/auth/login', (req, res) => {
    const { email, password } = req.body || {};
    const user = users.find((u) => u.email === String(email || '').toLowerCase());
    // Same message for unknown user and wrong password, so accounts cannot be probed.
    if (!user || !bcrypt.compareSync(String(password || ''), user.passwordHash))
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    const token = jwt.sign({ sub: user.id, role: user.role, name: user.name }, JWT_SECRET,
                           { algorithm: 'HS256', expiresIn: '1h' });
    res.json({ token, user: publicUser(user) });
  });

  app.get('/auth/me', guard('GET /auth/me'), (req, res) => {
    res.json({ user: publicUser(users.find((u) => u.id === req.user.sub)) });
  });

  app.post('/auth/change-password', guard('POST /auth/change-password'), (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    const user = users.find((u) => u.id === req.user.sub);
    if (!user || !bcrypt.compareSync(String(currentPassword || ''), user.passwordHash))
      return res.status(400).json({ error: 'Current password is incorrect.' });
    if (!newPassword || String(newPassword).length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    user.passwordHash = bcrypt.hashSync(String(newPassword), 8);
    res.json({ ok: true });
  });

  // --- Events (FR-01). Persistence is a stub until E3's POST /events is ready. ---
  app.get('/events', guard('GET /events'), (req, res) => {
    const { role, sub } = req.user;
    let list = store.state.events;
    if (role === 'coordinator') list = list.filter((e) => e.ownerId === sub); // scoped to own events
    if (role === 'student') list = list.filter((e) => e.status === 'Published');
    const formatted = list.map((e) => ({
      ...e,
      registered: role === 'student' && Array.isArray(e.registrations)
        ? e.registrations.some((r) => r.studentId === sub)
        : false,
      registeredCount: Array.isArray(e.registrations) ? e.registrations.length : 0,
      registrations: (role === 'admin' || role === 'coordinator') ? (e.registrations || []) : undefined,
    }));
    res.json({ events: formatted });
  });

  app.post('/events', guard('POST /events'), (req, res) => {
    const { errors, value, ok } = validateEvent(req.body);
    if (!ok) return res.status(400).json({ error: 'Fix the highlighted fields.', errors });
    res.status(201).json({ event: store.addEvent(value, req.user.sub) });
  });

  app.put('/events/:id', guard('PUT /events/:id'), (req, res) => {
    const ev = store.getEvent(Number(req.params.id));
    if (!ev) return res.status(404).json({ error: 'Event not found.' });
    if (req.user.role === 'coordinator' && ev.ownerId !== req.user.sub) {
      store.logAudit({ user: req.user.name, role: req.user.role, action: `PUT /events/${ev.id}`,
                       result: 'DENIED (not owner)' });
      return res.status(403).json({ error: 'You can only edit your own events.' });
    }
    const { errors, value, ok } = validateEvent(req.body);
    if (!ok) return res.status(400).json({ error: 'Fix the highlighted fields.', errors });
    Object.assign(ev, value);
    res.json({ event: ev });
  });

  // --- Student Event Registration ---
  app.post('/events/:id/register', guard('POST /events/:id/register'), (req, res) => {
    const ev = store.getEvent(Number(req.params.id));
    if (!ev) return res.status(404).json({ error: 'Event not found.' });
    if (!Array.isArray(ev.registrations)) ev.registrations = [];

    const studentId = req.user.sub;
    const exists = ev.registrations.some((r) => r.studentId === studentId);
    if (exists) return res.status(409).json({ error: 'You are already registered for this event.' });

    ev.registrations.push({
      studentId,
      studentName: req.user.name,
      registeredAt: new Date().toISOString(),
    });
    res.status(201).json({
      ok: true,
      message: `Registered for ${ev.name}!`,
      event: { ...ev, registered: true, registeredCount: ev.registrations.length },
    });
  });

  app.delete('/events/:id/register', guard('DELETE /events/:id/register'), (req, res) => {
    const ev = store.getEvent(Number(req.params.id));
    if (!ev) return res.status(404).json({ error: 'Event not found.' });
    if (!Array.isArray(ev.registrations)) ev.registrations = [];

    const studentId = req.user.sub;
    const idx = ev.registrations.findIndex((r) => r.studentId === studentId);
    if (idx === -1) return res.status(404).json({ error: 'You are not registered for this event.' });

    ev.registrations.splice(idx, 1);
    res.json({
      ok: true,
      message: `Cancelled registration for ${ev.name}.`,
      event: { ...ev, registered: false, registeredCount: ev.registrations.length },
    });
  });

  // --- Timetable (STUBS: E1 generates, E3 stores/publishes) ---
  app.post('/timetable/generate', guard('POST /timetable/generate'), (req, res) => {
    const events = store.state.events.filter((e) => e.status !== 'Published');
    if (!events.length) return res.status(409).json({ error: 'No submitted events to schedule.' });
    let cursor = 9 * 60; // 09:00, events placed back to back
    const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const entries = events.map((e) => {
      const start = cursor;
      cursor += e.durationMinutes;
      e.status = 'Scheduled';
      return { eventId: e.id, name: e.name, venue: e.preferredVenue || 'Main Hall',
               date: e.preferredDate || 'Day 1', start: hhmm(start), end: hhmm(cursor),
               judges: e.judgesRequired };
    });
    const prev = store.state.timetable;
    store.state.timetable = { version: prev ? prev.version : 0, published: false, entries,
                              stub: 'Placeholder for E1 timetable generation.' };
    res.json({ timetable: store.state.timetable });
  });

  app.post('/timetable/publish', guard('POST /timetable/publish'), (req, res) => {
    const tt = store.state.timetable;
    if (!tt) return res.status(409).json({ error: 'Generate a timetable before publishing.' });
    tt.version += 1;
    tt.published = true;
    tt.entries.forEach((en) => { const ev = store.getEvent(en.eventId); if (ev) ev.status = 'Published'; });
    res.json({ timetable: tt });
  });

  app.get('/timetable', guard('GET /timetable'), (req, res) => {
    const tt = store.state.timetable;
    if (!tt || (!tt.published && req.user.role !== 'admin')) return res.json({ timetable: null });
    res.json({ timetable: tt });
  });

  app.get('/schedule/me', guard('GET /schedule/me'), (req, res) => {
    const tt = store.state.timetable;
    res.json({ entries: tt && tt.published ? tt.entries : [],
               stub: 'Placeholder until judge assignments come from E2/E3.' });
  });

  app.get('/audit', guard('GET /audit'), (req, res) => res.json({ audit: store.state.audit }));

  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  return app;
}

module.exports = { createApp };
