'use strict';
/**
 * controllers/eventController.js - thin HTTP handlers (no SQL, no business rules).
 * Authentication/authorization belongs to Engine 4; nothing is checked here.
 */

const repo = require('../repositories/repositories');
const timetable = require('../services/timetableService');
const { ValidationError } = require('../services/transactionService');
const { getPool } = require('../config/db');

/** Wrap async handlers so rejected promises reach the error middleware (works on Express 4 and 5). */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parseId(value, name = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError(`${name} must be a positive integer`, { kind: 'invalid_value' });
  }
  return n;
}

const health = asyncHandler(async (req, res) => {
  const { rows } = await getPool().query('SELECT 1 AS ok');
  res.json({ status: 'ok', database: rows[0].ok === 1 });
});

const healthDb = asyncHandler(async (req, res) => {
  const { rows } = await getPool().query('SELECT 1 AS ok');
  res.json({ status: 'healthy', database: 'connected', ok: rows[0].ok === 1 });
});

const getApprovedEvents = asyncHandler(async (req, res) => {
  res.json({ events: await repo.getApprovedEvents(), venues: await repo.getVenues() });
});

const getVenues = asyncHandler(async (req, res) => {
  res.json({ venues: await repo.getVenues() });
});

const createEvent = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const event = await repo.createEvent({
    name: b.name,
    theme: b.theme,
    description: b.description,
    durationMin: b.duration_min,
    judgesRequired: b.judges_required,
    remarks: b.remarks,
    coordinatorId: b.coordinator_id,
  });
  res.status(201).json({ event });
});

const getEvent = asyncHandler(async (req, res) => {
  res.json({ event: await repo.getEventById(parseId(req.params.id)) });
});

const setEventStatus = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const event = await repo.setEventStatus(parseId(req.params.id), b.status, {
    approvedBy: b.approved_by ?? null,
    remarks: b.remarks ?? null,
  });
  res.json({ event });
});

const registerStudent = asyncHandler(async (req, res) => {
  const registration = await repo.registerStudent(parseId((req.body || {}).student_id, 'student_id'), parseId(req.params.id));
  res.status(201).json({ registration });
});

const submitScore = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const score = await repo.submitScore(
    parseId(req.params.id),
    parseId(b.judge_id, 'judge_id'),
    parseId(b.participant_id, 'participant_id'),
    b.points
  );
  res.status(201).json({ score });
});

const createVersion = asyncHandler(async (req, res) => {
  const version = await timetable.createDraftVersion((req.body || {}).version_no);
  res.status(201).json({ version });
});

const saveSchedule = asyncHandler(async (req, res) => {
  const slots = await timetable.saveSchedule(parseId(req.params.id), (req.body || {}).slots);
  res.json({ saved: slots.length, slots });
});

const getSchedule = asyncHandler(async (req, res) => {
  res.json(await timetable.getSchedule(parseId(req.params.id)));
});

const detectConflicts = asyncHandler(async (req, res) => {
  res.json(await timetable.detectConflicts(parseId(req.params.id)));
});

const publishVersion = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const version = await timetable.publishVersion(parseId(req.params.id), b.published_by ?? null);
  res.json({ version });
});

module.exports = {
  asyncHandler,
  health,
  healthDb,
  getApprovedEvents,
  getVenues,
  createEvent,
  getEvent,
  setEventStatus,
  registerStudent,
  submitScore,
  createVersion,
  saveSchedule,
  getSchedule,
  detectConflicts,
  publishVersion,
};
