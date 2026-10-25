const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const initSqlJs = require('sql.js');

const DEFAULT_CATEGORIES = ['epub', 'pdf', 'parches', 'txt', 'scripts', 'video', 'audio', 'software'];

async function openDatabase(filename) {
  const SQL = await initSqlJs();
  let database = new SQL.Database(fs.existsSync(filename) ? fs.readFileSync(filename) : undefined);
  database.run('PRAGMA foreign_keys = ON');

  function all(sql, params = []) {
    const statement = database.prepare(sql);
    try {
      statement.bind(params);
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally { statement.free(); }
  }
  const get = (sql, params = []) => all(sql, params)[0] || null;
  const run = (sql, params = []) => database.run(sql, params);
  const snapshot = () => {
    const bytes = database.export();
    database.run('PRAGMA foreign_keys = ON');
    return bytes;
  };
  function save() {
    const temporary = filename + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(temporary, Buffer.from(snapshot()), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, filename);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  function transaction(action) {
    const before = snapshot();
    run('BEGIN');
    try {
      const result = action();
      run('COMMIT');
      save();
      return result;
    } catch (error) {
      database.close();
      database = new SQL.Database(before);
      run('PRAGMA foreign_keys = ON');
      throw error;
    }
  }

  const columns = all('PRAGMA table_info(files)');
  const legacy = columns.length > 0 && !columns.some(column => column.name === 'work_id');
  const needsTokens = columns.length > 0 && !columns.some(column => column.name === 'download_token');
  const visitColumns = all('PRAGMA table_info(visits)');
  const needsTraffic = visitColumns.length > 0 && !visitColumns.some(column => column.name === 'classification');
  if (legacy || needsTokens || needsTraffic) fs.copyFileSync(filename, `${filename}.migration-${Date.now()}.bak`);
  if (legacy) run('ALTER TABLE files RENAME TO legacy_files');

  run(`CREATE TABLE IF NOT EXISTS works (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, author TEXT NOT NULL, year INTEGER,
    category TEXT, description TEXT, cover_filename TEXT, uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP, uploader_ip TEXT
  )`);
  run(`CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT, work_id INTEGER NOT NULL, filename TEXT NOT NULL,
    original_name TEXT NOT NULL, format TEXT NOT NULL, size INTEGER NOT NULL, download_token TEXT NOT NULL UNIQUE,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
  )`);
  run(`CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, country TEXT, city TEXT, region TEXT,
    lat REAL, lon REAL, isp TEXT, visited_at DATETIME DEFAULT CURRENT_TIMESTAMP, page TEXT DEFAULT '/'
  )`);
  const trafficColumns = {
    request_id: 'TEXT', country_code: 'TEXT', classification: "TEXT NOT NULL DEFAULT 'unknown'",
    classification_reason: "TEXT NOT NULL DEFAULT 'Registro anterior: sin cabeceras suficientes para clasificar'",
    user_agent: "TEXT NOT NULL DEFAULT ''", method: 'TEXT', status_code: 'INTEGER',
    duration_ms: 'INTEGER', response_bytes: 'INTEGER', is_page_view: 'INTEGER NOT NULL DEFAULT 0',
    js_confirmed: 'INTEGER NOT NULL DEFAULT 0', request_type: "TEXT NOT NULL DEFAULT 'page'",
    referrer: "TEXT NOT NULL DEFAULT ''", fetch_mode: "TEXT NOT NULL DEFAULT ''", fetch_dest: "TEXT NOT NULL DEFAULT ''",
    accept_header: "TEXT NOT NULL DEFAULT ''", source: "TEXT NOT NULL DEFAULT 'legacy'",
    geo_status: "TEXT NOT NULL DEFAULT 'legacy'", aborted: 'INTEGER NOT NULL DEFAULT 0'
  };
  const currentVisitColumns = new Set(all('PRAGMA table_info(visits)').map(column => column.name));
  for (const [name, definition] of Object.entries(trafficColumns)) {
    if (!currentVisitColumns.has(name)) run(`ALTER TABLE visits ADD COLUMN ${name} ${definition}`);
  }
  if (needsTraffic) run("UPDATE visits SET is_page_view = 1 WHERE page = '/'");
  run('CREATE TABLE IF NOT EXISTS admin_users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL)');
  run('CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL)');
  run('CREATE TABLE IF NOT EXISTS sessions (sid_hash TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL)');
  run('CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)');
  run('CREATE INDEX IF NOT EXISTS visits_date ON visits(visited_at)');
  run('CREATE UNIQUE INDEX IF NOT EXISTS visits_request ON visits(request_id)');
  run('CREATE INDEX IF NOT EXISTS visits_class_date ON visits(classification, visited_at)');
  run('CREATE INDEX IF NOT EXISTS visits_ip_date ON visits(ip, visited_at)');
  run('CREATE INDEX IF NOT EXISTS files_work ON files(work_id)');

  if (legacy) {
    transaction(() => {
      for (const file of all('SELECT * FROM legacy_files')) {
        run('INSERT INTO works (title, author, year, category, description, cover_filename, uploaded_at, uploader_ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [file.title, file.author, file.year, file.category || null, file.description || '', file.cover_filename, file.uploaded_at, file.uploader_ip]);
        const id = get('SELECT last_insert_rowid() AS id').id;
        run('INSERT INTO files (id, work_id, filename, original_name, format, size, uploaded_at, download_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [file.id, id, file.filename, file.original_name, file.format, file.size, file.uploaded_at, randomBytes(32).toString('hex')]);
      }
      run('DROP TABLE legacy_files');
    });
  }
  if (!all('PRAGMA table_info(files)').some(column => column.name === 'download_token')) {
    transaction(() => {
      run('ALTER TABLE files ADD COLUMN download_token TEXT');
      for (const file of all('SELECT id FROM files')) run('UPDATE files SET download_token = ? WHERE id = ?', [randomBytes(32).toString('hex'), file.id]);
    });
  }
  run('CREATE UNIQUE INDEX IF NOT EXISTS files_download_token_unique ON files(download_token)');
  if (!get('SELECT id FROM categories LIMIT 1')) {
    for (const name of DEFAULT_CATEGORIES) run('INSERT INTO categories (name) VALUES (?)', [name]);
  }
  run('DELETE FROM sessions WHERE expires_at <= ?', [Date.now()]);
  save();
  return { all, get, run, save, transaction, close: () => database.close() };
}

module.exports = { openDatabase };
