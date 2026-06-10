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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
// Free-tier friendly default; override with SUMMARY_MODEL if your key has quota elsewhere.
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || 'gemini-2.5-flash';

// Audio containers we accept on upload. In-browser recordings arrive as
// webm/mp4/ogg; phone uploads (e.g. iPhone Voice Memos) are typically .m4a.
const AUDIO_EXT_RE = /\.(m4a|mp4|mov|webm|ogg|oga|mp3|wav|aac|caf|flac|aif|aiff|amr|3gp|3gpp)$/i;

// Choose the on-disk extension: prefer the uploaded file's real extension so an
// iPhone .m4a stays .m4a, then fall back to the MIME type, then a generic name.
// Deepgram sniffs the container from the bytes, so this is mainly for clean
// playback in the dashboard.
function pickAudioExt(file) {
  const match = (file.originalname || '').toLowerCase().match(AUDIO_EXT_RE);
  if (match) return match[1] === 'oga' ? 'ogg' : match[1].toLowerCase();
  const type = file.mimetype || '';
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a';
  if (type.includes('webm')) return 'webm';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('wav')) return 'wav';
  return 'audio';
}

// Store interview audio straight to disk (inside the persistent data volume) so
// large recordings never get buffered in memory on the small server.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, audioDir),
    filename: (req, file, cb) => {
      cb(null, `interview_${Date.now()}_${Math.round(Math.random() * 1e6)}.${pickAudioExt(file)}`);
    }
  }),
  // 100 MB leaves room for longer recordings uploaded from remote sites with no
  // signal (e.g. a phone voice memo taken at the zipline).
  limits: { fileSize: 100 * 1024 * 1024 }
});

// Wrap the multer middleware so an oversized or unreadable upload comes back as
// clean JSON instead of express's default HTML 500 (which the client can't parse).
function uploadAudio(req, res, next) {
  upload.single('audio')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'Recording is too large (max 100 MB). Use Voice Memos’ default compressed quality, or trim it first.'
      : 'Could not read the uploaded recording.';
    return sendError(res, 400, message);
  });
}

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
// EQA v2 model — 7 categories x 3 features, each scored 0/2/4 (penalty). Final = 84 - sum of deductions.
const EQA_CATEGORIES = [
  { key: 'waste',     label: 'Waste & recycling',                    features: ['waste_litter', 'waste_bins_find', 'waste_bins_use'] },
  { key: 'nature',    label: 'Natural landscape & biodiversity',     features: ['nature_healthy', 'nature_native', 'nature_tracks'] },
  { key: 'pollution', label: 'Pollution & resource management',      features: ['poll_clean', 'poll_noise', 'poll_resources'] },
  { key: 'crowding',  label: 'Visitor pressure & crowding',          features: ['crowd_space', 'crowd_managed', 'crowd_barriers'] },
  { key: 'access',    label: 'Accessibility & visitor facilities',   features: ['access_disability', 'access_facilities', 'access_transport'] },
  { key: 'culture',   label: 'Cultural sustainability',              features: ['culture_reo', 'culture_respect', 'culture_iwi'] },
  { key: 'education', label: 'Sustainability education & management', features: ['edu_info', 'edu_encourage', 'edu_programmes'] }
];
const EQA_FEATURES_V2 = EQA_CATEGORIES.flatMap(c => c.features); // 21 feature keys
const EQA_MAX_SCORE = 84;
// A row uses the new model only once its 21 features are populated; older rows are "legacy".
const isEqaV2 = row => EQA_FEATURES_V2.every(k => row[k] !== null && row[k] !== undefined);
// Team members who conduct surveys, interviews, and EQA assessments.
const TEAM_MEMBERS = ['Rick', 'Adam', 'Callum', 'Taylor'];
const parseTeamMember = value =>
  (typeof value === 'string' && TEAM_MEMBERS.includes(value.trim())) ? value.trim() : '';

// ─── AI interview/speech summary (Google Gemini) ─────────────────────────
const HYPOTHESIS = 'Tourism in Rotorua is (socially and environmentally) sustainable.';
const SUMMARY_SYSTEM = [
  'You are a research assistant for a Sacred Heart College (Auckland) geography study.',
  `The study tests this hypothesis: "${HYPOTHESIS}"`,
  'You will be given the transcript of a field interview or a recorded speech about tourism in Rotorua.',
  'Do two things:',
  '1. Write a concise, plain-language summary (2-4 sentences) of what was said.',
  '2. Extract the key points the speaker made. For each point, decide its stance toward the',
  '   hypothesis ("supports", "contradicts", or "neutral") and which dimension it concerns',
  '   ("social", "environmental", or "general").',
  'Base everything only on the transcript — do not invent details. If a point is unclear or not',
  'about sustainability, mark it "neutral". Keep each point to one short sentence.'
].join('\n');
// Gemini structured-output schema (OpenAPI subset; Schema `type` values are UPPERCASE).
const SUMMARY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    points: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          point: { type: 'STRING' },
          stance: { type: 'STRING', enum: ['supports', 'contradicts', 'neutral'] },
          dimension: { type: 'STRING', enum: ['social', 'environmental', 'general'] }
        },
        required: ['point', 'stance', 'dimension'],
        propertyOrdering: ['point', 'stance', 'dimension']
      }
    }
  },
  required: ['summary', 'points'],
  propertyOrdering: ['summary', 'points']
};

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

// Validate a survey payload (shared by create + edit). Returns { values } or { error }.
function parseSurveyBody(body) {
  const respondentName = typeof body.respondent_name === 'string' ? body.respondent_name.trim().slice(0, 80) : '';
  const interviewer = parseTeamMember(body.interviewer);
  const attraction = typeof body.attraction === 'string' ? body.attraction.trim() : '';
  const isLocal = body.is_local;

  if (!attraction) return { error: 'Attraction is required.' };
  if (isLocal !== 'yes' && isLocal !== 'no') return { error: 'Local status is invalid.' };

  const answers = QUESTION_KEYS.map(key => {
    const value = parseIntStrict(body[key]);
    if (value === null || value < 1 || value > 5) return null;
    return value;
  });
  if (answers.some(value => value === null)) {
    return { error: 'All survey questions must be answered with a value between 1 and 5.' };
  }

  return {
    values: {
      respondentName,
      interviewer,
      attraction,
      isLocal,
      locationLabel: parseLabel(body.location_label),
      latitude: parseCoord(body.latitude, -90, 90),
      longitude: parseCoord(body.longitude, -180, 180),
      answers
    }
  };
}

app.post('/api/survey', (req, res) => {
  try {
    const parsed = parseSurveyBody(req.body);
    if (parsed.error) return sendError(res, 400, parsed.error);
    const v = parsed.values;

    const stmt = db.prepare(`
      INSERT INTO survey_responses (
        respondent_name, interviewer, attraction, is_local, location_label, latitude, longitude,
        q1, q2, q3, q4, q5, q6, q7, q8, q9, q10, q11, q12
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    const info = stmt.run(
      v.respondentName || null, v.interviewer || null, v.attraction, v.isLocal,
      v.locationLabel, v.latitude, v.longitude, ...v.answers
    );
    return res.json({ success: true, id: info.lastInsertRowid });
  } catch (error) {
    return sendError(res, 500, 'Failed to save survey response.');
  }
});

// Validate an EQA payload (shared by create + edit). Returns { values } or { error }.
function parseEqaBody(body) {
  const location = typeof body.location === 'string' ? body.location.trim() : '';
  if (!location) return { error: 'Location is required.' };

  const features = {};
  for (const key of EQA_FEATURES_V2) {
    const value = parseAllowed(body[key], [0, 2, 4]);
    if (value === null) return { error: 'Every feature must be scored 0, 2 or 4.' };
    features[key] = value;
  }
  const totalScore = EQA_FEATURES_V2.reduce((sum, key) => sum + features[key], 0); // 0..84 deductions

  return {
    values: {
      location,
      locationLabel: parseLabel(body.location_label),
      latitude: parseCoord(body.latitude, -90, 90),
      longitude: parseCoord(body.longitude, -180, 180),
      assessDate: typeof body.assess_date === 'string' ? body.assess_date.trim() : '',
      assessor: parseTeamMember(body.assessor),
      features,
      totalScore,
      strongest: typeof body.strongest_feature === 'string' ? body.strongest_feature.trim().slice(0, 120) : '',
      notes: typeof body.notes === 'string' ? body.notes.trim() : ''
    }
  };
}

// Column order shared by the EQA insert/update so the 21 features stay in sync.
const EQA_META_COLS = ['location', 'location_label', 'latitude', 'longitude', 'assess_date', 'assessor', 'total_score', 'strongest_feature', 'notes'];
const EQA_WRITE_COLS = [...EQA_META_COLS, ...EQA_FEATURES_V2];
const eqaWriteValues = v => [
  v.location, v.locationLabel, v.latitude, v.longitude, v.assessDate || null, v.assessor || null,
  v.totalScore, v.strongest || null, v.notes || null,
  ...EQA_FEATURES_V2.map(key => v.features[key])
];

app.post('/api/eqa', (req, res) => {
  try {
    const parsed = parseEqaBody(req.body);
    if (parsed.error) return sendError(res, 400, parsed.error);

    const placeholders = EQA_WRITE_COLS.map(() => '?').join(', ');
    const stmt = db.prepare(`INSERT INTO eqa_assessments (${EQA_WRITE_COLS.join(', ')}) VALUES (${placeholders})`);
    const info = stmt.run(...eqaWriteValues(parsed.values));

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

    // Only v2 assessments feed the new aggregates; legacy rows are counted but excluded.
    const eqaV2Rows = eqaRows.filter(isEqaV2);
    const eqaTotal = eqaV2Rows.length;
    const legacyCount = eqaRows.length - eqaV2Rows.length;

    const catDeduction = (row, cat) => cat.features.reduce((sum, key) => sum + (parseIntStrict(row[key]) || 0), 0);
    const totalDeduction = row => EQA_FEATURES_V2.reduce((sum, key) => sum + (parseIntStrict(row[key]) || 0), 0);

    const avgFinalScore = eqaTotal ? EQA_MAX_SCORE - average(eqaV2Rows.map(totalDeduction)) : 0;

    const avgPerCategory = {};
    EQA_CATEGORIES.forEach(cat => {
      avgPerCategory[cat.key] = eqaTotal ? average(eqaV2Rows.map(row => catDeduction(row, cat))) : 0;
    });

    // Weakest category = the one losing the most points on average.
    let weakest = { key: null, value: -1 };
    EQA_CATEGORIES.forEach(cat => {
      if (avgPerCategory[cat.key] > weakest.value) weakest = { key: cat.key, value: avgPerCategory[cat.key] };
    });

    const locationMap = new Map();
    eqaV2Rows.forEach(row => {
      const location = row.location || 'Unknown';
      if (!locationMap.has(location)) {
        const entry = { location, count: 0, deductionSum: 0 };
        EQA_CATEGORIES.forEach(cat => { entry[cat.key] = 0; });
        locationMap.set(location, entry);
      }
      const entry = locationMap.get(location);
      entry.count += 1;
      entry.deductionSum += totalDeduction(row);
      EQA_CATEGORIES.forEach(cat => { entry[cat.key] += catDeduction(row, cat); });
    });

    const byLocation = Array.from(locationMap.values())
      .map(entry => {
        const out = {
          location: entry.location,
          count: entry.count,
          final_score: entry.count ? EQA_MAX_SCORE - entry.deductionSum / entry.count : 0
        };
        EQA_CATEGORIES.forEach(cat => { out[cat.key] = entry.count ? entry[cat.key] / entry.count : 0; });
        return out;
      })
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
        legacy_count: legacyCount,
        max_score: EQA_MAX_SCORE,
        avg_final_score: avgFinalScore,
        avg_per_category: avgPerCategory,
        weakest_category: weakest.key,
        categories: EQA_CATEGORIES.map(cat => ({ key: cat.key, label: cat.label })),
        by_location: byLocation
      }
    });
  } catch (error) {
    return sendError(res, 500, 'Failed to load dashboard stats.');
  }
});

app.put('/api/admin/survey/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return sendError(res, 400, 'Invalid ID.');

    const parsed = parseSurveyBody(req.body);
    if (parsed.error) return sendError(res, 400, parsed.error);
    const v = parsed.values;

    const result = db.prepare(`
      UPDATE survey_responses SET
        respondent_name = ?, interviewer = ?, attraction = ?, is_local = ?,
        location_label = ?, latitude = ?, longitude = ?,
        q1 = ?, q2 = ?, q3 = ?, q4 = ?, q5 = ?, q6 = ?, q7 = ?, q8 = ?, q9 = ?, q10 = ?, q11 = ?, q12 = ?
      WHERE id = ?
    `).run(
      v.respondentName || null, v.interviewer || null, v.attraction, v.isLocal,
      v.locationLabel, v.latitude, v.longitude, ...v.answers, id
    );

    if (result.changes === 0) return sendError(res, 404, 'Survey response not found.');
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, 500, 'Failed to update survey response.');
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

app.put('/api/admin/eqa/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return sendError(res, 400, 'Invalid ID.');

    const parsed = parseEqaBody(req.body);
    if (parsed.error) return sendError(res, 400, parsed.error);

    const setClause = EQA_WRITE_COLS.map(col => `${col} = ?`).join(', ');
    const result = db.prepare(`UPDATE eqa_assessments SET ${setClause} WHERE id = ?`)
      .run(...eqaWriteValues(parsed.values), id);

    if (result.changes === 0) return sendError(res, 404, 'EQA assessment not found.');
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, 500, 'Failed to update EQA assessment.');
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
app.post('/api/admin/interviews', uploadAudio, (req, res) => {
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

// Summarise an interview transcript and classify each point against the hypothesis.
app.post('/api/admin/interviews/:id/summarize', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return sendError(res, 500, 'Summaries are not configured (GEMINI_API_KEY is not set on the server).');
    }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return sendError(res, 400, 'Invalid ID.');

    const row = db.prepare('SELECT transcript FROM interviews WHERE id = ?').get(id);
    if (!row) return sendError(res, 404, 'Interview not found.');
    const transcript = (row.transcript || '').trim();
    if (!transcript) return sendError(res, 400, 'Add or generate a transcript before summarising.');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(SUMMARY_MODEL)}:generateContent`;
    const gemRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SUMMARY_SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: transcript }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: SUMMARY_SCHEMA,
          temperature: 0.2,
          maxOutputTokens: 2048
        }
      })
    });

    if (!gemRes.ok) {
      const detail = await gemRes.text().catch(() => '');
      let message = detail.slice(0, 300);
      try { message = JSON.parse(detail).error.message || message; } catch (_) {}
      return sendError(res, 502, `Gemini error (${gemRes.status}). ${message}`);
    }

    const data = await gemRes.json();
    const candidate = data && data.candidates && data.candidates[0];
    const finish = candidate && candidate.finishReason;
    if (finish && finish !== 'STOP' && finish !== 'MAX_TOKENS') {
      return sendError(res, 502, `Gemini stopped early (${finish}). Try again or shorten the transcript.`);
    }
    const text = (candidate && candidate.content && Array.isArray(candidate.content.parts))
      ? candidate.content.parts.map(p => p.text || '').join('')
      : '';

    let parsed;
    try { parsed = JSON.parse(text); } catch (_) {
      return sendError(res, 502, 'Gemini did not return valid JSON. Please try again.');
    }
    if (!parsed || typeof parsed.summary !== 'string' || !Array.isArray(parsed.points)) {
      return sendError(res, 502, 'Gemini returned an unexpected shape. Please try again.');
    }

    db.prepare("UPDATE interviews SET summary = ?, summary_updated_at = datetime('now'), summary_model = ? WHERE id = ?")
      .run(JSON.stringify(parsed), SUMMARY_MODEL, id);

    return res.json({ success: true, summary: parsed });
  } catch (error) {
    return sendError(res, 500, 'Failed to summarise interview.');
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
    // total_score holds deductions on v2 rows; surface the final score too. Legacy rows leave it blank.
    rows.forEach(row => { row.final_score = isEqaV2(row) ? EQA_MAX_SCORE - (parseIntStrict(row.total_score) || 0) : ''; });

    const columns = [
      { key: 'id', header: 'id' },
      { key: 'submitted_at', header: 'submitted_at' },
      { key: 'location', header: 'location' },
      { key: 'location_label', header: 'location_label' },
      { key: 'latitude', header: 'latitude' },
      { key: 'longitude', header: 'longitude' },
      { key: 'assess_date', header: 'assess_date' },
      { key: 'assessor', header: 'assessor' },
      { key: 'total_score', header: 'total_deductions' },
      { key: 'final_score', header: 'final_score' },
      { key: 'strongest_feature', header: 'strongest_feature' },
      ...EQA_FEATURES_V2.map(key => ({ key, header: key })),
      // legacy 7-feature columns, kept so old assessments still export
      ...['lq', 'noise', 'air', 'litter', 'vandalism', 'transport', 'derelict'].map(key => ({ key, header: 'legacy_' + key })),
      { key: 'notes', header: 'notes' }
    ];
    const csv = buildCsv(rows, columns);

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
