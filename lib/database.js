const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const initSqlJs = require('sql.js');

const DEFAULT_CATEGORIES = ['epub', 'pdf', 'parches', 'txt', 'scripts', 'video', 'audio', 'software'];

async function openDatabase(filename) {
  const SQL = await initSqlJs();
  let database = new SQL.Database(fs.existsSync(filename) ? fs.readFileSync(filename) : undefined);
  database.run('PRAGMA foreign_keys = ON');
  database.run('PRAGMA secure_delete = ON');

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
    database.run('PRAGMA secure_delete = ON');
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
      run('PRAGMA secure_delete = ON');
      throw error;
    }
  }

  // Remove analytics before any schema backup is created. Never copy visitor data
  // into a new migration backup as part of this privacy update.
  let removedAnalytics = false;
  if (get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'visits'")) {
    run('DROP TABLE visits');
    removedAnalytics = true;
  }
  for (const table of ['works', 'files', 'legacy_files']) {
    if (all(`PRAGMA table_info(${table})`).some(column => column.name === 'uploader_ip')) {
      run(`ALTER TABLE ${table} DROP COLUMN uploader_ip`);
      removedAnalytics = true;
    }
  }
  if (removedAnalytics) {
    run('VACUUM');
    save();
  }

  const columns = all('PRAGMA table_info(files)');
  const legacy = columns.length > 0 && !columns.some(column => column.name === 'work_id');
  const needsTokens = columns.length > 0 && !columns.some(column => column.name === 'download_token');
  if (legacy || needsTokens) fs.copyFileSync(filename, `${filename}.migration-${Date.now()}.bak`);
  if (legacy) run('ALTER TABLE files RENAME TO legacy_files');

  run(`CREATE TABLE IF NOT EXISTS works (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, author TEXT NOT NULL, year INTEGER,
    category TEXT, description TEXT, cover_filename TEXT, uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  run(`CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT, work_id INTEGER NOT NULL, filename TEXT NOT NULL,
    original_name TEXT NOT NULL, format TEXT NOT NULL, size INTEGER NOT NULL, download_token TEXT NOT NULL UNIQUE,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
  )`);
  run('CREATE TABLE IF NOT EXISTS admin_users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL)');
  run('CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL)');
  run('CREATE TABLE IF NOT EXISTS sessions (sid_hash TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL)');
  run('CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)');
  run('CREATE INDEX IF NOT EXISTS files_work ON files(work_id)');

  if (legacy) {
    transaction(() => {
      for (const file of all('SELECT * FROM legacy_files')) {
        run('INSERT INTO works (title, author, year, category, description, cover_filename, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [file.title, file.author, file.year, file.category || null, file.description || '', file.cover_filename, file.uploaded_at]);
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
