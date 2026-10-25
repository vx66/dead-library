const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const initSqlJs = require('sql.js');
const { openDatabase } = require('../lib/database');
const { createVisits } = require('../lib/visits');
const { classify, loggedPath } = require('../lib/traffic-classifier');
const { countryCode } = require('../lib/countries');
const { tempRoot, start, stop, login, rawFetch } = require('./helpers');

const browser = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const browserHeaders = { 'user-agent': browser, accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
const secret = 'traffic-tests-only-not-a-production-secret';

function request(overrides = {}) {
  const headers = { host: 'localhost', ...browserHeaders, ...overrides.headers };
  return {
    ip: '127.0.0.1', method: 'GET', originalUrl: '/', protocol: 'http', ...overrides,
    get: name => headers[name.toLowerCase()]
  };
}
function response(status = 200, bytes = '42') {
  const res = new EventEmitter();
  res.statusCode = status;
  res.writableFinished = true;
  res.getHeader = name => name === 'content-length' ? bytes : undefined;
  return res;
}
function capture(traffic, req, res = response()) {
  traffic.middleware(req, res, () => {});
  res.emit('finish');
  res.emit('close');
  return res;
}
async function fixture(action, options = {}) {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'library-traffic-'));
  const database = await openDatabase(path.join(directory, 'library.db'));
  const traffic = createVisits(database, { secret, ...options });
  try { await action(traffic, database, directory); }
  finally { await traffic.close(); database.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}

test('Clasificación conservadora: navegadores, bots declarados, herramientas y actividad sospechosa', () => {
  const event = { path: '/', method: 'GET', status: 200, userAgent: browser, accept: 'text/html' };
  assert.equal(classify(event).category, 'browser');
  assert.equal(classify({ ...event, accept: '' }).category, 'unknown');
  assert.equal(classify({ ...event, userAgent: '' }).category, 'unknown');
  assert.equal(classify({ ...event, userAgent: 'curl/8.0' }).category, 'automated');
  assert.equal(classify({ ...event, userAgent: browser.replace('Chrome/', 'HeadlessChrome/'), jsConfirmed: true }).category, 'automated');
  assert.equal(classify({ ...event, userAgent: browser + ' Googlebot/2.1', jsConfirmed: true }).category, 'bot');
  assert.match(classify({ ...event, userAgent: 'Googlebot/2.1' }).reason, /no verificada/);
  assert.equal(classify({ ...event, userAgent: 'nuclei' }).category, 'suspicious');
  for (const path of ['/.env', '/.git/config', '/wp-login.php', '/cgi-bin/test', '/%2e%2e/etc/passwd']) {
    assert.equal(classify({ ...event, path }).category, 'suspicious', path);
  }
  assert.equal(classify({ ...event, path: '/enlace-roto', status: 404 }).category, 'browser');
  assert.equal(classify(event, { requests: 120 }).category, 'suspicious');
  assert.equal(classify(event, { failedLogins: 5 }).category, 'suspicious');
  assert.equal(classify(event, { notFound: 15 }).category, 'suspicious');
  assert.equal(classify({ ...event, status: 429 }).category, 'suspicious');
  assert.equal(classify({ ...event, userAgent: 'unknown', isp: 'Amazon AWS' }).category, 'unknown');
});

test('Países históricos resueltos a ISO y rutas sensibles anonimizadas sin query', () => {
  assert.equal(countryCode(null, 'United States'), 'US');
  assert.equal(countryCode(null, 'Estados Unidos'), 'US');
  assert.equal(countryCode(null, 'United Kingdom'), 'GB');
  assert.equal(countryCode('cl', 'Chile'), 'CL');
  assert.equal(countryCode('??', 'Desconocido'), null);
  assert.equal(loggedPath('/download/secret-token?password=do-not-store'), '/download/[token]');
  assert.equal(loggedPath('/admin/works/123?csrf=do-not-store'), '/admin/works/[id]');
});

test('Una respuesta se registra una vez y las interrupciones no se cuentan como página completa', async () => {
  await fixture(traffic => {
    capture(traffic, request());
    const aborted = response();
    aborted.writableFinished = false;
    traffic.middleware(request(), aborted, () => {});
    aborted.emit('close');
    const stats = traffic.stats({ type: 'page' });
    assert.equal(stats.counts.requests, 2);
    assert.equal(stats.counts.pageViews, 1);
    assert.equal(stats.counts.browserPageViews, 1);
    assert.equal(stats.recent[0].status_code, 499);
    assert.equal(stats.recent[0].response_bytes, null);
    assert.equal(stats.recent[0].aborted, 1);
  });
});

test('Señal JavaScript firmada, no reutilizable desde otra IP/UA/origen ni tras caducar', async () => {
  let clock = Date.now();
  await fixture(traffic => {
    const req = request();
    capture(traffic, req);
    const receipt = traffic.receiptMeta(req).match(/content="([^"]+)"/)[1];
    const confirmation = request({ method: 'POST', originalUrl: '/api/traffic/confirm', body: { receipt } });
    assert.throws(() => traffic.confirm({ ...confirmation, body: { receipt: receipt.slice(0, -1) + (receipt.endsWith('a') ? 'b' : 'a') } }), /no válida/);
    assert.throws(() => traffic.confirm({ ...confirmation, ip: '127.0.0.2' }), /no válida/);
    assert.throws(() => traffic.confirm(request({ method: 'POST', body: { receipt }, headers: { 'user-agent': 'curl/8.0' } })), /no válida/);
    assert.throws(() => traffic.confirm(request({ method: 'POST', body: { receipt }, headers: { origin: 'https://evil.example' } })), /Origen/);
    traffic.confirm(confirmation);
    traffic.confirm(confirmation);
    const stats = traffic.stats({ type: 'page' });
    assert.equal(stats.counts.requests, 1);
    assert.equal(stats.counts.jsPageViews, 1);
    assert.equal(stats.recent[0].classification, 'browser');
    assert.match(stats.recent[0].classification_reason, /JavaScript/);
    assert.equal(stats.recent[0].request_id, undefined);
    traffic.confirm(confirmation);
    clock += 300001;
    assert.throws(() => traffic.confirm(confirmation), /no válida/);
  }, { now: () => clock });
});

test('Filtros, paginación y exclusión de healthchecks/consultas propias', async () => {
  await fixture(traffic => {
    for (const url of ['/healthz', '/admin/csrf', '/api/traffic/confirm']) capture(traffic, request({ originalUrl: url }));
    capture(traffic, request({ originalUrl: '/admin/stats', session: { admin: true } }));
    for (let index = 0; index < 60; index++) capture(traffic, request({ headers: { 'user-agent': 'curl/8.0' } }));
    const first = traffic.stats({ category: 'automated', type: 'page', days: '1' });
    assert.equal(first.total, 60);
    assert.equal(first.pages, 2);
    assert.equal(first.recent.length, 50);
    assert.equal(traffic.stats({ category: 'automated', page: '2' }).recent.length, 10);
    assert.equal(traffic.stats({ category: 'browser' }).total, 0);
    assert.equal(traffic.stats({ ip: '127.0.0.2' }).total, 0);
    for (const query of [{ category: ['browser'] }, { days: '999' }, { page: '-1' }, { type: 'invalid' }, { ip: 'anything' }]) {
      assert.throws(() => traffic.stats(query), /Filtro/);
    }
  });
});

test('La geolocalización se consulta una vez por IP y conserva código de país, región e ISP', async () => {
  let calls = 0;
  await fixture(async traffic => {
    capture(traffic, request({ ip: '8.8.8.8' }));
    capture(traffic, request({ ip: '8.8.8.8', originalUrl: '/api/works' }));
    await traffic.lookup('8.8.8.8');
    const stats = traffic.stats();
    assert.equal(calls, 1);
    assert.equal(stats.recent[0].country_code, 'US');
    assert.equal(stats.recent[0].city, 'Columbus');
    assert.equal(stats.recent[0].isp, 'Example provider');
    assert.equal(stats.byCountry[0].country_code, 'US');
    assert.equal(stats.byCountry[0].c, 2);
  }, { fetch: async () => {
    calls++;
    return { ok: true, json: async () => ({ success: true, country: 'United States', country_code: 'US', city: 'Columbus', region: 'Ohio', latitude: 1, longitude: 2, connection: { isp: 'Example provider' } }) };
  } });
});

test('Los registros históricos se migran sin inventar User-Agent, respuesta o clasificación', async () => {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'library-old-visits-'));
  let database;
  let traffic;
  try {
    const SQL = await initSqlJs();
    const old = new SQL.Database();
    old.run(`CREATE TABLE visits (id INTEGER PRIMARY KEY, ip TEXT, country TEXT, city TEXT, region TEXT, lat REAL, lon REAL, isp TEXT, visited_at TEXT, page TEXT)`);
    old.run("INSERT INTO visits VALUES (1, '8.8.8.8', 'United States', 'Columbus', 'Ohio', 1, 2, 'Amazon.com, Inc.', datetime('now'), '/')");
    const filename = path.join(directory, 'library.db');
    fs.writeFileSync(filename, Buffer.from(old.export()));
    old.close();
    database = await openDatabase(filename);
    traffic = createVisits(database, { secret });
    const stats = traffic.stats();
    assert.equal(stats.total, 1);
    assert.equal(stats.counts.legacyRows, 1);
    assert.equal(stats.counts.browserPageViews, 0);
    assert.equal(stats.recent[0].classification, 'unknown');
    assert.equal(stats.recent[0].user_agent, '');
    assert.equal(stats.recent[0].status_code, null);
    assert.equal(stats.recent[0].country_code, 'US');
    assert.equal(stats.recent[0].isp, 'Amazon.com, Inc.');
    assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.bak')).length, 1);
  } finally {
    if (traffic) await traffic.close();
    if (database) database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('La cola está acotada y los descartes por saturación se hacen visibles', async () => {
  await fixture(traffic => {
    for (let index = 0; index < 1005; index++) capture(traffic, request());
    const stats = traffic.stats();
    assert.equal(stats.total, 1000);
    assert.equal(stats.droppedEvents, 5);
  });
});

test('HTTP real: navegador con JS, bot, herramienta y escaneo; privacidad y tabla protegida', async () => {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'library-traffic-http-'));
  let server;
  try {
    server = await start(directory);
    assert.equal((await rawFetch(server.base + '/admin/stats')).status, 401);
    const page = await rawFetch(server.base + '/', { headers: browserHeaders });
    const html = await page.text();
    const receipt = html.match(/name="traffic-receipt" content="([^"]+)"/)[1];
    const confirm = await rawFetch(server.base + '/api/traffic/confirm', {
      method: 'POST', headers: { ...browserHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ receipt })
    });
    assert.equal(confirm.status, 204);
    await rawFetch(server.base + '/', { headers: { 'user-agent': 'Googlebot/2.1' } });
    await rawFetch(server.base + '/', { headers: { 'user-agent': 'curl/8.0' } });
    await rawFetch(server.base + '/.env?secret=never-log-this', { headers: { 'user-agent': 'nuclei' } });
    const headers = await login(server.base);
    let stats = await (await rawFetch(server.base + '/admin/stats?type=page', { headers })).json();
    assert.equal(stats.counts.pageViews, 3);
    assert.equal(stats.counts.browserPageViews, 1);
    assert.equal(stats.counts.jsPageViews, 1);
    assert.equal(stats.byCategory.find(row => row.category === 'bot').c, 1);
    assert.equal(stats.byCategory.find(row => row.category === 'automated').c, 1);
    stats = await (await rawFetch(server.base + '/admin/stats?category=suspicious', { headers })).json();
    assert.ok(stats.recent.some(row => row.page === '/.env' && row.status_code === 404));
    assert.doesNotMatch(JSON.stringify(stats), /never-log-this|traffic-receipt|password_hash/);
    assert.equal((await rawFetch(server.base + '/admin/stats?category=invalid', { headers })).status, 400);
    const upload = new FormData();
    upload.set('title', 'Descarga de prueba');
    upload.set('author', 'Autora');
    upload.append('files', new Blob(['safe']), 'sample.txt');
    const created = await fetch(server.base + '/admin/upload', { method: 'POST', headers, body: upload });
    assert.equal(created.status, 200);
    const { workId } = await created.json();
    const work = await (await fetch(`${server.base}/api/works/${workId}`)).json();
    const url = work.files[0].download_url;
    const token = url.split('/').pop();
    await rawFetch(server.base + url + '?secret=never-log-this', { headers: { 'user-agent': 'curl/8.0', referer: `https://user:do-not-log@ref.example${url}?private=never-log-this` } });
    await rawFetch(server.base + url, { method: 'HEAD', headers: { 'user-agent': 'curl/8.0' } });
    const downloads = await (await rawFetch(server.base + '/admin/stats?type=download', { headers })).json();
    assert.equal(downloads.total, 2);
    assert.equal(downloads.counts.downloadRequests, 1);
    const download = downloads.recent.find(row => row.method === 'GET');
    assert.equal(download.page, '/download/[token]');
    assert.equal(download.referrer, 'https://ref.example/download/[token]');
    assert.equal(download.response_bytes, 4);
    assert.equal(downloads.recent.find(row => row.method === 'HEAD').response_bytes, 0);
    assert.ok(!JSON.stringify(downloads).includes(token));
    assert.doesNotMatch(JSON.stringify(downloads), /never-log-this|do-not-log/);
  } finally {
    if (server) await stop(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
