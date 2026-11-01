import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Audit() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.audit().then((d) => setRows(d.audit)).catch((e) => setError(e.message)); }, []);

  if (error) return <p className="alert" role="alert">{error}</p>;
  if (!rows) return <p className="muted">Loading access log…</p>;
  return (
    <section className="panel">
      <h2>Denied access attempts</h2>
      {rows.length === 0 ? <p className="empty">No denied attempts so far.</p> : (
        <table>
          <thead><tr><th>Time</th><th>User</th><th>Role</th><th>Action</th><th>Result</th></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i}><td>{new Date(r.at).toLocaleTimeString()}</td><td>{r.user}</td><td>{r.role}</td><td>{r.action}</td><td>{r.result}</td></tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}
