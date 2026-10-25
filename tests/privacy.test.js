const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const { spawnSync } = require('node:child_process');
const { openDatabase } = require('../lib/database');
const { root, tempRoot, start, stop, login, readDatabase, username, password } = require('./helpers');

test('No hay panel, endpoints, recibos ni código de analítica; la tipografía es local', async () => {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'library-no-analytics-'));
  let server;
  try {
    server = await start(directory);
    const response = await fetch(server.base + '/', { headers: { 'user-agent': 'private-agent-marker', 'x-forwarded-for': '198.51.100.242' } });
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /traffic-receipt|TRAFFIC_RECEIPT|sendBeacon/);
    assert.doesNotMatch(response.headers.get('content-security-policy'), /googleapis|gstatic/);
    for (const font of ['400', '700']) {
      const fontResponse = await fetch(`${server.base}/fonts/ibm-plex-mono-${font}.woff2`);
      assert.equal(fontResponse.status, 200);
      assert.equal(Buffer.from(await fontResponse.arrayBuffer()).subarray(0, 4).toString(), 'wOF2');
    }
    assert.equal((await fetch(server.base + '/fonts/OFL.txt')).status, 200);
    assert.equal((await fetch(server.base + '/fonts/package.json')).status, 404);
    const headers = await login(server.base);
    for (const url of ['/admin/stats', '/admin/ip-info', '/api/ip-info', '/vendor/chart.umd.js']) {
      assert.equal((await fetch(server.base + url, { headers })).status, 404, url);
    }
    assert.equal((await fetch(server.base + '/api/traffic/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
    const admin = await (await fetch(server.base + '/admin', { headers })).text();
    assert.doesNotMatch(admin, /data-section="stats"|chart\.umd|tráfico y visitas/);
    for (const filename of ['public/js/main.js', 'public/js/admin.js', 'server.js']) {
      assert.doesNotMatch(fs.readFileSync(path.join(root, filename), 'utf8'), /sendBeacon|traffic-receipt|ipwho\.is|createVisits|renderTrafficCharts/);
    }
    const css = await (await fetch(server.base + '/css/style.css')).text();
    assert.doesNotMatch(css, /fonts\.googleapis|fonts\.gstatic|traffic-table|ip-table/);
    const tables = await readDatabase(directory, "SELECT name FROM sqlite_master WHERE type = 'table'");
    assert.ok(!tables.some(table => table.name === 'visits'));
    const columns = await readDatabase(directory, 'PRAGMA table_info(works)');
    assert.ok(!columns.some(column => column.name === 'uploader_ip'));
    const active = fs.readFileSync(path.join(directory, 'library.db'));
    assert.ok(!active.includes(Buffer.from('198.51.100.242')));
    assert.ok(!active.includes(Buffer.from('private-agent-marker')));
  } finally {
    if (server) await stop(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('La migración limpia tráfico e IPs de la base activa y conserva biblioteca, tokens y cuenta', async () => {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'library-privacy-migration-'));
  let server;
  try {
    fs.mkdirSync(path.join(directory, 'uploads'));
    const SQL = await initSqlJs();
    const old = new SQL.Database();
    old.run(`CREATE TABLE works (id INTEGER PRIMARY KEY, title TEXT, author TEXT, year INTEGER, category TEXT,
      description TEXT, cover_filename TEXT, uploaded_at TEXT, uploader_ip TEXT)`);
    old.run(`CREATE TABLE files (id INTEGER PRIMARY KEY, work_id INTEGER, filename TEXT, original_name TEXT,
      format TEXT, size INTEGER, download_token TEXT, uploaded_at TEXT)`);
    old.run(`CREATE TABLE visits (id INTEGER PRIMARY KEY, ip TEXT, country TEXT, city TEXT, region TEXT,
      isp TEXT, user_agent TEXT, classification TEXT, request_id TEXT)`);
    old.run('CREATE INDEX visits_ip_date ON visits(ip)');
    old.run('CREATE TABLE admin_users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT)');
    old.run("INSERT INTO works VALUES (7, 'Obra conservada', 'Autora', 2026, 'txt', 'Descripción conservada', NULL, '2026-01-01', '198.51.100.253')");
    old.run('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [19, 7, 'existing.txt', 'original.txt', 'txt', 17, 'd'.repeat(64), '2026-01-01']);
    old.run("INSERT INTO visits VALUES (1, '198.51.100.252', 'PAIS-MARCADOR-ANTIGUO', 'Ciudad privada', 'Región privada', 'ISP-MARCADOR-PRIVADO', 'AGENTE-MARCADOR-PRIVADO', 'browser', 'old-receipt')");
    const hash = await bcrypt.hash(password, 12);
    old.run('INSERT INTO admin_users VALUES (?, ?, ?)', [5, username, hash]);
    const filename = path.join(directory, 'library.db');
    fs.writeFileSync(filename, Buffer.from(old.export()));
    old.close();
    // Existing backups belong to the operator; this migration must not overwrite them.
    const historicalBackup = filename + '.migration-prior.bak';
    fs.copyFileSync(filename, historicalBackup);
    const oldBackupBytes = fs.readFileSync(historicalBackup);
    fs.writeFileSync(path.join(directory, 'uploads/existing.txt'), 'Archivo existente');
    server = await start(directory, { seed: false });
    const headers = await login(server.base);
    const work = await (await fetch(server.base + '/api/works/7')).json();
    assert.equal(work.title, 'Obra conservada');
    assert.equal(work.description, 'Descripción conservada');
    assert.equal(work.files[0].download_url, '/download/' + 'd'.repeat(64));
    assert.equal(await (await fetch(server.base + work.files[0].download_url)).text(), 'Archivo existente');
    assert.equal((await readDatabase(directory, 'SELECT * FROM admin_users'))[0].password_hash, hash);
    assert.equal((await readDatabase(directory, "SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'visits%'"))[0].count, 0);
    assert.ok(!(await readDatabase(directory, 'PRAGMA table_info(works)')).some(column => column.name === 'uploader_ip'));
    const cleaned = fs.readFileSync(filename);
    for (const marker of ['198.51.100.252', '198.51.100.253', 'PAIS-MARCADOR-ANTIGUO', 'ISP-MARCADOR-PRIVADO', 'AGENTE-MARCADOR-PRIVADO']) {
      assert.ok(!cleaned.includes(Buffer.from(marker)), marker);
    }
    assert.deepEqual(fs.readFileSync(historicalBackup), oldBackupBytes);
    await stop(server);
    server = await start(directory, { seed: false });
    assert.equal((await fetch(server.base + '/admin/works', { headers })).status, 200);
    assert.equal((await (await fetch(server.base + '/api/works/7')).json()).files[0].download_url, work.files[0].download_url);
    assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.bak')).length, 1);
  } finally {
    if (server) await stop(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('La migración de archivos antiguos no copia datos personales en nuevos respaldos', async () => {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'library-private-legacy-'));
  let server;
  try {
    fs.mkdirSync(path.join(directory, 'uploads'));
    const SQL = await initSqlJs();
    const old = new SQL.Database();
    old.run(`CREATE TABLE files (id INTEGER PRIMARY KEY, title TEXT, author TEXT, year INTEGER, category TEXT,
      format TEXT, size INTEGER, filename TEXT, original_name TEXT, cover_filename TEXT, uploaded_at TEXT, uploader_ip TEXT)`);
    old.run("INSERT INTO files VALUES (2, 'Obra antigua', 'Autora', 2005, 'txt', 'txt', 4, 'legacy.txt', 'legacy.txt', NULL, '2026-01-01', '198.51.100.251')");
    old.run('CREATE TABLE visits (id INTEGER PRIMARY KEY, ip TEXT)');
    old.run("INSERT INTO visits VALUES (1, '198.51.100.250')");
    fs.writeFileSync(path.join(directory, 'library.db'), Buffer.from(old.export()));
    old.close();
    fs.writeFileSync(path.join(directory, 'uploads/legacy.txt'), 'safe');
    server = await start(directory);
    const work = (await (await fetch(server.base + '/api/works')).json())[0];
    assert.equal(work.title, 'Obra antigua');
    assert.equal(await (await fetch(server.base + work.files[0].download_url)).text(), 'safe');
    const backup = fs.readdirSync(directory).find(name => name.endsWith('.bak'));
    assert.ok(backup);
    const bytes = fs.readFileSync(path.join(directory, backup));
    assert.ok(!bytes.includes(Buffer.from('198.51.100.251')));
    assert.ok(!bytes.includes(Buffer.from('198.51.100.250')));
  } finally {
    if (server) await stop(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('La auditoría de privacidad es de solo lectura y no muestra registros personales', async () => {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'library-audit-readonly-'));
  try {
    const SQL = await initSqlJs();
    const old = new SQL.Database();
    old.run('CREATE TABLE visits (id INTEGER PRIMARY KEY, ip TEXT, user_agent TEXT)');
    old.run('INSERT INTO visits VALUES (?, ?, ?)', [1, '198.51.100.249', 'PRIVATE-AUDIT-RECORD-MARKER']);
    const filename = path.join(directory, 'library.db');
    const before = Buffer.from(old.export());
    old.close();
    fs.writeFileSync(filename, before);
    const backup = filename + '.previous.bak';
    fs.writeFileSync(backup, before);
    const audit = spawnSync(process.execPath, ['scripts/audit-privacy.js', '--data-dir', directory], { cwd: root, encoding: 'utf8' });
    assert.equal(audit.status, 2, audit.stderr);
    const result = JSON.parse(audit.stdout);
    assert.equal(result.readOnly, true);
    assert.deepEqual(result.knownRuntimeFindings, []);
    assert.equal(result.database.migrationRequired, true);
    assert.equal(result.database.tables[0].rows, 1);
    assert.equal(result.previousDatabaseBackupCount, 1);
    assert.doesNotMatch(audit.stdout, /198\.51\.100\.249|PRIVATE-AUDIT-RECORD-MARKER/);
    assert.deepEqual(fs.readFileSync(filename), before);
    assert.deepEqual(fs.readFileSync(backup), before);
    assert.equal(fs.readdirSync(directory).length, 2);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('La auditoría reconoce una base actual sin analítica y no genera datos al inspeccionar', async () => {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'library-audit-current-'));
  try {
    const filename = path.join(directory, 'library.db');
    const database = await openDatabase(filename);
    database.close();
    const before = fs.readFileSync(filename);
    const audit = spawnSync(process.execPath, ['scripts/audit-privacy.js', '--data-dir', directory], { cwd: root, encoding: 'utf8' });
    assert.equal(audit.status, 0, audit.stderr);
    const result = JSON.parse(audit.stdout);
    assert.equal(result.database.present, true);
    assert.equal(result.database.migrationRequired, false);
    assert.deepEqual(result.database.legacyFields, []);
    assert.deepEqual(fs.readFileSync(filename), before);
    assert.equal(fs.readdirSync(directory).length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
