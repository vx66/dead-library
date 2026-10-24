const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const http = require('node:http');

const root = path.resolve(__dirname, '..');
const tempRoot = path.join(os.tmpdir(), 'opencode');
fs.mkdirSync(tempRoot, { recursive: true });
const username = 'test-admin';
const password = 'test-password-2026-safe';

function rawFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...options.headers };
    const body = options.body ? String(options.body) : null;
    if (options.body instanceof URLSearchParams) headers['content-type'] = 'application/x-www-form-urlencoded';
    const request = http.request(url, { method: options.method || 'GET', headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const resultHeaders = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) resultHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: resultHeaders }));
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function seedAdmin(directory) {
  const filename = path.join(directory, 'library.db');
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.existsSync(filename) ? fs.readFileSync(filename) : undefined);
  db.run('CREATE TABLE IF NOT EXISTS admin_users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL)');
  if (!db.exec('SELECT id FROM admin_users LIMIT 1').length) {
    db.run('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)', [username, await bcrypt.hash(password, 12)]);
    fs.writeFileSync(filename, Buffer.from(db.export()));
  }
  db.close();
}

async function start(directory, options = {}) {
  if (options.seed !== false) await seedAdmin(directory);
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const env = { ...process.env, NODE_ENV: 'test', PORT: String(port), DATA_DIR: directory, PUBLIC_ORIGIN: '', TRUST_PROXY: '',
    ADMIN_USERNAME: username, ADMIN_PASSWORD: password, ...options.env };
  delete env.SESSION_SECRET;
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(output);
    try { if ((await rawFetch(base + '/api/categories', { headers: options.probeHeaders || {} })).ok) return { child, base }; }
    catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error('El servidor no inició: ' + output);
}

async function stop(server) {
  if (server.child.exitCode !== null) return;
  const closed = once(server.child, 'close');
  if (server.child.connected) server.child.send('shutdown');
  else server.child.kill();
  const timeout = setTimeout(() => server.child.kill(), 6000);
  timeout.unref();
  await closed;
  clearTimeout(timeout);
}

async function csrf(base, cookie, headers = {}) {
  const response = await rawFetch(base + '/admin/csrf', { headers: { ...headers, ...(cookie ? { cookie } : {}) } });
  if (!response.ok) throw new Error('CSRF request failed: ' + response.status);
  return {
    ...headers,
    cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie,
    'x-csrf-token': (await response.json()).csrfToken
  };
}

async function login(base, headers = {}) {
  const before = await csrf(base, null, headers);
  const response = await rawFetch(base + '/admin/login', {
    method: 'POST', redirect: 'manual', headers: before,
    body: new URLSearchParams({ username, password })
  });
  if (response.status !== 302) throw new Error('Login failed: ' + response.status + ' ' + await response.text());
  return csrf(base, response.headers.get('set-cookie').split(';')[0], headers);
}

async function readDatabase(directory, sql) {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(path.join(directory, 'library.db')));
  const statement = db.prepare(sql);
  const rows = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  db.close();
  return rows;
}

module.exports = { root, tempRoot, start, stop, csrf, login, readDatabase, username, password, rawFetch };
