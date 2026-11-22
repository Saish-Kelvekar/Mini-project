-- =============================================================================
-- Event Management, Proposal Approval and Timetable Generation System
-- PostgreSQL Schema (Engine 3: Database Engine)
-- Run: psql -U postgres -d event_timetable -f schema.sql
-- =============================================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 2. USERS
-- "user" is a reserved keyword in PostgreSQL; hence app_user.
CREATE TABLE IF NOT EXISTS app_user (
    user_id        SERIAL PRIMARY KEY,
    name           VARCHAR(100) NOT NULL,
    email          VARCHAR(150) NOT NULL UNIQUE,
    password_hash  VARCHAR(255) NOT NULL,
    role           VARCHAR(20)  NOT NULL
                   CHECK (role IN ('Admin', 'Coordinator', 'Judge', 'Student'))
);

-- 3. FEST & SCHEDULER CONFIGURATION
CREATE TABLE IF NOT EXISTS fest_config (
    config_id         SERIAL PRIMARY KEY,
    fest_name         VARCHAR(100) NOT NULL,
    start_date        DATE NOT NULL,
    end_date          DATE NOT NULL CHECK (end_date >= start_date),
    daily_start_time  TIME NOT NULL,
    daily_end_time    TIME NOT NULL CHECK (daily_end_time > daily_start_time),
    lunch_break_start TIME,
    lunch_break_end   TIME CHECK (lunch_break_end > lunch_break_start)
);

-- 4. RESOURCES (Venues & Equipment)
CREATE TABLE IF NOT EXISTS resource (
    resource_id  SERIAL PRIMARY KEY,
    type         VARCHAR(20) NOT NULL CHECK (type IN ('Venue', 'Equipment')),
    name         VARCHAR(100) NOT NULL,
    capacity     INT CHECK (capacity IS NULL OR capacity > 0)
);

-- 5. AVAILABILITY
CREATE TABLE IF NOT EXISTS venue_availability (
    avail_id      SERIAL PRIMARY KEY,
    venue_id      INT NOT NULL REFERENCES resource(resource_id) ON DELETE CASCADE,
    start_time    TIMESTAMP NOT NULL,
    end_time      TIMESTAMP NOT NULL CHECK (end_time > start_time),
    is_available  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS judge_availability (
    avail_id      SERIAL PRIMARY KEY,
    judge_id      INT NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
    start_time    TIMESTAMP NOT NULL,
    end_time      TIMESTAMP NOT NULL CHECK (end_time > start_time),
    is_available  BOOLEAN NOT NULL DEFAULT TRUE
);

-- 6. EVENTS
CREATE TABLE IF NOT EXISTS event (
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
    approved_at      TIMESTAMP,
    created_at       TIMESTAMP NOT NULL DEFAULT now()
);

-- 7. EVENT REQUIREMENTS (for Scheduler/Solver)
CREATE TABLE IF NOT EXISTS event_requirement (
    req_id               SERIAL PRIMARY KEY,
    event_id             INT NOT NULL REFERENCES event(event_id) ON DELETE CASCADE,
    resource_id          INT REFERENCES resource(resource_id),
    required_venue_type  VARCHAR(50),
    min_capacity         INT CHECK (min_capacity IS NULL OR min_capacity > 0),
    equipment_needed     VARCHAR(100),
    quantity             INT NOT NULL DEFAULT 1 CHECK (quantity > 0)
);

-- 8. EVENT JUDGES
CREATE TABLE IF NOT EXISTS event_judge (
    event_id  INT NOT NULL REFERENCES event(event_id) ON DELETE CASCADE,
    judge_id  INT NOT NULL REFERENCES app_user(user_id),
    PRIMARY KEY (event_id, judge_id)
);

-- 9. TIMETABLE VERSIONS
CREATE TABLE IF NOT EXISTS timetable_version (
    version_id    SERIAL PRIMARY KEY,
    version_no    INT NOT NULL UNIQUE,
    status        VARCHAR(20) NOT NULL DEFAULT 'Draft'
                  CHECK (status IN ('Draft', 'Published', 'Archived')),
    published_by  INT REFERENCES app_user(user_id),
    published_at  TIMESTAMP
);

-- 10. SCHEDULE SLOTS
-- Enforces no overlapping events in the same venue within a timetable version
CREATE TABLE IF NOT EXISTS schedule_slot (
    slot_id     SERIAL PRIMARY KEY,
    event_id    INT NOT NULL REFERENCES event(event_id) ON DELETE CASCADE,
    version_id  INT NOT NULL REFERENCES timetable_version(version_id) ON DELETE CASCADE,
    venue_id    INT NOT NULL REFERENCES resource(resource_id),
    start_time  TIMESTAMP NOT NULL,
    end_time    TIMESTAMP NOT NULL,
    CHECK (end_time > start_time),
    UNIQUE (version_id, event_id),
    EXCLUDE USING gist (
        version_id WITH =,
        venue_id   WITH =,
        tsrange(start_time, end_time) WITH &&
    )
);

-- 11. EQUIPMENT ALLOCATIONS
-- Version-aware equipment reservations preventing double-booking within a timetable version
CREATE TABLE IF NOT EXISTS allocation (
    alloc_id     SERIAL PRIMARY KEY,
    event_id     INT NOT NULL REFERENCES event(event_id) ON DELETE CASCADE,
    resource_id  INT NOT NULL REFERENCES resource(resource_id),
    version_id   INT NOT NULL REFERENCES timetable_version(version_id) ON DELETE CASCADE,
    quantity     INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
    start_time   TIMESTAMP NOT NULL,
    end_time     TIMESTAMP NOT NULL,
    CHECK (end_time > start_time),
    EXCLUDE USING gist (
        version_id  WITH =,
        resource_id WITH =,
        tsrange(start_time, end_time) WITH &&
    )
);

-- 12. CONFLICTS
CREATE TABLE IF NOT EXISTS conflict (
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
    detected_at  TIMESTAMP NOT NULL DEFAULT now(),
    CHECK (event_a < event_b),
    UNIQUE NULLS NOT DISTINCT (version_id, event_a, event_b, type, resource_id)
);

-- 13. REGISTRATIONS
CREATE TABLE IF NOT EXISTS registration (
    reg_id         SERIAL PRIMARY KEY,
    student_id     INT NOT NULL REFERENCES app_user(user_id),
    event_id       INT NOT NULL REFERENCES event(event_id) ON DELETE CASCADE,
    status         VARCHAR(20) NOT NULL DEFAULT 'Registered'
                   CHECK (status IN ('Registered', 'Cancelled', 'Attended')),
    registered_at  TIMESTAMP NOT NULL DEFAULT now(),
    UNIQUE (event_id, student_id)
);

-- 14. SCORES
CREATE TABLE IF NOT EXISTS score (
    score_id        SERIAL PRIMARY KEY,
    event_id        INT NOT NULL,
    judge_id        INT NOT NULL,
    participant_id  INT NOT NULL,
    points          INT NOT NULL CHECK (points BETWEEN 0 AND 100),
    FOREIGN KEY (event_id, judge_id) REFERENCES event_judge(event_id, judge_id) ON DELETE CASCADE,
    FOREIGN KEY (event_id, participant_id) REFERENCES registration(event_id, student_id) ON DELETE CASCADE,
    UNIQUE (event_id, judge_id, participant_id),
    CHECK (judge_id <> participant_id)
);

-- 15. AUDIT LOG
CREATE TABLE IF NOT EXISTS audit_log (
    log_id    SERIAL PRIMARY KEY,
    user_id   INT REFERENCES app_user(user_id),
    action    VARCHAR(100) NOT NULL,
    endpoint  VARCHAR(200),
    result    VARCHAR(50),
    at_time   TIMESTAMP NOT NULL DEFAULT now()
);

-- =============================================================================
-- INDEXES
-- =============================================================================

-- Ensure exactly one timetable version can be 'Published'
CREATE UNIQUE INDEX IF NOT EXISTS one_published_version
    ON timetable_version ((1))
    WHERE status = 'Published';

-- Foreign key indexes for query performance
CREATE INDEX IF NOT EXISTS idx_event_coordinator   ON event(coordinator_id);
CREATE INDEX IF NOT EXISTS idx_event_approved_by   ON event(approved_by);
CREATE INDEX IF NOT EXISTS idx_event_judge_judge   ON event_judge(judge_id);
CREATE INDEX IF NOT EXISTS idx_slot_event          ON schedule_slot(event_id);
CREATE INDEX IF NOT EXISTS idx_slot_version        ON schedule_slot(version_id);
CREATE INDEX IF NOT EXISTS idx_slot_venue          ON schedule_slot(venue_id);
CREATE INDEX IF NOT EXISTS idx_allocation_event    ON allocation(event_id);
CREATE INDEX IF NOT EXISTS idx_allocation_resource ON allocation(resource_id);
CREATE INDEX IF NOT EXISTS idx_allocation_version  ON allocation(version_id);
CREATE INDEX IF NOT EXISTS idx_conflict_version    ON conflict(version_id);
CREATE INDEX IF NOT EXISTS idx_conflict_events     ON conflict(event_a, event_b);
CREATE INDEX IF NOT EXISTS idx_conflict_resource   ON conflict(resource_id);
CREATE INDEX IF NOT EXISTS idx_registration_event  ON registration(event_id);
CREATE INDEX IF NOT EXISTS idx_registration_student ON registration(student_id);
CREATE INDEX IF NOT EXISTS idx_score_event         ON score(event_id);
CREATE INDEX IF NOT EXISTS idx_score_judge         ON score(judge_id);
CREATE INDEX IF NOT EXISTS idx_score_participant   ON score(participant_id);
CREATE INDEX IF NOT EXISTS idx_audit_user          ON audit_log(user_id);

-- =============================================================================
-- TRIGGERS & VALIDATION FUNCTIONS
-- =============================================================================

-- Trigger 1: Ensure schedule_slot.venue_id points to a resource of type 'Venue'
CREATE OR REPLACE FUNCTION check_slot_venue_type()
RETURNS TRIGGER AS $$
DECLARE
    v_type VARCHAR(20);
BEGIN
    SELECT type INTO v_type FROM resource WHERE resource_id = NEW.venue_id;
    IF v_type IS DISTINCT FROM 'Venue' THEN
        RAISE EXCEPTION 'Resource % is of type %, but schedule_slot requires a Venue.', NEW.venue_id, v_type
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_slot_venue_type ON schedule_slot;
CREATE TRIGGER trg_slot_venue_type
    BEFORE INSERT OR UPDATE OF venue_id ON schedule_slot
    FOR EACH ROW EXECUTE FUNCTION check_slot_venue_type();


-- Trigger 2: Ensure slot duration exactly equals event.duration_min
CREATE OR REPLACE FUNCTION check_slot_duration()
RETURNS TRIGGER AS $$
DECLARE
    v_dur INT;
BEGIN
    SELECT duration_min INTO v_dur FROM event WHERE event_id = NEW.event_id;
    IF (NEW.end_time - NEW.start_time) <> (v_dur * INTERVAL '1 minute') THEN
        RAISE EXCEPTION 'Slot duration (%) must equal event duration_min (% minutes)',
            (NEW.end_time - NEW.start_time), v_dur
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_slot_duration ON schedule_slot;
CREATE TRIGGER trg_slot_duration
    BEFORE INSERT OR UPDATE OF start_time, end_time, event_id ON schedule_slot
    FOR EACH ROW EXECUTE FUNCTION check_slot_duration();


-- Trigger 3: Enforce roles in event (coordinator must be Coordinator; approved_by must be Admin)
CREATE OR REPLACE FUNCTION check_event_roles()
RETURNS TRIGGER AS $$
DECLARE
    v_role VARCHAR(20);
BEGIN
    SELECT role INTO v_role FROM app_user WHERE user_id = NEW.coordinator_id;
    IF v_role IS DISTINCT FROM 'Coordinator' THEN
        RAISE EXCEPTION 'User % is not a Coordinator (role: %)', NEW.coordinator_id, v_role
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.approved_by IS NOT NULL THEN
        SELECT role INTO v_role FROM app_user WHERE user_id = NEW.approved_by;
        IF v_role IS DISTINCT FROM 'Admin' THEN
            RAISE EXCEPTION 'Approving user % is not an Admin (role: %)', NEW.approved_by, v_role
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_event_roles ON event;
CREATE TRIGGER trg_event_roles
    BEFORE INSERT OR UPDATE OF coordinator_id, approved_by ON event
    FOR EACH ROW EXECUTE FUNCTION check_event_roles();


-- Trigger 4: Enforce Judge role on event_judge and judge_availability
CREATE OR REPLACE FUNCTION check_judge_role()
RETURNS TRIGGER AS $$
DECLARE
    v_role VARCHAR(20);
BEGIN
    SELECT role INTO v_role FROM app_user WHERE user_id = NEW.judge_id;
    IF v_role IS DISTINCT FROM 'Judge' THEN
        RAISE EXCEPTION 'User % is not a Judge (role: %)', NEW.judge_id, v_role
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_event_judge_role ON event_judge;
CREATE TRIGGER trg_event_judge_role
    BEFORE INSERT OR UPDATE OF judge_id ON event_judge
    FOR EACH ROW EXECUTE FUNCTION check_judge_role();

DROP TRIGGER IF EXISTS trg_judge_avail_role ON judge_availability;
CREATE TRIGGER trg_judge_avail_role
    BEFORE INSERT OR UPDATE OF judge_id ON judge_availability
    FOR EACH ROW EXECUTE FUNCTION check_judge_role();


-- Trigger 5: Enforce Student role on registration
CREATE OR REPLACE FUNCTION check_student_role()
RETURNS TRIGGER AS $$
DECLARE
    v_role VARCHAR(20);
BEGIN
    SELECT role INTO v_role FROM app_user WHERE user_id = NEW.student_id;
    IF v_role IS DISTINCT FROM 'Student' THEN
        RAISE EXCEPTION 'User % is not a Student (role: %)', NEW.student_id, v_role
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_registration_student_role ON registration;
CREATE TRIGGER trg_registration_student_role
    BEFORE INSERT OR UPDATE OF student_id ON registration
    FOR EACH ROW EXECUTE FUNCTION check_student_role();


-- =============================================================================
-- VIEWS FOR CONFLICT DETECTION & REPORTING
-- =============================================================================

-- View 1: Judge conflicts (same judge assigned to overlapping slots in the same timetable version)
CREATE OR REPLACE VIEW v_judge_conflicts AS
SELECT
    s1.version_id,
    j1.judge_id,
    u.name AS judge_name,
    s1.event_id AS event_a,
    e1.name AS event_a_name,
    s2.event_id AS event_b,
    e2.name AS event_b_name,
    s1.slot_id AS slot_a_id,
    s2.slot_id AS slot_b_id,
    GREATEST(s1.start_time, s2.start_time) AS conflict_start,
    LEAST(s1.end_time, s2.end_time) AS conflict_end
FROM schedule_slot s1
JOIN schedule_slot s2
  ON s1.version_id = s2.version_id
 AND s1.event_id < s2.event_id
 AND tsrange(s1.start_time, s1.end_time) && tsrange(s2.start_time, s2.end_time)
JOIN event_judge j1 ON j1.event_id = s1.event_id
JOIN event_judge j2 ON j2.event_id = s2.event_id AND j1.judge_id = j2.judge_id
JOIN app_user u ON u.user_id = j1.judge_id
JOIN event e1 ON e1.event_id = s1.event_id
JOIN event e2 ON e2.event_id = s2.event_id;


-- View 2: Participant conflicts (same student registered for overlapping slots in the same version)
CREATE OR REPLACE VIEW v_participant_conflicts AS
SELECT
    s1.version_id,
    r1.student_id,
    u.name AS student_name,
    s1.event_id AS event_a,
    e1.name AS event_a_name,
    s2.event_id AS event_b,
    e2.name AS event_b_name,
    s1.slot_id AS slot_a_id,
    s2.slot_id AS slot_b_id,
    GREATEST(s1.start_time, s2.start_time) AS conflict_start,
    LEAST(s1.end_time, s2.end_time) AS conflict_end
FROM schedule_slot s1
JOIN schedule_slot s2
  ON s1.version_id = s2.version_id
 AND s1.event_id < s2.event_id
 AND tsrange(s1.start_time, s1.end_time) && tsrange(s2.start_time, s2.end_time)
JOIN registration r1 ON r1.event_id = s1.event_id AND r1.status <> 'Cancelled'
JOIN registration r2 ON r2.event_id = s2.event_id AND r2.status <> 'Cancelled' AND r1.student_id = r2.student_id
JOIN app_user u ON u.user_id = r1.student_id
JOIN event e1 ON e1.event_id = s1.event_id
JOIN event e2 ON e2.event_id = s2.event_id;


-- View 3: Judge shortfall (events where assigned judges < judges_required)
CREATE OR REPLACE VIEW v_event_judge_shortfall AS
SELECT
    e.event_id,
    e.name AS event_name,
    e.judges_required,
    COUNT(ej.judge_id)::INT AS judges_assigned,
    (e.judges_required - COUNT(ej.judge_id))::INT AS shortfall
FROM event e
LEFT JOIN event_judge ej ON e.event_id = ej.event_id
GROUP BY e.event_id, e.name, e.judges_required
HAVING COUNT(ej.judge_id) < e.judges_required;


-- View 4: Capacity violations (active registrations exceed venue capacity)
CREATE OR REPLACE VIEW v_capacity_violations AS
SELECT
    s.version_id,
    s.slot_id,
    s.event_id,
    e.name AS event_name,
    s.venue_id,
    r.name AS venue_name,
    r.capacity AS venue_capacity,
    COUNT(reg.reg_id)::INT AS registered_students,
    (COUNT(reg.reg_id) - r.capacity)::INT AS excess_participants
FROM schedule_slot s
JOIN event e ON s.event_id = e.event_id
JOIN resource r ON s.venue_id = r.resource_id
LEFT JOIN registration reg ON reg.event_id = s.event_id AND reg.status <> 'Cancelled'
WHERE r.capacity IS NOT NULL
GROUP BY s.version_id, s.slot_id, s.event_id, e.name, s.venue_id, r.name, r.capacity
HAVING COUNT(reg.reg_id) > r.capacity;
