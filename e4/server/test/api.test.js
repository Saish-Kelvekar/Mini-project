// E4 API tests: 401 / 403 / 400 / 201 behaviour and role scoping.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createApp } = require("../src/app");
const { DEV_PASSWORDS } = require("../src/users");

let server, base;
before(async () => {
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};
const login = async (email) =>
  (
    await call("POST", "/auth/login", {
      body: { email, password: DEV_PASSWORDS[email] },
    })
  ).data.token;
const goodEvent = {
  name: "Hackathon Finals",
  type: "technical",
  durationMinutes: 120,
  judgesRequired: 3,
  preferredVenue: "Lab 2",
  preferredDate: "2026-11-20",
};

test("login succeeds with correct credentials and fails with the same message otherwise", async () => {
  const ok = await call("POST", "/auth/login", {
    body: {
      email: "admin@college.test",
      password: DEV_PASSWORDS["admin@college.test"],
    },
  });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.token);
  assert.equal(ok.data.user.passwordHash, undefined);
  const badPw = await call("POST", "/auth/login", {
    body: { email: "admin@college.test", password: "nope" },
  });
  const noUser = await call("POST", "/auth/login", {
    body: { email: "x@y.z", password: "nope" },
  });
  assert.equal(badPw.status, 401);
  assert.equal(noUser.status, 401);
  assert.equal(badPw.data.error, noUser.data.error);
});

test("no token, garbage token, expired token and wrong-secret token all return 401", async () => {
  assert.equal((await call("GET", "/events")).status, 401);
  assert.equal(
    (await call("GET", "/events", { token: "garbage" })).status,
    401,
  );
  const expired = jwt.sign(
    { sub: "u1", role: "admin", name: "x" },
    "dev-only-secret-change-me",
    { expiresIn: -10 },
  );
  assert.equal((await call("GET", "/events", { token: expired })).status, 401);
  const forged = jwt.sign(
    { sub: "u1", role: "admin", name: "x" },
    "wrong-secret",
  );
  assert.equal((await call("GET", "/events", { token: forged })).status, 401);
});

test("wrong role returns 403 (student and admin cannot create events, judge cannot list events)", async () => {
  const student = await login("student@college.test");
  const judge = await login("judge@college.test");
  const admin = await login("admin@college.test");
  assert.equal(
    (await call("POST", "/events", { token: student, body: goodEvent })).status,
    403,
  );
  assert.equal(
    (await call("POST", "/events", { token: admin, body: goodEvent })).status,
    403,
  );
  assert.equal((await call("GET", "/events", { token: judge })).status, 403);
  assert.equal(
    (await call("POST", "/timetable/publish", { token: student })).status,
    403,
  );
});

test("invalid event returns 400 with field errors; valid event returns 201", async () => {
  const coord = await login("coord1@college.test");
  const bad = await call("POST", "/events", {
    token: coord,
    body: { name: "A", type: "x", durationMinutes: 5, judgesRequired: -1 },
  });
  assert.equal(bad.status, 400);
  for (const f of ["name", "type", "durationMinutes", "judgesRequired"])
    assert.ok(bad.data.errors[f], `missing error for ${f}`);
  const good = await call("POST", "/events", { token: coord, body: goodEvent });
  assert.equal(good.status, 201);
  assert.equal(good.data.event.status, "Submitted");
});

test("FC-04: coordinator cannot edit another coordinator's event; attempt is logged", async () => {
  const c1 = await login("coord1@college.test");
  const c2 = await login("coord2@college.test");
  const admin = await login("admin@college.test");
  const { data } = await call("POST", "/events", {
    token: c1,
    body: goodEvent,
  });
  const attempt = await call("PUT", `/events/${data.event.id}`, {
    token: c2,
    body: goodEvent,
  });
  assert.equal(attempt.status, 403);
  const own = await call("PUT", `/events/${data.event.id}`, {
    token: c1,
    body: { ...goodEvent, name: "Hackathon Round 2" },
  });
  assert.equal(own.status, 200);
  const audit = (await call("GET", "/audit", { token: admin })).data.audit;
  assert.ok(
    audit.some(
      (a) => a.role === "coordinator" && a.result === "DENIED (not owner)",
    ),
  );
});

test("coordinators only see their own events; students only see published ones", async () => {
  const c2 = await login("coord2@college.test");
  const student = await login("student@college.test");
  const mine = (await call("GET", "/events", { token: c2 })).data.events;
  assert.ok(mine.every((e) => e.ownerId === "u3"));
  assert.equal(
    (await call("GET", "/events", { token: student })).data.events.length,
    0,
  );
});

test("admin generate -> publish flow; students and judges then see the published result", async () => {
  const admin = await login("admin@college.test");
  const student = await login("student@college.test");
  const judge = await login("judge@college.test");
  assert.equal(
    (await call("POST", "/timetable/generate", { token: admin })).status,
    200,
  );
  assert.equal(
    (await call("GET", "/timetable", { token: student })).data.timetable,
    null,
  ); // not published yet
  assert.equal(
    (await call("POST", "/timetable/publish", { token: admin })).status,
    200,
  );
  assert.ok(
    (await call("GET", "/timetable", { token: student })).data.timetable
      .published,
  );
  assert.ok(
    (await call("GET", "/events", { token: student })).data.events.length > 0,
  );
  assert.ok(
    (await call("GET", "/schedule/me", { token: judge })).data.entries.length >
      0,
  );
});

test("users can change their own password; old password stops working", async () => {
  const ORIGINAL = DEV_PASSWORDS["coord2@college.test"];
  const token = await login("coord2@college.test");
  const change = (cur, next) =>
    call("POST", "/auth/change-password", {
      token,
      body: { currentPassword: cur, newPassword: next },
    });
  assert.equal((await change("wrong-one", "NewPass123")).status, 400); // wrong current password
  assert.equal((await change(ORIGINAL, "short")).status, 400); // too weak
  assert.equal((await change(ORIGINAL, "NewPass123")).status, 200);
  const oldLogin = await call("POST", "/auth/login", {
    body: { email: "coord2@college.test", password: ORIGINAL },
  });
  const newLogin = await call("POST", "/auth/login", {
    body: { email: "coord2@college.test", password: "NewPass123" },
  });
  assert.equal(oldLogin.status, 401);
  assert.equal(newLogin.status, 200);
  assert.equal(
    (await call("POST", "/auth/change-password", { body: {} })).status,
    401,
  ); // needs sign-in
  await change("NewPass123", ORIGINAL); // restore for the other tests
});

test("student can register and unregister for events; other roles cannot register", async () => {
  const coord = await login("coord1@college.test");
  const student = await login("student@college.test");
  const admin = await login("admin@college.test");

  const created = await call("POST", "/events", {
    token: coord,
    body: { ...goodEvent, durationHours: 2, resourcesRequired: "Projector, 2 Mics" },
  });
  assert.equal(created.status, 201);
  const eventId = created.data.event.id;
  assert.equal(created.data.event.resourcesRequired, "Projector, 2 Mics");
  assert.equal(created.data.event.durationHours, 2);

  // Non-student gets 403
  assert.equal((await call("POST", `/events/${eventId}/register`, { token: coord })).status, 403);
  assert.equal((await call("POST", `/events/${eventId}/register`, { token: admin })).status, 403);

  // Student registers
  const reg = await call("POST", `/events/${eventId}/register`, { token: student });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.ok, true);

  // Duplicate registration returns 409
  const dup = await call("POST", `/events/${eventId}/register`, { token: student });
  assert.equal(dup.status, 409);

  // Student unregisters
  const unreg = await call("DELETE", `/events/${eventId}/register`, { token: student });
  assert.equal(unreg.status, 200);
  assert.equal(unreg.data.ok, true);
});

test("unknown routes return 404 and the matrix covers all guarded endpoints", async () => {
  const { MATRIX } = require("../src/permissions");
  assert.equal(Object.keys(MATRIX).length, 12);
  assert.equal((await call("GET", "/not-a-route")).status, 404);
});
