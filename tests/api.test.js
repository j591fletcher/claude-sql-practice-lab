const request = require('supertest');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const os = require('os');

// Must be set before requiring the app so DATA_DIR is overridden
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-practice-test-'));
process.env.DATA_DIR = TEST_DIR;

const app = require('../server');

const TEST_DB = path.join(TEST_DIR, 'test.db');

beforeAll((done) => {
  const db = new sqlite3.Database(TEST_DB);
  db.serialize(() => {
    db.run('CREATE TABLE villagers (name TEXT, species TEXT, personality TEXT)');
    db.run("INSERT INTO villagers VALUES ('Bob', 'Cat', 'Lazy')");
    db.run("INSERT INTO villagers VALUES ('Fauna', 'Deer', 'Normal')");
    db.run('CREATE TABLE fish (name TEXT, price INTEGER, location TEXT)');
    db.run("INSERT INTO fish VALUES ('Bass', 400, 'River')");
    db.run("INSERT INTO fish VALUES ('Salmon', 700, 'River')");
  });
  db.close(done);
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true });
});

// ── /api/databases ──────────────────────────────────────────────────────────

describe('GET /api/databases', () => {
  test('returns list of .db files', async () => {
    const res = await request(app).get('/api/databases');
    expect(res.status).toBe(200);
    expect(res.body).toContain('test.db');
  });
});

// ── /api/tables ─────────────────────────────────────────────────────────────

describe('GET /api/tables', () => {
  test('returns tables for a valid database', async () => {
    const res = await request(app).get('/api/tables?db=test.db');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.arrayContaining(['villagers', 'fish']));
  });

  test('returns 400 when db param is missing', async () => {
    const res = await request(app).get('/api/tables');
    expect(res.status).toBe(400);
  });

  test('returns 500 for a non-existent database', async () => {
    const res = await request(app).get('/api/tables?db=missing.db');
    expect(res.status).toBe(500);
  });
});

// ── /api/schema ─────────────────────────────────────────────────────────────

describe('GET /api/schema', () => {
  test('returns column info for a valid table', async () => {
    const res = await request(app).get('/api/schema?db=test.db&table=villagers');
    expect(res.status).toBe(200);
    const names = res.body.map((col) => col.name);
    expect(names).toEqual(['name', 'species', 'personality']);
  });

  test('returns 400 when table param is missing', async () => {
    const res = await request(app).get('/api/schema?db=test.db');
    expect(res.status).toBe(400);
  });
});

// ── /api/validate-sql ────────────────────────────────────────────────────────

describe('POST /api/validate-sql', () => {
  test('returns rows for a valid query', async () => {
    const res = await request(app)
      .post('/api/validate-sql')
      .send({ db: 'test.db', query: 'SELECT * FROM villagers' });
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0].name).toBe('Bob');
  });

  test('filters rows correctly with WHERE', async () => {
    const res = await request(app)
      .post('/api/validate-sql')
      .send({ db: 'test.db', query: "SELECT * FROM villagers WHERE species = 'Cat'" });
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].name).toBe('Bob');
  });

  test('returns 400 for invalid SQL', async () => {
    const res = await request(app)
      .post('/api/validate-sql')
      .send({ db: 'test.db', query: 'SELECT * FROM nonexistent_table' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('returns 400 when body is missing fields', async () => {
    const res = await request(app).post('/api/validate-sql').send({ db: 'test.db' });
    expect(res.status).toBe(400);
  });
});

// ── /api/generate-problem ────────────────────────────────────────────────────

describe('POST /api/generate-problem', () => {
  beforeEach(() => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Ollama not running'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns a fallback problem when Ollama is unavailable', async () => {
    const res = await request(app)
      .post('/api/generate-problem')
      .send({ db: 'test.db', topic: 'SELECT' });
    expect(res.status).toBe(200);
    expect(res.body.problem).toBeDefined();
    expect(res.body.source).toBe('fallback');
    expect(res.body.tables).toHaveLength(1);
  });

  test('picks 2 tables for JOIN topics', async () => {
    const res = await request(app)
      .post('/api/generate-problem')
      .send({ db: 'test.db', topic: 'JOINs' });
    expect(res.status).toBe(200);
    expect(res.body.tables).toHaveLength(2);
  });

  test('returns 400 when topic is missing', async () => {
    const res = await request(app)
      .post('/api/generate-problem')
      .send({ db: 'test.db' });
    expect(res.status).toBe(400);
  });

  test('returns a problem from Ollama when available', async () => {
    jest.restoreAllMocks();
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'Write a query to find all Cat villagers.' }),
    });
    const res = await request(app)
      .post('/api/generate-problem')
      .send({ db: 'test.db', topic: 'WHERE' });
    expect(res.status).toBe(200);
    expect(res.body.problem).toBe('Write a query to find all Cat villagers.');
    expect(res.body.source).toBe('ollama');
  });
});
