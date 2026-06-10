#!/usr/bin/env node
/**
 * vault-import.js — pull AIO-Survey data into the Obsidian research vault.
 *
 * Usage:  npm run vault:import   (or: node scripts/vault-import.js)
 *
 * Config, via environment variables or KEY=value lines in .env at the repo root:
 *   ADMIN_PASSWORD  admin dashboard password (required)
 *   SURVEY_URL      base URL of the running app (default http://localhost:3000)
 *   VAULT_DIR       vault folder, relative to the repo root (default notes)
 *
 * Every run regenerates one note per interview plus Analysis/Evidence Board.md,
 * Analysis/Survey Stats.md and Analysis/EQA Scores.md. Anything a human wrote
 * below the MARKER line in those notes is preserved. Needs Node 18+.
 */

const fs = require('fs');
const path = require('path');

// ── config ──────────────────────────────────────────────────────────────────
const repoRoot = path.join(__dirname, '..');

// Tiny .env reader so we don't need the dotenv package.
const envFile = path.join(repoRoot, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  }
}

// Accept a bare domain like "example.com" — assume https when no scheme given.
const rawUrl = (process.env.SURVEY_URL || 'http://localhost:3000').trim().replace(/\/+$/, '');
const BASE_URL = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const VAULT = path.resolve(repoRoot, process.env.VAULT_DIR || 'notes');

if (!PASSWORD) {
  console.error('ADMIN_PASSWORD is not set. Add it to .env or the environment.');
  process.exit(1);
}

const AUTH = 'Basic ' + Buffer.from(':' + PASSWORD).toString('base64');

async function getJson(route) {
  let res;
  try {
    res = await fetch(BASE_URL + route, { headers: { Authorization: AUTH } });
  } catch (err) {
    throw new Error(`Could not reach ${BASE_URL} — is the app running? (${err.cause?.code || err.message})`);
  }
  if (res.status === 401) throw new Error('Server rejected ADMIN_PASSWORD (401).');
  if (!res.ok) throw new Error(`${route} failed with status ${res.status}.`);
  return res.json();
}

// ── note writing ────────────────────────────────────────────────────────────
const MARKER = '%% ── your notes below this line are kept on re-import ── %%';

// Regenerate everything above the marker; keep the marker and whatever a
// human wrote below it.
function writeNote(relPath, generated) {
  const file = path.join(VAULT, relPath);
  let tail = '\n\n';
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8');
    const at = existing.indexOf(MARKER);
    if (at !== -1) tail = existing.slice(at + MARKER.length) || '\n\n';
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${generated.trimEnd()}\n\n${MARKER}${tail}`);
}

// ── formatting helpers ──────────────────────────────────────────────────────
// SQLite datetime('now') is UTC; the trip happened on NZ time, so a 9 am
// interview must not get filed under the previous day.
function nz(utcish) {
  const d = utcish instanceof Date ? utcish : new Date(String(utcish).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return { date: String(utcish || '').slice(0, 10) || 'unknown-date', time: '' };
  const parts = new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(d).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

const pad3 = id => String(id).padStart(3, '0');

// Strip characters that Windows filenames or Obsidian wiki-links can't handle.
function safeName(text) {
  return String(text || '')
    .replace(/[<>:"/\\|?*#^\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, '');
}

function parseSummary(row) {
  if (!row.summary) return null;
  try {
    const parsed = JSON.parse(row.summary);
    if (parsed && typeof parsed.summary === 'string' && Array.isArray(parsed.points)) return parsed;
  } catch (_) { /* malformed summary — treat as missing */ }
  return null;
}

const STANCES = ['supports', 'contradicts', 'neutral'];
const DIMENSIONS = ['environmental', 'social', 'general'];
const ICON = { supports: '✅', contradicts: '❌', neutral: '➖' };
const DIM_ICON = { environmental: '🌿', social: '👥', general: '🌐' };

const cleanPoint = p => ({
  point: String(p.point || '').trim(),
  stance: STANCES.includes(p.stance) ? p.stance : 'neutral',
  dimension: DIMENSIONS.includes(p.dimension) ? p.dimension : 'general'
});

// Minimal YAML frontmatter; string values JSON-quoted (valid YAML scalars).
function frontmatter(obj) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) lines.push(`${key}: [${value.map(v => JSON.stringify(String(v))).join(', ')}]`);
    else if (typeof value === 'number') lines.push(`${key}: ${value}`);
    else lines.push(`${key}: ${JSON.stringify(String(value))}`);
  }
  lines.push('---');
  return lines.join('\n');
}

const linkTo = name => (name && name !== 'Unknown') ? `[[${name}]]` : (name || 'Unknown');

// ── interview notes ─────────────────────────────────────────────────────────
function interviewFileName(row) {
  const { date } = nz(row.submitted_at);
  const label = safeName(row.interviewee) || safeName(row.location) || 'Interview';
  return `${pad3(row.id)} - ${date} - ${label}.md`;
}

function interviewNote(row) {
  const { date, time } = nz(row.submitted_at);
  const summary = parseSummary(row);
  const points = summary ? summary.points.map(cleanPoint).filter(p => p.point) : [];
  const tally = stance => points.filter(p => p.stance === stance).length;
  const dimensions = [...new Set(points.map(p => p.dimension))].filter(d => d !== 'general');

  const head = frontmatter({
    id: row.id,
    date,
    time,
    location: row.location,
    location_label: row.location_label,
    interviewer: row.interviewer,
    interviewee: row.interviewee,
    latitude: row.latitude,
    longitude: row.longitude,
    supports: summary ? tally('supports') : undefined,
    contradicts: summary ? tally('contradicts') : undefined,
    neutral: summary ? tally('neutral') : undefined,
    tags: ['interview', ...dimensions]
  });

  const who = row.interviewee || 'Unnamed speaker';
  const lines = [head, '', `# Interview ${row.id} — ${who}`, ''];

  const meta = [
    `**When:** ${date}${time ? ` ${time}` : ''} (NZT)`,
    `**Where:** ${linkTo(row.location)}${row.location_label ? ` — ${row.location_label}` : ''}`
  ];
  if (row.interviewer) meta.push(`**By:** ${row.interviewer}`);
  if (row.audio_file) meta.push(`**Recording:** [listen](${BASE_URL}/api/admin/interviews/${row.id}/audio)`);
  lines.push(meta.join(' · '), '');

  if (summary) {
    lines.push('## AI summary', '', summary.summary.trim(), '');
    if (points.length) {
      lines.push('## Key points', '');
      for (const p of points) lines.push(`- ${ICON[p.stance]} ${p.point} #${p.stance} #${p.dimension}`);
      lines.push('');
    }
    const model = row.summary_model ? `Summary by ${row.summary_model}` : 'AI summary';
    const when = row.summary_updated_at ? ` on ${nz(row.summary_updated_at).date}` : '';
    lines.push(`*${model}${when} — check the transcript before quoting in the report.*`, '');
  } else {
    lines.push('## AI summary', '', '*None yet — generate one from the admin dashboard, then re-run the import.*', '');
  }

  lines.push('## Transcript', '');
  if (row.transcript && row.transcript.trim()) {
    if (row.transcript_source) lines.push(`*source: ${row.transcript_source}*`, '');
    lines.push(...row.transcript.trim().split(/\r?\n/).map(l => `> ${l}`));
  } else {
    lines.push('*None yet.*');
  }

  if (row.notes && row.notes.trim()) {
    lines.push('', '## Field notes (from the app)', '', row.notes.trim());
  }

  return lines.join('\n');
}

// ── analysis notes ──────────────────────────────────────────────────────────
function evidenceBoard(interviews) {
  const buckets = {}; // stance → dimension → [bullet]
  let summarised = 0;

  for (const row of interviews) {
    const summary = parseSummary(row);
    if (!summary) continue;
    summarised++;
    const link = `[[${interviewFileName(row).replace(/\.md$/, '')}]]`;
    const who = row.interviewee || row.location || `interview ${row.id}`;
    for (const raw of summary.points) {
      const p = cleanPoint(raw);
      if (!p.point) continue;
      const byDim = (buckets[p.stance] ??= {});
      (byDim[p.dimension] ??= []).push(`- ${p.point} — *${who}*, ${link}`);
    }
  }

  const count = (stance, dim) => ((buckets[stance] || {})[dim] || []).length;
  const total = STANCES.reduce((n, s) => n + DIMENSIONS.reduce((m, d) => m + count(s, d), 0), 0);
  const pending = interviews.length - summarised;
  const now = nz(new Date());

  const lines = ['# Evidence Board', '',
    `*${total} classified point(s) from ${summarised} of ${interviews.length} interview(s)` +
    (pending ? ` — ${pending} still need an AI summary` : '') +
    `. Updated ${now.date} ${now.time} NZT.*`, ''];

  lines.push('## Tally', '',
    `| | ${DIMENSIONS.map(d => `${DIM_ICON[d]} ${d}`).join(' | ')} |`,
    `| --- | ${DIMENSIONS.map(() => '---').join(' | ')} |`);
  for (const stance of STANCES) {
    lines.push(`| ${ICON[stance]} ${stance} | ${DIMENSIONS.map(d => count(stance, d)).join(' | ')} |`);
  }
  lines.push('');

  const SECTION = {
    supports: '## ✅ Supports the hypothesis',
    contradicts: '## ❌ Contradicts the hypothesis',
    neutral: '## ➖ Neutral / context'
  };
  for (const stance of STANCES) {
    lines.push(SECTION[stance], '');
    let any = false;
    for (const dim of DIMENSIONS) {
      const bullets = (buckets[stance] || {})[dim];
      if (!bullets || !bullets.length) continue;
      any = true;
      lines.push(`### ${DIM_ICON[dim]} ${dim[0].toUpperCase()}${dim.slice(1)}`, '', ...bullets, '');
    }
    if (!any) lines.push('*Nothing here yet.*', '');
  }

  return lines.join('\n');
}

// Question wording mirrors public/rotorua-survey.html — keep in sync if edited.
const QUESTIONS = {
  q1: ['env', 'This attraction manages rubbish effectively'],
  q2: ['env', 'Recycling facilities are easy to access at this attraction'],
  q3: ['env', 'The natural environment at this attraction is well looked after'],
  q4: ['env', 'This attraction gives visitors clear information on how to reduce their environmental impact'],
  q5: ['social', 'The attraction is accessible for a wide range of visitors, including families, elderly people and people with disabilities'],
  q6: ['env', 'The attraction is not overcrowded'],
  q7: ['social', 'Public transport is easily accessible to get to and from this attraction'],
  q8: ['social', 'The pricing for this attraction is reasonable'],
  q9: ['env', 'From what you have seen, tourism in Rotorua protects the natural environment'],
  q10: ['social', 'Rotorua tourism represents Māori culture in a respectful way'],
  q11: ['social', 'Tourism in Rotorua benefits the local community'],
  q12: ['social', 'Rotorua is managing tourism in a way that can continue in the long run']
};

function surveyStats(survey) {
  const now = nz(new Date());
  if (!survey.total_responses) {
    return `# Survey Stats\n\n*No survey responses yet. Updated ${now.date} ${now.time} NZT.*`;
  }
  const f = n => Number(n || 0).toFixed(2);
  const lines = ['# Survey Stats', '',
    `*${survey.total_responses} response(s) — ${survey.locals_count} locals, ${survey.visitors_count} visitors. ` +
    `Scale: 5 = strongly agree (more sustainable). Updated ${now.date} ${now.time} NZT.*`, '',
    `**Environmental average:** ${f(survey.avg_environmental)} / 5`,
    `**Social average:** ${f(survey.avg_social)} / 5`, '',
    '## By attraction', '',
    '| Attraction | Responses | 🌿 Env | 👥 Social |',
    '| --- | --- | --- | --- |'];
  for (const a of survey.by_attraction || []) {
    lines.push(`| ${linkTo(a.attraction)} | ${a.count} | ${f(a.avg_env)} | ${f(a.avg_social)} |`);
  }
  lines.push('', '## By question', '',
    '| # | Dim | Question | Avg |',
    '| --- | --- | --- | --- |');
  for (const [q, [dim, text]] of Object.entries(QUESTIONS)) {
    const avg = (survey.avg_per_question || {})[q];
    lines.push(`| ${q} | ${dim === 'env' ? '🌿' : '👥'} | ${text} | ${avg === undefined ? '–' : f(avg)} |`);
  }
  return lines.join('\n');
}

function eqaScores(eqa) {
  const now = nz(new Date());
  const f = n => Number(n || 0).toFixed(1);
  if (!eqa.total_assessments) {
    const legacy = eqa.legacy_count ? ` (${eqa.legacy_count} legacy assessment(s) excluded — they predate the 21-feature model)` : '';
    return `# EQA Scores\n\n*No EQA assessments yet${legacy}. Updated ${now.date} ${now.time} NZT.*`;
  }
  const cats = eqa.categories || [];
  const lines = ['# EQA Scores', '',
    `*${eqa.total_assessments} assessment(s)${eqa.legacy_count ? ` (+${eqa.legacy_count} legacy, excluded)` : ''}. ` +
    `Final score out of ${eqa.max_score}; higher = better. Updated ${now.date} ${now.time} NZT.*`, '',
    `**Average final score:** ${f(eqa.avg_final_score)} / ${eqa.max_score}`];
  const weakest = cats.find(c => c.key === eqa.weakest_category);
  if (weakest) {
    lines.push(`**Weakest category:** ${weakest.label} (−${f((eqa.avg_per_category || {})[weakest.key])} on average)`);
  }
  lines.push('', '## By location', '',
    `| Location | Assessments | Final /${eqa.max_score} | ${cats.map(c => c.label).join(' | ')} |`,
    `| --- | --- | --- | ${cats.map(() => '---').join(' | ')} |`);
  for (const loc of eqa.by_location || []) {
    lines.push(`| ${linkTo(loc.location)} | ${loc.count} | **${f(loc.final_score)}** | ${cats.map(c => '−' + f(loc[c.key])).join(' | ')} |`);
  }
  lines.push('', '*Per-category numbers are average points deducted (0–12 per category); closer to 0 is better.*', '',
    '## Category averages (all sites)', '',
    '| Category | Avg deduction |',
    '| --- | --- |');
  for (const c of cats) {
    lines.push(`| ${c.label} | −${f((eqa.avg_per_category || {})[c.key])} |`);
  }
  return lines.join('\n');
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`Importing from ${BASE_URL} into ${path.relative(repoRoot, VAULT) || VAULT} ...`);
  const [interviews, stats] = await Promise.all([
    getJson('/api/admin/interviews'),
    getJson('/api/admin/stats')
  ]);

  const dir = path.join(VAULT, 'Interviews');
  fs.mkdirSync(dir, { recursive: true });

  // If a note's name inputs changed (e.g. transcript date fixed), rename the
  // old file first so the human tail below the marker moves along with it.
  const existing = fs.readdirSync(dir);
  let points = 0;
  for (const row of interviews) {
    const name = interviewFileName(row);
    const old = existing.find(file => {
      const m = file.match(/^(\d+) - .*\.md$/);
      return m && Number(m[1]) === Number(row.id);
    });
    if (old && old !== name) fs.renameSync(path.join(dir, old), path.join(dir, name));
    writeNote(path.join('Interviews', name), interviewNote(row));
    const summary = parseSummary(row);
    if (summary) points += summary.points.length;
  }

  // Notes whose interview was deleted in the app are left alone, but flagged.
  const liveIds = new Set(interviews.map(row => Number(row.id)));
  const orphans = fs.readdirSync(dir).filter(file => {
    const m = file.match(/^(\d+) - .*\.md$/);
    return m && !liveIds.has(Number(m[1]));
  });

  writeNote(path.join('Analysis', 'Evidence Board.md'), evidenceBoard(interviews));
  writeNote(path.join('Analysis', 'Survey Stats.md'), surveyStats(stats.survey || {}));
  writeNote(path.join('Analysis', 'EQA Scores.md'), eqaScores(stats.eqa || {}));

  console.log(`Done: ${interviews.length} interview note(s), ${points} evidence point(s), survey + EQA stats refreshed.`);
  if (orphans.length) {
    console.warn(`Note: ${orphans.length} note(s) belong to interviews deleted in the app — remove them yourself if unwanted:`);
    for (const file of orphans) console.warn(`  Interviews/${file}`);
  }
})().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
