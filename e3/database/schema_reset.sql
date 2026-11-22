-- =============================================================================
-- schema_reset.sql - Complete database teardown script
-- Drops all tables, views, triggers, and functions for a clean reinstall.
-- Use ONLY when --reset is explicitly specified in setup_db.py.
-- =============================================================================

DROP VIEW IF EXISTS v_capacity_violations CASCADE;
DROP VIEW IF EXISTS v_event_judge_shortfall CASCADE;
DROP VIEW IF EXISTS v_participant_conflicts CASCADE;
DROP VIEW IF EXISTS v_judge_conflicts CASCADE;

DROP TABLE IF EXISTS audit_log CASCADE;
DROP TABLE IF EXISTS score CASCADE;
DROP TABLE IF EXISTS registration CASCADE;
DROP TABLE IF EXISTS conflict CASCADE;
DROP TABLE IF EXISTS schedule_slot CASCADE;
DROP TABLE IF EXISTS allocation CASCADE;
DROP TABLE IF EXISTS event_judge CASCADE;
DROP TABLE IF EXISTS event_requirement CASCADE;
DROP TABLE IF EXISTS judge_availability CASCADE;
DROP TABLE IF EXISTS venue_availability CASCADE;
DROP TABLE IF EXISTS timetable_version CASCADE;
DROP TABLE IF EXISTS event CASCADE;
DROP TABLE IF EXISTS resource CASCADE;
DROP TABLE IF EXISTS fest_config CASCADE;
DROP TABLE IF EXISTS app_user CASCADE;

DROP FUNCTION IF EXISTS check_slot_venue_type() CASCADE;
DROP FUNCTION IF EXISTS check_slot_duration() CASCADE;
DROP FUNCTION IF EXISTS check_event_roles() CASCADE;
DROP FUNCTION IF EXISTS check_judge_role() CASCADE;
DROP FUNCTION IF EXISTS check_student_role() CASCADE;
