const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { loadConfig } = require('./lib/config');
const { openDatabase } = require('./lib/database');
const { installSecurity } = require('./lib/security');
const { createStorage, storedPath, safeRemove } = require('./lib/storage');
const { text, workData, validateId } = require('./lib/validation');
const { createVisits } = require('./lib/visits');
const { HttpError, asyncRoute } = require('./lib/errors');
const { acquireDataLock } = require('./lib/data-lock');
const { syncAdmin } = require('./lib/admin');

async function start() {
  const config = loadConfig();
  acquireDataLock(config.dataDirectory);
  const database = await openDatabase(config.databaseFile);
  if (await syncAdmin(database, config.admin)) console.log('[Admin] Credenciales de entorno sincronizadas');
  const storage = createStorage(config, database);
  const visits = createVisits(database, { secret: config.secret, origin: config.origin });
  const indexHtml = fs.readFileSync(path.join(config.root, 'public/views/index.html'), 'utf8');
  const app = express();
  app.use(visits.middleware);
  app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok' });
  });
  const security = installSecurity(app, config, database);
  const dummyHash = await bcrypt.hash(randomBytes(24).toString('hex'), 12);
  app.use(express.json({ limit: '128kb' }));
  app.use(express.urlencoded({ extended: false, limit: '128kb', parameterLimit: 20 }));
  app.param('id', validateId);

  function publicFile(file) {
    return {
      original_name: file.original_name, format: file.format, size: file.size,
      uploaded_at: file.uploaded_at, download_url: `/download/${file.download_token}`
    };
  }
  function workResult(work, admin = false) {
    return {
      id: work.id, title: work.title, author: work.author,
      year: work.year !== null && Number.isInteger(Number(work.year)) ? Number(work.year) : null,
      category: work.category, description: work.description,
      cover: work.cover_filename ? `/covers/${encodeURIComponent(work.cover_filename)}` : null,
      uploaded_at: work.uploaded_at,
      files: database.all('SELECT * FROM files WHERE work_id = ? ORDER BY id', [work.id]).map(file =>
        admin ? { ...publicFile(file), id: file.id } : publicFile(file))
    };
  }
  function addFiles(workId, files) {
    for (const file of files || []) {
      database.run('INSERT INTO files (work_id, filename, original_name, format, size, download_token) VALUES (?, ?, ?, ?, ?, ?)',
        [workId, file.filename, file.originalname, path.extname(file.originalname).slice(1).toLowerCase(), file.size, randomBytes(32).toString('hex')]);
    }
  }
  const findWork = id => {
    const work = database.get('SELECT * FROM works WHERE id = ?', [id]);
    if (!work) throw new HttpError(404, 'Obra no encontrada');
    return work;
  };

  // Public assets are explicitly allowlisted. Private data is never mounted as static content.
  app.use('/css', express.static(path.join(config.root, 'public/css'), { dotfiles: 'deny' }));
  app.use('/js', express.static(path.join(config.root, 'public/js'), { dotfiles: 'deny' }));
  app.get('/favicon.svg', (req, res) => res.sendFile(path.join(config.root, 'public/favicon.svg')));
  app.get('/vendor/chart.umd.js', (req, res) => res.sendFile(path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.js')));
  app.get('/covers/:filename', (req, res, next) => {
    try {
      const filename = req.params.filename;
      if (!/\.(jpe?g|png|gif|webp)$/i.test(filename) || !database.get('SELECT id FROM works WHERE cover_filename = ?', [filename])) {
        throw new HttpError(404, 'Portada no encontrada');
      }
      res.set('Content-Security-Policy', "default-src 'none'; sandbox");
      res.sendFile(storedPath(config.covers, filename), error => { if (error) next(error); });
    } catch (error) { next(error); }
  });
  app.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store').type('html').send(indexHtml.replace('<!-- TRAFFIC_RECEIPT -->', visits.receiptMeta(req)));
  });
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/works', (req, res) => {
    const order = req.query.order === undefined ? 'desc' : text(req.query.order, 'El orden', 10, true);
    const orders = { desc: 'uploaded_at DESC, id DESC', asc: 'uploaded_at ASC, id ASC', alpha: 'title COLLATE NOCASE ASC, id ASC' };
    if (!Object.hasOwn(orders, order)) throw new HttpError(400, 'Orden no válido');
    const category = text(req.query.category, 'La categoría', 80);
    const sql = `SELECT * FROM works ${category ? 'WHERE category = ?' : ''} ORDER BY ${orders[order]}`;
    res.json(database.all(sql, category ? [category] : []).map(work => workResult(work)));
  });
  app.get('/api/works/:id', (req, res) => res.json(workResult(findWork(req.params.id))));
  app.get('/api/categories', (req, res) => res.json(database.all('SELECT id, name FROM categories ORDER BY name')));
  app.post('/api/traffic/confirm', (req, res) => {
    visits.confirm(req);
    res.sendStatus(204);
  });
  app.get('/download/:token', (req, res, next) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.token)) throw new HttpError(404, 'Archivo no encontrado');
    const file = database.get('SELECT * FROM files WHERE download_token = ?', [req.params.token]);
    if (!file) throw new HttpError(404, 'Archivo no encontrado');
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'no-store' });
    res.download(storedPath(config.uploads, file.filename), file.original_name, error => { if (error) next(error); });
  });

  app.get('/admin/csrf', (req, res) => res.json({ csrfToken: security.csrfToken(req) }));
  app.get('/admin/login', (req, res) => res.sendFile(path.join(config.root, 'public/views/login.html')));
  app.post('/admin/login', security.loginLimiter, security.csrf, asyncRoute(async (req, res) => {
    const username = text(req.body.username, 'El usuario', 100, true);
    const password = req.body.password;
    if (typeof password !== 'string' || Buffer.byteLength(password) > 72 || !password) throw new HttpError(400, 'Credenciales no válidas');
    const user = database.get('SELECT * FROM admin_users WHERE username = ?', [username]);
    const valid = await bcrypt.compare(password, user ? user.password_hash : dummyHash);
    if (!user || !valid) throw new HttpError(401, 'Credenciales incorrectas');
    if (bcrypt.getRounds(user.password_hash) < 12) {
      const hash = await bcrypt.hash(password, 12);
      database.transaction(() => database.run('UPDATE admin_users SET password_hash = ? WHERE id = ?', [hash, user.id]));
    }
    await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.admin = true;
    req.session.userId = user.id;
    req.session.authAt = Date.now();
    security.csrfToken(req);
    await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    res.redirect('/admin');
  }));
  app.get('/admin', (req, res, next) => {
    if (!req.session || !req.session.admin) return res.redirect('/admin/login');
    security.requireAdmin(req, res, error => error ? next(error) : res.sendFile(path.join(config.root, 'public/views/admin.html')));
  });
  app.use('/admin', security.requireAdmin, (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    security.csrf(req, res, error => error ? next(error) : security.writeLimiter(req, res, next));
  });
  app.post('/admin/logout', asyncRoute(async (req, res) => {
    await new Promise((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve()));
    res.clearCookie('dsl.sid', { path: '/', httpOnly: true, sameSite: 'strict', secure: config.production });
    res.json({ success: true });
  }));
  app.get('/admin/works', (req, res) => res.json(database.all('SELECT * FROM works ORDER BY uploaded_at DESC, id DESC').map(work => workResult(work, true))));
  app.post('/admin/upload', storage.upload, asyncRoute(async (req, res) => {
    if (!req.files || !req.files.files || !req.files.files.length) throw new HttpError(400, 'Selecciona al menos un archivo');
    const data = workData(req.body, database);
    const cover = await storage.prepare(req);
    const workId = database.transaction(() => {
      database.run('INSERT INTO works (title, author, year, category, description, cover_filename, uploader_ip) VALUES (?, ?, ?, ?, ?, ?, ?)', [...data, cover, visits.ip(req)]);
      const id = database.get('SELECT last_insert_rowid() AS id').id;
      addFiles(id, req.files.files);
      return id;
    });
    req.uploadsCommitted = true;
    res.json({ success: true, workId, message: 'Obra subida correctamente' });
  }));
  app.put('/admin/works/:id', storage.upload, asyncRoute(async (req, res) => {
    const work = findWork(req.params.id);
    const data = workData(req.body, database);
    const cover = await storage.prepare(req) || work.cover_filename;
    database.transaction(() => {
      database.run('UPDATE works SET title = ?, author = ?, year = ?, category = ?, description = ?, cover_filename = ? WHERE id = ?', [...data, cover, work.id]);
      addFiles(work.id, req.files && req.files.files);
    });
    req.uploadsCommitted = true;
    if (work.cover_filename && work.cover_filename !== cover) safeRemove(storedPath(config.covers, work.cover_filename));
    res.json({ success: true, message: 'Obra actualizada correctamente' });
  }));
  app.delete('/admin/works/:id', (req, res) => {
    const work = findWork(req.params.id);
    const files = database.all('SELECT filename FROM files WHERE work_id = ?', [work.id]);
    database.transaction(() => {
      database.run('DELETE FROM files WHERE work_id = ?', [work.id]);
      database.run('DELETE FROM works WHERE id = ?', [work.id]);
    });
    for (const file of files) safeRemove(storedPath(config.uploads, file.filename));
    if (work.cover_filename) safeRemove(storedPath(config.covers, work.cover_filename));
    res.json({ success: true });
  });
  app.delete('/admin/files/:id', (req, res) => {
    const file = database.get('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) throw new HttpError(404, 'Archivo no encontrado');
    database.transaction(() => database.run('DELETE FROM files WHERE id = ?', [file.id]));
    safeRemove(storedPath(config.uploads, file.filename));
    res.json({ success: true });
  });
  app.get('/admin/categories', (req, res) => res.json(database.all('SELECT id, name FROM categories ORDER BY name')));
  app.post('/admin/categories', (req, res) => {
    const name = text(req.body.name, 'El nombre', 80, true);
    if (database.get('SELECT id FROM categories WHERE lower(name) = lower(?)', [name])) throw new HttpError(409, 'La categoría ya existe');
    database.transaction(() => database.run('INSERT INTO categories (name) VALUES (?)', [name]));
    res.json({ success: true });
  });
  app.delete('/admin/categories/:id', (req, res) => {
    const category = database.get('SELECT * FROM categories WHERE id = ?', [req.params.id]);
    if (!category) throw new HttpError(404, 'Categoría no encontrada');
    database.transaction(() => {
      database.run('UPDATE works SET category = NULL WHERE category = ?', [category.name]);
      database.run('DELETE FROM categories WHERE id = ?', [category.id]);
    });
    res.json({ success: true });
  });
  app.get('/admin/stats', (req, res) => res.json(visits.stats(req.query)));
  app.get('/admin/ip-info', asyncRoute(async (req, res) => {
    const ip = visits.ip(req);
    res.json({ ip, ...await visits.lookup(ip) });
  }));

  app.use((req, res, next) => next(new HttpError(404, 'Página no encontrada')));
  app.use((error, req, res, next) => {
    storage.cleanup(req);
    if (res.headersSent) return next(error);
    let status = error instanceof HttpError ? error.status : 500;
    let message = error instanceof HttpError ? error.message : 'No se pudo completar la solicitud';
    if (error.code && error.code.startsWith('LIMIT_')) {
      status = 400;
      message = error.code === 'LIMIT_FILE_SIZE' ? 'Cada archivo puede pesar como máximo 250 MB' : 'La subida supera los límites permitidos';
    } else if (error.type === 'entity.too.large') {
      status = 413; message = 'La solicitud es demasiado grande';
    } else if (error instanceof SyntaxError && error.type === 'entity.parse.failed') {
      status = 400; message = 'El cuerpo de la solicitud no es válido';
    } else if (error.status === 404 || error.code === 'ENOENT') {
      status = 404; message = 'Archivo no encontrado';
    }
    if (status === 500) console.error('[Servidor] Error interno:', error.name);
    res.status(status).json({ error: message });
  });

  const server = app.listen(config.port, () => {
    console.log(`DEAD SMILE LIBRARY: puerto ${server.address().port}`);
  });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `El puerto ${config.port} ya está en uso.` : 'No se pudo iniciar el servidor');
    process.exitCode = 1;
  });
  const shutdown = () => {
    server.close(async () => {
      try { await visits.close(); database.close(); process.exit(0); }
      catch (_) { process.exit(1); }
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutdown);
  if (process.env.NODE_ENV === 'test' && process.connected) process.on('message', message => {
    if (message === 'shutdown') shutdown();
  });
}

start().catch(error => {
  console.error('[Inicio]', error.message);
  process.exitCode = 1;
});
