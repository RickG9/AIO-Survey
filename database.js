const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'responses.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS survey_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submitted_at TEXT DEFAULT (datetime('now')),
    respondent_name TEXT,
    attraction TEXT,
    is_local TEXT,
    q1 INTEGER,
    q2 INTEGER,
    q3 INTEGER,
    q4 INTEGER,
    q5 INTEGER,
    q6 INTEGER,
    q7 INTEGER,
    q8 INTEGER,
    q9 INTEGER,
    q10 INTEGER,
    q11 INTEGER,
    q12 INTEGER
  );

  CREATE TABLE IF NOT EXISTS eqa_assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submitted_at TEXT DEFAULT (datetime('now')),
    location TEXT,
    assess_date TEXT,
    assessor TEXT,
    lq INTEGER,
    noise INTEGER,
    air INTEGER,
    litter INTEGER,
    vandalism INTEGER,
    transport INTEGER,
    derelict INTEGER,
    total_score INTEGER,
    notes TEXT
  );
`);

// Migration: add respondent_name to existing databases that were created before this column.
try { db.exec(`ALTER TABLE survey_responses ADD COLUMN respondent_name TEXT`); } catch (_) {}

module.exports = db;
