const { google } = require('googleapis');
const nodemailer = require('nodemailer');

const SERVICE_LABELS = {
  mowing: 'Weekly Mowing',
  edging: 'Edging & Trimming',
  beds:   'Landscape Beds',
  plow:   'Driveway Plowing',
  shovel: 'Sidewalk Shoveling',
};
const SLOT_DURATION_MS = 2 * 60 * 60 * 1000;
const TIMEZONE = 'America/Detroit';
const BUSINESS_EMAIL = 'hello@thompsonlawn.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function parseKey(raw) {
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

function getAuth() {
  const key = parseKey(process.env.GOOGLE_PRIVATE_KEY || '');
  if (!key) throw new Error('GOOGLE_PRIVATE_KEY env var is missing');
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

function parseSlotTime(dateISO, timeLabel) {
  const base = new Date(dateISO);
  const [timePart, period] = timeLabel.split(' ');
  let [h, m] = timePart.split(':').map(Number);
  if (period === 'PM' && h !== 12) h += 12;
  if (period === 'AM' && h === 12) h = 0;
  base.setHours(h, m, 0, 0);
  return base;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { name, phone, address, notes, svc, freq, date, time } = body;

  if (!name || !phone || !address || !date || !time || !svc) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  const serviceLabel = SERVICE_LABELS[svc] || svc;
  const slotStart = parseSlotTime(date, time);
  const slotEnd   = new Date(slotStart.getTime() + SLOT_DURATION_MS);

  try {
    // 1. Create Google Calendar event
    const auth = getAuth();
    const calendar = google.calendar({ version: 'v3', auth });

    await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      requestBody: {
        summary:     `${serviceLabel} — ${name}`,
        description: [
          `Service:   ${serviceLabel}`,
          `Frequency: ${freq}`,
          `Address:   ${address}`,
          `Phone:     ${phone}`,
          notes ? `Notes:     ${notes}` : null,
        ].filter(Boolean).join('\n'),
        start: { dateTime: slotStart.toISOString(), timeZone: TIMEZONE },
        end:   { dateTime: slotEnd.toISOString(),   timeZone: TIMEZONE },
        reminders: {
          useDefault: false,
          overrides: [{ method: 'popup', minutes: 60 }],
        },
      },
    });

    // 2. Send confirmation email if SMTP is configured
    if (process.env.SMTP_PASS) {
      const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: Number(process.env.SMTP_PORT || 587),
        secure: false,
        auth: {
          user: process.env.SMTP_USER || BUSINESS_EMAIL,
          pass: process.env.SMTP_PASS,
        },
      });

      const dateStr = slotStart.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: TIMEZONE,
      });

      await transport.sendMail({
        from:    `"Thompson Snow & Lawn Care" <${process.env.SMTP_USER || BUSINESS_EMAIL}>`,
        to:      BUSINESS_EMAIL,
        subject: `New booking: ${serviceLabel} — ${name} on ${dateStr}`,
        text: [
          'New appointment request received.',
          '',
          `Customer:  ${name}`,
          `Phone:     ${phone}`,
          `Address:   ${address}`,
          `Service:   ${serviceLabel}`,
          `Frequency: ${freq}`,
          `Date/Time: ${dateStr} at ${time}`,
          notes ? `Notes:     ${notes}` : null,
          '',
          'This appointment has been added to your Google Calendar.',
        ].filter(l => l !== null).join('\n'),
      });
    }

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    };
  } catch (err) {
    console.error('[book] ERROR:', err.message, err.stack);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Booking failed — please call us directly.' }),
    };
  }
};
