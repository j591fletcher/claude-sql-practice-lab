const TOPICS = {
  easy: [
    'SELECT', 'WHERE', 'ORDER BY', 'LIMIT', 'DISTINCT',
    'Aliases', 'AND / OR / NOT', 'BETWEEN', 'IN / NOT IN',
    'LIKE', 'NULL handling', 'Aggregate Functions',
  ],
  intermediate: [
    'GROUP BY', 'HAVING', 'JOINs', 'UNION / UNION ALL', 'Subqueries',
    'CASE WHEN', 'COALESCE', 'String Functions', 'CAST',
  ],
  advanced: [
    'CTEs', 'Recursive CTEs', 'ROW_NUMBER',
    'RANK & DENSE_RANK', 'PARTITION BY', 'LAG & LEAD',
    'FIRST_VALUE & LAST_VALUE', 'NTILE', 'Running Totals',
    'Correlated Subqueries', 'EXISTS / NOT EXISTS', 'INTERSECT & EXCEPT',
  ],
};

// ── Mastery tiers ──
// A topic earns Bronze → Silver → Gold by accumulating correct solves.
// Thresholds scale by difficulty so harder topics reward sooner.
const TIER_THRESHOLDS = {
  easy:         { bronze: 3, silver: 8, gold: 15 },
  intermediate: { bronze: 2, silver: 6, gold: 12 },
  advanced:     { bronze: 2, silver: 5, gold: 10 },
};
const DIFF_ORDER = ['easy', 'intermediate', 'advanced'];
const DIFF_LABEL = { easy: 'Easy', intermediate: 'Intermediate', advanced: 'Advanced' };

// topic → difficulty lookup
const TOPIC_DIFF = {};
for (const [diff, list] of Object.entries(TOPICS)) list.forEach((t) => { TOPIC_DIFF[t] = diff; });

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
function setActiveDiffTab(diff) {
  document.querySelectorAll('.diff-tab').forEach((t) => {
    const on = t.dataset.diff === diff;
    t.classList.toggle('active', on);
    t.setAttribute('aria-pressed', String(on));
  });
}

document.querySelectorAll('.diff-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    activeDiff = tab.dataset.diff;
    setActiveDiffTab(activeDiff);
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
    pill.setAttribute('aria-pressed', String(topic === selectedTopic));

    const label = document.createElement('span');
    label.textContent = topic;
    pill.appendChild(label);

    const count = topicProgress[topic];
    if (count) {
      const badge = document.createElement('span');
      badge.className = 'pill-count';
      badge.textContent = count;
      badge.setAttribute('aria-label', `${count} solved`);
      pill.appendChild(badge);
    }

    pill.addEventListener('click', () => {
      selectedTopic = topic;
      document.querySelectorAll('.topic-pill').forEach((p) => {
        const on = p === pill;
        p.classList.toggle('selected', on);
        p.setAttribute('aria-pressed', String(on));
      });
    });
    bar.appendChild(pill);
  });
}

// ── Ambient stats (header) ──
function computeStats() {
  let gold = 0, solves = 0, total = 0, pctSum = 0;
  DIFF_ORDER.forEach((diff) => {
    TOPICS[diff].forEach((topic) => {
      total++;
      const c = topicProgress[topic] || 0;
      solves += c;
      const th = TIER_THRESHOLDS[diff];
      pctSum += Math.min(c / th.gold, 1);
      if (c >= th.gold) gold++;
    });
  });
  return { gold, solves, total, overall: total ? pctSum / total : 0 };
}

function updateStats() {
  const s = computeStats();
  document.getElementById('statMastered').textContent = `${s.gold}/${s.total}`;
  document.getElementById('statSolves').textContent = s.solves;

  const ring = document.getElementById('ringFg');
  if (ring) {
    const r = ring.r.baseVal.value;
    const c = 2 * Math.PI * r;
    ring.style.strokeDasharray = `${c}`;
    ring.style.strokeDashoffset = `${c * (1 - s.overall)}`;
  }
  const pctEl = document.getElementById('ringPct');
  if (pctEl) pctEl.textContent = `${Math.round(s.overall * 100)}%`;
}

// ── Mastery Map ──
function tierFor(topic, count) {
  const th = TIER_THRESHOLDS[TOPIC_DIFF[topic]] || TIER_THRESHOLDS.easy;
  if (count >= th.gold)   return { tier: 'gold',   reached: 3 };
  if (count >= th.silver) return { tier: 'silver', reached: 2, toNext: th.gold - count,   nextName: 'Gold' };
  if (count >= th.bronze) return { tier: 'bronze', reached: 1, toNext: th.silver - count, nextName: 'Silver' };
  return { tier: 'none', reached: 0, toNext: th.bronze - count, nextName: 'Bronze' };
}

function renderMasteryMap() {
  const columns = document.getElementById('mmColumns');
  columns.innerHTML = '';
  let goldTotal = 0, solveTotal = 0, topicTotal = 0;

  DIFF_ORDER.forEach((diff) => {
    const col = document.createElement('div');
    col.className = 'mm-col';
    const tiles = document.createElement('div');
    tiles.className = 'mm-tiles';

    let colGold = 0;
    TOPICS[diff].forEach((topic) => {
      topicTotal++;
      const count = topicProgress[topic] || 0;
      solveTotal += count;
      const info = tierFor(topic, count);
      if (info.tier === 'gold') { colGold++; goldTotal++; }

      const pip = (cls, on) => `<i class="mm-pip ${cls}${on ? ' on' : ''}"></i>`;
      const pips = pip('bronze', info.reached >= 1) + pip('silver', info.reached >= 2) + pip('gold', info.reached >= 3);

      let sub;
      if (info.tier === 'gold') sub = `★ Mastered · ${count} solves`;
      else if (count === 0)     sub = `Not started · ${info.toNext} to Bronze`;
      else                      sub = `${count} solve${count !== 1 ? 's' : ''} · ${info.toNext} to ${info.nextName}`;

      const tile = document.createElement('div');
      tile.className = `mm-tile mm-${info.tier}`;
      tile.setAttribute('role', 'button');
      tile.setAttribute('tabindex', '0');
      const tierWord = info.tier === 'none' ? 'not started' : `${info.tier} tier`;
      tile.setAttribute('aria-label', `${topic}, ${tierWord}. ${sub.replace('★', '').trim()}. Practice this topic.`);
      tile.innerHTML = `
        <div class="mm-tile-top">
          <span class="mm-name">${topic}</span>
          <span class="mm-pips" aria-hidden="true">${pips}</span>
        </div>
        <div class="mm-sub">${sub}</div>`;
      tile.addEventListener('click', () => selectTopicFromMap(diff, topic));
      tile.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectTopicFromMap(diff, topic); }
      });
      tiles.appendChild(tile);
    });

    const head = document.createElement('div');
    head.className = 'mm-col-head';
    head.innerHTML = `<span>${DIFF_LABEL[diff]}</span><span class="mm-col-count">${colGold}/${TOPICS[diff].length} ★</span>`;
    col.appendChild(head);
    col.appendChild(tiles);
    columns.appendChild(col);
  });

  document.getElementById('mmSummary').innerHTML =
    `<b>${goldTotal}</b> / ${topicTotal} topics mastered · <b>${solveTotal}</b> total solves`;
}

function selectTopicFromMap(diff, topic) {
  activeDiff = diff;
  selectedTopic = topic;
  setActiveDiffTab(diff);
  renderTopicPills();
  closeMasteryMap();
}

let mapPrevFocus = null;

function openMasteryMap() {
  // Re-fetch progress so the map reflects the latest solves, then render.
  fetch('/api/progress')
    .then((r) => (r.ok ? r.json() : []))
    .then((rows) => { topicProgress = Object.fromEntries(rows.map((p) => [p.topic, p.count])); renderTopicPills(); updateStats(); })
    .catch(() => { /* fall back to in-memory progress */ })
    .finally(() => {
      renderMasteryMap();
      mapPrevFocus = document.activeElement;
      document.getElementById('mapOverlay').classList.add('open');
      // Move focus into the dialog for keyboard/screen-reader users.
      document.getElementById('mmCloseBtn').focus();
    });
}

function closeMasteryMap() {
  const overlay = document.getElementById('mapOverlay');
  if (!overlay.classList.contains('open')) return;
  overlay.classList.remove('open');
  // Restore focus to the control that opened the dialog.
  if (mapPrevFocus && typeof mapPrevFocus.focus === 'function') mapPrevFocus.focus();
  mapPrevFocus = null;
}

// Trap Tab focus within the open Mastery Map dialog.
function trapMapFocus(e) {
  if (e.key !== 'Tab') return;
  const overlay = document.getElementById('mapOverlay');
  if (!overlay.classList.contains('open')) return;
  const focusables = overlay.querySelectorAll('button, [tabindex]:not([tabindex="-1"])');
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
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
// The drawer is an inline flex panel, so opening/closing it resizes the editor
// pane. CodeMirror caches its dimensions, so refresh it after the width
// transition (0.2s) finishes to avoid stale layout / hidden cursor.
function refreshEditorAfterResize() {
  setTimeout(() => editor.refresh(), 220);
}

function closeSchema() {
  activeSchemaTables.clear();
  document.getElementById('schemaDrawer').classList.remove('open');
  document.getElementById('schemaDrawerContent').innerHTML = '';
  document.querySelectorAll('.table-chip-btn').forEach((c) => { c.classList.remove('active'); c.setAttribute('aria-pressed', 'false'); });
  refreshEditorAfterResize();
}

async function toggleSchema(tableName, chipEl) {
  const content = document.getElementById('schemaDrawerContent');

  if (activeSchemaTables.has(tableName)) {
    activeSchemaTables.delete(tableName);
    chipEl.classList.remove('active');
    chipEl.setAttribute('aria-pressed', 'false');
    document.getElementById(`schema-section-${CSS.escape(tableName)}`)?.remove();
    if (activeSchemaTables.size === 0) {
      document.getElementById('schemaDrawer').classList.remove('open');
      refreshEditorAfterResize();
    }
    return;
  }

  const wasClosed = activeSchemaTables.size === 0;
  activeSchemaTables.add(tableName);
  chipEl.classList.add('active');
  chipEl.setAttribute('aria-pressed', 'true');
  document.getElementById('schemaDrawer').classList.add('open');
  if (wasClosed) refreshEditorAfterResize();

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
  problemText.textContent = 'Generating…';
  btn.disabled = true;

  // New problem — clear any query and results from the previous one.
  editor.setValue('');
  document.getElementById('resultArea').textContent = 'Run a query to see results here.';
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
    document.getElementById('sourceDot').style.background = isOllama ? 'var(--teal)' : 'var(--ink-faint)';
    document.getElementById('sourceModel').textContent = isOllama ? (payload.model || 'local model') : 'fallback';
    document.getElementById('problemMeta').style.display = 'flex';

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
        chip.setAttribute('aria-pressed', 'false');
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
  resultArea.textContent = 'Running…';
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
  columns.forEach((col) => { const th = document.createElement('th'); th.scope = 'col'; th.textContent = col; headerRow.appendChild(th); });
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
    banner.textContent = payload.correct ? '✓  Correct! Nice work.' : '✗  Not quite — compare your results with expected below.';
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
          updateStats();
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
  // Explain why it's locked so it isn't a mystery (tooltip + screen readers).
  const reason = !currentProblemId
    ? 'Generate a problem first'
    : (wrongAnswerCount < 2 ? 'Unlocks after 2 incorrect attempts' : 'Show a hint for this problem');
  btn.title = reason;
  btn.setAttribute('aria-label', `Hint — ${reason}`);
}

async function showHint() {
  if (!currentProblemId) return;
  const section = document.getElementById('hintSection');
  const hintTextEl = document.getElementById('hintText');
  const btn = document.getElementById('hintBtn');

  btn.disabled = true;
  hintTextEl.textContent = 'Generating hint…';
  section.style.display = 'flex';

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

  section.style.display = 'flex';
  code.textContent = 'Loading…';
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
  updateStats();
}

document.getElementById('mapBtn').addEventListener('click', openMasteryMap);
document.getElementById('mmCloseBtn').addEventListener('click', closeMasteryMap);
document.getElementById('mapOverlay').addEventListener('click', (e) => { if (e.target.id === 'mapOverlay') closeMasteryMap(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMasteryMap(); });
document.addEventListener('keydown', trapMapFocus);

document.getElementById('generateProblem').addEventListener('click', generateProblem);
document.getElementById('validateSql').addEventListener('click', validateSql);
document.getElementById('submitAnswer').addEventListener('click', submitAnswer);
document.getElementById('schemaCloseBtn').addEventListener('click', closeSchema);
document.getElementById('hintBtn').addEventListener('click', showHint);
document.getElementById('revealSolutionBtn').addEventListener('click', revealSolution);

// ── CodeMirror ──
editor = CodeMirror.fromTextArea(document.getElementById('sqlInput'), {
  mode: 'text/x-sql',
  theme: 'default',
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
