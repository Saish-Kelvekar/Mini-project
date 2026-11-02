// Seed users for development/testing WITHOUT a database. Each test account has its own password.
// Passwords are stored hashed (bcrypt), never in plain text. E3 will replace this with the USER / ROLE tables.
const bcrypt = require("bcryptjs");

// Test-only credentials (email -> password). Real users will set their own via the Account page.
const DEV_PASSWORDS = {
  "admin@college.test": "Admin@2026",
  "coord1@college.test": "Coord1@2026",
  "coord2@college.test": "Coord2@2026",
  "judge@college.test": "Judge@2026",
  "student@college.test": "Student@2026",
};

const seed = [
  { id: "u1", name: " Admin", email: "admin@college.test", role: "admin" },
  {
    id: "u2",
    name: " Coordinator",
    email: "coord1@college.test",
    role: "coordinator",
  },
  {
    id: "u3",
    name: " Coordinator",
    email: "coord2@college.test",
    role: "coordinator",
  },
  { id: "u4", name: " Judge", email: "judge@college.test", role: "judge" },
  {
    id: "u5",
    name: " Student",
    email: "student@college.test",
    role: "student",
  },
];

const users = seed.map((u) => ({
  ...u,
  passwordHash: bcrypt.hashSync(DEV_PASSWORDS[u.email], 8),
}));

const publicUser = ({ id, name, email, role }) => ({ id, name, email, role });

module.exports = { users, publicUser, DEV_PASSWORDS };
