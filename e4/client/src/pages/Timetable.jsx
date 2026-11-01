import { useEffect, useState } from 'react';
import { api } from '../api.js';

export function EntriesTable({ entries }) {
  return (
    <table>
      <thead><tr><th>Date</th><th>Time</th><th>Event</th><th>Venue</th><th>Judges</th></tr></thead>
      <tbody>
        {entries.map((en) => (
          <tr key={en.eventId}><td>{en.date}</td><td>{en.start}–{en.end}</td><td>{en.name}</td><td>{en.venue}</td><td>{en.judges}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Timetable({ user }) {
  const [tt, setTt] = useState(undefined);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isAdmin = user.role === 'admin';

  const load = () => api.timetable().then((d) => setTt(d.timetable)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const act = async (fn) => {
    setError(''); setBusy(true);
    try { setTt((await fn()).timetable); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  if (tt === undefined && !error) return <p className="muted">Loading timetable…</p>;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Timetable {tt?.published && <span className="status s-published">Published v{tt.version}</span>}
          {tt && !tt.published && <span className="status s-scheduled">Draft</span>}</h2>
        {isAdmin && (
          <div className="actions">
            <button onClick={() => act(api.generate)} disabled={busy}>Generate timetable</button>
            <button className="primary" onClick={() => act(api.publish)} disabled={busy || !tt}>Publish timetable</button>
          </div>
        )}
      </div>
      {error && <p className="alert" role="alert">{error}</p>}
      {tt ? <EntriesTable entries={tt.entries} /> : (
        <p className="empty">{isAdmin ? 'No timetable yet. Generate one from the submitted events.' : 'No timetable has been published yet.'}</p>
      )}
      {tt?.stub && <p className="muted note">{tt.stub}</p>}
    </section>
  );
}
