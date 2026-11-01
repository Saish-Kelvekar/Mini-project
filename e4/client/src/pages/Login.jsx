import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// Quick-fill test accounts. These exist ONLY in development builds (import.meta.env.DEV is false in `npm run build`).
// Passwords match server/src/users.js and are never printed on the page.
const DEV_ACCOUNTS = [
  ['Admin',       'admin@college.test',   'Admin@2026'],
  ['Coordinator', 'coord1@college.test',  'Coord1@2026'],
  ['Judge',       'judge@college.test',   'Judge@2026'],
  ['Student',     'student@college.test', 'Student@2026'],
];

// Decorative timetable: columns are venues, blocks are events, the gap is a free slot.
function TimetableArt() {
  const blocks = [
    [20, 20, 70, 50, 0.35], [20, 80, 70, 70, 0.18], [20, 160, 70, 40, 0.28],
    [110, 20, 70, 80, 0.18], [110, 110, 70, 45, 1], [110, 165, 70, 35, 0.18],
    [200, 20, 70, 35, 0.28], [200, 65, 70, 60, 0.35], [200, 135, 70, 65, 0.18],
    [290, 20, 70, 60, 0.18], [290, 90, 70, 40, 0.28], [290, 140, 70, 60, 0.35],
  ];
  return (
    <svg className="art" viewBox="0 0 380 220" aria-hidden="true">
      {blocks.map(([x, y, w, h, o], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} rx="5" fill="var(--gold)" opacity={o} />
      ))}
    </svg>
  );
}

export default function Login({ onSignIn, notice }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [toast, setToast] = useState(notice || '');
  const [busy, setBusy] = useState(false);
  const emailRef = useRef(null);

  // Notifications disappear on their own after 5 seconds.
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // On a failed sign-in: show the message, clear both fields and put the cursor back in Email.
  const fail = (message) => {
    setEmail('');
    setPassword('');
    setToast(message);
    emailRef.current?.focus();
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!email || !password) return setToast('Enter your email and password.');
    setBusy(true);
    try {
      onSignIn(await api.login(email, password));
    } catch (err) {
      fail(err.status ? err.message : 'Cannot reach the server. Check that it is running.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-split">
      {toast && (
        <div className="toast" role="alert">
          <span>{toast}</span>
          <button type="button" className="toast-x" onClick={() => setToast('')} aria-label="Dismiss notification">×</button>
        </div>
      )}

      <aside className="login-hero">
        <div className="hero-brand">Event Scheduler</div>
        <div className="hero-body">
          <h1>One timetable for every fest event.</h1>
          <p>Propose events, assign judges and venues, and publish a schedule with no double bookings.</p>
          <TimetableArt />
        </div>
      </aside>

      <section className="login-form-side">
        <form className="login-form" onSubmit={submit} noValidate>
          <h2>Sign in</h2>
          <p className="muted">Use the account your college event committee gave you.</p>
          <label>Email
            <input ref={emailRef} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </label>
          <label>Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          <button className="primary wide" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>

          {import.meta.env.DEV && (
            <div className="dev-box">
              <p className="muted">Development only: fill in a test account</p>
              <div className="chips">
                {DEV_ACCOUNTS.map(([label, mail, pw]) => (
                  <button type="button" key={mail} className="chip"
                          onClick={() => { setEmail(mail); setPassword(pw); }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </form>
      </section>
    </div>
  );
}