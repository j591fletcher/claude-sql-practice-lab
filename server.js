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
progressDb.run(`
  CREATE TABLE IF NOT EXISTS recent_problems (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    topic        TEXT    NOT NULL,
    problem_text TEXT    NOT NULL,
    generated_at TEXT    NOT NULL
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

const TOPIC_CONTEXT = {
  'SELECT':              'The question must ask for specific columns — not SELECT *. It should be clear why those columns are useful together.',
  'WHERE':               'The question must require filtering rows on a meaningful condition. The filter should narrow the result set significantly — not return nearly everything.',
  'GROUP BY':            'The question must require aggregating rows by one or more columns. Make clear what to group and what to measure — not just "summarize the data."',
  'HAVING':              'The question must require filtering on an aggregate. The condition should only make sense after grouping — it cannot be solved with WHERE alone.',
  'ORDER BY':            'The question must require sorting in a specific, motivated way. The sort column and direction should be clearly justified by the question.',
  'INNER JOIN':          'The question must require combining data from two tables via a shared relationship. It should be obvious that neither table alone can answer it.',
  'LEFT JOIN':           'The question must depend on the fact that some left-table rows may have no match in the right table. The answer changes meaningfully if an INNER JOIN were used instead.',
  'RIGHT JOIN':          'The question must depend on preserving all rows from the right table regardless of whether a match exists in the left table.',
  'FULL OUTER JOIN':     'The question must require showing rows from both tables even when no match exists on either side.',
  'SELF JOIN':           'The question must require joining the table to itself to compare or relate rows within the same table.',
  'CROSS JOIN':          'The question must produce a meaningful Cartesian product — every combination of rows from two tables.',
  'UNION / UNION ALL':   'The question must require combining result sets from two separate queries. Make it clear whether duplicates matter (UNION vs UNION ALL).',
  'INTERSECT & EXCEPT':  'The question must use set operations: INTERSECT to find common rows between two queries, or EXCEPT to find rows in one set but not another.',
  'SUBQUERY':            'The question must require a query nested inside another. The inner query result must feed the outer query — it cannot be flattened into a single-level query easily.',
  'AGGREGATE FUNCTIONS': 'The question must use one or more aggregate functions (COUNT, SUM, AVG, MIN, MAX) to compute a summary from multiple rows.',
  'CTE':                 'The question must require a WITH clause to break a complex query into readable steps. The CTE result must be meaningfully reused in the main query.',
  'WINDOW FUNCTIONS':    'The question must require a calculation across a set of related rows without collapsing them into a single output row.',
};

const TOPIC_ANGLES = {
  'SELECT':               ['use column aliases', 'use DISTINCT', 'compute a derived column with arithmetic or string functions'],
  'WHERE':                ['use a range condition (BETWEEN or comparisons)', 'use LIKE for pattern matching', 'combine AND/OR with multiple conditions', 'use IN with a list of values'],
  'GROUP BY':             ['group by a single column with COUNT(*)', 'group by two columns at once', 'use SUM or AVG instead of COUNT', 'combine with ORDER BY to rank groups'],
  'HAVING':               ['filter groups where an aggregate exceeds a threshold', 'use HAVING with COUNT to find groups with more than N members', 'combine HAVING with a WHERE clause'],
  'ORDER BY':             ['sort descending by a numeric column', 'sort by multiple columns with mixed directions', 'combine ORDER BY with LIMIT for top-N results'],
  'INNER JOIN':           ['join and filter the result with WHERE', 'join and aggregate across both tables', 'join and order by a column from the second table'],
  'LEFT JOIN':            ['find rows in the left table with no match (NULL check)', 'left join and count matches per left-table row', 'left join with a filter that reveals unmatched rows'],
  'SUBQUERY':             ['use a subquery in WHERE with IN', 'use a subquery in the FROM clause as a derived table', 'use EXISTS'],
  'AGGREGATE FUNCTIONS':  ['combine multiple aggregates in one query', 'use aggregate on a filtered subset', 'combine with GROUP BY'],
  'CTE':                  ['use a CTE to pre-filter before the main query', 'use a CTE to compute an aggregate reused in the main query', 'chain two CTEs'],
  'WINDOW FUNCTIONS':     ['use ROW_NUMBER() to rank within a partition', 'use SUM() OVER() for a running total', 'use RANK() or DENSE_RANK()', 'use LAG() or LEAD()'],
  'UNION / UNION ALL':    ['combine results from two queries with different filters', 'use UNION ALL then aggregate the combined result'],
  'INTERSECT & EXCEPT':   ['use EXCEPT to find rows in one set but not another', 'use INTERSECT to find common rows between two queries'],
};

function pickAngle(topic) {
  const angles = TOPIC_ANGLES[topic];
  if (!angles || angles.length === 0) return null;
  return angles[Math.floor(Math.random() * angles.length)];
}

function getRecentProblems(topic, limit = 7) {
  return new Promise((resolve, reject) => {
    progressDb.all(
      'SELECT problem_text FROM recent_problems WHERE topic = ? ORDER BY generated_at DESC LIMIT ?',
      [topic, limit],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows.map((r) => r.problem_text));
      }
    );
  });
}

function saveRecentProblem(topic, problemText) {
  const now = new Date().toISOString();
  progressDb.run(
    'INSERT INTO recent_problems (topic, problem_text, generated_at) VALUES (?, ?, ?)',
    [topic, problemText, now],
    () => {
      progressDb.run(
        `DELETE FROM recent_problems WHERE topic = ? AND id NOT IN (
          SELECT id FROM recent_problems WHERE topic = ? ORDER BY generated_at DESC LIMIT 10
        )`,
        [topic, topic]
      );
    }
  );
}

function getTableSchema(database, table) {
  return new Promise((resolve, reject) => {
    database.all(`PRAGMA table_info("${table}")`, (err, rows) => {
      if (err) return reject(err);
      const cols = rows.map((r) => {
        let desc = `  ${r.name} ${r.type || 'TEXT'}`;
        const flags = [];
        if (r.pk) flags.push('PRIMARY KEY');
        if (r.notnull && !r.pk) flags.push('NOT NULL');
        if (flags.length) desc += ` (${flags.join(', ')})`;
        return desc;
      });
      resolve(cols.join('\n'));
    });
  });
}

function getTableForeignKeys(database, table) {
  return new Promise((resolve, reject) => {
    database.all(`PRAGMA foreign_key_list("${table}")`, (err, rows) => {
      if (err) return reject(err);
      resolve(rows.map((r) => `  ${r.from} → ${r.table}.${r.to}`));
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
        const [schemas, samples, fkLists, recentProblems] = await Promise.all([
          Promise.all(selectedTables.map((t) => getTableSchema(database, t))),
          Promise.all(selectedTables.map((t) => getSampleRows(database, t, 3))),
          Promise.all(selectedTables.map((t) => getTableForeignKeys(database, t))),
          getRecentProblems(topic),
        ]);

        const schemaBlock = selectedTables.map((t, i) => {
          let block = `Table "${t}":\n${schemas[i]}`;
          if (fkLists[i].length > 0) block += `\nForeign keys:\n${fkLists[i].join('\n')}`;
          block += `\nSample rows: ${JSON.stringify(samples[i])}`;
          return block;
        }).join('\n\n');

        const rules = '- problem: 1–3 sentences. Name specific columns from the schema. Ask for patterns, ranges, or categories across multiple rows. Describe the desired result — not the SQL steps to get there.\n- sql: Must return at least 5 rows. Filter using ranges, patterns, or categories drawn from the sample data (e.g. WHERE price > 400, WHERE name LIKE \'B%\'). Every column mentioned in the problem must appear in the SELECT.';

        let varietyBlock = '';
        if (recentProblems.length > 0) {
          varietyBlock += `\n\nYou have already given me these problems for this topic — do NOT repeat the same patterns, column combinations, or question structure:\n` +
            recentProblems.map((p, i) => `${i + 1}. "${p}"`).join('\n');
        }
        const angle = pickAngle(topic);
        if (angle) varietyBlock += `\n\nAngle to take for this problem: ${angle}`;

        const topicContext = TOPIC_CONTEXT[topic] ? `\nContext: ${TOPIC_CONTEXT[topic]}` : '';
        const prompt = `You are a SQL interview coach. Return ONLY valid JSON: {"problem":"...","sql":"..."}\n\n${schemaBlock}\nTopic: ${topic}${topicContext}\n\n${rules}${varietyBlock}`;

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
              saveRecentProblem(topic, parsed.problem);
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

  const hintPrompt = `You are a SQL tutor helping me practice. I am stuck on this problem:\n\n"${pending.problemText}"\n\nTopic: ${pending.topic}\n${pending.schemaBlock}\nCorrect SQL (for your reference only — do not share it): ${pending.sql}\n\nGive me ONE hint (1–2 sentences) that:\n- Names the key SQL clause or concept I should apply\n- Points me toward the relevant columns or tables to use\n- Leaves the actual query for me to figure out\n\nWrite the hint directly to me. Be concrete. Write no SQL.`;

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
