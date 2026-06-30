const { resultSetsEqual, rowsPrefixEqual, expectsOrder, normScalar } = require('../server');

// Rows arrive from node-sqlite3 as objects keyed by output column name. The
// comparator grades positionally (by value order), so differing aliases between
// the reference solution and the user's query must still compare equal.

// ── resultSetsEqual: accepts (unordered) ─────────────────────────────────────

describe('resultSetsEqual — accepts equivalent results', () => {
  test('ignores column names/aliases (positional match)', () => {
    const expected = [{ total: 5 }];
    const actual = [{ count: 5 }];
    expect(resultSetsEqual(expected, actual, false)).toBe(true);
  });

  test('tolerates float noise within rounding precision', () => {
    const expected = [{ avg: 3.3333333 }];
    const actual = [{ avg: 3.3333 }];
    expect(resultSetsEqual(expected, actual, false)).toBe(true);
  });

  test('coerces numeric strings to match numbers', () => {
    const expected = [{ id: 1 }];
    const actual = [{ id: '1' }];
    expect(resultSetsEqual(expected, actual, false)).toBe(true);
  });

  test('trims surrounding whitespace', () => {
    const expected = [{ name: 'Bob' }];
    const actual = [{ name: ' Bob ' }];
    expect(resultSetsEqual(expected, actual, false)).toBe(true);
  });

  test('treats NULLs as equal', () => {
    const expected = [{ x: null }];
    const actual = [{ x: null }];
    expect(resultSetsEqual(expected, actual, false)).toBe(true);
  });

  test('ignores row order when unordered', () => {
    const expected = [{ name: 'Bob' }, { name: 'Fauna' }];
    const actual = [{ name: 'Fauna' }, { name: 'Bob' }];
    expect(resultSetsEqual(expected, actual, false)).toBe(true);
  });

  test('preserves duplicate-row multiplicity', () => {
    const expected = [{ n: 1 }, { n: 1 }, { n: 2 }];
    const actual = [{ n: 2 }, { n: 1 }, { n: 1 }];
    expect(resultSetsEqual(expected, actual, false)).toBe(true);
  });
});

// ── resultSetsEqual: rejects ─────────────────────────────────────────────────

describe('resultSetsEqual — rejects wrong results', () => {
  test('different values', () => {
    expect(resultSetsEqual([{ x: 1 }], [{ x: 2 }], false)).toBe(false);
  });

  test('swapped column order (positional mismatch)', () => {
    const expected = [{ name: 'Bob', price: 400 }];
    const actual = [{ price: 400, name: 'Bob' }];
    expect(resultSetsEqual(expected, actual, false)).toBe(false);
  });

  test('extra column', () => {
    const expected = [{ name: 'Bob' }];
    const actual = [{ name: 'Bob', species: 'Cat' }];
    expect(resultSetsEqual(expected, actual, false)).toBe(false);
  });

  test('different row count', () => {
    expect(resultSetsEqual([{ x: 1 }], [{ x: 1 }, { x: 1 }], false)).toBe(false);
  });

  test('case difference (case-sensitive)', () => {
    expect(resultSetsEqual([{ name: 'Bob' }], [{ name: 'bob' }], false)).toBe(false);
  });

  test('wrong row order when ordered is required', () => {
    const expected = [{ name: 'Bob' }, { name: 'Fauna' }];
    const actual = [{ name: 'Fauna' }, { name: 'Bob' }];
    expect(resultSetsEqual(expected, actual, true)).toBe(false);
  });

  test('correct row order when ordered is required', () => {
    const expected = [{ name: 'Bob' }, { name: 'Fauna' }];
    const actual = [{ x: 'Bob' }, { x: 'Fauna' }];
    expect(resultSetsEqual(expected, actual, true)).toBe(true);
  });
});

// ── expectsOrder ─────────────────────────────────────────────────────────────

describe('expectsOrder', () => {
  test('true for a trailing top-level ORDER BY', () => {
    expect(expectsOrder('SELECT name FROM fish ORDER BY price DESC')).toBe(true);
  });

  test('true for ORDER BY ... LIMIT', () => {
    expect(expectsOrder('SELECT name FROM fish ORDER BY price DESC LIMIT 3')).toBe(true);
  });

  test('false for no ORDER BY', () => {
    expect(expectsOrder('SELECT name FROM fish WHERE price > 100')).toBe(false);
  });

  test('false for ORDER BY only inside a window function', () => {
    expect(expectsOrder('SELECT name, ROW_NUMBER() OVER (ORDER BY price) AS rn FROM fish')).toBe(false);
  });

  test('false for ORDER BY only inside a subquery', () => {
    expect(expectsOrder('SELECT * FROM (SELECT name FROM fish ORDER BY price LIMIT 5)')).toBe(false);
  });

  test('does not trip on ORDER BY inside a string literal', () => {
    expect(expectsOrder("SELECT 'order by' AS note FROM fish")).toBe(false);
  });
});

// ── rowsPrefixEqual (top-N, LIMIT omitted) ───────────────────────────────────

describe('rowsPrefixEqual', () => {
  test('accepts when expected rows are the ordered prefix of actual', () => {
    const expected = [{ name: 'Salmon' }, { name: 'Bass' }];
    const actual = [{ x: 'Salmon' }, { x: 'Bass' }, { x: 'Carp' }];
    expect(rowsPrefixEqual(expected, actual)).toBe(true);
  });

  test('rejects when the prefix differs', () => {
    const expected = [{ name: 'Salmon' }, { name: 'Bass' }];
    const actual = [{ x: 'Bass' }, { x: 'Salmon' }, { x: 'Carp' }];
    expect(rowsPrefixEqual(expected, actual)).toBe(false);
  });

  test('rejects when actual has fewer rows than expected', () => {
    expect(rowsPrefixEqual([{ n: 1 }, { n: 2 }], [{ n: 1 }])).toBe(false);
  });
});

// ── normScalar ───────────────────────────────────────────────────────────────

describe('normScalar', () => {
  test('rounds floats to FLOAT_DECIMALS', () => {
    expect(normScalar(3.3333333)).toBe(normScalar('3.3333'));
  });

  test('coerces numeric strings', () => {
    expect(normScalar('3.50')).toBe(3.5);
  });

  test('trims strings but preserves case', () => {
    expect(normScalar('  Bob ')).toBe('Bob');
    expect(normScalar('bob')).not.toBe(normScalar('Bob'));
  });

  test('passes null through', () => {
    expect(normScalar(null)).toBeNull();
    expect(normScalar(undefined)).toBeNull();
  });
});
