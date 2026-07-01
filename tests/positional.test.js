const sqlite3 = require('sqlite3').verbose();
const { queryRowsPositional, resultSetsEqual } = require('../server');

// Regression: a correct JOIN answer was rejected unless the user added AS
// aliases, because two output columns sharing a name (villagers.name /
// fish.name) collapsed to one key in node-sqlite3's row objects. The positional
// read must preserve every column so aliasing no longer changes the outcome.

function makeDb() {
  const db = new sqlite3.Database(':memory:');
  return new Promise((resolve) => {
    db.serialize(() => {
      db.run('CREATE TABLE villagers (id INTEGER, name TEXT)');
      db.run('CREATE TABLE fish (id INTEGER, name TEXT)');
      db.run("INSERT INTO villagers VALUES (1,'Bob'),(2,'Ann')");
      db.run("INSERT INTO fish VALUES (1,'Bass'),(2,'Carp')", () => resolve(db));
    });
  });
}

const JOIN_NO_ALIAS = 'SELECT villagers.name, fish.name FROM villagers JOIN fish ON villagers.id = fish.id ORDER BY villagers.id';
const JOIN_ALIASED  = 'SELECT villagers.name AS v, fish.name AS f FROM villagers JOIN fish ON villagers.id = fish.id ORDER BY villagers.id';

describe('queryRowsPositional — duplicate output column names', () => {
  let db;
  beforeAll(async () => { db = await makeDb(); });
  afterAll(() => db.close());

  test('preserves both columns despite the shared name', async () => {
    const rows = await queryRowsPositional(db, JOIN_NO_ALIAS);
    expect(rows.map((r) => Object.values(r))).toEqual([['Bob', 'Bass'], ['Ann', 'Carp']]);
  });

  test('un-aliased answer matches aliased expected (the reported bug)', async () => {
    const expected = await queryRowsPositional(db, JOIN_ALIASED);
    const actual = await queryRowsPositional(db, JOIN_NO_ALIAS);
    expect(resultSetsEqual(expected, actual, true)).toBe(true);
  });

  test('a genuinely wrong answer is still rejected', async () => {
    const expected = await queryRowsPositional(db, JOIN_NO_ALIAS);
    const wrong = await queryRowsPositional(db, "SELECT villagers.name, 'Wrong' FROM villagers ORDER BY id");
    expect(resultSetsEqual(expected, wrong, true)).toBe(false);
  });

  test('trailing semicolon is tolerated', async () => {
    const rows = await queryRowsPositional(db, JOIN_NO_ALIAS + ';');
    expect(rows).toHaveLength(2);
  });
});
