const TOPICS = {
  easy: [
    'SELECT', 'WHERE', 'ORDER BY', 'LIMIT', 'DISTINCT',
    'Aliases', 'AND / OR / NOT', 'BETWEEN', 'IN / NOT IN',
    'LIKE', 'NULL handling', 'COUNT', 'SUM', 'AVG', 'MIN & MAX',
  ],
  intermediate: [
    'GROUP BY', 'HAVING', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN',
    'FULL OUTER JOIN', 'SELF JOIN', 'UNION / UNION ALL', 'Subqueries',
    'CASE WHEN', 'COALESCE', 'String Functions', 'CAST',
  ],
  advanced: [
    'CTEs', 'Multiple CTEs', 'Recursive CTEs', 'ROW_NUMBER',
    'RANK & DENSE_RANK', 'PARTITION BY', 'LAG & LEAD',
    'FIRST_VALUE & LAST_VALUE', 'NTILE', 'Running Totals',
    'Correlated Subqueries', 'EXISTS / NOT EXISTS', 'INTERSECT & EXCEPT',
  ],
};

let activeDatabase = null;
let availableTables = [];
let selectedTopic = TOPICS.easy[0];
let activeDiff = 'easy';
const activeSchemaTables = new Set();
let editor = null;
let allSchemaHints = {};
let topicProgress = {};
let currentProblemId = null;
let currentProblemSolved = false;
let wrongAnswerCount = 0;

// ── Difficulty tabs ──
document.querySelectorAll('.diff-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.diff-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    activeDiff = tab.dataset.diff;
    selectedTopic = TOPICS[activeDiff][0];
    renderTopicPills();
  });
});

function renderTopicPills() {
  const bar = document.getElementById('topicBar');
  bar.innerHTML = '';
  TOPICS[activeDiff].forEach((topic) => {
    const pill = document.createElement('button');
    pill.className = 'topic-pill' + (topic === selectedTopic ? ' selected' : '');

    const label = document.createElement('span');
    label.textContent = topic;
    pill.appendChild(label);

    const count = topicProgress[topic];
    if (count) {
      const badge = document.createElement('span');
      badge.className = 'pill-count';
      badge.textContent = count;
      pill.appendChild(badge);
    }

    pill.addEventListener('click', () => {
      selectedTopic = topic;
      document.querySelectorAll('.topic-pill').forEach((p) => p.classList.remove('selected'));
      pill.classList.add('selected');
    });
    bar.appendChild(pill);
  });
}

// ── Resize ──
const resultsPane = document.getElementById('resultsPane');
const resizeHandle = document.getElementById('resizeHandle');
let isResizing = false, startY = 0, startHeight = 0;

resizeHandle.addEventListener('mousedown', (e) => {
  isResizing = true;
  startY = e.clientY;
  startHeight = resultsPane.offsetHeight;
  document.body.style.cursor = 'row-resize';
  document.body.style.userSelect = 'none';
});

document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  const newHeight = Math.max(80, Math.min(startHeight + (startY - e.clientY), window.innerHeight * 0.8));
  resultsPane.style.height = newHeight + 'px';
});

document.addEventListener('mouseup', () => {
  if (!isResizing) return;
  isResizing = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});


// ── Schema drawer ──
function closeSchema() {
  activeSchemaTables.clear();
  document.getElementById('schemaDrawer').classList.remove('open');
  document.getElementById('schemaDrawerContent').innerHTML = '';
  document.querySelectorAll('.table-chip-btn').forEach((c) => c.classList.remove('active'));
}

async function toggleSchema(tableName, chipEl) {
  const content = document.getElementById('schemaDrawerContent');

  if (activeSchemaTables.has(tableName)) {
    activeSchemaTables.delete(tableName);
    chipEl.classList.remove('active');
    document.getElementById(`schema-section-${CSS.escape(tableName)}`)?.remove();
    if (activeSchemaTables.size === 0) document.getElementById('schemaDrawer').classList.remove('open');
    return;
  }

  activeSchemaTables.add(tableName);
  chipEl.classList.add('active');
  document.getElementById('schemaDrawer').classList.add('open');

  const section = document.createElement('div');
  section.id = `schema-section-${CSS.escape(tableName)}`;
  section.className = 'schema-section';
  section.innerHTML = `<div class="schema-section-header">${tableName}</div><div class="schema-loading">Loading…</div>`;
  content.appendChild(section);

  try {
    const res = await fetch(`/api/schema?db=${encodeURIComponent(activeDatabase)}&table=${encodeURIComponent(tableName)}`);
    const cols = await res.json();
    section.innerHTML = `
      <div class="schema-section-header">${tableName}</div>
      <div class="schema-cols">${cols.map((c) => `
        <div class="schema-col-row">
          <span class="schema-col-name">${c.name}</span>
          <span class="schema-col-type">${c.type || 'text'}</span>
        </div>`).join('')}
      </div>`;
  } catch {
    section.innerHTML = `<div class="schema-section-header">${tableName}</div><div class="schema-error">Failed to load.</div>`;
  }
}

// ── Generate problem ──
async function generateProblem() {
  if (!activeDatabase) {
    document.getElementById('problemText').textContent = 'Database not loaded yet.';
    return;
  }
  const btn = document.getElementById('generateProblem');
  const problemText = document.getElementById('problemText');
  problemText.textContent = 'Generating...';
  btn.disabled = true;
  try {
    const response = await fetch('/api/generate-problem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db: activeDatabase, topic: selectedTopic }),
    });
    const payload = await response.json();
    if (!response.ok) { problemText.textContent = `Error: ${payload.error}`; return; }
    problemText.textContent = payload.problem;

    currentProblemId = payload.problemId || null;
    currentProblemSolved = false;
    wrongAnswerCount = 0;
    updateHintButton();
    document.getElementById('hintSection').style.display = 'none';
    document.getElementById('hintText').textContent = '';
    loadSolution();

    const isOllama = payload.source === 'ollama';
    document.getElementById('sourceDot').style.background = isOllama ? 'var(--accent)' : 'var(--muted)';
    document.getElementById('sourceModel').textContent = isOllama ? 'qwen2.5-coder:7b' : 'fallback';
    document.getElementById('problemMeta').style.display = 'flex';
    problemText.classList.remove('no-meta');

    const tablesSection = document.getElementById('tablesSection');
    const tableChipsEl = document.getElementById('tableChips');

    closeSchema();
    tableChipsEl.innerHTML = '';

    if (payload.tables && payload.tables.length) {
      tablesSection.style.display = 'flex';
      payload.tables.forEach((t) => {
        const chip = document.createElement('button');
        chip.className = 'table-chip-btn';
        chip.textContent = t;
        chip.addEventListener('click', () => toggleSchema(t, chip));
        tableChipsEl.appendChild(chip);
      });

      // Restrict autocomplete to only the tables used in this problem
      const hints = Object.fromEntries(
        payload.tables.filter((t) => allSchemaHints[t]).map((t) => [t, allSchemaHints[t]])
      );
      editor.setOption('hintOptions', { tables: hints, completeSingle: true });
    } else {
      tablesSection.style.display = 'none';
    }
  } finally {
    btn.disabled = false;
  }
}

// ── Run query ──
async function validateSql() {
  const query = editor.getValue().trim();
  const resultArea = document.getElementById('resultArea');
  if (!activeDatabase || !query) {
    resultArea.textContent = 'Please enter a SQL query.';
    return;
  }
  resultArea.textContent = 'Running...';
  const btn = document.getElementById('validateSql');
  btn.disabled = true;
  try {
    const response = await fetch('/api/validate-sql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db: activeDatabase, query }),
    });
    const payload = await response.json();
    if (!response.ok) { resultArea.textContent = `Error: ${payload.error}`; return; }
    renderResult(payload.rows);
  } finally {
    btn.disabled = false;
  }
}

function appendResultTable(rows, container) {
  if (!rows.length) {
    const msg = document.createElement('div');
    msg.className = 'row-count';
    msg.textContent = 'No rows returned.';
    container.appendChild(msg);
    return;
  }
  const columns = Object.keys(rows[0]);
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  columns.forEach((col) => { const th = document.createElement('th'); th.textContent = col; headerRow.appendChild(th); });
  thead.appendChild(headerRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    columns.forEach((col) => { const td = document.createElement('td'); td.textContent = row[col] === null ? 'NULL' : row[col]; tr.appendChild(td); });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);
  const count = document.createElement('div');
  count.className = 'row-count';
  count.textContent = `${rows.length} row${rows.length !== 1 ? 's' : ''} returned`;
  container.appendChild(count);
}

function renderResult(rows) {
  const resultArea = document.getElementById('resultArea');
  resultArea.innerHTML = '';
  appendResultTable(rows, resultArea);
}

// ── Submit answer ──
async function submitAnswer() {
  const query = editor.getValue().trim();
  const resultArea = document.getElementById('resultArea');
  if (!query) { resultArea.textContent = 'Write a SQL query first.'; return; }

  // No expected answer available — just run the query and show results
  if (!currentProblemId) {
    resultArea.innerHTML = '';
    const note = document.createElement('div');
    note.className = 'answer-banner answer-incorrect';
    note.textContent = '⚠  No expected answer available for this problem — showing your results only.';
    resultArea.appendChild(note);
    const res = await fetch('/api/validate-sql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db: activeDatabase, query }),
    });
    const payload = await res.json();
    if (!res.ok) { resultArea.textContent = `Error: ${payload.error}`; return; }
    appendResultTable(payload.rows, resultArea);
    return;
  }

  const btn = document.getElementById('submitAnswer');
  btn.disabled = true;
  resultArea.innerHTML = '';

  try {
    const res = await fetch('/api/check-answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problemId: currentProblemId, db: activeDatabase, query }),
    });
    const payload = await res.json();

    if (!res.ok) {
      const err = document.createElement('div');
      err.className = 'result-section-label';
      err.textContent = `Error: ${payload.error}`;
      resultArea.appendChild(err);
      return;
    }

    const banner = document.createElement('div');
    banner.className = 'answer-banner ' + (payload.correct ? 'answer-correct' : 'answer-incorrect');
    banner.textContent = payload.correct ? '✓  Correct!' : '✗  Not quite — compare your results with expected below.';
    resultArea.appendChild(banner);

    const yourLabel = document.createElement('div');
    yourLabel.className = 'result-section-label';
    yourLabel.textContent = 'Your results';
    resultArea.appendChild(yourLabel);
    appendResultTable(payload.actual, resultArea);

    if (!payload.correct) {
      const expLabel = document.createElement('div');
      expLabel.className = 'result-section-label result-section-label--expected';
      expLabel.textContent = 'Expected results';
      resultArea.appendChild(expLabel);
      appendResultTable(payload.expected, resultArea);
    }

    if (!payload.correct) {
      wrongAnswerCount++;
      updateHintButton();
    }

    // Save progress only on the first correct submission for this problem
    if (payload.correct && !currentProblemSolved) {
      currentProblemSolved = true;
      try {
        const pr = await fetch('/api/progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic: selectedTopic }),
        });
        if (pr.ok) {
          const pd = await pr.json();
          topicProgress[selectedTopic] = pd.count;
          renderTopicPills();
        }
      } catch { /* non-fatal */ }
    }
  } finally {
    btn.disabled = false;
  }
}

// ── Hint ──
function updateHintButton() {
  const btn = document.getElementById('hintBtn');
  btn.disabled = !currentProblemId || wrongAnswerCount < 2;
}

async function showHint() {
  if (!currentProblemId) return;
  const section = document.getElementById('hintSection');
  const hintTextEl = document.getElementById('hintText');
  const btn = document.getElementById('hintBtn');

  btn.disabled = true;
  hintTextEl.textContent = 'Generating hint...';
  section.style.display = 'block';

  try {
    const res = await fetch('/api/generate-hint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problemId: currentProblemId }),
    });
    const payload = await res.json();
    hintTextEl.textContent = res.ok ? payload.hint : `Error: ${payload.error}`;
  } catch {
    hintTextEl.textContent = 'Failed to generate hint.';
  } finally {
    updateHintButton();
  }
}

// ── Solution ──
async function loadSolution() {
  const section = document.getElementById('solutionSection');
  const code = document.getElementById('solutionCode');
  if (!currentProblemId) { section.style.display = 'none'; return; }

  section.style.display = 'block';
  code.textContent = 'Loading...';
  code.classList.add('solution-blurred');
  document.getElementById('revealSolutionBtn').textContent = 'Reveal';

  try {
    const res = await fetch(`/api/solution/${currentProblemId}`);
    if (!res.ok) { code.textContent = 'Solution unavailable.'; return; }
    const payload = await res.json();
    code.textContent = payload.sql;
  } catch {
    code.textContent = 'Solution unavailable.';
  }
}

function revealSolution() {
  const code = document.getElementById('solutionCode');
  const btn = document.getElementById('revealSolutionBtn');
  const isBlurred = code.classList.contains('solution-blurred');
  code.classList.toggle('solution-blurred', !isBlurred);
  btn.textContent = isBlurred ? 'Hide' : 'Reveal';
}

// ── Init ──
async function initialize() {
  const dbs = await fetch('/api/databases').then((r) => r.ok ? r.json() : []);
  if (!dbs.length) { document.getElementById('problemText').textContent = 'No database found. Run: node scripts/load-csv.js'; return; }
  activeDatabase = dbs[0];
  availableTables = await fetch(`/api/tables?db=${encodeURIComponent(activeDatabase)}`).then((r) => r.ok ? r.json() : []);

  // Load persisted progress
  const progressRows = await fetch('/api/progress').then((r) => r.ok ? r.json() : []);
  topicProgress = Object.fromEntries(progressRows.map((p) => [p.topic, p.count]));

  // Fetch column names for every table and cache them
  await Promise.all(availableTables.map(async (table) => {
    const res = await fetch(`/api/schema?db=${encodeURIComponent(activeDatabase)}&table=${encodeURIComponent(table)}`);
    if (res.ok) {
      const cols = await res.json();
      allSchemaHints[table] = cols.map((c) => c.name);
    }
  }));

  renderTopicPills();
}

document.getElementById('generateProblem').addEventListener('click', generateProblem);
document.getElementById('validateSql').addEventListener('click', validateSql);
document.getElementById('submitAnswer').addEventListener('click', submitAnswer);
document.getElementById('schemaCloseBtn').addEventListener('click', closeSchema);
document.getElementById('hintBtn').addEventListener('click', showHint);
document.getElementById('revealSolutionBtn').addEventListener('click', revealSolution);

// ── CodeMirror ──
editor = CodeMirror.fromTextArea(document.getElementById('sqlInput'), {
  mode: 'text/x-sql',
  theme: 'dracula',
  lineNumbers: true,
  tabSize: 2,
  indentWithTabs: false,
  lineWrapping: true,
  autofocus: true,
  extraKeys: {
    'Ctrl-Enter': () => validateSql(),
    'Cmd-Enter': () => validateSql(),
    'Ctrl-Space': (cm) => cm.showHint(),
    'Tab': (cm) => {
      if (cm.somethingSelected()) { cm.indentSelection('add'); return; }
      const token = cm.getTokenAt(cm.getCursor());
      if (token.string.trim().length > 0) {
        cm.showHint({ completeSingle: true });
      } else {
        cm.replaceSelection('  ');
      }
    },
  },
});

initialize();
