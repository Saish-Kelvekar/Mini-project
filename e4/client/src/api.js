// Thin REST client. Sends the JWT on every call and signs the user out on any 401.
let token = (() => {
  try {
    return JSON.parse(sessionStorage.getItem('session'))?.token ?? null;
  } catch {
    return null;
  }
})();
let onUnauthorized = () => {};
export const setToken = (t) => { token = t; };
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function request(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    const err = new Error(data.error || 'Something went wrong. Try again.');
    err.status = res.status;
    err.fields = data.errors || {};
    throw err;
  }
  return data;
}

export const api = {
  login: (email, password) => request('POST', '/auth/login', { email, password }),
  events: () => request('GET', '/events'),
  createEvent: (e) => request('POST', '/events', e),
  registerEvent: (id) => request('POST', `/events/${id}/register`),
  unregisterEvent: (id) => request('DELETE', `/events/${id}/register`),
  timetable: () => request('GET', '/timetable'),
  generate: () => request('POST', '/timetable/generate'),
  publish: () => request('POST', '/timetable/publish'),
  mySchedule: () => request('GET', '/schedule/me'),
  audit: () => request('GET', '/audit'),
};
