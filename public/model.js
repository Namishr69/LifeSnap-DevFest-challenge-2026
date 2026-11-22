export const categories = ['Task', 'Appointment', 'Deadline', 'Bill', 'Delivery', 'Information', 'Saved'];
export const priorities = ['Normal', 'High', 'Low'];
export const dateKey = (date = new Date()) => [
  date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')
].join('-');
export const localDate = key => new Date(key + 'T12:00:00');
export const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !isNaN(localDate(value)) && dateKey(localDate(value)) === value;
export const validTime = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

function escapeICS(value) {
  return String(value).replaceAll('\\', '\\\\').replace(/\r\n|\r|\n/g, '\\n')
    .replaceAll(';', '\\;').replaceAll(',', '\\,');
}

function fold(line) {
  const encoder = new TextEncoder();
  let bytes = 0;
  let result = '';
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > 75) {
      result += '\r\n ';
      bytes = 1;
    }
    result += char;
    bytes += size;
  }
  return result;
}

export function calendarFile(items, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LifeSnap//Action Inbox//EN', 'CALSCALE:GREGORIAN'];
  for (const item of items.filter(item => validDate(item.date))) {
    const day = item.date.replaceAll('-', '');
    const start = validTime(item.time) ? 'DTSTART:' + day + 'T' + item.time.replace(':', '') + '00' : 'DTSTART;VALUE=DATE:' + day;
    lines.push('BEGIN:VEVENT', 'UID:' + escapeICS(item.id) + '@lifesnap.local',
      'DTSTAMP:' + stamp, start, 'SUMMARY:' + escapeICS(item.title),
      'DESCRIPTION:' + escapeICS([item.description, item.next].filter(Boolean).join('\n')), 'END:VEVENT');
  }
  return lines.concat('END:VCALENDAR').map(fold).join('\r\n') + '\r\n';
}
