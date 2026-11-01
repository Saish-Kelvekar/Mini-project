import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Events({ user, goTo }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [toastMsg, setToastMsg] = useState('');

  const load = () => {
    api.events().then((d) => setEvents(d.events)).catch((e) => setError(e.message));
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!toastMsg) return undefined;
    const t = setTimeout(() => setToastMsg(''), 4000);
    return () => clearTimeout(t);
  }, [toastMsg]);

  const handleRegister = async (id) => {
    setBusyId(id);
    setError('');
    try {
      const res = await api.registerEvent(id);
      setToastMsg(res.message || 'Successfully registered for event!');
      setEvents((prev) =>
        prev.map((e) => (e.id === id ? { ...e, registered: true, registeredCount: (e.registeredCount || 0) + 1 } : e))
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleUnregister = async (id) => {
    setBusyId(id);
    setError('');
    try {
      const res = await api.unregisterEvent(id);
      setToastMsg(res.message || 'Registration cancelled.');
      setEvents((prev) =>
        prev.map((e) => (e.id === id ? { ...e, registered: false, registeredCount: Math.max(0, (e.registeredCount || 1) - 1) } : e))
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const formatDuration = (e) => {
    if (e.durationHours != null) return `${e.durationHours} hr${e.durationHours === 1 ? '' : 's'}`;
    if (e.durationMinutes != null) {
      const h = Number((e.durationMinutes / 60).toFixed(1));
      return `${h} hr${h === 1 ? '' : 's'}`;
    }
    return '—';
  };

  const heading = { admin: 'All events', coordinator: 'Your events', student: 'Published events' }[user.role];
  if (error && !events) return <p className="alert" role="alert">{error}</p>;
  if (!events) return <p className="muted">Loading events…</p>;

  return (
    <section className="panel">
      {toastMsg && (
        <div className="toast toast-success" role="status">
          <span>{toastMsg}</span>
          <button type="button" className="toast-x" onClick={() => setToastMsg('')} aria-label="Dismiss notification">×</button>
        </div>
      )}

      <div className="panel-head">
        <h2>{heading}</h2>
        {user.role === 'coordinator' && (
          <button className="primary sm" onClick={() => goTo('new')}>+ Propose new event</button>
        )}
      </div>

      {error && <p className="alert" role="alert">{error}</p>}

      {events.length === 0 ? (
        <div className="empty">
          <p>{user.role === 'student' ? 'No events are published yet. Check back after the admin publishes the timetable.' : 'No events yet.'}</p>
          {user.role === 'coordinator' && <button className="primary" onClick={() => goTo('new')}>Submit an event proposal</button>}
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Type</th>
              <th>Duration</th>
              <th>Judges</th>
              <th>Venue</th>
              <th>Resources required</th>
              <th>Status</th>
              <th>{user.role === 'student' ? 'Registration' : 'Students registered'}</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td><strong>{e.name}</strong></td>
                <td>{e.type}</td>
                <td>{formatDuration(e)}</td>
                <td>{e.judgesRequired}</td>
                <td>{e.preferredVenue || '—'}</td>
                <td style={{ maxWidth: '220px', whiteSpace: 'pre-wrap' }}>{e.resourcesRequired || '—'}</td>
                <td><span className={`status s-${e.status.toLowerCase()}`}>{e.status}</span></td>
                <td>
                  {user.role === 'student' ? (
                    e.registered ? (
                      <button
                        className="registered sm"
                        disabled={busyId === e.id}
                        onClick={() => handleUnregister(e.id)}
                        title="Click to cancel registration"
                      >
                        {busyId === e.id ? 'Updating…' : '✓ Registered'}
                      </button>
                    ) : (
                      <button
                        className="primary sm"
                        disabled={busyId === e.id}
                        onClick={() => handleRegister(e.id)}
                      >
                        {busyId === e.id ? 'Registering…' : 'Register'}
                      </button>
                    )
                  ) : (
                    <span className="badge-reg">
                      {e.registeredCount || 0} registered
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
