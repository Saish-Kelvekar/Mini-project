import { useEffect, useState } from 'react';
import { api, setToken, setUnauthorizedHandler } from './api.js';
import Login from './pages/Login.jsx';
import Events from './pages/Events.jsx';
import EventForm from './pages/EventForm.jsx';
import Timetable from './pages/Timetable.jsx';
import Schedule from './pages/Schedule.jsx';
import Audit from './pages/Audit.jsx';

// Role-scoped navigation: each role only gets the screens its API permissions allow.
const VIEWS = {
  events:    { label: 'Events',        component: Events },
  new:       { label: 'New event',     component: EventForm },
  timetable: { label: 'Timetable',     component: Timetable },
  schedule:  { label: 'My schedule',   component: Schedule },
  audit:     { label: 'Access log',    component: Audit },
};
const NAV = {
  admin:       ['events', 'timetable', 'audit'],
  coordinator: ['events', 'new'],
  judge:       ['schedule'],
  student:     ['events', 'timetable'],
};

export default function App() {
  const [session, setSession] = useState(() => {
    try {
      const s = JSON.parse(sessionStorage.getItem('session'));
      if (s?.token) setToken(s.token);
      return s;
    } catch {
      return null;
    }
  });
  const [view, setView] = useState(null);
  const [notice, setNotice] = useState('');
  const [successToast, setSuccessToast] = useState('');

  const signOut = (message = '') => {
    setToken(null);
    sessionStorage.removeItem('session');
    setSession(null);
    setView(null);
    setNotice(message);
    setSuccessToast('');
  };

  useEffect(() => {
    setUnauthorizedHandler(() => signOut('Please sign in to continue.'));
  }, []);

  useEffect(() => {
    if (!successToast) return undefined;
    const t = setTimeout(() => setSuccessToast(''), 4000);
    return () => clearTimeout(t);
  }, [successToast]);

  const signIn = (s) => {
    setToken(s.token);
    sessionStorage.setItem('session', JSON.stringify(s));
    setSession(s);
    setNotice('');
    setView(NAV[s.user.role][0]);
    setSuccessToast(`Signed in successfully as ${s.user.name} (${s.user.role})!`);
  };

  if (!session) return <Login onSignIn={signIn} notice={notice} />;

  const { user } = session;
  const nav = NAV[user.role];
  const current = nav.includes(view) ? view : nav[0];
  const View = VIEWS[current].component;

  return (
    <div className="shell">
      {successToast && (
        <div className="toast toast-success" role="status">
          <span>{successToast}</span>
          <button type="button" className="toast-x" onClick={() => setSuccessToast('')} aria-label="Dismiss notification">×</button>
        </div>
      )}
      <header className="topbar">
        <div className="brand"><span className="mark" aria-hidden="true" />Event Scheduler</div>
        <nav aria-label="Main">
          {nav.map((key) => (
            <button key={key} className={key === current ? 'tab active' : 'tab'} onClick={() => setView(key)}>
              {VIEWS[key].label}
            </button>
          ))}
        </nav>
        <div className="who">
          <span>{user.name}</span>
          <span className={`role role-${user.role}`}>{user.role}</span>
          <button className="link" onClick={() => signOut()}>Sign out</button>
        </div>
      </header>
      <main>
        <View user={user} goTo={setView} />
      </main>
    </div>
  );
}
