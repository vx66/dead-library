const { isIP } = require('node:net');
const { randomBytes, createHmac, timingSafeEqual } = require('node:crypto');
const { HttpError } = require('./errors');
const { countryCode } = require('./countries');
const { CATEGORIES, classify, decodedPath, loggedPath, requestType } = require('./traffic-classifier');

const unknown = (status = 'unavailable') => ({ country: 'Desconocido', country_code: null, city: 'Desconocido', region: 'Desconocido', lat: null, lon: null, isp: 'Desconocido', geo_status: status });
const clean = (value, maximum = 150) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, maximum) : '';
const sqlDate = timestamp => new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ');
const TYPES = ['page', 'download', 'api', 'asset', 'admin', 'other'];

function publicAddress(address) {
  if (!isIP(address)) return false;
  if (isIP(address) === 6) return !/^(::|fc|fd|fe[89ab])/i.test(address);
  const [a, b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
    (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127));
}

function createVisits(database, { secret, origin = null, fetch: fetchGeo = global.fetch, now = Date.now } = {}) {
  if (!secret) throw new Error('El registro de tráfico requiere un secreto de firma');
  const receiptKey = createHmac('sha256', secret).update('traffic-receipts-v1').digest();
  const queue = new Map();
  const enrichments = new Map();
  const activity = new Map();
  const cache = new Map();
  const inFlight = new Map();
  let droppedEvents = 0;
  let closing = false;
  const ip = req => (req.ip || '').replace(/^::ffff:/i, '');
  const userAgent = req => clean(req.get('user-agent'), 512);
  const boundedSet = (map, key, value, limit) => {
    if (map.size >= limit && !map.has(key)) map.delete(map.keys().next().value);
    map.set(key, value);
  };

  async function lookup(address) {
    if (!publicAddress(address)) return unknown();
    const saved = cache.get(address);
    if (saved && saved.expires > now()) return saved.data;
    if (inFlight.has(address)) return inFlight.get(address);
    if (inFlight.size >= 4 || closing) {
      const data = unknown();
      boundedSet(cache, address, { expires: now() + 60000, data }, 1000);
      boundedSet(enrichments, address, data, 1000);
      return data;
    }
    const task = (async () => {
      let result = unknown();
      try {
        const response = await fetchGeo(`https://ipwho.is/${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(3000) });
        if (response.ok) {
          const data = await response.json();
          if (data.success) result = {
            country: clean(data.country) || 'Desconocido', country_code: countryCode(data.country_code, data.country),
            city: clean(data.city) || 'Desconocido', region: clean(data.region) || 'Desconocido',
            lat: typeof data.latitude === 'number' ? data.latitude : null,
            lon: typeof data.longitude === 'number' ? data.longitude : null,
            isp: clean(data.connection && data.connection.isp) || 'Desconocido', geo_status: 'resolved'
          };
        }
      } catch (_) {}
      boundedSet(cache, address, { expires: now() + (result.geo_status === 'resolved' ? 86400000 : 60000), data: result }, 1000);
      boundedSet(enrichments, address, result, 1000);
      return result;
    })();
    inFlight.set(address, task);
    try { return await task; }
    finally { inFlight.delete(address); }
  }

  function flush() {
    if (!queue.size && !enrichments.size) return;
    const events = [...queue.values()];
    const updates = [...enrichments.entries()];
    database.transaction(() => {
      for (const event of events) {
        const saved = cache.get(event.ip);
        const geo = saved && saved.expires > now() ? saved.data : unknown(publicAddress(event.ip) ? 'pending' : 'unavailable');
        database.run(`INSERT INTO visits (request_id, ip, country, country_code, city, region, lat, lon, isp, visited_at, page,
          classification, classification_reason, user_agent, method, status_code, duration_ms, response_bytes,
          is_page_view, js_confirmed, request_type, referrer, fetch_mode, fetch_dest, accept_header, source, geo_status, aborted)
          VALUES (${Array(28).fill('?').join(',')})`,
        [event.id, event.ip, geo.country, geo.country_code, geo.city, geo.region, geo.lat, geo.lon, geo.isp, event.date, event.path,
          event.classification, event.reason, event.userAgent, event.method, event.status, event.duration, event.bytes,
          event.pageView ? 1 : 0, event.jsConfirmed ? 1 : 0, event.type, event.referrer, event.fetchMode, event.fetchDest,
          event.accept, 'http', geo.geo_status, event.aborted ? 1 : 0]);
      }
      for (const [address, geo] of updates) {
        database.run(`UPDATE visits SET country = ?, country_code = ?, city = ?, region = ?, lat = ?, lon = ?, isp = ?, geo_status = ?
          WHERE ip = ? AND source = 'http' AND geo_status IN ('pending', 'unavailable')`, [geo.country, geo.country_code, geo.city, geo.region, geo.lat, geo.lon, geo.isp, geo.geo_status, address]);
      }
      database.run("DELETE FROM visits WHERE visited_at < datetime('now', '-90 days') OR id <= (SELECT MAX(id) - 50000 FROM visits)");
    });
    for (const event of events) queue.delete(event.id);
    for (const [address] of updates) enrichments.delete(address);
  }

  function recentActivity(event) {
    let window = activity.get(event.ip);
    if (!window || now() - window.start >= 60000) window = { start: now(), requests: 0, failedLogins: 0, notFound: 0 };
    window.requests++;
    if (event.path === '/admin/login' && event.method === 'POST' && [401, 403, 429].includes(event.status)) window.failedLogins++;
    if (event.status === 404) window.notFound++;
    boundedSet(activity, event.ip, window, 5000);
    return window;
  }

  function middleware(req, res, next) {
    const rawPath = decodedPath(req.originalUrl);
    if (['/healthz', '/api/traffic/confirm', '/admin/csrf'].includes(rawPath)) return next();
    const address = ip(req);
    if (!isIP(address)) return next();
    const started = process.hrtime.bigint();
    const id = randomBytes(16).toString('hex');
    req.trafficId = id;
    let recorded = false;
    const record = aborted => {
      if (recorded || closing) return;
      recorded = true;
      if (rawPath.startsWith('/admin') && !['/admin/login', '/admin/logout'].includes(rawPath) && req.session?.admin && res.statusCode < 400) return;
      const length = Number(res.getHeader('content-length'));
      let referrer = '';
      try {
        const url = new URL(req.get('referer'));
        if (['https:', 'http:'].includes(url.protocol)) referrer = clean(url.origin + loggedPath(url.pathname), 300);
      } catch (_) {}
      const event = {
        id, ip: address, date: sqlDate(now()), path: loggedPath(rawPath), method: clean(req.method, 10),
        status: aborted ? 499 : res.statusCode, userAgent: userAgent(req),
        fetchMode: clean(req.get('sec-fetch-mode'), 30), fetchDest: clean(req.get('sec-fetch-dest'), 30),
        accept: clean(req.get('accept'), 200), referrer,
        duration: Math.max(0, Math.round(Number(process.hrtime.bigint() - started) / 1e6)),
        bytes: aborted ? null : ['HEAD'].includes(req.method) || [204, 304].includes(res.statusCode) ? 0 : Number.isSafeInteger(length) && length >= 0 ? length : null,
        pageView: req.method === 'GET' && rawPath === '/' && res.statusCode === 200 && !aborted,
        jsConfirmed: false, type: requestType(rawPath), aborted
      };
      const result = classify(event, recentActivity(event));
      event.classification = result.category;
      event.reason = result.reason;
      if (queue.size >= 1000) { droppedEvents++; return; }
      queue.set(id, event);
      lookup(address).catch(() => {});
    };
    res.once('finish', () => record(false));
    res.once('close', () => record(!res.writableFinished));
    next();
  }

  const signature = (id, expires, req) => createHmac('sha256', receiptKey)
    .update(`${id}.${expires}.${ip(req)}.${userAgent(req)}`).digest('hex');

  function receiptMeta(req) {
    if (!req.trafficId) return '';
    const expires = String(now() + 300000);
    return `<meta name="traffic-receipt" content="${req.trafficId}.${expires}.${signature(req.trafficId, expires, req)}">`;
  }

  function confirm(req) {
    const expectedOrigin = origin || `${req.protocol}://${req.get('host')}`;
    if (req.get('sec-fetch-site') === 'cross-site' || (req.get('origin') && req.get('origin') !== expectedOrigin)) throw new HttpError(403, 'Origen no permitido');
    const receipt = req.body && req.body.receipt;
    if (typeof receipt !== 'string' || !/^[a-f0-9]{32}\.\d{13}\.[a-f0-9]{64}$/.test(receipt)) throw new HttpError(403, 'Señal de visita no válida');
    const [id, expires, mac] = receipt.split('.');
    if (Number(expires) < now() || Number(expires) > now() + 300000 || !timingSafeEqual(Buffer.from(mac), Buffer.from(signature(id, expires, req)))) {
      throw new HttpError(403, 'Señal de visita no válida');
    }
    const event = queue.get(id);
    const row = event ? null : database.get("SELECT * FROM visits WHERE request_id = ? AND source = 'http'", [id]);
    if ((!event && !row) || (event && !event.pageView) || (row && !row.is_page_view)) throw new HttpError(403, 'Señal de visita no válida');
    if (event?.jsConfirmed || row?.js_confirmed) return;
    const snapshot = event || {
      path: row.page, method: row.method, status: row.status_code, userAgent: row.user_agent,
      fetchMode: row.fetch_mode, fetchDest: row.fetch_dest, accept: row.accept_header,
      classification: row.classification, reason: row.classification_reason
    };
    const result = snapshot.classification === 'suspicious' ? { category: snapshot.classification, reason: snapshot.reason } : classify({ ...snapshot, jsConfirmed: true });
    if (event) {
      event.jsConfirmed = true;
      event.classification = result.category;
      event.reason = result.reason;
    } else database.transaction(() => {
      database.run('UPDATE visits SET js_confirmed = 1, classification = ?, classification_reason = ? WHERE request_id = ?', [result.category, result.reason, id]);
    });
  }

  function stats(query = {}) {
    const daysText = query.days === undefined ? '7' : query.days;
    const category = query.category || '';
    const type = query.type || '';
    const address = query.ip || '';
    const pageText = query.page === undefined ? '1' : query.page;
    if (!['1', '7', '30', '90'].includes(daysText) || (category && !CATEGORIES.includes(category)) ||
      (type && !TYPES.includes(type)) || (address && (typeof address !== 'string' || !isIP(address))) ||
      typeof pageText !== 'string' || !/^[1-9]\d{0,3}$/.test(pageText)) throw new HttpError(400, 'Filtro de tráfico no válido');
    flush();
    const days = Number(daysText);
    const since = new Date(now());
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - days + 1);
    const clauses = ['visited_at >= ?'];
    const params = [sqlDate(since.getTime())];
    for (const [column, value] of [['classification', category], ['request_type', type], ['ip', address]]) {
      if (value) { clauses.push(`${column} = ?`); params.push(value); }
    }
    const where = ' WHERE ' + clauses.join(' AND ');
    const counts = database.get(`SELECT COUNT(*) AS requests, COUNT(DISTINCT ip) AS uniqueIps,
      COALESCE(SUM(is_page_view), 0) AS pageViews,
      COALESCE(SUM(CASE WHEN is_page_view = 1 AND classification = 'browser' THEN 1 ELSE 0 END), 0) AS browserPageViews,
      COALESCE(SUM(CASE WHEN is_page_view = 1 AND js_confirmed = 1 THEN 1 ELSE 0 END), 0) AS jsPageViews,
      COALESCE(SUM(CASE WHEN classification = 'suspicious' THEN 1 ELSE 0 END), 0) AS suspiciousRequests,
      COALESCE(SUM(CASE WHEN request_type = 'download' AND method = 'GET' AND status_code IN (200, 206) THEN 1 ELSE 0 END), 0) AS downloadRequests,
      COALESCE(SUM(response_bytes), 0) AS measuredBytes,
      COALESCE(SUM(CASE WHEN source = 'legacy' THEN 1 ELSE 0 END), 0) AS legacyRows
      FROM visits${where}`, params);
    const pages = Math.max(1, Math.ceil(counts.requests / 50));
    const page = Math.min(Number(pageText), pages);
    const rows = database.all(`SELECT id, ip, country, country_code, city, region, lat, lon, isp, visited_at, page,
      classification, classification_reason, user_agent, method, status_code, duration_ms, response_bytes,
      is_page_view, js_confirmed, request_type, referrer, source, geo_status, aborted FROM visits${where}
      ORDER BY visited_at DESC, id DESC LIMIT 50 OFFSET ?`, [...params, (page - 1) * 50]);
    const byCategory = CATEGORIES.map(name => ({ category: name, c: 0 }));
    for (const row of database.all(`SELECT classification, COUNT(*) AS c FROM visits${where} GROUP BY classification`, params)) {
      const bucket = byCategory.find(bucket => bucket.category === row.classification);
      if (bucket) bucket.c = row.c;
    }
    const countries = new Map();
    for (const row of database.all(`SELECT country, country_code, COUNT(*) AS c FROM visits${where} GROUP BY country, country_code`, params)) {
      const code = countryCode(row.country_code, row.country);
      const key = code || 'unknown';
      const bucket = countries.get(key) || { country_code: code, country: code ? row.country : 'Sin geolocalización', c: 0 };
      bucket.c += row.c;
      countries.set(key, bucket);
    }
    return {
      total: counts.requests, counts, days, since: sqlDate(since.getTime()), page, pages, pageSize: 50,
      filters: { category, type, ip: address }, droppedEvents,
      recent: rows.map(row => ({ ...row, country_code: countryCode(row.country_code, row.country) })),
      byCategory, byCountry: [...countries.values()].sort((a, b) => b.c - a.c).slice(0, 10),
      byDay: database.all(`SELECT DATE(visited_at) AS day, classification, COUNT(*) AS c FROM visits${where} GROUP BY DATE(visited_at), classification ORDER BY day`, params)
    };
  }

  const timer = setInterval(() => {
    try { flush(); } catch (_) { console.error('[Tráfico] No se pudo guardar el lote de solicitudes'); }
  }, 1000);
  timer.unref();
  async function close() {
    closing = true;
    clearInterval(timer);
    await Promise.allSettled([...inFlight.values()]);
    flush();
  }
  return { ip, lookup, middleware, receiptMeta, confirm, flush, stats, close };
}

module.exports = { createVisits, publicAddress };
