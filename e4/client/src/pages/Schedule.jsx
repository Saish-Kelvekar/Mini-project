import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { EntriesTable } from './Timetable.jsx';

export default function Schedule() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.mySchedule().then(setData).catch((e) => setError(e.message)); }, []);

  if (error) return <p className="alert" role="alert">{error}</p>;
  if (!data) return <p className="muted">Loading your schedule…</p>;
  return (
    <section className="panel">
      <h2>My schedule</h2>
      {data.entries.length ? <EntriesTable entries={data.entries} /> : <p className="empty">Nothing is assigned yet. Your schedule appears once the timetable is published.</p>}
      <p className="muted note">{data.stub}</p>
    </section>
  );
}
