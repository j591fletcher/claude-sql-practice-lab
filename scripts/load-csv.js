const fs = require('fs');
const path = require('path');
const readline = require('readline');
const sqlite3 = require('sqlite3').verbose();

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'animal_crossing.db');

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function sanitizeColumnName(name) {
  return name.trim().replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
}

async function loadCSV(db, filePath, tableName) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
    let headers = null;
    const rows = [];

    rl.on('line', (line) => {
      if (!line.trim()) return;
      const cols = parseCSVLine(line);
      if (!headers) {
        headers = cols.map(sanitizeColumnName);
      } else {
        rows.push(cols);
      }
    });

    rl.on('close', () => {
      if (!headers) return resolve();

      const colDefs = headers.map((h) => `"${h}" TEXT`).join(', ');
      db.serialize(() => {
        db.run(`DROP TABLE IF EXISTS "${tableName}"`);
        db.run(`CREATE TABLE "${tableName}" (${colDefs})`, (err) => {
          if (err) return reject(err);
        });

        const placeholders = headers.map(() => '?').join(', ');
        const stmt = db.prepare(`INSERT INTO "${tableName}" VALUES (${placeholders})`);
        for (const row of rows) {
          const values = headers.map((_, i) => (row[i] !== undefined ? row[i].trim() : null));
          stmt.run(values);
        }
        stmt.finalize((err) => {
          if (err) return reject(err);
          console.log(`  Loaded ${rows.length} rows into "${tableName}"`);
          resolve();
        });
      });
    });

    rl.on('error', reject);
  });
}

async function main() {
  const csvFiles = fs.readdirSync(DATA_DIR).filter((f) => path.extname(f).toLowerCase() === '.csv');

  if (csvFiles.length === 0) {
    console.log('No CSV files found in data/');
    return;
  }

  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const db = new sqlite3.Database(DB_PATH);

  console.log(`Creating ${DB_PATH}`);
  for (const file of csvFiles) {
    const tableName = path.basename(file, '.csv');
    console.log(`Loading ${file} → table "${tableName}"`);
    await loadCSV(db, path.join(DATA_DIR, file), tableName);
  }

  db.close(() => console.log('\nDone! Database ready at data/animal_crossing.db'));
}

main().catch((err) => { console.error(err); process.exit(1); });
