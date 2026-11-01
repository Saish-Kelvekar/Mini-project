import { useState } from 'react';
import { api } from '../api.js';

const TYPES = ['technical', 'cultural', 'academic', 'extracurricular'];
const EMPTY = { name: '', type: '', durationHours: '', judgesRequired: '', resourcesRequired: '', preferredVenue: '', preferredDate: '' };

// Client-side checks mirror the server rules so people get instant feedback (server still re-validates).
function check(v) {
  const e = {};
  if (v.name.trim().length < 3 || v.name.trim().length > 100) e.name = 'Enter a name between 3 and 100 characters.';
  if (!TYPES.includes(v.type)) e.type = 'Choose an event type.';
  const h = Number(v.durationHours);
  if (v.durationHours === '' || isNaN(h) || h < 0.25 || h > 24) e.durationHours = 'Enter duration between 0.5 and 24 hours (e.g. 1, 1.5, 2).';
  const j = Number(v.judgesRequired);
  if (v.judgesRequired === '' || !Number.isInteger(j) || j < 0 || j > 10) e.judgesRequired = 'Enter whole judges, 0 to 10.';
  if (v.preferredDate && !/^\d{4}-\d{2}-\d{2}$/.test(v.preferredDate)) e.preferredDate = 'Use the format YYYY-MM-DD.';
  if (v.resourcesRequired && v.resourcesRequired.length > 500) e.resourcesRequired = 'Resources description must be 500 characters or fewer.';
  return e;
}

export default function EventForm({ goTo }) {
  const [v, setV] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setFormError('');
    const local = check(v);
    setErrors(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    try {
      const payload = {
        ...v,
        durationHours: Number(v.durationHours),
        durationMinutes: Math.round(Number(v.durationHours) * 60),
      };
      await api.createEvent(payload);
      goTo('events');
    } catch (err) {
      setErrors(err.fields || {});
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const field = (k, label, input, hint) => (
    <label className={errors[k] ? 'has-error' : ''}>{label}
      {input}
      {errors[k] ? <span className="field-error" role="alert">{errors[k]}</span> : hint && <span className="muted hint">{hint}</span>}
    </label>
  );

  return (
    <section className="panel form-panel">
      <h2>Submit an event proposal</h2>
      {formError && <p className="alert" role="alert">{formError}</p>}
      <form onSubmit={submit} noValidate>
        {field('name', 'Event name', <input value={v.name} onChange={set('name')} />)}
        {field('type', 'Event type',
          <select value={v.type} onChange={set('type')}>
            <option value="">Choose a type</option>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>)}
        <div className="row">
          {field('durationHours', 'Duration (in hours)',
            <input type="number" step="0.5" min="0.5" max="24" placeholder="e.g. 2" value={v.durationHours} onChange={set('durationHours')} />,
            'e.g. 1, 1.5, 2, 3 hrs')}
          {field('judgesRequired', 'Judges required', <input inputMode="numeric" value={v.judgesRequired} onChange={set('judgesRequired')} />)}
        </div>
        {field('resourcesRequired', 'Resources required',
          <textarea rows="3" placeholder="e.g., Projector, Audio/Mic system, Whiteboard" value={v.resourcesRequired} onChange={set('resourcesRequired')} />,
          'List equipment, hardware resources needed')}
        <div className="row">
          {field('preferredVenue', 'Preferred venue (optional)', <input value={v.preferredVenue} onChange={set('preferredVenue')} />)}
          {field('preferredDate', 'Preferred date (optional)', <input placeholder="YYYY-MM-DD" value={v.preferredDate} onChange={set('preferredDate')} />)}
        </div>
        <button className="primary" disabled={busy}>{busy ? 'Submitting…' : 'Submit proposal'}</button>
      </form>
    </section>
  );
}
