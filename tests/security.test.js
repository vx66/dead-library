const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { root, tempRoot, start, stop, csrf, login, readDatabase, username, password, rawFetch } = require('./helpers');

function secureTest(name, action) {
  test(name, async () => {
    const directory = fs.mkdtempSync(path.join(tempRoot, 'library-security-'));
    let server;
    try { server = await start(directory); await action(server, directory); }
    finally {
      if (server) await stop(server);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

function payload() {
  const body = new FormData();
  body.set('title', '<img src=x onerror=alert(1)>');
  body.set('author', 'Autor');
  body.set('category', 'pdf');
  body.set('description', '<script>alert(1)</script>');
  body.append('files', new Blob(['<script>alert(1)</script>']), 'document.html');
  return body;
}

secureTest('Cabeceras, CSP sin scripts inline, recursos locales y datos privados inaccesibles', async ({ base }) => {
  const response = await fetch(base + '/');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy'), /script-src 'self';/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await fetch(base + '/fonts/ibm-plex-mono-400.woff2')).status, 200);
  for (const url of ['/.env', '/db/library.db', '/db/.session-secret', '/lib/security.js', '/public/views/admin.html', '/views/admin.html', '/uploads/test.txt']) {
    const blocked = await fetch(base + url);
    assert.equal(blocked.status, 404, url);
    assert.doesNotMatch(await blocked.text(), /password_hash|node_modules|[A-Z]:\\Users/);
  }
  assert.equal((await rawFetch(base + '/', { headers: { host: 'untrusted.example' } })).status, 400);
});

secureTest('Autorización, CSRF, cambio de sesión al acceder y cierre solo mediante POST', async ({ base }, directory) => {
  for (const url of ['/admin/works', '/admin/categories']) {
    const response = await fetch(base + url, { redirect: 'manual' });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await fetch(base + '/admin/upload', { method: 'POST', body: payload() })).status, 401);
  assert.deepEqual(fs.readdirSync(path.join(directory, 'uploads')), []);
  assert.equal((await fetch(base + '/api/ip-info')).status, 404);
  const anonymous = await csrf(base);
  const requestLogin = headers => fetch(base + '/admin/login', {
    method: 'POST', redirect: 'manual', headers, body: new URLSearchParams({ username, password })
  });
  assert.equal((await requestLogin({ cookie: anonymous.cookie })).status, 403);
  assert.equal((await requestLogin({ ...anonymous, origin: 'https://evil.example' })).status, 403);
  assert.equal((await requestLogin({ ...anonymous, 'sec-fetch-site': 'cross-site' })).status, 403);
  const accepted = await requestLogin(anonymous);
  assert.equal(accepted.status, 302);
  const cookieHeader = accepted.headers.get('set-cookie');
  assert.match(cookieHeader, /HttpOnly/i);
  assert.match(cookieHeader, /SameSite=Strict/i);
  const cookie = cookieHeader.split(';')[0];
  assert.notEqual(cookie, anonymous.cookie);
  const headers = await csrf(base, cookie);
  assert.equal((await fetch(base + '/admin/works', { headers: anonymous })).status, 401);
  assert.equal((await fetch(base + '/admin/categories', { method: 'POST', headers: { cookie }, body: new URLSearchParams({ name: 'denied' }) })).status, 403);
  assert.equal((await fetch(base + '/admin/categories', { method: 'POST', headers: { ...headers, 'x-csrf-token': 'a'.repeat(64) }, body: new URLSearchParams({ name: 'denied' }) })).status, 403);
  assert.equal((await fetch(base + '/admin/categories', { method: 'POST', headers: { ...headers, origin: 'null' }, body: new URLSearchParams({ name: 'denied' }) })).status, 403);
  assert.equal((await fetch(base + '/admin/logout', { headers })).status, 404);
  assert.equal((await fetch(base + '/admin/works', { headers })).status, 200);
  const sessions = await readDatabase(directory, 'SELECT sid_hash FROM sessions');
  assert.ok(sessions.every(row => /^[a-f0-9]{64}$/.test(row.sid_hash)));
  assert.equal((await fetch(base + '/admin/logout', { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(base + '/admin/works', { headers })).status, 401);
});

secureTest('Los intentos fallidos de acceso quedan limitados incluso con X-Forwarded-For falsificado', async ({ base }) => {
  const headers = await csrf(base);
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(base + '/admin/login', {
      method: 'POST', headers: { ...headers, 'x-forwarded-for': `8.8.8.${attempt}` },
      body: new URLSearchParams({ username, password: 'wrong-password' })
    });
    assert.equal(response.status, attempt < 5 ? 401 : 429);
  }
});

secureTest('Una segunda instancia no puede sobrescribir la base del servidor activo', async ({ base }, directory) => {
  await assert.rejects(start(directory), /base está en uso/i);
  assert.equal((await fetch(base + '/admin/works', { headers: await login(base) })).status, 200);
});

secureTest('Portadas falsas rechazadas; HTML descargable aislado; errores sin rutas internas', async ({ base }, directory) => {
  const headers = await login(base);
  for (const name of ['fake.png', 'fake.jpg', 'vector.svg']) {
    const body = payload();
    body.append('cover', new Blob(['<html><script>alert(1)</script></html>'], { type: 'image/png' }), name);
    const response = await fetch(base + '/admin/upload', { method: 'POST', headers, body });
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /[A-Z]:\\|node_modules|SQLITE/);
    assert.deepEqual(fs.readdirSync(path.join(directory, 'uploads')), []);
    assert.deepEqual(fs.readdirSync(path.join(directory, 'covers')), []);
  }
  const response = await fetch(base + '/admin/upload', { method: 'POST', headers, body: payload() });
  assert.equal(response.status, 200);
  const works = await (await fetch(base + '/api/works')).json();
  assert.equal(works[0].title, '<img src=x onerror=alert(1)>');
  assert.equal(works[0].files[0].filename, undefined);
  const file = await fetch(base + works[0].files[0].download_url);
  assert.equal(file.headers.get('content-type'), 'application/octet-stream');
  assert.match(file.headers.get('content-disposition'), /attachment/);
  assert.match(file.headers.get('content-security-policy'), /sandbox/);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await file.text(), '<script>alert(1)</script>');
});

secureTest('Validación de parámetros y consultas; borrar categorías conserva las obras', async ({ base }) => {
  const headers = await login(base);
  for (const query of ['?order[sql]=desc', '?order=asc&order=desc', '?category[a]=pdf', '?order=__proto__']) {
    assert.equal((await fetch(base + '/api/works' + query)).status, 400);
  }
  assert.equal((await fetch(base + '/api/works/-1')).status, 404);
  const injected = await fetch(base + '/api/works?category=' + encodeURIComponent("' OR 1=1 --"));
  assert.deepEqual(await injected.json(), []);
  const badYear = payload();
  badYear.set('year', '<img>');
  assert.equal((await fetch(base + '/admin/upload', { method: 'POST', headers, body: badYear })).status, 400);
  const badTitle = payload();
  badTitle.append('title', 'duplicado');
  assert.equal((await fetch(base + '/admin/upload', { method: 'POST', headers, body: badTitle })).status, 400);
  assert.equal((await fetch(base + '/admin/categories', { method: 'POST', headers, body: new URLSearchParams({ name: '   ' }) })).status, 400);
  assert.equal((await fetch(base + '/admin/categories', { method: 'POST', headers, body: new URLSearchParams({ name: 'PDF' }) })).status, 409);
  assert.equal((await fetch(base + '/admin/upload', { method: 'POST', headers, body: payload() })).status, 200);
  const categories = await (await fetch(base + '/admin/categories', { headers })).json();
  const category = categories.find(row => row.name === 'pdf');
  assert.equal((await fetch(`${base}/admin/categories/${category.id}`, { method: 'DELETE', headers })).status, 200);
  const works = await (await fetch(base + '/api/works')).json();
  assert.equal(works.length, 1);
  assert.equal(works[0].category, null);
  assert.equal((await fetch(base + works[0].files[0].download_url)).status, 200);
});

test('Producción: cookie Secure y HSTS bajo HTTPS con proxy de confianza explícito', async () => {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'library-https-'));
  let server;
  const forwarded = { host: 'library.example', 'x-forwarded-proto': 'https', origin: 'https://library.example' };
  try {
    server = await start(directory, {
      env: { NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://library.example', TRUST_PROXY: 'loopback' },
      probeHeaders: forwarded
    });
    const response = await rawFetch(server.base + '/admin/csrf', { headers: forwarded });
    assert.match(response.headers.get('set-cookie'), /; Secure/i);
    assert.match(response.headers.get('strict-transport-security'), /max-age=31536000/);
    assert.equal((await rawFetch(server.base + '/admin/works', { headers: await login(server.base, forwarded) })).status, 200);
    assert.equal((await rawFetch(server.base + '/', { headers: { ...forwarded, host: 'evil.example' } })).status, 400);
  } finally {
    if (server) await stop(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Las credenciales de entorno se sincronizan con hash e invalidan sesiones al cambiar', async () => {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'library-admin-cli-'));
  let server;
  try {
    server = await start(directory);
    const oldHeaders = await login(server.base);
    await stop(server);
    const credentials = { username: 'updated-admin', password: 'new-private-password-2026' };
    const child = spawn(process.execPath, ['scripts/admin-sync.js'], {
      cwd: root, env: { ...process.env, DATA_DIR: directory, NODE_ENV: 'test', PUBLIC_ORIGIN: '',
        ADMIN_USERNAME: credentials.username, ADMIN_PASSWORD: credentials.password }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, output);
    assert.ok(!output.includes(credentials.password));
    const users = await readDatabase(directory, 'SELECT * FROM admin_users');
    assert.equal(users.length, 1);
    assert.match(users[0].password_hash, /^\$2[aby]\$12\$/);
    assert.equal((await readDatabase(directory, 'SELECT COUNT(*) AS count FROM sessions'))[0].count, 0);
    server = await start(directory, { seed: false, env: { ADMIN_USERNAME: credentials.username, ADMIN_PASSWORD: credentials.password } });
    assert.equal((await fetch(server.base + '/admin/works', { headers: oldHeaders })).status, 401);
    const headers = await csrf(server.base);
    const response = await fetch(server.base + '/admin/login', { method: 'POST', redirect: 'manual', headers, body: new URLSearchParams(credentials) });
    assert.equal(response.status, 302);
  } finally {
    if (server) await stop(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('No se utiliza ninguna cuenta predeterminada cuando faltan credenciales de entorno', async () => {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'library-required-env-'));
  try {
    await assert.rejects(start(directory, { env: { ADMIN_USERNAME: '', ADMIN_PASSWORD: '' } }), /ADMIN_USERNAME/);
    await assert.rejects(start(directory, { env: { ADMIN_PASSWORD: 'short' } }), /ADMIN_PASSWORD/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
