const session = require('express-session');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { HttpError } = require('./errors');

const SESSION_AGE = 8 * 60 * 60 * 1000;
const ABSOLUTE_SESSION_AGE = 24 * 60 * 60 * 1000;
const sidHash = sid => createHash('sha256').update(sid).digest('hex');

class DatabaseSessionStore extends session.Store {
  constructor(database) {
    super();
    this.database = database;
  }
  get(sid, callback) {
    try {
      const row = this.database.get('SELECT data, expires_at FROM sessions WHERE sid_hash = ?', [sidHash(sid)]);
      callback(null, row && row.expires_at > Date.now() ? JSON.parse(row.data) : null);
    } catch (error) { callback(error); }
  }
  set(sid, data, callback = () => {}) {
    try {
      const expires = data.cookie.expires ? new Date(data.cookie.expires).getTime() : Date.now() + SESSION_AGE;
      this.database.transaction(() => {
        this.database.run('DELETE FROM sessions WHERE expires_at <= ?', [Date.now()]);
        this.database.run('INSERT OR REPLACE INTO sessions (sid_hash, data, expires_at) VALUES (?, ?, ?)', [sidHash(sid), JSON.stringify(data), expires]);
      });
      callback();
    } catch (error) { callback(error); }
  }
  destroy(sid, callback = () => {}) {
    try {
      this.database.transaction(() => this.database.run('DELETE FROM sessions WHERE sid_hash = ?', [sidHash(sid)]));
      callback();
    } catch (error) { callback(error); }
  }
  touch(sid, data, callback = () => {}) {
    const row = this.database.get('SELECT expires_at FROM sessions WHERE sid_hash = ?', [sidHash(sid)]);
    const expires = new Date(data.cookie.expires).getTime();
    if (row && expires - row.expires_at > 5 * 60 * 1000) return this.set(sid, data, callback);
    callback();
  }
}

function installSecurity(app, config, database) {
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustedProxy);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
        baseUri: ["'none'"], formAction: ["'self'"],
        upgradeInsecureRequests: config.production ? [] : null
      }
    },
    strictTransportSecurity: config.production ? { maxAge: 31536000, includeSubDomains: true } : false,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' }
  }));
  app.use((req, res, next) => {
    const host = req.get('host') || '';
    if (config.origin) {
      if (host.toLowerCase() !== new URL(config.origin).host.toLowerCase()) return next(new HttpError(400, 'Host no válido'));
    } else if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) {
      return next(new HttpError(400, 'Configura PUBLIC_ORIGIN para utilizar este dominio'));
    }
    next();
  });
  const options = { path: '/', httpOnly: true, sameSite: 'strict', secure: config.production, maxAge: SESSION_AGE };
  app.use('/admin', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  }, session({
    name: 'dsl.sid', secret: config.secret, store: new DatabaseSessionStore(database),
    resave: false, saveUninitialized: false, rolling: true, cookie: options
  }));

  const limiter = (limit, windowMs) => rateLimit({
    windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Demasiadas solicitudes. Inténtalo más tarde.' }
  });
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 5, skipSuccessfulRequests: true,
    standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Demasiados intentos de acceso. Inténtalo en 15 minutos.' }
  });
  app.use('/api', limiter(150, 60 * 1000));
  app.use('/admin/csrf', limiter(60, 60 * 1000));

  function requireAdmin(req, res, next) {
    if (!req.session || !req.session.admin || !req.session.authAt || Date.now() - req.session.authAt > ABSOLUTE_SESSION_AGE) {
      return next(new HttpError(401, 'Inicia sesión para continuar'));
    }
    next();
  }
  const csrfToken = req => {
    if (!req.session.csrfToken) req.session.csrfToken = randomBytes(32).toString('hex');
    return req.session.csrfToken;
  };
  function csrf(req, res, next) {
    const origin = req.get('origin');
    const expectedOrigin = config.origin || `${req.protocol}://${req.get('host')}`;
    if (req.get('sec-fetch-site') === 'cross-site' || (origin && origin !== expectedOrigin)) {
      return next(new HttpError(403, 'Origen de solicitud no permitido'));
    }
    const token = req.get('x-csrf-token');
    const expected = req.session && req.session.csrfToken;
    if (!expected || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      return next(new HttpError(403, 'La sesión de seguridad ha caducado. Recarga la página.'));
    }
    next();
  }
  return { requireAdmin, csrfToken, csrf, loginLimiter, cookieOptions: options, writeLimiter: limiter(90, 60 * 1000) };
}

module.exports = { installSecurity };
