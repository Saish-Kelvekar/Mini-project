'use strict';
/**
 * routes/eventRoutes.js - REST endpoints exposed by Engine 3 (mounted at /api).
 */

const express = require('express');
const c = require('../controllers/eventController');

const router = express.Router();

router.get('/health', c.health);
router.get('/health/db', c.healthDb);

// Data for the scheduler (Engine 1/2)
router.get('/events/approved', c.getApprovedEvents);
router.get('/venues', c.getVenues);

// Events / proposals
router.post('/events', c.createEvent);
router.get('/events/:id', c.getEvent);
router.patch('/events/:id/status', c.setEventStatus);
router.post('/events/:id/register', c.registerStudent);
router.post('/events/:id/scores', c.submitScore);

// Timetable versions
router.post('/versions', c.createVersion);
router.get('/versions/:id/schedule', c.getSchedule);
router.put('/versions/:id/schedule', c.saveSchedule);
router.post('/versions/:id/conflicts/detect', c.detectConflicts);
router.post('/versions/:id/publish', c.publishVersion);

module.exports = router;
