const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');

const root = path.resolve(__dirname, '..');
const runtimeFiles = ['server.js', ...fs.readdirSync(path.join(root, 'lib')).filter(name => name.endsWith('.js')).map(name => `lib/${name}`),
  ...fs.readdirSync(path.join(root, 'public/js')).filter(name => name.endsWith('.js')).map(name => `public/js/${name}`),
  ...fs.readdirSync(path.join(root, 'public/views')).filter(name => name.endsWith('.html')).map(name => `public/views/${name}`), 'public/css/style.css'];

(async () => {
  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
  const argument = process.argv.indexOf('--data-dir');
  if (argument !== -1 && (!process.argv[argument + 1] || process.argv[argument + 1].startsWith('--'))) throw new Error('MISSING_DATA_DIRECTORY');
  const directory = path.resolve(argument === -1 ? process.env.DATA_DIR || path.join(root, 'db') : process.argv[argument + 1]);
  const findings = [];
  const patterns = [
    ['analytics-write', /(?:INSERT\s+INTO|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+visits\b/i],
    ['analytics-beacon', /sendBeacon\s*\(|traffic-receipt|\/api\/traffic\/confirm/],
    ['external-tracker-or-geolocation', /google-analytics\.com|googletagmanager\.com|clarity\.ms|connect\.facebook\.net|ipwho\.is|ip-api\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/i]
  ];
  for (const filename of runtimeFiles) {
    const source = fs.readFileSync(path.join(root, filename), 'utf8');
    for (const [kind, pattern] of patterns) if (pattern.test(source)) findings.push({ file: filename, kind });
  }
  const report = {
    scope: 'local', readOnly: true, generatedAt: new Date().toISOString(),
    knownRuntimeFindings: findings,
    database: { present: false, migrationRequired: false, legacyFields: [], tables: [] },
    previousDatabaseBackupCount: 0,
    limitations: ['Pattern checks are not proof of absence of all tracking.', 'Backups and infrastructure logs are not inspected or modified.', 'This report is not a legal certification or a statement about past versions.']
  };
  const filename = path.join(directory, 'library.db');
  if (fs.existsSync(directory)) report.previousDatabaseBackupCount = fs.readdirSync(directory).filter(name => name.startsWith('library.db.') && name.endsWith('.bak')).length;
  if (fs.existsSync(filename)) {
    const SQL = await initSqlJs();
    const database = new SQL.Database(fs.readFileSync(filename));
    database.run('PRAGMA query_only = ON');
    const all = sql => {
      const statement = database.prepare(sql);
      const rows = [];
      try { while (statement.step()) rows.push(statement.getAsObject()); }
      finally { statement.free(); }
      return rows;
    };
    try {
      report.database.present = true;
      for (const { name } of all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
        // Names are quoted as identifiers; no record values are returned.
        const identifier = '"' + name.replace(/"/g, '""') + '"';
        const count = all(`SELECT COUNT(*) AS count FROM ${identifier}`)[0].count;
        report.database.tables.push({ table: name, rows: count });
        for (const column of all(`PRAGMA table_info(${identifier})`)) {
          if (['ip', 'uploader_ip', 'user_agent', 'isp', 'country', 'city', 'region', 'referrer'].includes(column.name)) {
            report.database.legacyFields.push({ table: name, field: column.name });
          }
        }
        if (name === 'visits') report.database.migrationRequired = true;
      }
      if (report.database.legacyFields.length) report.database.migrationRequired = true;
    } finally { database.close(); }
  }
  console.log(JSON.stringify(report, null, 2));
  if (findings.length) process.exitCode = 1;
  else if (report.database.migrationRequired) process.exitCode = 2;
})().catch(error => {
  console.error('No se pudo completar la auditoría local de solo lectura:', error.code || error.name);
  process.exitCode = 1;
});
