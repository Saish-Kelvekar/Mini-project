# E4 – Secure Access & Web Interface Engine (Sprint 1 slice)

React + Node.js/Express. Covers **FR-01, FR-06, NFR-04, NFR-05** (partial). Other engines are stubbed.

## What works
- JWT login (bcrypt-hashed passwords, 1 h tokens, HS256 pinned).
- **Role-permission matrix** (`server/src/permissions.js`) enforced on every endpoint: 401 (not signed in) / 403 (wrong role). Endpoints missing from the matrix are denied.
- Role-scoped screens: Admin, Coordinator, Judge, Student see different menus and data.
- Event proposal form (FR-01) with client + server validation: 400 with field errors, 201 on success.
- FC-04: a coordinator editing another coordinator's event gets 403, and the attempt appears in the admin's **Access log**.
- Core task (sign in -> New event -> Submit) is 3 clicks (NFR-05).

## Stubs (to be replaced)
| Stub | Replaced by |
|---|---|
| In-memory store (`server/src/store.js`) | E3 PostgreSQL, `POST /events` |
| In-memory users (`server/src/users.js`) | E3 USER / ROLE tables |
| `POST /timetable/generate` | E1 `POST /timetable/generate` |
| `POST /timetable/publish` | E3 publish + versioning |
| `GET /schedule/me` | E2/E3 judge assignments |

## Run
```bash
cd server && npm install && npm test   # 10 API tests
npm start                              # http://localhost:4000

cd ../client && npm install && npm run dev   # http://localhost:5173 (proxies /api -> :4000)
```
Dev accounts: `admin@college.test` (`Admin@2026`), `coord1@college.test` (`Coord1@2026`), `coord2@college.test` (`Coord2@2026`), `judge@college.test` (`Judge@2026`), `student@college.test` (`Student@2026`).
Set `JWT_SECRET` in production; the default is for development only. Serve over HTTPS in deployment (NFR-04).

## Demo script for Gate 2
1. Sign in as Coordinator -> New event (specify time in hours & resources required) -> submit with bad values (field errors) -> submit valid (201).
2. Sign in as Admin -> Timetable -> Generate -> Publish. Notice Admin only has Timetable, Events, and Access log (cannot add events).
3. Sign in as Student -> see published events -> click **Register** to register for an event (or click **✓ Registered** to cancel).
4. As coord2, try to edit coord1's event (API test `FC-04`) -> Admin's Access log shows the denial.
