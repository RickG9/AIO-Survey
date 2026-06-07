const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

const audioDir = db.audioDir;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';

// Store interview audio straight to disk (inside the persistent data volume) so
// large recordings never get buffered in memory on the small server.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, audioDir),
    filename: (req, file, cb) => {
      const ext = (file.mimetype && file.mimetype.includes('mp4')) ? 'mp4'
        : (file.mimetype && file.mimetype.includes('webm')) ? 'webm'
        : (file.mimetype && file.mimetype.includes('ogg')) ? 'ogg'
        : 'audio';
      cb(null, `interview_${Date.now()}_${Math.round(Math.random() * 1e6)}.${ext}`);
    }
  }),
  limits: { fileSize: 60 * 1024 * 1024 } // 60 MB per recording is plenty for a field interview
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD environment variable is not set. Refusing to start so the admin dashboard is never exposed without a password.');
  process.exit(1);
}

// Constant-time comparison to avoid leaking the password via timing.
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAuth(res) {
  res.setHeader('WWW-Authenticate', 'Basic realm="AIO-Survey Admin", charset="UTF-8"');
  return res.status(401).send('Authentication required.');
}

// Gate the admin dashboard, admin APIs and CSV exports behind a single password.
// Runs before express.static so the static /admin page is protected too.
const PROTECTED_PREFIXES = ['/admin', '/api/admin/', '/api/export/', '/eqa-assessment.html', '/api/eqa', '/interview.html'];
app.use((req, res, next) => {
  const isProtected = PROTECTED_PREFIXES.some(prefix => req.path.startsWith(prefix));
  if (!isProtected) return next();

  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return requireAuth(res);

  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const password = decoded.slice(decoded.indexOf(':') + 1);
  if (!safeEqual(password, ADMIN_PASSWORD)) return requireAuth(res);

  return next();
});

const QUESTION_KEYS = Array.from({ length: 12 }, (_, i) => `q${i + 1}`);
const ENV_KEYS = ['q1', 'q2', 'q3', 'q4', 'q6', 'q9'];
const SOCIAL_KEYS = ['q5', 'q7', 'q8', 'q10', 'q11', 'q12'];
const EQA_FEATURES = ['lq', 'noise', 'air', 'litter', 'vandalism', 'transport', 'derelict'];
// Team members who conduct surveys, interviews, and EQA assessments.
const TEAM_MEMBERS = ['Rick', 'Adam', 'Callum', 'Taylor'];
const parseTeamMember = value =>
  (typeof value === 'string' && TEAM_MEMBERS.includes(value.trim())) ? value.trim() : '';

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function sendError(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function parseIntStrict(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num;
}

function parseAllowed(value, allowed) {
  const num = parseIntStrict(value);
  if (num === null || !allowed.includes(num)) return null;
  return num;
}

// Optional latitude/longitude from a form. Returns a valid number or null.
function parseCoord(value, min, max) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num < min || num > max) return null;
  return num;
}

function parseLabel(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, 120);
  return trimmed || null;
}

function escapeCsv(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildCsv(rows, columns) {
  const header = columns.map(col => escapeCsv(col.header)).join(',');
  const lines = rows.map(row => columns.map(col => escapeCsv(row[col.key])).join(','));
  return [header, ...lines].join('\n');
}

app.post('/api/survey', (req, res) => {
  try {
    const respondentName = typeof req.body.respondent_name === 'string' ? req.body.respondent_name.trim().slice(0, 80) : '';
    const interviewer = parseTeamMember(req.body.interviewer);
    const attraction = typeof req.body.attraction === 'string' ? req.body.attraction.trim() : '';
    const isLocal = req.body.is_local;

    if (!attraction) return sendError(res, 400, 'Attraction is required.');
    if (isLocal !== 'yes' && isLocal !== 'no') return sendError(res, 400, 'Local status is invalid.');

    const answers = QUESTION_KEYS.map(key => {
      const value = parseIntStrict(req.body[key]);
      if (value === null || value < 1 || value > 5) return null;
      return value;
    });

    if (answers.some(value => value === null)) {
      return sendError(res, 400, 'All survey questions must be answered with a value between 1 and 5.');
    }

    const locationLabel = parseLabel(req.body.location_label);
    const latitude = parseCoord(req.body.latitude, -90, 90);
    const longitude = parseCoord(req.body.longitude, -180, 180);

    const stmt = db.prepare(`
      INSERT INTO survey_responses (
        respondent_name, interviewer, attraction, is_local, location_label, latitude, longitude,
        q1, q2, q3, q4, q5, q6, q7, q8, q9, q10, q11, q12
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    const info = stmt.run(respondentName || null, interviewer || null, attraction, isLocal, locationLabel, latitude, longitude, ...answers);
    return res.json({ success: true, id: info.lastInsertRowid });
  } catch (error) {
    return sendError(res, 500, 'Failed to save survey response.');
  }
});

app.post('/api/eqa', (req, res) => {
  try {
    const location = typeof req.body.location === 'string' ? req.body.location.trim() : '';
    if (!location) return sendError(res, 400, 'Location is required.');

    const assessDate = typeof req.body.assess_date === 'string' ? req.body.assess_date.trim() : '';
    const assessor = parseTeamMember(req.body.assessor);
    const notes = typeof req.body.notes === 'string' ? req.body.notes.trim() : '';

    const lq = parseAllowed(req.body.lq, [0, 4, 8]);
    const noise = parseAllowed(req.body.noise, [0, 4, 8]);
    const air = parseAllowed(req.body.air, [0, 10]);
    const litter = parseAllowed(req.body.litter, [0, 4, 8]);
    const vandalism = parseAllowed(req.body.vandalism, [0, 4, 8]);
    const transport = parseAllowed(req.body.transport, [0, 4, 8]);
    const derelict = parseAllowed(req.body.derelict, [0, 4, 10]);

    const values = [lq, noise, air, litter, vandalism, transport, derelict];
    if (values.some(value => value === null)) {
      return sendError(res, 400, 'All EQA feature scores must be selected.');
    }

    const totalScore = values.reduce((sum, value) => sum + value, 0);

    const locationLabel = parseLabel(req.body.location_label);
    const latitude = parseCoord(req.body.latitude, -90, 90);
    const longitude = parseCoord(req.body.longitude, -180, 180);

    const stmt = db.prepare(`
      INSERT INTO eqa_assessments (
        location, location_label, latitude, longitude, assess_date, assessor,
        lq, noise, air, litter, vandalism, transport, derelict, total_score, notes
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    const info = stmt.run(
      location,
      locationLabel,
      latitude,
      longitude,
      assessDate || null,
      assessor || null,
      lq,
      noise,
      air,
      litter,
      vandalism,
      transport,
      derelict,
      totalScore,
      notes || null
    );

    return res.json({ success: true, id: info.lastInsertRowid });
  } catch (error) {
    return sendError(res, 500, 'Failed to save EQA assessment.');
  }
});

app.get('/api/admin/survey', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM survey_responses ORDER BY submitted_at DESC, id DESC').all();
    return res.json(rows);
  } catch (error) {
    return sendError(res, 500, 'Failed to load survey responses.');
  }
});

app.get('/api/admin/eqa', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM eqa_assessments ORDER BY submitted_at DESC, id DESC').all();
    return res.json(rows);
  } catch (error) {
    return sendError(res, 500, 'Failed to load EQA assessments.');
  }
});

app.get('/api/admin/stats', (req, res) => {
  try {
    const surveyRows = db.prepare('SELECT * FROM survey_responses').all();
    const eqaRows = db.prepare('SELECT * FROM eqa_assessments').all();

    const totalResponses = surveyRows.length;
    const localsCount = surveyRows.filter(row => row.is_local === 'yes').length;
    const visitorsCount = totalResponses - localsCount;

    const avgPerQuestion = {};
    QUESTION_KEYS.forEach(key => {
      const values = surveyRows
        .map(row => parseIntStrict(row[key]))
        .filter(value => value !== null);
      avgPerQuestion[key] = values.length ? average(values) : 0;
    });

    const avgEnvironmental = average(ENV_KEYS.map(key => avgPerQuestion[key] || 0));
    const avgSocial = average(SOCIAL_KEYS.map(key => avgPerQuestion[key] || 0));

    const attractionMap = new Map();
    surveyRows.forEach(row => {
      const attraction = row.attraction || 'Unknown';
      const envScore = average(ENV_KEYS.map(key => parseIntStrict(row[key]) || 0));
      const socialScore = average(SOCIAL_KEYS.map(key => parseIntStrict(row[key]) || 0));

      if (!attractionMap.has(attraction)) {
        attractionMap.set(attraction, { attraction, count: 0, envSum: 0, socialSum: 0 });
      }
      const entry = attractionMap.get(attraction);
      entry.count += 1;
      entry.envSum += envScore;
      entry.socialSum += socialScore;
    });

    const byAttraction = Array.from(attractionMap.values())
      .map(entry => ({
        attraction: entry.attraction,
        count: entry.count,
        avg_env: entry.count ? entry.envSum / entry.count : 0,
        avg_social: entry.count ? entry.socialSum / entry.count : 0
      }))
      .sort((a, b) => b.count - a.count);

    const eqaTotal = eqaRows.length;
    const avgTotalScore = average(
      eqaRows.map(row => {
        const total = parseIntStrict(row.total_score);
        if (total !== null) return total;
        return EQA_FEATURES.reduce((sum, key) => sum + (parseIntStrict(row[key]) || 0), 0);
      })
    );

    const avgPerFeature = {};
    EQA_FEATURES.forEach(key => {
      const values = eqaRows
        .map(row => parseIntStrict(row[key]))
        .filter(value => value !== null);
      avgPerFeature[key] = values.length ? average(values) : 0;
    });

    const locationMap = new Map();
    eqaRows.forEach(row => {
      const location = row.location || 'Unknown';
      if (!locationMap.has(location)) {
        locationMap.set(location, {
          location,
          count: 0,
          totalSum: 0,
          lqSum: 0,
          noiseSum: 0,
          airSum: 0,
          litterSum: 0,
          vandalismSum: 0,
          transportSum: 0,
          derelictSum: 0
        });
      }
      const entry = locationMap.get(location);
      entry.count += 1;
      const rowTotal = parseIntStrict(row.total_score) || EQA_FEATURES.reduce((sum, key) => sum + (parseIntStrict(row[key]) || 0), 0);
      entry.totalSum += rowTotal;
      entry.lqSum += parseIntStrict(row.lq) || 0;
      entry.noiseSum += parseIntStrict(row.noise) || 0;
      entry.airSum += parseIntStrict(row.air) || 0;
      entry.litterSum += parseIntStrict(row.litter) || 0;
      entry.vandalismSum += parseIntStrict(row.vandalism) || 0;
      entry.transportSum += parseIntStrict(row.transport) || 0;
      entry.derelictSum += parseIntStrict(row.derelict) || 0;
    });

    const byLocation = Array.from(locationMap.values())
      .map(entry => ({
        location: entry.location,
        count: entry.count,
        total_score: entry.count ? entry.totalSum / entry.count : 0,
        lq: entry.count ? entry.lqSum / entry.count : 0,
        noise: entry.count ? entry.noiseSum / entry.count : 0,
        air: entry.count ? entry.airSum / entry.count : 0,
        litter: entry.count ? entry.litterSum / entry.count : 0,
        vandalism: entry.count ? entry.vandalismSum / entry.count : 0,
        transport: entry.count ? entry.transportSum / entry.count : 0,
        derelict: entry.count ? entry.derelictSum / entry.count : 0
      }))
      .sort((a, b) => a.location.localeCompare(b.location));

    return res.json({
      survey: {
        total_responses: totalResponses,
        locals_count: localsCount,
        visitors_count: visitorsCount,
        avg_per_question: avgPerQuestion,
        avg_environmental: avgEnvironmental,
        avg_social: avgSocial,
        by_attraction: byAttraction
      },
      eqa: {
        total_assessments: eqaTotal,
        avg_total_score: avgTotalScore,
        avg_per_feature: avgPerFeature,
        by_location: byLocation
      }
    });
  } catch (error) {
    return sendError(res, 500, 'Failed to load dashboard stats.');
  }
});

app.delete('/api/admin/survey/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return sendError(res, 400, 'Invalid ID.');
    db.prepare('DELETE FROM survey_responses WHERE id = ?').run(id);
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, 500, 'Failed to delete survey response.');
  }
});

app.delete('/api/admin/eqa/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return sendError(res, 400, 'Invalid ID.');
    db.prepare('DELETE FROM eqa_assessments WHERE id = ?').run(id);
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, 500, 'Failed to delete EQA assessment.');
  }
});

app.delete('/api/admin/survey', (req, res) => {
  try {
    db.prepare('DELETE FROM survey_responses').run();
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, 500, 'Failed to clear survey responses.');
  }
});

app.delete('/api/admin/eqa', (req, res) => {
  try {
    db.prepare('DELETE FROM eqa_assessments').run();
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, 500, 'Failed to clear EQA assessments.');
  }
});

// ─── Interviews (admin only) ─────────────────────────────────────────────
app.post('/api/admin/interviews', upload.single('audio'), (req, res) => {
  try {
    const location = typeof req.body.location === 'string' ? req.body.location.trim() : '';
    if (!location) {
      if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
      return sendError(res, 400, 'Location is required.');
    }

    const locationLabel = parseLabel(req.body.location_label);
    const latitude = parseCoord(req.body.latitude, -90, 90);
    const longitude = parseCoord(req.body.longitude, -180, 180);
    const interviewer = parseTeamMember(req.body.interviewer);
    const interviewee = typeof req.body.interviewee === 'string' ? req.body.interviewee.trim().slice(0, 80) : '';
    const notes = typeof req.body.notes === 'string' ? req.body.notes.trim() : '';
    const liveTranscript = typeof req.body.transcript === 'string' ? req.body.transcript.trim() : '';
    const audioFile = req.file ? req.file.filename : null;

    const stmt = db.prepare(`
      INSERT INTO interviews (
        location, location_label, latitude, longitude, interviewer, interviewee,
        audio_file, transcript, transcript_source, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(
      location,
      locationLabel,
      latitude,
      longitude,
      interviewer || null,
      interviewee || null,
      audioFile,
      liveTranscript || null,
      liveTranscript ? 'live' : null,
      notes || null
    );

    return res.json({ success: true, id: info.lastInsertRowid });
  } catch (error) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
    return sendError(res, 500, 'Failed to save interview.');
  }
});

app.get('/api/admin/interviews', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM interviews ORDER BY submitted_at DESC, id DESC').all();
    return res.json(rows);
  } catch (error) {
    return sendError(res, 500, 'Failed to load interviews.');
  }
});

app.get('/api/admin/interviews/:id/audio', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return sendError(res, 400, 'Invalid ID.');
    const row = db.prepare('SELECT audio_file FROM interviews WHERE id = ?').get(id);
    if (!row || !row.audio_file) return sendError(res, 404, 'No recording for this interview.');
    // sendFile requires an absolute path; resolve in case DATA_DIR is relative.
    const filePath = path.resolve(audioDir, row.audio_file);
    if (!fs.existsSync(filePath)) return sendError(res, 404, 'Recording file is missing.');
    return res.sendFile(filePath);
  } catch (error) {
    return sendError(res, 500, 'Failed to load recording.');
  }
});

app.post('/api/admin/interviews/:id/transcribe', async (req, res) => {
  try {
    if (!DEEPGRAM_API_KEY) {
      return sendError(res, 500, 'Transcription is not configured (DEEPGRAM_API_KEY is not set on the server).');
    }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return sendError(res, 400, 'Invalid ID.');

    const row = db.prepare('SELECT audio_file FROM interviews WHERE id = ?').get(id);
    if (!row || !row.audio_file) return sendError(res, 404, 'No recording to transcribe.');
    const filePath = path.join(audioDir, row.audio_file);
    if (!fs.existsSync(filePath)) return sendError(res, 404, 'Recording file is missing.');

    const audioBuffer = fs.readFileSync(filePath);
    const dgRes = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&punctuate=true&smart_format=true', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/octet-stream'
      },
      body: audioBuffer
    });

    if (!dgRes.ok) {
      const detail = await dgRes.text().catch(() => '');
      return sendError(res, 502, `Deepgram error (${dgRes.status}). ${detail.slice(0, 200)}`);
    }

    const data = await dgRes.json();
    const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';

    db.prepare('UPDATE interviews SET transcript = ?, transcript_source = ? WHERE id = ?')
      .run(transcript, 'deepgram', id);

    return res.json({ success: true, transcript });
  } catch (error) {
    return sendError(res, 500, 'Failed to transcribe recording.');
  }
});

app.put('/api/admin/interviews/:id/transcript', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return sendError(res, 400, 'Invalid ID.');
    const transcript = typeof req.body.transcript === 'string' ? req.body.transcript : '';
    db.prepare('UPDATE interviews SET transcript = ?, transcript_source = ? WHERE id = ?')
      .run(transcript, 'manual', id);
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, 500, 'Failed to save transcript.');
  }
});

app.delete('/api/admin/interviews/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return sendError(res, 400, 'Invalid ID.');
    const row = db.prepare('SELECT audio_file FROM interviews WHERE id = ?').get(id);
    db.prepare('DELETE FROM interviews WHERE id = ?').run(id);
    if (row && row.audio_file) {
      try { fs.unlinkSync(path.join(audioDir, row.audio_file)); } catch (_) {}
    }
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, 500, 'Failed to delete interview.');
  }
});

app.get('/api/export/interviews.csv', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM interviews ORDER BY submitted_at DESC, id DESC').all();
    const csv = buildCsv(rows, [
      { key: 'id', header: 'id' },
      { key: 'submitted_at', header: 'submitted_at' },
      { key: 'location', header: 'location' },
      { key: 'location_label', header: 'location_label' },
      { key: 'latitude', header: 'latitude' },
      { key: 'longitude', header: 'longitude' },
      { key: 'interviewer', header: 'interviewer' },
      { key: 'interviewee', header: 'interviewee' },
      { key: 'transcript', header: 'transcript' },
      { key: 'transcript_source', header: 'transcript_source' },
      { key: 'notes', header: 'notes' }
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="interviews.csv"');
    return res.send(csv);
  } catch (error) {
    return sendError(res, 500, 'Failed to export interviews CSV.');
  }
});

app.get('/api/export/survey.csv', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM survey_responses ORDER BY submitted_at DESC, id DESC').all();
    const csv = buildCsv(rows, [
      { key: 'id', header: 'id' },
      { key: 'submitted_at', header: 'submitted_at' },
      { key: 'respondent_name', header: 'respondent_name' },
      { key: 'interviewer', header: 'interviewer' },
      { key: 'attraction', header: 'attraction' },
      { key: 'is_local', header: 'is_local' },
      { key: 'location_label', header: 'location_label' },
      { key: 'latitude', header: 'latitude' },
      { key: 'longitude', header: 'longitude' },
      { key: 'q1', header: 'q1' },
      { key: 'q2', header: 'q2' },
      { key: 'q3', header: 'q3' },
      { key: 'q4', header: 'q4' },
      { key: 'q5', header: 'q5' },
      { key: 'q6', header: 'q6' },
      { key: 'q7', header: 'q7' },
      { key: 'q8', header: 'q8' },
      { key: 'q9', header: 'q9' },
      { key: 'q10', header: 'q10' },
      { key: 'q11', header: 'q11' },
      { key: 'q12', header: 'q12' }
    ]);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="survey_responses.csv"');
    return res.send(csv);
  } catch (error) {
    return sendError(res, 500, 'Failed to export survey CSV.');
  }
});

app.get('/api/export/eqa.csv', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM eqa_assessments ORDER BY submitted_at DESC, id DESC').all();
    const csv = buildCsv(rows, [
      { key: 'id', header: 'id' },
      { key: 'submitted_at', header: 'submitted_at' },
      { key: 'location', header: 'location' },
      { key: 'location_label', header: 'location_label' },
      { key: 'latitude', header: 'latitude' },
      { key: 'longitude', header: 'longitude' },
      { key: 'assess_date', header: 'assess_date' },
      { key: 'assessor', header: 'assessor' },
      { key: 'lq', header: 'lq' },
      { key: 'noise', header: 'noise' },
      { key: 'air', header: 'air' },
      { key: 'litter', header: 'litter' },
      { key: 'vandalism', header: 'vandalism' },
      { key: 'transport', header: 'transport' },
      { key: 'derelict', header: 'derelict' },
      { key: 'total_score', header: 'total_score' },
      { key: 'notes', header: 'notes' }
    ]);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="eqa_assessments.csv"');
    return res.send(csv);
  } catch (error) {
    return sendError(res, 500, 'Failed to export EQA CSV.');
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
