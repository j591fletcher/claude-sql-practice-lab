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

// ── Topic-consolidation migration ──
// Some granular topics were merged into broader ones. Fold any progress and
// recent-problem history stored under the old names into the new name so no
// practice counts are lost. Idempotent: once old rows are gone it no-ops.
const TOPIC_MIGRATIONS = {
  'COUNT': 'Aggregate Functions',
  'SUM': 'Aggregate Functions',
  'AVG': 'Aggregate Functions',
  'MIN & MAX': 'Aggregate Functions',
  'Multiple CTEs': 'CTEs',
};
progressDb.serialize(() => {
  for (const [oldTopic, newTopic] of Object.entries(TOPIC_MIGRATIONS)) {
    // Merge the count into the new topic (summing if it already exists).
    progressDb.run(
      `INSERT INTO topic_progress (topic, count, last_practiced)
         SELECT ?, count, last_practiced FROM topic_progress WHERE topic = ?
       ON CONFLICT(topic) DO UPDATE SET
         count = count + excluded.count,
         last_practiced = MAX(topic_progress.last_practiced, excluded.last_practiced)`,
      [newTopic, oldTopic]
    );
    progressDb.run('DELETE FROM topic_progress WHERE topic = ?', [oldTopic]);
    progressDb.run('UPDATE recent_problems SET topic = ? WHERE topic = ?', [newTopic, oldTopic]);
  }
});

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
  'JOINs', 'UNION / UNION ALL', 'INTERSECT & EXCEPT',
]);

const TOPIC_CONTEXT = {
  // ── Easy ──
  'SELECT':              'The question must ask for specific columns — not SELECT *. It should be clear why those columns are useful together.',
  'WHERE':               'The question must require filtering rows on a meaningful condition. The filter should narrow the result set significantly — not return nearly everything.',
  'ORDER BY':            'The question must require sorting in a specific, motivated way. The sort column and direction should be clearly justified by the question.',
  'LIMIT':               'The question must require restricting the number of rows returned. Make it clear that only a specific count of results is wanted, implying more rows exist but should be excluded.',
  'DISTINCT':            'The question must require eliminating duplicate values. The table should have repeated values in the target column, making DISTINCT the meaningful choice over a plain SELECT.',
  'Aliases':             'The question must require renaming one or more columns or tables for clarity. The output column names should be more readable or meaningful than the raw schema names.',
  'AND / OR / NOT':      'The question must require combining multiple conditions with logical operators. At least two conditions must be combined, and the choice of AND/OR/NOT must be meaningful — not interchangeable.',
  'BETWEEN':             'The question must require filtering rows within an inclusive range of values. The range should be contextually meaningful — not arbitrary bounds replaceable with a simple equality check.',
  'IN / NOT IN':         'The question must require matching a column against a specific set of values. The set should contain at least 3 values, making IN more appropriate than chained OR conditions.',
  'LIKE':                'The question must require pattern matching on a text column using % or _ wildcards. The pattern must be meaningful — not an exact match that could use = instead.',
  'NULL handling':       'The question must require explicitly handling NULL values using IS NULL, IS NOT NULL, or COALESCE. The answer should change if NULLs are ignored, so their treatment must be intentional.',
  'COUNT':               'The question must require counting rows or non-NULL values. Make it clear whether all rows or only distinct/non-null values should be counted.',
  'SUM':                 'The question must require totaling a numeric column across multiple rows. The result should be a single meaningful total — not a per-row calculation.',
  'AVG':                 'The question must require computing the mean of a numeric column. Make it clear what population of rows is being averaged.',
  'MIN & MAX':           'The question must require finding both the smallest and largest value in a column in a single query. Contrast them meaningfully rather than asking for just one.',
  'Aggregate Functions': 'The question must require summarizing many rows into a single value using one or more aggregate functions (COUNT, SUM, AVG, MIN, MAX). Pick whichever aggregate(s) the question genuinely needs, and make the summary meaningful — not a per-row calculation.',
  // ── Intermediate ──
  'GROUP BY':            'The question must require aggregating rows by one or more columns. Make clear what to group and what to measure — not just "summarize the data."',
  'HAVING':              'The question must require filtering on an aggregate. The condition should only make sense after grouping — it cannot be solved with WHERE alone.',
  'JOINs':               'The question must require combining rows across tables via a shared relationship, and must require exactly ONE specific kind of join to answer correctly — INNER, LEFT, RIGHT, FULL OUTER, or SELF — chosen randomly. Critically, the question wording must NOT name or hint at which join type is needed; the solver should have to reason about whether unmatched rows must be preserved (outer joins), whether only matching rows count (inner), or whether the table relates to itself (self). Make sure the correct join type genuinely matters: the answer should change if a different join were used.',
  'UNION / UNION ALL':   'The question must require combining result sets from two separate queries. Make it clear whether duplicates matter (UNION vs UNION ALL).',
  'Subqueries':          'The question must require a query nested inside another. The inner query result must feed the outer query — it cannot be flattened into a single-level query easily.',
  'CASE WHEN':           'The question must require conditional logic that categorizes or transforms values inline. The conditions should be meaningful — not trivially replaceable by a simple WHERE filter.',
  'COALESCE':            'The question must require substituting a fallback value when a column is NULL. The table must actually contain NULLs in the relevant column, making COALESCE necessary.',
  'String Functions':    'The question must require manipulating text using built-in string functions (UPPER, LOWER, LENGTH, SUBSTR, REPLACE, TRIM, etc.). The transformation should produce a meaningfully different output.',
  'CAST':                'The question must require explicitly converting a value from one data type to another. The type mismatch should be meaningful — not a redundant cast on an already-correct type.',
  // ── Advanced ──
  'CTEs':                'The question must require a WITH clause to name and reuse an intermediate result set. The CTE must be referenced in the main query — it should not be inlined without losing clarity.',
  'Multiple CTEs':       'The question must require at least two named CTEs in a single WITH clause. Each CTE should serve a distinct purpose, and the main query should reference more than one of them.',
  'Recursive CTEs':      'The question must require a recursive WITH clause to traverse hierarchical or sequential data. The base case and recursive case must both be meaningful — this cannot be solved with a simple join.',
  'ROW_NUMBER':          'The question must require assigning a unique sequential integer to each row within a partition. The numbering should serve a purpose — such as isolating the first or last row per group.',
  'RANK & DENSE_RANK':   'The question must require ranking rows where ties are possible and tie-handling behavior matters. The difference between RANK (gaps) and DENSE_RANK (no gaps) should be relevant given the data.',
  'PARTITION BY':        'The question must require performing a window calculation independently within each group of rows. The partition boundary should be meaningful — results should differ significantly across partitions.',
  'LAG & LEAD':          'The question must require comparing a row to an adjacent row in a sequence. The offset relationship should be meaningful — such as comparing a value to the previous period or next entry.',
  'FIRST_VALUE & LAST_VALUE': 'The question must require retrieving the first or last value in an ordered window frame. The frame boundary must matter, and the result should depend on the ordering within the partition.',
  'NTILE':               'The question must require dividing rows into a specified number of equal-sized buckets. The bucket assignment should be meaningful — such as quartiles, deciles, or percentile groups.',
  'Running Totals':      'The question must require computing a cumulative sum that grows row by row in a defined order. The running total should be over a meaningful numeric column, ordered by a column that defines the sequence.',
  'Correlated Subqueries': 'The question must require a subquery that references a column from the outer query. The inner query must execute once per outer row — it cannot be replaced by a simple join or uncorrelated subquery.',
  'EXISTS / NOT EXISTS': 'The question must require checking for the presence or absence of related rows. The result should depend on whether matching rows exist — not on their values.',
  'INTERSECT & EXCEPT':  'The question must use set operations: INTERSECT to find common rows between two queries, or EXCEPT to find rows in one set but not another.',
  // ── Legacy keys (kept for backward compatibility with any stored progress) ──
  'SUBQUERY':            'The question must require a query nested inside another. The inner query result must feed the outer query — it cannot be flattened into a single-level query easily.',
  'AGGREGATE FUNCTIONS': 'The question must use one or more aggregate functions (COUNT, SUM, AVG, MIN, MAX) to compute a summary from multiple rows.',
  'CTE':                 'The question must require a WITH clause to break a complex query into readable steps. The CTE result must be meaningfully reused in the main query.',
  'WINDOW FUNCTIONS':    'The question must require a calculation across a set of related rows without collapsing them into a single output row.',
};

const TOPIC_ANGLES = {
  // ── Easy ──
  'SELECT':               ['use column aliases', 'use DISTINCT', 'compute a derived column with arithmetic or string functions'],
  'WHERE':                ['use a range condition (BETWEEN or comparisons)', 'use LIKE for pattern matching', 'combine AND/OR with multiple conditions', 'use IN with a list of values'],
  'ORDER BY':             ['sort descending by a numeric column', 'sort by multiple columns with mixed directions', 'combine ORDER BY with LIMIT for top-N results'],
  'LIMIT':                ['use LIMIT with ORDER BY to get top-N results', 'use LIMIT with OFFSET to skip rows', 'use LIMIT to preview the largest or smallest values'],
  'DISTINCT':             ['count distinct values with COUNT(DISTINCT col)', 'select distinct values from a text column with duplicates', 'combine DISTINCT with ORDER BY'],
  'Aliases':              ['alias a computed column to a readable name', 'alias a long column name to something shorter', 'alias both a column and a table in the same query'],
  'AND / OR / NOT':       ['combine two conditions with AND', 'use OR to include rows matching either of two conditions', 'use NOT to exclude a set of values'],
  'BETWEEN':              ['filter a numeric column within an inclusive range', 'combine BETWEEN with another condition', 'use NOT BETWEEN to exclude a range'],
  'IN / NOT IN':          ['use IN with a list of at least 3 text values', 'use NOT IN to exclude a set of values', 'combine IN with another WHERE condition'],
  'LIKE':                 ['match values starting with a prefix using X%', 'match values containing a substring using %X%', 'use _ to match exactly one character'],
  'NULL handling':        ['find rows where a column IS NULL', 'find rows where a column IS NOT NULL', 'use COALESCE to replace NULLs with a default value'],
  'COUNT':                ['count all rows with COUNT(*)', 'count non-null values in a specific column', 'count distinct values with COUNT(DISTINCT col)'],
  'SUM':                  ['sum a numeric column across all rows', 'sum a filtered subset of rows', 'sum with GROUP BY to get totals per category'],
  'AVG':                  ['compute the average of a numeric column', 'average a filtered subset', 'round the average to two decimal places'],
  'MIN & MAX':            ['find both the minimum and maximum in one query', 'find the min/max within a filtered subset', 'combine MIN and MAX with GROUP BY'],
  'Aggregate Functions':  ['count rows with COUNT(*)', 'total a numeric column with SUM', 'average a numeric column with AVG', 'find both MIN and MAX in one query', 'combine several aggregates in a single query', 'aggregate over a filtered subset'],
  // ── Intermediate ──
  'GROUP BY':             ['group by a single column with COUNT(*)', 'group by two columns at once', 'use SUM or AVG instead of COUNT', 'combine with ORDER BY to rank groups'],
  'HAVING':               ['filter groups where an aggregate exceeds a threshold', 'use HAVING with COUNT to find groups with more than N members', 'combine HAVING with a WHERE clause'],
  'JOINs':                ['design it so an INNER JOIN is correct — combine matching rows from both tables and filter or aggregate', 'design it so a LEFT JOIN is correct — the answer depends on left-table rows that have no match (NULL check)', 'design it so a RIGHT JOIN is correct — the answer depends on right-table rows that have no match in the left', 'design it so a FULL OUTER JOIN is correct — the answer needs rows with no match on either side', 'design it so a SELF JOIN is correct — relate or compare rows within a single table'],
  'UNION / UNION ALL':    ['combine results from two queries with different filters', 'use UNION ALL then aggregate the combined result'],
  'Subqueries':           ['use a subquery in WHERE with IN', 'use a subquery in the FROM clause as a derived table', 'use a scalar subquery in SELECT'],
  'CASE WHEN':            ['categorize a numeric column into labeled buckets', 'assign a label based on a text column value', 'use CASE WHEN inside an aggregate'],
  'COALESCE':             ['replace NULLs in a column with a default string', 'use COALESCE to combine two columns where one may be NULL', 'use COALESCE inside an aggregate'],
  'String Functions':     ['use UPPER or LOWER to normalize text', 'use LENGTH to filter by string length', 'use SUBSTR or REPLACE to transform a value'],
  'CAST':                 ['cast a text column to INTEGER for arithmetic', 'cast a numeric column to TEXT for concatenation', 'cast inside an aggregate expression'],
  // ── Advanced ──
  'CTEs':                 ['use a CTE to pre-filter before the main query', 'use a CTE to compute an aggregate reused in the main query'],
  'Multiple CTEs':        ['chain two CTEs where the second references the first', 'define two independent CTEs and join them in the main query'],
  'Recursive CTEs':       ['traverse a parent-child hierarchy to find all ancestors or descendants', 'generate a sequence of numbers using recursion'],
  'ROW_NUMBER':           ['assign row numbers within a partition ordered by a numeric column', 'use ROW_NUMBER to isolate the single top row per group'],
  'RANK & DENSE_RANK':    ['rank rows where ties produce gaps with RANK()', 'use DENSE_RANK to rank without gaps', 'compare RANK and DENSE_RANK in the same query'],
  'PARTITION BY':         ['partition by a category column and compute an aggregate per partition', 'use PARTITION BY with ORDER BY to get running values per group'],
  'LAG & LEAD':           ['use LAG to compare a value to the previous row', 'use LEAD to look ahead to the next row', 'compute the difference between a row and its predecessor'],
  'FIRST_VALUE & LAST_VALUE': ['get the first value in each partition ordered by a numeric column', 'get the last value and compare it to the current row value'],
  'NTILE':                ['divide rows into 4 quartiles', 'divide rows into deciles and filter by a specific bucket'],
  'Running Totals':       ['compute a running SUM ordered by a sequence column', 'compute a running total within a partition'],
  'Correlated Subqueries':['use a correlated subquery in WHERE to filter by a per-row aggregate', 'use a correlated subquery in SELECT to add a computed column'],
  'EXISTS / NOT EXISTS':  ['use EXISTS to find rows with at least one matching related row', 'use NOT EXISTS to find rows with no matches'],
  'INTERSECT & EXCEPT':   ['use EXCEPT to find rows in one set but not another', 'use INTERSECT to find common rows between two queries'],
  // ── Legacy keys ──
  'SUBQUERY':             ['use a subquery in WHERE with IN', 'use a subquery in the FROM clause as a derived table', 'use EXISTS'],
  'AGGREGATE FUNCTIONS':  ['combine multiple aggregates in one query', 'use aggregate on a filtered subset', 'combine with GROUP BY'],
  'CTE':                  ['use a CTE to pre-filter before the main query', 'use a CTE to compute an aggregate reused in the main query', 'chain two CTEs'],
  'WINDOW FUNCTIONS':     ['use ROW_NUMBER() to rank within a partition', 'use SUM() OVER() for a running total', 'use RANK() or DENSE_RANK()', 'use LAG() or LEAD()'],
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

// LeetCode-style result comparison. We grade by running both the reference and
// the user's query and comparing result sets with three tolerances:
//   1. Columns are compared by POSITION, not name — aliases are ignored, but
//      column order and count must match the expected output.
//   2. Row order is enforced only when the reference solution sorts (see
//      expectsOrder); otherwise rows are compared as an order-independent multiset.
//   3. Values are normalized — floats rounded, NULL-safe, numeric strings coerced,
//      surrounding whitespace trimmed (case preserved).

const FLOAT_DECIMALS = 4; // absorbs IEEE float noise & minor precision diffs; single knob to tune leniency

// Normalize a single scalar cell value for tolerant comparison.
function normScalar(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Number(v.toFixed(FLOAT_DECIMALS)) : String(v);
  if (typeof v === 'string') {
    const t = v.trim();                                   // trim whitespace, case preserved
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(Number(t).toFixed(FLOAT_DECIMALS)); // "1" -> 1, "3.50" -> 3.5
    return t;
  }
  return v; // booleans etc.
}

// Row -> array of normalized values in SELECT column order. Object.values
// preserves column order, so this ignores column NAMES while honoring column
// order and count.
function normRow(row) {
  return Object.values(row).map(normScalar);
}

// True only if the SQL's outermost query has an ORDER BY (depth 0). Tracking
// parenthesis depth naturally excludes ORDER BY inside OVER ( ... ) window
// clauses and inside subqueries (both at depth > 0).
function expectsOrder(sql) {
  if (!sql) return false;
  let depth = 0;
  const s = sql.replace(/'(?:[^']|'')*'/g, "''"); // blank out string literals to avoid false hits
  const re = /\border\s+by\b|\(|\)/gi;
  let m;
  while ((m = re.exec(s))) {
    const tok = m[0];
    if (tok === '(') depth++;
    else if (tok === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) return true; // an ORDER BY at top level
  }
  return false;
}

function resultSetsEqual(expected, actual, ordered) {
  if (expected.length !== actual.length) return false;
  let e = expected.map(normRow);
  let a = actual.map(normRow);
  if (!ordered) {                                  // sort rows when order is not required
    const key = (r) => JSON.stringify(r);
    e = [...e].sort((x, y) => key(x).localeCompare(key(y)));
    a = [...a].sort((x, y) => key(x).localeCompare(key(y)));
  }
  return JSON.stringify(e) === JSON.stringify(a);
}

// True when the SQL ends with a plain `LIMIT n` (no OFFSET). These "top N"
// solutions should still accept an answer that omits the LIMIT clause.
function hasTrailingLimit(sql) {
  if (!sql) return false;
  return /\blimit\s+\d+\s*;?\s*$/i.test(sql.trim()) && !/\boffset\b/i.test(sql);
}

// Order-sensitive prefix check: the (limited) expected rows equal the first
// N rows of the user's result. Used when the expected SQL has a LIMIT but the
// user's correct query left it off, returning the same rows plus extras.
function rowsPrefixEqual(expected, actual) {
  if (actual.length < expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (JSON.stringify(normRow(expected[i])) !== JSON.stringify(normRow(actual[i]))) return false;
  }
  return true;
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

        const rules = '- problem: 1–3 sentences. Name specific columns from the schema. Ask for patterns, ranges, or categories across multiple rows. Describe the desired result — not the SQL steps to get there.\n- sql: Must return at least 5 rows. Filter using ranges, patterns, or categories drawn from the sample data (e.g. WHERE price > 400, WHERE name LIKE \'B%\'). Every column mentioned in the problem must appear in the SELECT.\n- Keep the sql as SIMPLE and direct as possible: write the shortest query that fully answers the problem. Use only the clauses the topic requires. Do NOT add subqueries, CTEs, joins, window functions, extra conditions, or other constructs unless the problem genuinely needs them. Prefer the most straightforward, idiomatic solution a beginner would write.';

        let varietyBlock = '';
        if (recentProblems.length > 0) {
          varietyBlock += `\n\nYou have already given me these problems for this topic — do NOT repeat the same patterns, column combinations, or question structure:\n` +
            recentProblems.map((p, i) => `${i + 1}. "${p}"`).join('\n');
        }

        const topicContext = TOPIC_CONTEXT[topic] ? `\nContext: ${TOPIC_CONTEXT[topic]}` : '';

        let problemText = `Write a SQL query on ${selectedTables.join(' and ')} practising ${topic}.`;
        let source = 'fallback';
        let problemId = null;

        // Try a few times: the problem is only accepted if its expected SQL
        // both runs AND returns at least one row. An empty result set means a
        // problem the user can never see their answer match, so we regenerate.
        const MAX_ATTEMPTS = 5;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !problemId; attempt++) {
          // Fresh angle each attempt for variety across retries.
          const angle = pickAngle(topic);
          const angleBlock = angle ? `\n\nAngle to take for this problem: ${angle}` : '';
          const prompt = `You are a SQL interview coach. Return ONLY valid JSON: {"problem":"...","sql":"..."}\n\n${schemaBlock}\nTopic: ${topic}${topicContext}\n\n${rules}${varietyBlock}${angleBlock}`;

          let raw;
          try {
            console.log(`Calling Ollama for topic: ${topic}, tables: ${selectedTables.join(', ')} (attempt ${attempt}/${MAX_ATTEMPTS})`);
            raw = await generateProblemFromOllama(prompt, 'json');
            console.log('Ollama raw response:', raw.substring(0, 300));
          } catch (apiError) {
            // Retry on a failed request too — a transient blip shouldn't drop us
            // to the answerless fallback when the next attempt would succeed.
            console.warn(`Attempt ${attempt}: Ollama request failed, retrying:`, apiError.message);
            continue;
          }

          const parsed = parseOllamaJson(raw);
          if (!parsed) {
            console.warn(`Attempt ${attempt}: could not parse Ollama response as JSON — retrying`);
            // Remember the last raw text in case every attempt fails to parse.
            problemText = raw;
            source = 'ollama';
            continue;
          }

          let expectedRows;
          try {
            expectedRows = await queryRows(database, parsed.sql);
          } catch (sqlErr) {
            console.warn(`Attempt ${attempt}: expected SQL failed to execute, retrying:`, sqlErr.message);
            continue;
          }

          if (expectedRows.length === 0) {
            console.warn(`Attempt ${attempt}: expected SQL returned 0 rows, retrying`);
            continue;
          }

          // Accepted: parses, runs, and returns at least one row.
          problemText = parsed.problem;
          source = 'ollama';
          problemId = randomUUID();
          pendingProblems.set(problemId, { db, expectedRows, sql: parsed.sql, topic, schemaBlock, problemText: parsed.problem });
          saveRecentProblem(topic, parsed.problem);
          console.log(`Stored expected answer for problemId ${problemId} (${expectedRows.length} rows)`);
        }

        database.close();
        res.json({ problem: problemText, source, tables: selectedTables, problemId, model: process.env.OLLAMA_MODEL || 'gemma3:27b' });
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
    const ordered = expectsOrder(pending.sql);
    let correct = resultSetsEqual(pending.expectedRows, actualRows, ordered);
    // Accept "top N" answers that leave off the expected solution's LIMIT.
    if (!correct && hasTrailingLimit(pending.sql)) {
      correct = rowsPrefixEqual(pending.expectedRows, actualRows);
    }
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
    warmUpOllama();
  });
}

// Preload the model into VRAM on startup so the first problem isn't slow.
async function warmUpOllama() {
  const model = process.env.OLLAMA_MODEL || 'gemma3:27b';
  const host = process.env.OLLAMA_BASE_URL || 'http://localhost:11500';
  try {
    await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m' }),
    });
    console.log(`Warmed up Ollama model: ${model}`);
  } catch (err) {
    console.log(`Ollama warm-up skipped: ${err.message}`);
  }
}

module.exports = app;
module.exports.resultSetsEqual = resultSetsEqual;
module.exports.rowsPrefixEqual = rowsPrefixEqual;
module.exports.expectsOrder = expectsOrder;
module.exports.normScalar = normScalar;

async function generateProblemFromOllama(prompt, format = null) {
  const model = process.env.OLLAMA_MODEL || 'gemma3:27b';
  const host = process.env.OLLAMA_BASE_URL || 'http://localhost:11500';
  const body = { model, prompt, stream: false, keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m' };
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
