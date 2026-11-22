-- =============================================================================
-- tests.sql - Plain-SQL Automated Test Suite for Engine 3 Database Engine
-- Run with: psql -U postgres -d event_timetable -f tests.sql
-- All tests use DO blocks, catch expected errors, and self-clean.
-- =============================================================================

\set ON_ERROR_STOP on
SET client_min_messages = notice;

CREATE TEMP TABLE IF NOT EXISTS test_results (
    test_id INT,
    name TEXT,
    status TEXT
);
TRUNCATE TABLE test_results;

-- Test 1: Duplicate email in app_user is rejected
DO $$
DECLARE
    v_id INT;
BEGIN
    INSERT INTO app_user (name, email, password_hash, role)
    VALUES ('Alice T1', 't1_dup@college.edu', 'hash', 'Student')
    RETURNING user_id INTO v_id;

    BEGIN
        INSERT INTO app_user (name, email, password_hash, role)
        VALUES ('Bob T1', 't1_dup@college.edu', 'hash', 'Student');
        INSERT INTO test_results VALUES (1, 'duplicate email rejected', 'FAIL');
        RAISE NOTICE 'Test 1: FAIL (duplicate email accepted)';
    EXCEPTION WHEN unique_violation THEN
        INSERT INTO test_results VALUES (1, 'duplicate email rejected', 'PASS');
        RAISE NOTICE 'Test 1: PASS (duplicate email in app_user rejected)';
    END;

    DELETE FROM app_user WHERE user_id = v_id;
END $$;

-- Test 2: Invalid role in app_user is rejected
DO $$
BEGIN
    BEGIN
        INSERT INTO app_user (name, email, password_hash, role)
        VALUES ('BadRole T2', 't2_badrole@college.edu', 'hash', 'SuperUser');
        INSERT INTO test_results VALUES (2, 'invalid role rejected', 'FAIL');
        RAISE NOTICE 'Test 2: FAIL (invalid role accepted)';
    EXCEPTION WHEN check_violation THEN
        INSERT INTO test_results VALUES (2, 'invalid role rejected', 'PASS');
        RAISE NOTICE 'Test 2: PASS (invalid role in app_user rejected)';
    END;
END $$;

-- Test 3: Overlapping schedule_slot rows in the same venue and version are rejected
DO $$
DECLARE
    v_uid INT; v_e1 INT; v_e2 INT; v_vno INT; v_vid INT; v_sid INT;
BEGIN
    INSERT INTO app_user (name, email, password_hash, role)
    VALUES ('Coord T3', 't3_coord@college.edu', 'hash', 'Coordinator') RETURNING user_id INTO v_uid;

    INSERT INTO event (name, duration_min, coordinator_id)
    VALUES ('Event T3-1', 60, v_uid) RETURNING event_id INTO v_e1;
    INSERT INTO event (name, duration_min, coordinator_id)
    VALUES ('Event T3-2', 60, v_uid) RETURNING event_id INTO v_e2;

    INSERT INTO timetable_version (version_no, status) VALUES (8803, 'Draft') RETURNING version_id INTO v_vno;
    INSERT INTO resource (type, name) VALUES ('Venue', 'Hall T3') RETURNING resource_id INTO v_vid;

    INSERT INTO schedule_slot (event_id, version_id, venue_id, start_time, end_time)
    VALUES (v_e1, v_vno, v_vid, '2026-12-05 10:00:00', '2026-12-05 11:00:00') RETURNING slot_id INTO v_sid;

    BEGIN
        INSERT INTO schedule_slot (event_id, version_id, venue_id, start_time, end_time)
        VALUES (v_e2, v_vno, v_vid, '2026-12-05 10:30:00', '2026-12-05 11:30:00');
        INSERT INTO test_results VALUES (3, 'overlapping venue slots rejected', 'FAIL');
        RAISE NOTICE 'Test 3: FAIL (overlapping slot accepted)';
    EXCEPTION WHEN exclusion_violation THEN
        INSERT INTO test_results VALUES (3, 'overlapping venue slots rejected', 'PASS');
        RAISE NOTICE 'Test 3: PASS (overlapping schedule_slots rejected)';
    END;

    DELETE FROM schedule_slot WHERE slot_id = v_sid;
    DELETE FROM timetable_version WHERE version_id = v_vno;
    DELETE FROM event WHERE event_id IN (v_e1, v_e2);
    DELETE FROM resource WHERE resource_id = v_vid;
    DELETE FROM app_user WHERE user_id = v_uid;
END $$;

-- Test 4: Non-overlapping back-to-back slots in the same venue are accepted
DO $$
DECLARE
    v_uid INT; v_e1 INT; v_e2 INT; v_vno INT; v_vid INT; v_s1 INT; v_s2 INT;
BEGIN
    INSERT INTO app_user (name, email, password_hash, role)
    VALUES ('Coord T4', 't4_coord@college.edu', 'hash', 'Coordinator') RETURNING user_id INTO v_uid;

    INSERT INTO event (name, duration_min, coordinator_id)
    VALUES ('Event T4-1', 60, v_uid) RETURNING event_id INTO v_e1;
    INSERT INTO event (name, duration_min, coordinator_id)
    VALUES ('Event T4-2', 60, v_uid) RETURNING event_id INTO v_e2;

    INSERT INTO timetable_version (version_no, status) VALUES (8804, 'Draft') RETURNING version_id INTO v_vno;
    INSERT INTO resource (type, name) VALUES ('Venue', 'Hall T4') RETURNING resource_id INTO v_vid;

    BEGIN
        INSERT INTO schedule_slot (event_id, version_id, venue_id, start_time, end_time)
        VALUES (v_e1, v_vno, v_vid, '2026-12-05 09:00:00', '2026-12-05 10:00:00') RETURNING slot_id INTO v_s1;
        INSERT INTO schedule_slot (event_id, version_id, venue_id, start_time, end_time)
        VALUES (v_e2, v_vno, v_vid, '2026-12-05 10:00:00', '2026-12-05 11:00:00') RETURNING slot_id INTO v_s2;

        INSERT INTO test_results VALUES (4, 'back-to-back slots accepted', 'PASS');
        RAISE NOTICE 'Test 4: PASS (non-overlapping back-to-back slots accepted)';
    EXCEPTION WHEN OTHERS THEN
        INSERT INTO test_results VALUES (4, 'back-to-back slots accepted', 'FAIL');
        RAISE NOTICE 'Test 4: FAIL (back-to-back slots rejected: %)', SQLERRM;
    END;

    DELETE FROM schedule_slot WHERE slot_id IN (v_s1, v_s2);
    DELETE FROM timetable_version WHERE version_id = v_vno;
    DELETE FROM event WHERE event_id IN (v_e1, v_e2);
    DELETE FROM resource WHERE resource_id = v_vid;
    DELETE FROM app_user WHERE user_id = v_uid;
END $$;

-- Test 5: Overlapping allocation rows for the same resource in the same version are rejected
DO $$
DECLARE
    v_uid INT; v_e1 INT; v_e2 INT; v_rid INT; v_aid INT; v_vno INT;
BEGIN
    INSERT INTO app_user (name, email, password_hash, role)
    VALUES ('Coord T5', 't5_coord@college.edu', 'hash', 'Coordinator') RETURNING user_id INTO v_uid;

    INSERT INTO event (name, duration_min, coordinator_id)
    VALUES ('Event T5-1', 60, v_uid) RETURNING event_id INTO v_e1;
    INSERT INTO event (name, duration_min, coordinator_id)
    VALUES ('Event T5-2', 60, v_uid) RETURNING event_id INTO v_e2;

    INSERT INTO timetable_version (version_no, status) VALUES (8805, 'Draft') RETURNING version_id INTO v_vno;
    INSERT INTO resource (type, name) VALUES ('Equipment', 'Mic T5') RETURNING resource_id INTO v_rid;

    INSERT INTO allocation (event_id, resource_id, version_id, start_time, end_time)
    VALUES (v_e1, v_rid, v_vno, '2026-12-05 10:00:00', '2026-12-05 12:00:00') RETURNING alloc_id INTO v_aid;

    BEGIN
        INSERT INTO allocation (event_id, resource_id, version_id, start_time, end_time)
        VALUES (v_e2, v_rid, v_vno, '2026-12-05 11:00:00', '2026-12-05 13:00:00');
        INSERT INTO test_results VALUES (5, 'overlapping resource allocation rejected', 'FAIL');
        RAISE NOTICE 'Test 5: FAIL (overlapping allocation accepted)';
    EXCEPTION WHEN exclusion_violation THEN
        INSERT INTO test_results VALUES (5, 'overlapping resource allocation rejected', 'PASS');
        RAISE NOTICE 'Test 5: PASS (overlapping allocation rejected)';
    END;

    DELETE FROM allocation WHERE alloc_id = v_aid;
    DELETE FROM timetable_version WHERE version_id = v_vno;
    DELETE FROM event WHERE event_id IN (v_e1, v_e2);
    DELETE FROM resource WHERE resource_id = v_rid;
    DELETE FROM app_user WHERE user_id = v_uid;
END $$;

-- Test 6: A second timetable_version with status 'Published' is rejected
DO $$
DECLARE
    v_vno INT;
BEGIN
    -- Temporary record. Only create it if no Published version exists yet: when
    -- sample_data.sql is loaded, one already does, and inserting another here would
    -- abort the whole script before the real check below runs.
    IF NOT EXISTS (SELECT 1 FROM timetable_version WHERE status = 'Published') THEN
        INSERT INTO timetable_version (version_no, status) VALUES (8806, 'Published') RETURNING version_id INTO v_vno;
    END IF;

    BEGIN
        INSERT INTO timetable_version (version_no, status) VALUES (8807, 'Published');
        INSERT INTO test_results VALUES (6, 'only one published version allowed', 'FAIL');
        RAISE NOTICE 'Test 6: FAIL (second published version accepted)';
    EXCEPTION WHEN unique_violation THEN
        INSERT INTO test_results VALUES (6, 'only one published version allowed', 'PASS');
        RAISE NOTICE 'Test 6: PASS (second published version rejected)';
    END;

    IF v_vno IS NOT NULL THEN
        DELETE FROM timetable_version WHERE version_id = v_vno;
    END IF;
END $$;

-- Test 7: Duplicate student registration for same event is rejected
DO $$
DECLARE
    v_c INT; v_s INT; v_e INT; v_reg INT;
BEGIN
    INSERT INTO app_user (name, email, password_hash, role)
    VALUES ('Coord T7', 't7_c@college.edu', 'hash', 'Coordinator') RETURNING user_id INTO v_c;
    INSERT INTO app_user (name, email, password_hash, role)
    VALUES ('Stud T7', 't7_s@college.edu', 'hash', 'Student') RETURNING user_id INTO v_s;
    INSERT INTO event (name, duration_min, coordinator_id)
    VALUES ('Event T7', 60, v_c) RETURNING event_id INTO v_e;

    INSERT INTO registration (student_id, event_id, status)
    VALUES (v_s, v_e, 'Registered') RETURNING reg_id INTO v_reg;

    BEGIN
        INSERT INTO registration (student_id, event_id, status)
        VALUES (v_s, v_e, 'Registered');
        INSERT INTO test_results VALUES (7, 'duplicate registration rejected', 'FAIL');
        RAISE NOTICE 'Test 7: FAIL (duplicate registration accepted)';
    EXCEPTION WHEN unique_violation THEN
        INSERT INTO test_results VALUES (7, 'duplicate registration rejected', 'PASS');
        RAISE NOTICE 'Test 7: PASS (duplicate registration rejected)';
    END;

    DELETE FROM registration WHERE reg_id = v_reg;
    DELETE FROM event WHERE event_id = v_e;
    DELETE FROM app_user WHERE user_id IN (v_c, v_s);
END $$;

-- Test 8: Judge scoring same participant twice in same event is rejected
DO $$
DECLARE
    v_c INT; v_j INT; v_p INT; v_e INT; v_sc INT;
BEGIN
    INSERT INTO app_user (name, email, password_hash, role)
    VALUES ('Coord T8', 't8_c@college.edu', 'hash', 'Coordinator') RETURNING user_id INTO v_c;
    INSERT INTO app_user (name, email, password_hash, role)
    VALUES ('Judge T8', 't8_j@college.edu', 'hash', 'Judge') RETURNING user_id INTO v_j;
    INSERT INTO app_user (name, email, password_hash, role)
    VALUES ('Stud T8', 't8_p@college.edu', 'hash', 'Student') RETURNING user_id INTO v_p;

    INSERT INTO event (name, duration_min, coordinator_id)
    VALUES ('Event T8', 60, v_c) RETURNING event_id INTO v_e;

    INSERT INTO event_judge (event_id, judge_id) VALUES (v_e, v_j);
    INSERT INTO registration (student_id, event_id) VALUES (v_p, v_e);

    INSERT INTO score (event_id, judge_id, participant_id, points)
    VALUES (v_e, v_j, v_p, 85) RETURNING score_id INTO v_sc;

    BEGIN
        INSERT INTO score (event_id, judge_id, participant_id, points)
        VALUES (v_e, v_j, v_p, 90);
        INSERT INTO test_results VALUES (8, 'duplicate scoring rejected', 'FAIL');
        RAISE NOTICE 'Test 8: FAIL (duplicate scoring accepted)';
    EXCEPTION WHEN unique_violation THEN
        INSERT INTO test_results VALUES (8, 'duplicate scoring rejected', 'PASS');
        RAISE NOTICE 'Test 8: PASS (duplicate scoring rejected)';
    END;

    DELETE FROM score WHERE score_id = v_sc;
    DELETE FROM registration WHERE event_id = v_e AND student_id = v_p;
    DELETE FROM event_judge WHERE event_id = v_e AND judge_id = v_j;
    DELETE FROM event WHERE event_id = v_e;
    DELETE FROM app_user WHERE user_id IN (v_c, v_j, v_p);
END $$;

-- Test 9: Judge scoring themselves is rejected
DO $$
DECLARE
    v_c INT; v_j INT; v_e INT;
BEGIN
    INSERT INTO app_user (name, email, password_hash, role)
    VALUES ('Coord T9', 't9_c@college.edu', 'hash', 'Coordinator') RETURNING user_id INTO v_c;
    INSERT INTO app_user (name, email, password_hash, role)
    VALUES ('Judge T9', 't9_j@college.edu', 'hash', 'Judge') RETURNING user_id INTO v_j;

    INSERT INTO event (name, duration_min, coordinator_id)
    VALUES ('Event T9', 60, v_c) RETURNING event_id INTO v_e;

    BEGIN
        INSERT INTO score (event_id, judge_id, participant_id, points)
        VALUES (v_e, v_j, v_j, 99);
        INSERT INTO test_results VALUES (9, 'self-scoring rejected', 'FAIL');
        RAISE NOTICE 'Test 9: FAIL (judge scored themselves)';
    EXCEPTION WHEN check_violation THEN
        INSERT INTO test_results VALUES (9, 'self-scoring rejected', 'PASS');
        RAISE NOTICE 'Test 9: PASS (judge scoring themselves rejected)';
    END;

    DELETE FROM event WHERE event_id = v_e;
    DELETE FROM app_user WHERE user_id IN (v_c, v_j);
END $$;

-- Test 10: Conflict row with event_a >= event_b is rejected
DO $$
DECLARE
    v_c INT; v_e INT; v_vno INT;
BEGIN
    INSERT INTO app_user (name, email, password_hash, role)
    VALUES ('Coord T10', 't10_c@college.edu', 'hash', 'Coordinator') RETURNING user_id INTO v_c;
    INSERT INTO event (name, duration_min, coordinator_id)
    VALUES ('Event T10', 60, v_c) RETURNING event_id INTO v_e;
    INSERT INTO timetable_version (version_no, status) VALUES (8810, 'Draft') RETURNING version_id INTO v_vno;

    BEGIN
        INSERT INTO conflict (version_id, event_a, event_b, type, severity, status)
        VALUES (v_vno, v_e, v_e, 'Resource', 'Critical', 'Open');
        INSERT INTO test_results VALUES (10, 'conflict event_a < event_b enforced', 'FAIL');
        RAISE NOTICE 'Test 10: FAIL (event_a = event_b accepted)';
    EXCEPTION WHEN check_violation THEN
        INSERT INTO test_results VALUES (10, 'conflict event_a < event_b enforced', 'PASS');
        RAISE NOTICE 'Test 10: PASS (conflict with event_a >= event_b rejected)';
    END;

    DELETE FROM timetable_version WHERE version_id = v_vno;
    DELETE FROM event WHERE event_id = v_e;
    DELETE FROM app_user WHERE user_id = v_c;
END $$;

-- Test 11: Event with duration_min <= 0 is rejected
DO $$
DECLARE
    v_c INT;
BEGIN
    INSERT INTO app_user (name, email, password_hash, role)
    VALUES ('Coord T11', 't11_c@college.edu', 'hash', 'Coordinator') RETURNING user_id INTO v_c;

    BEGIN
        INSERT INTO event (name, duration_min, coordinator_id)
        VALUES ('Event T11 Zero', 0, v_c);
        INSERT INTO test_results VALUES (11, 'zero duration rejected', 'FAIL');
        RAISE NOTICE 'Test 11: FAIL (duration 0 accepted)';
    EXCEPTION WHEN check_violation THEN
        INSERT INTO test_results VALUES (11, 'zero duration rejected', 'PASS');
        RAISE NOTICE 'Test 11: PASS (duration_min <= 0 rejected)';
    END;

    DELETE FROM app_user WHERE user_id = v_c;
END $$;

-- Test 12: End_time <= start_time is rejected
DO $$
DECLARE
    v_c INT; v_e INT; v_r INT; v_v INT;
BEGIN
    INSERT INTO app_user (name, email, password_hash, role)
    VALUES ('Coord T12', 't12_c@college.edu', 'hash', 'Coordinator') RETURNING user_id INTO v_c;
    INSERT INTO event (name, duration_min, coordinator_id)
    VALUES ('Event T12', 60, v_c) RETURNING event_id INTO v_e;
    INSERT INTO timetable_version (version_no, status) VALUES (8812, 'Draft') RETURNING version_id INTO v_v;
    INSERT INTO resource (type, name) VALUES ('Equipment', 'Mic T12') RETURNING resource_id INTO v_r;

    BEGIN
        INSERT INTO allocation (event_id, resource_id, version_id, start_time, end_time)
        VALUES (v_e, v_r, v_v, '2026-12-05 14:00:00', '2026-12-05 12:00:00');
        INSERT INTO test_results VALUES (12, 'end_time <= start_time rejected', 'FAIL');
        RAISE NOTICE 'Test 12: FAIL (inverted time accepted)';
    EXCEPTION WHEN check_violation THEN
        INSERT INTO test_results VALUES (12, 'end_time <= start_time rejected', 'PASS');
        RAISE NOTICE 'Test 12: PASS (end_time <= start_time rejected)';
    END;

    DELETE FROM timetable_version WHERE version_id = v_v;
    DELETE FROM event WHERE event_id = v_e;
    DELETE FROM resource WHERE resource_id = v_r;
    DELETE FROM app_user WHERE user_id = v_c;
END $$;

-- Test 13: schedule_slot venue_id must reference type 'Venue' (Equipment rejected)
DO $$
DECLARE
    v_c INT; v_e INT; v_vno INT; v_eq INT;
BEGIN
    INSERT INTO app_user (name, email, password_hash, role)
    VALUES ('Coord T13', 't13_c@college.edu', 'hash', 'Coordinator') RETURNING user_id INTO v_c;
    INSERT INTO event (name, duration_min, coordinator_id)
    VALUES ('Event T13', 60, v_c) RETURNING event_id INTO v_e;
    INSERT INTO timetable_version (version_no, status) VALUES (8813, 'Draft') RETURNING version_id INTO v_vno;
    INSERT INTO resource (type, name) VALUES ('Equipment', 'Speaker T13') RETURNING resource_id INTO v_eq;

    BEGIN
        INSERT INTO schedule_slot (event_id, version_id, venue_id, start_time, end_time)
        VALUES (v_e, v_vno, v_eq, '2026-12-05 10:00:00', '2026-12-05 11:00:00');
        INSERT INTO test_results VALUES (13, 'equipment rejected as venue', 'FAIL');
        RAISE NOTICE 'Test 13: FAIL (equipment accepted as venue)';
    EXCEPTION WHEN check_violation THEN
        INSERT INTO test_results VALUES (13, 'equipment rejected as venue', 'PASS');
        RAISE NOTICE 'Test 13: PASS (equipment rejected for schedule_slot.venue_id)';
    END;

    DELETE FROM timetable_version WHERE version_id = v_vno;
    DELETE FROM event WHERE event_id = v_e;
    DELETE FROM resource WHERE resource_id = v_eq;
    DELETE FROM app_user WHERE user_id = v_c;
END $$;

-- Test 14: Slot duration must equal event duration_min
DO $$
DECLARE
    v_c INT; v_e INT; v_vno INT; v_v INT;
BEGIN
    INSERT INTO app_user (name, email, password_hash, role)
    VALUES ('Coord T14', 't14_c@college.edu', 'hash', 'Coordinator') RETURNING user_id INTO v_c;
    INSERT INTO event (name, duration_min, coordinator_id)
    VALUES ('Event T14', 60, v_c) RETURNING event_id INTO v_e;
    INSERT INTO timetable_version (version_no, status) VALUES (8814, 'Draft') RETURNING version_id INTO v_vno;
    INSERT INTO resource (type, name) VALUES ('Venue', 'Room T14') RETURNING resource_id INTO v_v;

    BEGIN
        -- Attempt 90 min slot for 60 min event
        INSERT INTO schedule_slot (event_id, version_id, venue_id, start_time, end_time)
        VALUES (v_e, v_vno, v_v, '2026-12-05 10:00:00', '2026-12-05 11:30:00');
        INSERT INTO test_results VALUES (14, 'mismatched slot duration rejected', 'FAIL');
        RAISE NOTICE 'Test 14: FAIL (mismatched duration accepted)';
    EXCEPTION WHEN check_violation THEN
        INSERT INTO test_results VALUES (14, 'mismatched slot duration rejected', 'PASS');
        RAISE NOTICE 'Test 14: PASS (slot duration mismatch rejected)';
    END;

    DELETE FROM timetable_version WHERE version_id = v_vno;
    DELETE FROM event WHERE event_id = v_e;
    DELETE FROM resource WHERE resource_id = v_v;
    DELETE FROM app_user WHERE user_id = v_c;
END $$;

-- Test 15: Non-Judge assigned to event_judge is rejected
DO $$
DECLARE
    v_c INT; v_s INT; v_e INT;
BEGIN
    INSERT INTO app_user (name, email, password_hash, role)
    VALUES ('Coord T15', 't15_c@college.edu', 'hash', 'Coordinator') RETURNING user_id INTO v_c;
    INSERT INTO app_user (name, email, password_hash, role)
    VALUES ('Stud T15', 't15_s@college.edu', 'hash', 'Student') RETURNING user_id INTO v_s;
    INSERT INTO event (name, duration_min, coordinator_id)
    VALUES ('Event T15', 60, v_c) RETURNING event_id INTO v_e;

    BEGIN
        INSERT INTO event_judge (event_id, judge_id) VALUES (v_e, v_s);
        INSERT INTO test_results VALUES (15, 'non-judge in event_judge rejected', 'FAIL');
        RAISE NOTICE 'Test 15: FAIL (student accepted as judge)';
    EXCEPTION WHEN check_violation THEN
        INSERT INTO test_results VALUES (15, 'non-judge in event_judge rejected', 'PASS');
        RAISE NOTICE 'Test 15: PASS (non-judge role rejected from event_judge)';
    END;

    DELETE FROM event WHERE event_id = v_e;
    DELETE FROM app_user WHERE user_id IN (v_c, v_s);
END $$;

-- Test 16: Non-Student registering for an event is rejected
DO $$
DECLARE
    v_c INT; v_e INT;
BEGIN
    INSERT INTO app_user (name, email, password_hash, role)
    VALUES ('Coord T16', 't16_c@college.edu', 'hash', 'Coordinator') RETURNING user_id INTO v_c;
    INSERT INTO event (name, duration_min, coordinator_id)
    VALUES ('Event T16', 60, v_c) RETURNING event_id INTO v_e;

    BEGIN
        -- Coordinator attempting to register as student
        INSERT INTO registration (student_id, event_id) VALUES (v_c, v_e);
        INSERT INTO test_results VALUES (16, 'non-student registration rejected', 'FAIL');
        RAISE NOTICE 'Test 16: FAIL (coordinator accepted in registration)';
    EXCEPTION WHEN check_violation THEN
        INSERT INTO test_results VALUES (16, 'non-student registration rejected', 'PASS');
        RAISE NOTICE 'Test 16: PASS (non-student rejected from registration)';
    END;

    DELETE FROM event WHERE event_id = v_e;
    DELETE FROM app_user WHERE user_id = v_c;
END $$;

-- =============================================================================
-- FINAL TEST SUMMARY
-- =============================================================================
SELECT
    COUNT(*) AS total_tests,
    COUNT(*) FILTER (WHERE status = 'PASS') AS pass_count,
    COUNT(*) FILTER (WHERE status = 'FAIL') AS fail_count
FROM test_results;
