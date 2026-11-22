-- =============================================================================
-- sample_data.sql - Seed and test data for Engine 3
-- Includes valid schedules, back-to-back valid slots, and deliberate test clashes.
-- =============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- 1. USERS
INSERT INTO app_user (name, email, password_hash, role) VALUES
    ('Admin User',        'admin@college.edu',      'dummy_hash_admin',   'Admin'),
    ('Rahul Coordinator', 'rahul.c@college.edu',    'dummy_hash_coord1',  'Coordinator'),
    ('Meera Coordinator', 'meera.c@college.edu',    'dummy_hash_coord2',  'Coordinator'),
    ('Dr. Kulkarni',      'kulkarni.j@college.edu', 'dummy_hash_judge1',  'Judge'),
    ('Prof. Deshpande',   'deshpande.j@college.edu','dummy_hash_judge2',  'Judge'),
    ('Dr. Patil',         'patil.j@college.edu',    'dummy_hash_judge3',  'Judge'),
    ('Asha Student',      'asha.s@college.edu',     'dummy_hash_stud1',   'Student'),
    ('Bharat Student',    'bharat.s@college.edu',   'dummy_hash_stud2',   'Student'),
    ('Chitra Student',    'chitra.s@college.edu',   'dummy_hash_stud3',   'Student'),
    ('Deepak Student',    'deepak.s@college.edu',   'dummy_hash_stud4',   'Student'),
    ('Esha Student',      'esha.s@college.edu',     'dummy_hash_stud5',   'Student'),
    ('Farhan Student',    'farhan.s@college.edu',   'dummy_hash_stud6',   'Student')
ON CONFLICT (email) DO NOTHING;

-- 2. FEST CONFIGURATION
INSERT INTO fest_config (fest_name, start_date, end_date, daily_start_time, daily_end_time, lunch_break_start, lunch_break_end)
VALUES ('Invento Fest 2026', '2026-12-05', '2026-12-07', '09:00:00', '18:00:00', '13:00:00', '14:00:00')
ON CONFLICT DO NOTHING;

-- 3. RESOURCES (Venues & Equipment)
INSERT INTO resource (type, name, capacity) VALUES
    ('Venue',     'Main Auditorium',        500),
    ('Venue',     'Seminar Hall',           120),
    ('Venue',     'Computer Lab 1',          60),
    ('Venue',     'Open Air Amphitheatre',  300),
    ('Equipment', 'Projector 1',           NULL),
    ('Equipment', 'Sound System',          NULL),
    ('Equipment', 'Wireless Mic Set',      NULL)
ON CONFLICT DO NOTHING;

-- 4. VENUE AVAILABILITY
INSERT INTO venue_availability (venue_id, start_time, end_time, is_available)
SELECT r.resource_id, '2026-12-05 08:00:00'::timestamp, '2026-12-07 20:00:00'::timestamp, TRUE
FROM resource r WHERE r.type = 'Venue'
ON CONFLICT DO NOTHING;

-- 5. JUDGE AVAILABILITY
INSERT INTO judge_availability (judge_id, start_time, end_time, is_available)
SELECT u.user_id, '2026-12-05 09:00:00'::timestamp, '2026-12-07 18:00:00'::timestamp, TRUE
FROM app_user u WHERE u.role = 'Judge'
ON CONFLICT DO NOTHING;

-- 6. EVENTS
INSERT INTO event (name, theme, description, duration_min, judges_required, status, remarks, coordinator_id, approved_by, approved_at) VALUES
    ('Hackathon 2026', 'Innovation', '24-hour coding challenge', 120, 2,
     'Published', 'Approved by admin',
     (SELECT user_id FROM app_user WHERE email = 'rahul.c@college.edu'),
     (SELECT user_id FROM app_user WHERE email = 'admin@college.edu'), '2026-11-20 09:00:00'),
    ('Quiz Bowl', 'General knowledge', 'Inter-department quiz', 90, 1,
     'Published', 'Approved by admin',
     (SELECT user_id FROM app_user WHERE email = 'meera.c@college.edu'),
     (SELECT user_id FROM app_user WHERE email = 'admin@college.edu'), '2026-11-20 09:30:00'),
    ('Dance Night', 'Cultural', 'Solo and group dance performances', 150, 3,
     'Scheduled', NULL,
     (SELECT user_id FROM app_user WHERE email = 'meera.c@college.edu'),
     (SELECT user_id FROM app_user WHERE email = 'admin@college.edu'), '2026-11-20 10:00:00'),
    ('Robotics Expo', 'Technology', 'Student robot demonstrations', 180, 2,
     'Approved', NULL,
     (SELECT user_id FROM app_user WHERE email = 'rahul.c@college.edu'),
     (SELECT user_id FROM app_user WHERE email = 'admin@college.edu'), '2026-11-20 10:30:00'),
    ('Poetry Slam', 'Literature', 'Open-mic poetry evening', 60, 1,
     'Pending', NULL,
     (SELECT user_id FROM app_user WHERE email = 'meera.c@college.edu'),
     NULL, NULL),
    ('Food Fest', 'Social', 'Stalls in courtyard', 240, 0,
     'Rejected', 'Clashes with schedule',
     (SELECT user_id FROM app_user WHERE email = 'rahul.c@college.edu'),
     (SELECT user_id FROM app_user WHERE email = 'admin@college.edu'), '2026-11-20 11:00:00')
ON CONFLICT DO NOTHING;

-- 7. EVENT REQUIREMENTS
INSERT INTO event_requirement (event_id, required_venue_type, min_capacity, equipment_needed, quantity)
VALUES
    ((SELECT event_id FROM event WHERE name = 'Hackathon 2026'), 'Venue', 50, 'Projector 1', 1),
    ((SELECT event_id FROM event WHERE name = 'Quiz Bowl'), 'Venue', 80, 'Wireless Mic Set', 2),
    ((SELECT event_id FROM event WHERE name = 'Dance Night'), 'Venue', 250, 'Sound System', 1);

-- 8. EVENT JUDGES
INSERT INTO event_judge (event_id, judge_id)
SELECT e.event_id, u.user_id
FROM (VALUES
        ('Hackathon 2026', 'kulkarni.j@college.edu'),
        ('Hackathon 2026', 'deshpande.j@college.edu'),
        ('Quiz Bowl',      'patil.j@college.edu'),
        ('Dance Night',    'kulkarni.j@college.edu'),
        ('Dance Night',    'deshpande.j@college.edu'),
        ('Dance Night',    'patil.j@college.edu')
     ) AS v(event_name, judge_email)
JOIN event    e ON e.name  = v.event_name
JOIN app_user u ON u.email = v.judge_email
ON CONFLICT DO NOTHING;

-- 9. TIMETABLE VERSIONS
INSERT INTO timetable_version (version_no, status, published_by, published_at) VALUES
    (1, 'Archived',  (SELECT user_id FROM app_user WHERE email = 'admin@college.edu'), '2026-11-20 10:00:00'),
    (2, 'Published', (SELECT user_id FROM app_user WHERE email = 'admin@college.edu'), '2026-11-21 10:00:00'),
    (3, 'Draft',     NULL, NULL)
ON CONFLICT (version_no) DO NOTHING;

-- 10. SCHEDULE SLOTS
-- Version 2 (Published): Clean schedule featuring back-to-back slots in Seminar Hall
-- Slot 1: Quiz Bowl 11:00 to 12:30 (90 min) in Seminar Hall
-- Slot 2: Poetry Slam / Other event back-to-back: tsrange [11:00, 12:30) and [12:30, 13:30) is ALLOWED!
INSERT INTO schedule_slot (event_id, version_id, venue_id, start_time, end_time)
SELECT e.event_id, tv.version_id, r.resource_id, v.s::timestamp, v.f::timestamp
FROM (VALUES
        ('Hackathon 2026', 2, 'Computer Lab 1',   '2026-12-05 09:00:00', '2026-12-05 11:00:00'),
        ('Quiz Bowl',      2, 'Seminar Hall',     '2026-12-05 11:00:00', '2026-12-05 12:30:00'),
        ('Dance Night',    2, 'Main Auditorium',  '2026-12-06 17:00:00', '2026-12-06 19:30:00'),
        ('Robotics Expo',  2, 'Main Auditorium',  '2026-12-07 10:00:00', '2026-12-07 13:00:00')
     ) AS v(event_name, v_no, venue_name, s, f)
JOIN event             e  ON e.name = v.event_name
JOIN resource          r  ON r.name = v.venue_name
JOIN timetable_version tv ON tv.version_no = v.v_no
ON CONFLICT (version_id, event_id) DO NOTHING;

-- Version 3 (Draft): Demonstrates seeded judge and student overlap across DIFFERENT venues:
-- Hackathon in Computer Lab 1 (09:00-11:00) and Dance Night in Main Auditorium (10:00-12:30)
-- Both have Dr. Kulkarni as Judge, and both have Asha Student registered!
INSERT INTO schedule_slot (event_id, version_id, venue_id, start_time, end_time)
SELECT e.event_id, tv.version_id, r.resource_id, v.s::timestamp, v.f::timestamp
FROM (VALUES
        ('Hackathon 2026', 3, 'Computer Lab 1',   '2026-12-05 09:00:00', '2026-12-05 11:00:00'),
        ('Dance Night',    3, 'Main Auditorium',  '2026-12-05 10:00:00', '2026-12-05 12:30:00')
     ) AS v(event_name, v_no, venue_name, s, f)
JOIN event             e  ON e.name = v.event_name
JOIN resource          r  ON r.name = v.venue_name
JOIN timetable_version tv ON tv.version_no = v.v_no
ON CONFLICT (version_id, event_id) DO NOTHING;

-- 11. EQUIPMENT ALLOCATION (version-aware, quantity)
INSERT INTO allocation (event_id, resource_id, version_id, quantity, start_time, end_time)
SELECT e.event_id, r.resource_id, tv.version_id, 1, v.s::timestamp, v.f::timestamp
FROM (VALUES
        ('Hackathon 2026', 'Projector 1',      2, '2026-12-05 09:00:00', '2026-12-05 11:00:00'),
        ('Quiz Bowl',      'Projector 1',      2, '2026-12-05 11:00:00', '2026-12-05 12:30:00'),
        ('Dance Night',    'Sound System',     2, '2026-12-06 17:00:00', '2026-12-06 19:30:00'),
        ('Dance Night',    'Wireless Mic Set', 2, '2026-12-06 17:00:00', '2026-12-06 19:30:00')
     ) AS v(event_name, resource_name, v_no, s, f)
JOIN event             e  ON e.name = v.event_name
JOIN resource          r  ON r.name = v.resource_name
JOIN timetable_version tv ON tv.version_no = v.v_no
ON CONFLICT DO NOTHING;

-- 12. REGISTRATIONS
INSERT INTO registration (student_id, event_id, status)
SELECT u.user_id, e.event_id, v.st
FROM (VALUES
        ('asha.s@college.edu',   'Hackathon 2026', 'Attended'),
        ('bharat.s@college.edu', 'Hackathon 2026', 'Attended'),
        ('chitra.s@college.edu', 'Hackathon 2026', 'Registered'),
        ('asha.s@college.edu',   'Quiz Bowl',      'Attended'),
        ('deepak.s@college.edu', 'Quiz Bowl',      'Attended'),
        ('asha.s@college.edu',   'Dance Night',    'Registered'),
        ('esha.s@college.edu',   'Dance Night',    'Registered'),
        ('farhan.s@college.edu', 'Dance Night',    'Registered'),
        ('chitra.s@college.edu', 'Dance Night',    'Cancelled')
     ) AS v(email, event_name, st)
JOIN app_user u ON u.email = v.email
JOIN event    e ON e.name  = v.event_name
ON CONFLICT (event_id, student_id) DO NOTHING;

-- 13. SCORES
INSERT INTO score (event_id, judge_id, participant_id, points)
SELECT e.event_id, j.user_id, p.user_id, v.pts
FROM (VALUES
        ('Hackathon 2026', 'kulkarni.j@college.edu',  'asha.s@college.edu',   88),
        ('Hackathon 2026', 'deshpande.j@college.edu', 'asha.s@college.edu',   92),
        ('Hackathon 2026', 'kulkarni.j@college.edu',  'bharat.s@college.edu', 75),
        ('Hackathon 2026', 'deshpande.j@college.edu', 'bharat.s@college.edu', 81),
        ('Quiz Bowl',      'patil.j@college.edu',     'asha.s@college.edu',   70),
        ('Quiz Bowl',      'patil.j@college.edu',     'deepak.s@college.edu', 85)
     ) AS v(event_name, judge_email, participant_email, pts)
JOIN event    e ON e.name  = v.event_name
JOIN app_user j ON j.email = v.judge_email
JOIN app_user p ON p.email = v.participant_email
ON CONFLICT (event_id, judge_id, participant_id) DO NOTHING;

-- 14. AUDIT LOG
INSERT INTO audit_log (user_id, action, endpoint, result)
SELECT u.user_id, v.action, v.endpoint, v.result
FROM (VALUES
        ('admin@college.edu',   'LOGIN',             '/login',                  'success'),
        ('rahul.c@college.edu', 'SUBMIT_PROPOSAL',   '/events',                 'success'),
        ('admin@college.edu',   'APPROVE_EVENT',     '/events/1/approve',       'success'),
        ('admin@college.edu',   'PUBLISH_TIMETABLE', '/timetable/2/publish',    'success'),
        ('esha.s@college.edu',  'REGISTER',          '/events/3/register',      'success')
     ) AS v(email, action, endpoint, result)
JOIN app_user u ON u.email = v.email;

COMMIT;
