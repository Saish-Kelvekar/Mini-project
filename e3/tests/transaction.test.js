'use strict';
const h = require('./helpers'); // must be first
const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const repo = h.repo;
const { withTransaction, ConflictError, ValidationError, NotFoundError } = require('../src/services/transactionService');

let ids;
before(async () => { await h.setupTestDb(); });
after(async () => { await h.closePool(); });
beforeEach(async () => { await h.resetData(); ids = await h.seed(); });

const countUsers = async (email) =>
  (await h.getPool().query('SELECT COUNT(*) AS n FROM app_user WHERE email = $1', [email])).rows[0].n;

describe('CRUD', () => {
  test('create and read a user', async () => {
    const u = await repo.createUser({ name: 'New', email: 'new@t.edu', passwordHash: 'x', role: 'Student' });
    assert.ok(u.user_id);
    const back = await repo.getUserById(u.user_id);
    assert.equal(back.email, 'new@t.edu');
    assert.equal(back.password_hash, undefined, 'password hash must not be returned');
  });

  test('create, read, update and delete an event', async () => {
    const created = await repo.createEvent({
      name: 'Robotics', theme: 'Tech', durationMin: 90, judgesRequired: 2, coordinatorId: ids.coord,
    });
    assert.equal(created.status, 'Pending');

    const read = await repo.getEventById(created.event_id);
    assert.equal(read.name, 'Robotics');
    assert.equal(read.duration_min, 90);

    const approved = await repo.setEventStatus(created.event_id, 'Approved', { approvedBy: ids.admin, remarks: 'ok' });
    assert.equal(approved.status, 'Approved');
    assert.equal(approved.approved_by, ids.admin);
    assert.ok(approved.approved_at, 'approved_at should be stamped');
    assert.equal(approved.remarks, 'ok');

    assert.equal((await repo.listEvents({ status: 'Approved' })).length, 1);
    assert.equal((await repo.listEvents({ status: 'Pending' })).length, 0);

    await repo.deleteEvent(created.event_id);
    await assert.rejects(() => repo.getEventById(created.event_id), NotFoundError);
  });

  test('update / delete of a missing row is a NotFoundError', async () => {
    await assert.rejects(() => repo.setEventStatus(99999, 'Approved'), NotFoundError);
    await assert.rejects(() => repo.deleteEvent(99999), NotFoundError);
  });

  test('registration create / read; cancelled registration can be re-activated', async () => {
    const e = await h.mkEvent(ids, 'Quiz', 60);
    const r = await repo.registerStudent(ids.stud1, e.event_id);
    assert.equal(r.status, 'Registered');

    await h.getPool().query(`UPDATE registration SET status = 'Cancelled' WHERE reg_id = $1`, [r.reg_id]);
    const again = await repo.registerStudent(ids.stud1, e.event_id);
    assert.equal(again.reg_id, r.reg_id, 'same row is re-used');
    assert.equal(again.status, 'Registered');
  });

  test('audit log entry is stored', async () => {
    const row = await repo.logAction(ids.admin, 'LOGIN', '/login', 'success');
    assert.equal(row.action, 'LOGIN');
    assert.ok(row.at_time);
  });

  test('get_approved_events returns judges, requirements and registered_count', async () => {
    const e = await h.mkEvent(ids, 'Hackathon', 120, { status: 'Approved', judgesRequired: 2 });
    await h.mkEvent(ids, 'Still pending', 60); // Pending -> must not be returned
    await repo.assignJudge(e.event_id, ids.judge1);
    await repo.assignJudge(e.event_id, ids.judge2);
    await repo.addEventRequirement({ eventId: e.event_id, requiredVenueType: 'Venue', minCapacity: 50, equipmentNeeded: 'Projector', quantity: 1 });
    await repo.registerStudent(ids.stud1, e.event_id);
    await repo.registerStudent(ids.stud2, e.event_id);

    const list = await repo.getApprovedEvents();
    assert.equal(list.length, 1);
    const ev = list[0];
    assert.equal(ev.name, 'Hackathon');
    assert.equal(ev.coordinator_email, 'coord1@t.edu');
    assert.equal(ev.assigned_judges.length, 2);
    assert.equal(ev.requirements.length, 1);
    assert.equal(ev.requirements[0].min_capacity, 50);
    assert.equal(ev.registered_count, 2);
  });

  test('get_venues returns only Venue resources', async () => {
    const venues = await repo.getVenues();
    assert.equal(venues.length, 3);
    assert.ok(venues.every((v) => v.type === 'Venue'));
  });
});

describe('keys and duplicate rejection', () => {
  test('foreign key: a requirement for a non-existent event is rejected', async () => {
    await assert.rejects(
      () => repo.addEventRequirement({ eventId: 99999, quantity: 1 }),
      (err) => err instanceof ValidationError && err.kind === 'foreign_key' && err.code === '23503'
    );
  });

  test('event with a non-existent coordinator is rejected (role trigger runs before the FK check)', async () => {
    await assert.rejects(
      () => repo.createEvent({ name: 'Ghost', durationMin: 60, coordinatorId: 99999 }),
      (err) => err instanceof ValidationError && ['23514', '23503'].includes(err.code)
    );
  });

  test('foreign key: registering for a non-existent event is rejected', async () => {
    await assert.rejects(() => repo.registerStudent(ids.stud1, 99999), (e) => e instanceof ValidationError && e.code === '23503');
  });

  test('primary key: explicit duplicate user_id is rejected', async () => {
    await assert.rejects(
      () => h.getPool().query(`INSERT INTO app_user (user_id, name, email, password_hash, role) VALUES ($1,'X','x@t.edu','h','Student')`, [ids.admin]),
      (e) => e.code === '23505'
    );
  });

  test('duplicate email is rejected as ConflictError', async () => {
    await assert.rejects(
      () => repo.createUser({ name: 'Dup', email: 'admin@t.edu', passwordHash: 'x', role: 'Student' }),
      (e) => e instanceof ConflictError && e.kind === 'duplicate'
    );
  });

  test('duplicate active registration is rejected', async () => {
    const e = await h.mkEvent(ids, 'Quiz');
    await repo.registerStudent(ids.stud1, e.event_id);
    await assert.rejects(() => repo.registerStudent(ids.stud1, e.event_id), (err) => err instanceof ConflictError && err.kind === 'duplicate');
  });

  test('duplicate score is rejected; invalid scores are rejected', async () => {
    const e = await h.mkEvent(ids, 'Quiz');
    await repo.assignJudge(e.event_id, ids.judge1);
    await repo.registerStudent(ids.stud1, e.event_id);
    await repo.submitScore(e.event_id, ids.judge1, ids.stud1, 80);

    await assert.rejects(() => repo.submitScore(e.event_id, ids.judge1, ids.stud1, 90), ConflictError);
    await assert.rejects(() => repo.submitScore(e.event_id, ids.judge1, ids.stud1, 101), ValidationError);
    await assert.rejects(() => repo.submitScore(e.event_id, ids.judge1, ids.stud1, -1), ValidationError);
  });

  test('score: judge must be assigned and participant must be registered', async () => {
    const e = await h.mkEvent(ids, 'Quiz');
    await repo.registerStudent(ids.stud1, e.event_id);
    await assert.rejects(
      () => repo.submitScore(e.event_id, ids.judge2, ids.stud1, 50),
      (err) => err instanceof ValidationError && /not assigned/.test(err.message)
    );
    await repo.assignJudge(e.event_id, ids.judge2);
    await assert.rejects(
      () => repo.submitScore(e.event_id, ids.judge2, ids.stud2, 50),
      (err) => err instanceof ValidationError && /not registered/.test(err.message)
    );
  });

  test('role triggers: only Judges can judge, only Students can register', async () => {
    const e = await h.mkEvent(ids, 'Quiz');
    await assert.rejects(() => repo.assignJudge(e.event_id, ids.stud1), ValidationError);
    await assert.rejects(() => repo.registerStudent(ids.judge1, e.event_id), ValidationError);
  });

  test('CHECK constraints: zero duration and unknown status are rejected', async () => {
    await assert.rejects(() => h.mkEvent(ids, 'Zero', 0), ValidationError);
    const e = await h.mkEvent(ids, 'Ok');
    await assert.rejects(() => repo.setEventStatus(e.event_id, 'Nonsense'), ValidationError);
  });
});

describe('transactions: COMMIT and ROLLBACK', () => {
  test('COMMIT: all steps become visible to other connections', async () => {
    await withTransaction(async (c) => {
      await repo.createUser({ name: 'A', email: 'a@t.edu', passwordHash: 'x', role: 'Student' }, c);
      await repo.createUser({ name: 'B', email: 'b@t.edu', passwordHash: 'x', role: 'Student' }, c);
    });
    assert.equal(await countUsers('a@t.edu'), 1);
    assert.equal(await countUsers('b@t.edu'), 1);
  });

  test('isolation: uncommitted rows are invisible to other connections until COMMIT', async () => {
    let seenInside;
    await withTransaction(async (c) => {
      await repo.createUser({ name: 'A', email: 'iso@t.edu', passwordHash: 'x', role: 'Student' }, c);
      seenInside = await countUsers('iso@t.edu'); // different pooled connection
    });
    assert.equal(seenInside, 0);
    assert.equal(await countUsers('iso@t.edu'), 1);
  });

  test('ROLLBACK: an error after a successful insert undoes the earlier insert too', async () => {
    await assert.rejects(() =>
      withTransaction(async (c) => {
        await repo.createUser({ name: 'A', email: 'rb@t.edu', passwordHash: 'x', role: 'Student' }, c);
        await repo.createUser({ name: 'Dup', email: 'admin@t.edu', passwordHash: 'x', role: 'Student' }, c); // fails
      }),
      ConflictError
    );
    assert.equal(await countUsers('rb@t.edu'), 0, 'first insert must have been rolled back');
  });

  test('ROLLBACK: an application error (not a DB error) also rolls back', async () => {
    await assert.rejects(
      () => withTransaction(async (c) => {
        await repo.createUser({ name: 'A', email: 'app@t.edu', passwordHash: 'x', role: 'Student' }, c);
        throw new Error('boom');
      }),
      /boom/
    );
    assert.equal(await countUsers('app@t.edu'), 0);
  });

  test('multi-step operation is atomic: register + audit log both undone on failure', async () => {
    const e = await h.mkEvent(ids, 'Quiz');
    await assert.rejects(() =>
      withTransaction(async (c) => {
        await repo.registerStudent(ids.stud1, e.event_id, c);
        await repo.logAction(ids.stud1, 'REGISTER', '/x', 'success', c);
        await repo.logAction(99999, 'BAD', '/x', 'fail', c); // FK failure
      }),
      ValidationError
    );
    const reg = await h.getPool().query('SELECT COUNT(*) AS n FROM registration');
    const log = await h.getPool().query('SELECT COUNT(*) AS n FROM audit_log');
    assert.equal(reg.rows[0].n, 0);
    assert.equal(log.rows[0].n, 0);
  });

  test('connections are returned to the pool after COMMIT, ROLLBACK and errors', async () => {
    for (let i = 0; i < 15; i += 1) {
      await withTransaction(async (c) => c.query('SELECT 1'));
      await withTransaction(async () => { throw new Error('x'); }).catch(() => {});
      await withTransaction(async (c) => c.query('SELECT * FROM no_such_table')).catch(() => {});
    }
    const pool = h.getPool();
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.idleCount, pool.totalCount, 'every client must be idle (none leaked)');
    await h.getPool().query('SELECT 1'); // pool still works
  });

  test('errors carry the PostgreSQL code and constraint name', async () => {
    try {
      await repo.createUser({ name: 'Dup', email: 'admin@t.edu', passwordHash: 'x', role: 'Student' });
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.code, '23505');
      assert.ok(err.constraint);
    }
  });
});
