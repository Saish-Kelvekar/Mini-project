// E4 role-permission matrix (NFR-04): every endpoint lists the roles allowed to call it.
// An endpoint that is not in this table is denied for everyone.
const ROLES = ['admin', 'coordinator', 'judge', 'student'];

const MATRIX = {
  'GET /auth/me':               ['admin', 'coordinator', 'judge', 'student'],
  'POST /auth/change-password': ['admin', 'coordinator', 'judge', 'student'],
  'GET /events':                ['admin', 'coordinator', 'student'],
  'POST /events':               ['coordinator'],
  'PUT /events/:id':            ['coordinator'],
  'POST /events/:id/register':  ['student'],
  'DELETE /events/:id/register':['student'],
  'GET /timetable':             ['admin', 'coordinator', 'judge', 'student'],
  'POST /timetable/generate':   ['admin'],
  'POST /timetable/publish':    ['admin'],
  'GET /schedule/me':           ['judge'],
  'GET /audit':                 ['admin'],
};

module.exports = { ROLES, MATRIX };
