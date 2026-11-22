-- Event Management, Proposal Approval and Timetable System
-- PostgreSQL schema (revised ER diagram)
-- Run:  psql -U postgres -d your_db -f schema.sql

CREATE EXTENSION IF NOT EXISTS btree_gist;  -- needed for the no-overlap constraint

DROP TABLE IF EXISTS audit_log, score, registration, conflict, schedule_slot,
                     timetable_version, allocation, resource, event_judge,
                     event, app_user CASCADE;

-- "user" is a reserved word in PostgreSQL, so the table is app_user
CREATE TABLE app_user (
    user_id        SERIAL PRIMARY KEY,
    name           VARCHAR(100) NOT NULL,
    email          VARCHAR(150) NOT NULL UNIQUE,
    password_hash  VARCHAR(255) NOT NULL,
    role           VARCHAR(20)  NOT NULL
                   CHECK (role IN ('Admin', 'Coordinator', 'Judge', 'Student'))
);

CREATE TABLE event (
    event_id         SERIAL PRIMARY KEY,
    name             VARCHAR(150) NOT NULL,
    theme            VARCHAR(150),
    description      TEXT,
    duration_min     INT NOT NULL CHECK (duration_min > 0),
    judges_required  INT NOT NULL DEFAULT 0 CHECK (judges_required >= 0),
    status           VARCHAR(20) NOT NULL DEFAULT 'Pending'
                     CHECK (status IN ('Pending', 'Approved', 'Rejected',
                                       'Scheduled', 'Published', 'Completed')),
    remarks          TEXT,
    coordinator_id   INT NOT NULL REFERENCES app_user(user_id),
    approved_by      INT REFERENCES app_user(user_id),
    created_at       TIMESTAMP NOT NULL DEFAULT now()
);

-- Judges for an event (replaces the duplicate Judge/Coordinator rows in RESOURCE)
CREATE TABLE event_judge (
    event_id  INT NOT NULL REFERENCES event(event_id) ON DELETE CASCADE,
    judge_id  INT NOT NULL REFERENCES app_user(user_id),
    PRIMARY KEY (event_id, judge_id)
);

-- Venues and equipment only
CREATE TABLE resource (
    resource_id  SERIAL PRIMARY KEY,
    type         VARCHAR(20) NOT NULL CHECK (type IN ('Venue', 'Equipment')),
    name         VARCHAR(100) NOT NULL,
    capacity     INT CHECK (capacity IS NULL OR capacity > 0)
);

-- Resolves Event <-> Resource (use for equipment; venues live in schedule_slot)
CREATE TABLE allocation (
    alloc_id     SERIAL PRIMARY KEY,
    event_id     INT NOT NULL REFERENCES event(event_id) ON DELETE CASCADE,
    resource_id  INT NOT NULL REFERENCES resource(resource_id),
    start_time   TIMESTAMP NOT NULL,
    end_time     TIMESTAMP NOT NULL,
    CHECK (end_time > start_time),
    -- a resource cannot be booked for overlapping time ranges
    -- (assumes each resource row is a single unit)
    EXCLUDE USING gist (
        resource_id WITH =,
        tsrange(start_time, end_time) WITH &&
    )
);

CREATE TABLE timetable_version (
    version_id    SERIAL PRIMARY KEY,
    version_no    INT NOT NULL UNIQUE,
    status        VARCHAR(20) NOT NULL DEFAULT 'Draft'
                  CHECK (status IN ('Draft', 'Published', 'Archived')),
    published_by  INT REFERENCES app_user(user_id),
    published_at  TIMESTAMP
);

CREATE TABLE schedule_slot (
    slot_id     SERIAL PRIMARY KEY,
    event_id    INT NOT NULL REFERENCES event(event_id) ON DELETE CASCADE,
    version_id  INT NOT NULL REFERENCES timetable_version(version_id) ON DELETE CASCADE,
    venue_id    INT NOT NULL REFERENCES resource(resource_id),
    start_time  TIMESTAMP NOT NULL,
    end_time    TIMESTAMP NOT NULL,
    CHECK (end_time > start_time),
    -- no two slots may overlap in the same venue within one timetable version
    EXCLUDE USING gist (
        version_id WITH =,
        venue_id   WITH =,
        tsrange(start_time, end_time) WITH &&
    )
);

CREATE TABLE conflict (
    conflict_id  SERIAL PRIMARY KEY,
    version_id   INT NOT NULL REFERENCES timetable_version(version_id) ON DELETE CASCADE,
    event_a      INT NOT NULL REFERENCES event(event_id),
    event_b      INT NOT NULL REFERENCES event(event_id),
    resource_id  INT REFERENCES resource(resource_id),
    type         VARCHAR(20) NOT NULL CHECK (type IN ('Resource', 'Participant')),
    severity     VARCHAR(20) NOT NULL CHECK (severity IN ('Acceptable', 'Critical')),
    status       VARCHAR(20) NOT NULL DEFAULT 'Open'
                 CHECK (status IN ('Open', 'Resolved', 'Ignored')),
    raised_by    INT REFERENCES app_user(user_id),
    CHECK (event_a <> event_b)
);

CREATE TABLE registration (
    reg_id         SERIAL PRIMARY KEY,
    student_id     INT NOT NULL REFERENCES app_user(user_id),
    event_id       INT NOT NULL REFERENCES event(event_id) ON DELETE CASCADE,
    status         VARCHAR(20) NOT NULL DEFAULT 'Registered'
                   CHECK (status IN ('Registered', 'Cancelled', 'Attended')),
    registered_at  TIMESTAMP NOT NULL DEFAULT now(),
    UNIQUE (student_id, event_id)
);

CREATE TABLE score (
    score_id        SERIAL PRIMARY KEY,
    event_id        INT NOT NULL REFERENCES event(event_id) ON DELETE CASCADE,
    judge_id        INT NOT NULL REFERENCES app_user(user_id),
    participant_id  INT NOT NULL REFERENCES app_user(user_id),
    points          INT NOT NULL CHECK (points BETWEEN 0 AND 100),
    UNIQUE (event_id, judge_id, participant_id),
    CHECK (judge_id <> participant_id)
);

CREATE TABLE audit_log (
    log_id    SERIAL PRIMARY KEY,
    user_id   INT REFERENCES app_user(user_id),
    action    VARCHAR(100) NOT NULL,
    endpoint  VARCHAR(200),
    result    VARCHAR(50),
    at_time   TIMESTAMP NOT NULL DEFAULT now()
);

-- Only one timetable version may have status 'Published' at any time
CREATE UNIQUE INDEX one_published_version
    ON timetable_version ((1))
    WHERE status = 'Published';

-- Indexes on foreign keys used in joins
CREATE INDEX idx_event_coordinator   ON event(coordinator_id);
CREATE INDEX idx_slot_event          ON schedule_slot(event_id);
CREATE INDEX idx_slot_version        ON schedule_slot(version_id);
CREATE INDEX idx_conflict_version    ON conflict(version_id);
CREATE INDEX idx_registration_event  ON registration(event_id);
CREATE INDEX idx_score_event         ON score(event_id);
CREATE INDEX idx_audit_user          ON audit_log(user_id);
