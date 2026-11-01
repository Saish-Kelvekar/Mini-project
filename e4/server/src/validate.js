// Server-side validation for the event proposal form (FR-01). Returns field-level errors.
const EVENT_TYPES = ['technical', 'cultural', 'academic', 'extracurricular'];

function validateEvent(body = {}) {
  const errors = {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 3 || name.length > 100) errors.name = 'Enter a name between 3 and 100 characters.';

  if (!EVENT_TYPES.includes(body.type)) errors.type = `Choose one of: ${EVENT_TYPES.join(', ')}.`;

  let durationMinutes = Number(body.durationMinutes);
  let durationHours = Number(body.durationHours);
  if (isNaN(durationHours) && !isNaN(durationMinutes)) {
    durationHours = Number((durationMinutes / 60).toFixed(2));
  } else if (!isNaN(durationHours) && isNaN(durationMinutes)) {
    durationMinutes = Math.round(durationHours * 60);
  }

  if (isNaN(durationMinutes) || durationMinutes < 15 || durationMinutes > 1440) {
    errors.durationMinutes = 'Enter a whole number of minutes between 15 and 1440.';
    errors.durationHours = 'Enter duration in hours between 0.5 and 24.';
  }

  const judges = Number(body.judgesRequired);
  if (!Number.isInteger(judges) || judges < 0 || judges > 10)
    errors.judgesRequired = 'Enter a whole number of judges between 0 and 10.';

  const venue = typeof body.preferredVenue === 'string' ? body.preferredVenue.trim() : '';
  if (venue.length > 80) errors.preferredVenue = 'Venue must be 80 characters or fewer.';

  const date = typeof body.preferredDate === 'string' ? body.preferredDate.trim() : '';
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.preferredDate = 'Use the format YYYY-MM-DD.';

  const resources = typeof body.resourcesRequired === 'string' ? body.resourcesRequired.trim() : '';
  if (resources.length > 500) errors.resourcesRequired = 'Resources description must be 500 characters or fewer.';

  const value = { name, type: body.type, durationMinutes, durationHours, judgesRequired: judges,
                  preferredVenue: venue, preferredDate: date, resourcesRequired: resources };
  return { errors, value, ok: Object.keys(errors).length === 0 };
}

module.exports = { validateEvent, EVENT_TYPES };
