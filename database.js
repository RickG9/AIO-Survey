const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

// Audio recordings from the interview tool live alongside the DB so the Docker
// named volume (mounted at DATA_DIR) keeps them across redeploys.
const audioDir = path.join(dataDir, 'audio');
fs.mkdirSync(audioDir, { recursive: true });

const dbPath = path.join(dataDir, 'responses.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS survey_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submitted_at TEXT DEFAULT (datetime('now')),
    respondent_name TEXT,
    interviewer TEXT,
    attraction TEXT,
    is_local TEXT,
    location_label TEXT,
    latitude REAL,
    longitude REAL,
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
    location_label TEXT,
    latitude REAL,
    longitude REAL,
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

  CREATE TABLE IF NOT EXISTS interviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submitted_at TEXT DEFAULT (datetime('now')),
    location TEXT,
    location_label TEXT,
    latitude REAL,
    longitude REAL,
    interviewer TEXT,
    interviewee TEXT,
    audio_file TEXT,
    transcript TEXT,
    transcript_source TEXT,
    notes TEXT,
    summary TEXT,
    summary_updated_at TEXT,
    summary_model TEXT
  );
`);

// Migrations: add columns to databases created before they existed.
// Each is wrapped individually so an already-applied migration is a no-op.
const migrations = [
  `ALTER TABLE survey_responses ADD COLUMN respondent_name TEXT`,
  `ALTER TABLE survey_responses ADD COLUMN interviewer TEXT`,
  `ALTER TABLE survey_responses ADD COLUMN location_label TEXT`,
  `ALTER TABLE survey_responses ADD COLUMN latitude REAL`,
  `ALTER TABLE survey_responses ADD COLUMN longitude REAL`,
  `ALTER TABLE eqa_assessments ADD COLUMN location_label TEXT`,
  `ALTER TABLE eqa_assessments ADD COLUMN latitude REAL`,
  `ALTER TABLE eqa_assessments ADD COLUMN longitude REAL`,
  `ALTER TABLE interviews ADD COLUMN summary TEXT`,
  `ALTER TABLE interviews ADD COLUMN summary_updated_at TEXT`,
  `ALTER TABLE interviews ADD COLUMN summary_model TEXT`
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) { /* column already exists */ }
}

module.exports = db;
module.exports.audioDir = audioDir;
