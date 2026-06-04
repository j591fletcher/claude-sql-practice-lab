const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { randomUUID } = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 4000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, 'state');

if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

const progressDb = new sqlite3.Database(path.join(STATE_DIR, 'progress.db'));
progressDb.run(`
  CREATE TABLE IF NOT EXISTS topic_progress (
    topic          TEXT PRIMARY KEY,
    count          INTEGER NOT NULL DEFAULT 0,
    last_practiced TEXT    NOT NULL
  )
`);

// In-memory store: problemId → { db, expectedRows }
const pendingProblems = new Map();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function listDatabaseFiles() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  return fs.readdirSync(DATA_DIR)
    .filter((file) => ['.db', '.sqlite', '.sqlite3'].includes(path.extname(file).toLowerCase()))
    .map((file) => ({ name: file, path: path.join(DATA_DIR, file) }));
}

function openDatabase(dbName) {
  const dbPath = path.join(DATA_DIR, dbName);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbName}`);
  }
  return new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => {
    if (err) {
      console.error('Failed to open database', dbPath, err.message);
    }
  });
}

app.get('/api/databases', (req, res) => {
  try {
    const files = listDatabaseFiles();
    res.json(files.map((file) => file.name));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/tables', (req, res) => {
  try {
    const { db } = req.query;
    if (!db) return res.status(400).json({ error: 'Missing db query parameter' });
    const database = openDatabase(db);
    database.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name", (err, rows) => {
      database.close();
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows.map((row) => row.name));
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/schema', (req, res) => {
  try {
    const { db, table } = req.query;
    if (!db || !table) return res.status(400).json({ error: 'Missing db or table query parameter' });
    const database = openDatabase(db);
    database.all(`PRAGMA table_info(${table})`, (err, rows) => {
      database.close();
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows.map((row) => ({ cid: row.cid, name: row.name, type: row.type, notnull: row.notnull, dflt_value: row.dflt_value, pk: row.pk })));
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const MULTI_TABLE_TOPICS = new Set([
  'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL OUTER JOIN',
  'SELF JOIN', 'CROSS JOIN', 'UNION / UNION ALL', 'INTERSECT & EXCEPT',
]);

function getTableSchema(database, table) {
  return new Promise((resolve, reject) => {
    database.all(`PRAGMA table_info(${table})`, (err, rows) => {
      if (err) return reject(err);
      resolve(rows.map((r) => `${r.name} (${r.type})`).join(', '));
    });
  });
}

function getSampleRows(database, table, n = 3) {
  return new Promise((resolve, reject) => {
    database.all(`SELECT * FROM "${table}" LIMIT ${n}`, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function queryRows(database, sql) {
  return new Promise((resolve, reject) => {
    database.all(sql, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function pickRandom(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

function parseOllamaJson(text) {
  // Strip markdown fences, then try direct parse
  const cleaned = text.replace(/```(?:json|sql)?\s*/gi, '').trim();
  try {
    const obj = JSON.parse(cleaned);
    if (typeof obj.problem === 'string' && typeof obj.sql === 'string') return obj;
  } catch {}
  // If there's surrounding prose, pull out the first {...} block and try again
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]);
      if (typeof obj.problem === 'string' && typeof obj.sql === 'string') return obj;
    } catch {}
  }
  return null;
}

function normalizeRows(rows) {
  return rows
    .map((row) => {
      const n = {};
      Object.keys(row).sort().forEach((k) => { n[k] = row[k]; });
      return n;
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function resultSetsEqual(a, b) {
  if (a.length !== b.length) return false;
  return JSON.stringify(normalizeRows(a)) === JSON.stringify(normalizeRows(b));
}

app.post('/api/generate-problem', async (req, res) => {
  try {
    const { db, topic } = req.body;
    if (!db || !topic) {
      return res.status(400).json({ error: 'Expected body with db and topic' });
    }

    const database = openDatabase(db);

    database.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", async (err, tableRows) => {
      if (err) { database.close(); return res.status(500).json({ error: err.message }); }

      const allTables = tableRows.map((r) => r.name);
      const needsMultiple = MULTI_TABLE_TOPICS.has(topic);
      const selectedTables = needsMultiple ? pickRandom(allTables, 2) : pickRandom(allTables, 1);

      try {
        const [schemas, samples] = await Promise.all([
          Promise.all(selectedTables.map((t) => getTableSchema(database, t))),
          Promise.all(selectedTables.map((t) => getSampleRows(database, t, 3))),
        ]);

        const schemaBlock = selectedTables.map((t, i) =>
          `Table "${t}": ${schemas[i]}\nSample rows: ${JSON.stringify(samples[i])}`
        ).join('\n\n');

        const rules = '- problem: 1–3 sentences. Reference specific column names. Do NOT ask for details of a single named item. Do NOT reveal the SQL.\n- sql: Must return at least 2 rows. Do NOT filter to a single exact value (e.g. WHERE name = \'X\'). Use sample values only as reference for ranges, categories, or patterns (e.g. WHERE price > 400, WHERE name LIKE \'B%\').';

        const prompt = `You are a SQL interview coach. Return ONLY valid JSON: {"problem":"...","sql":"..."}\n\n${schemaBlock}\nTopic: ${topic}\n\n${rules}`;

        let problemText = `Write a SQL query on ${selectedTables.join(' and ')} practising ${topic}.`;
        let source = 'fallback';
        let problemId = null;

        try {
          console.log(`Calling Ollama for topic: ${topic}, tables: ${selectedTables.join(', ')}`);
          const raw = await generateProblemFromOllama(prompt, 'json');
          console.log('Ollama raw response:', raw.substring(0, 300));
          const parsed = parseOllamaJson(raw);

          if (parsed) {
            problemText = parsed.problem;
            source = 'ollama';
            // Run expected SQL and store result set
            try {
              const expectedRows = await queryRows(database, parsed.sql);
              problemId = randomUUID();
              pendingProblems.set(problemId, { db, expectedRows, sql: parsed.sql, topic, schemaBlock, problemText: parsed.problem });
              console.log(`Stored expected answer for problemId ${problemId} (${expectedRows.length} rows)`);
            } catch (sqlErr) {
              console.warn('Expected SQL failed to execute:', sqlErr.message);
            }
          } else {
            console.warn('Could not parse Ollama response as JSON — no answer checking for this problem');
            problemText = raw;
            source = 'ollama';
          }
          console.log('Ollama responded successfully');
        } catch (apiError) {
          console.warn('Ollama request failed, using fallback:', apiError.message);
        }

        database.close();
        res.json({ problem: problemText, source, tables: selectedTables, problemId });
      } catch (schemaErr) {
        database.close();
        res.status(500).json({ error: schemaErr.message });
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/check-answer', (req, res) => {
  const { problemId, db, query } = req.body;
  if (!problemId || !db || !query) return res.status(400).json({ error: 'Missing fields' });

  const pending = pendingProblems.get(problemId);
  if (!pending) return res.status(404).json({ error: 'Problem not found — generate a new one.' });

  let database;
  try {
    database = openDatabase(db);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  database.all(query, (err, actualRows) => {
    database.close();
    if (err) return res.status(400).json({ error: err.message });
    const correct = resultSetsEqual(pending.expectedRows, actualRows);
    res.json({ correct, actual: actualRows, expected: pending.expectedRows });
  });
});

app.post('/api/validate-sql', (req, res) => {
  try {
    const { db, query } = req.body;
    if (!db || !query) return res.status(400).json({ error: 'Expected body with db and query' });
    const database = openDatabase(db);
    database.all(query, (err, rows) => {
      database.close();
      if (err) return res.status(400).json({ error: err.message });
      res.json({ rows });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/progress', (req, res) => {
  progressDb.all('SELECT topic, count, last_practiced FROM topic_progress ORDER BY topic', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/progress', (req, res) => {
  const { topic } = req.body;
  if (!topic) return res.status(400).json({ error: 'Missing topic' });
  const now = new Date().toISOString();
  progressDb.run(
    `INSERT INTO topic_progress (topic, count, last_practiced) VALUES (?, 1, ?)
     ON CONFLICT(topic) DO UPDATE SET count = count + 1, last_practiced = excluded.last_practiced`,
    [topic, now],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      progressDb.get('SELECT count FROM topic_progress WHERE topic = ?', [topic], (err2, row) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ topic, count: row.count });
      });
    }
  );
});

app.get('/api/solution/:problemId', (req, res) => {
  const pending = pendingProblems.get(req.params.problemId);
  if (!pending) return res.status(404).json({ error: 'Problem not found — generate a new one.' });
  res.json({ sql: pending.sql });
});

app.post('/api/generate-hint', async (req, res) => {
  const { problemId } = req.body;
  if (!problemId) return res.status(400).json({ error: 'Missing problemId' });
  const pending = pendingProblems.get(problemId);
  if (!pending) return res.status(404).json({ error: 'Problem not found — generate a new one.' });

  const hintPrompt = `You are a SQL tutor. A student is stuck on this problem:\n\n"${pending.problemText}"\n\nTopic: ${pending.topic}\n${pending.schemaBlock}\nCorrect SQL: ${pending.sql}\n\nGive ONE concise hint (1-2 sentences). Do NOT reveal the SQL or exact values used. Guide toward the approach or SQL concept only.`;

  try {
    const hint = await generateProblemFromOllama(hintPrompt);
    res.json({ hint: hint.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

module.exports = app;

async function generateProblemFromOllama(prompt, format = null) {
  const model = process.env.OLLAMA_MODEL || 'gemma3:27b';
  const host = process.env.OLLAMA_BASE_URL || 'http://localhost:11500';
  const body = { model, prompt, stream: false };
  if (format) body.format = format;
  const response = await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Ollama responded with ${response.status}`);
  const payload = await response.json();
  return payload.response || 'Unable to generate a problem.';
}
