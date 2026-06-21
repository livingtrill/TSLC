const { google } = require('googleapis');

const SLOT_CONFIGS = [
  { label: '7:30 AM',  hour: 7,  min: 30 },
  { label: '10:00 AM', hour: 10, min: 0  },
  { label: '1:30 PM',  hour: 13, min: 30 },
];
const SLOT_DURATION_MS = 2 * 60 * 60 * 1000;
const TIMEZONE = 'America/Detroit';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function parseKey(raw) {
  // Handles both literal \n (from Netlify UI) and real newlines (from .env files)
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

function getAuth() {
  const key = parseKey(process.env.GOOGLE_PRIVATE_KEY || '');
  if (!key) throw new Error('GOOGLE_PRIVATE_KEY env var is missing');
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  }

  try {
    const auth = getAuth();
    const calendar = google.calendar({ version: 'v3', auth });

    const now = new Date();
    const windowEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    const { data } = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: now.toISOString(),
      timeMax: windowEnd.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const busyBlocks = (data.items || []).map(e => ({
      start: new Date(e.start.dateTime || e.start.date),
      end:   new Date(e.end.dateTime   || e.end.date),
    }));

    const days = [];
    for (let i = 0; i < 14; i++) {
      const dayStart = new Date(now);
      dayStart.setDate(now.getDate() + i);
      dayStart.setHours(0, 0, 0, 0);

      const isWeekend = dayStart.getDay() === 0 || dayStart.getDay() === 6;

      const slots = SLOT_CONFIGS.map(cfg => {
        const slotStart = new Date(dayStart);
        slotStart.setHours(cfg.hour, cfg.min, 0, 0);
        const slotEnd = new Date(slotStart.getTime() + SLOT_DURATION_MS);

        const isPast   = slotStart <= now;
        const isBusy   = busyBlocks.some(b => slotStart < b.end && slotEnd > b.start);

        return { time: cfg.label, free: !isWeekend && !isPast && !isBusy };
      });

      days.push({ date: dayStart.toISOString(), slots });
    }

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ days }),
    };
  } catch (err) {
    console.error('[availability]', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Failed to fetch availability' }),
    };
  }
};
