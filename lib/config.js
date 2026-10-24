const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { adminCredentials } = require('./admin');

function loadConfig() {
  const root = path.resolve(__dirname, '..');
  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
  const admin = adminCredentials();
  const production = process.env.NODE_ENV === 'production';
  const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(root, 'db'));
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT no es válido');

  let origin = null;
  if (process.env.PUBLIC_ORIGIN) {
    const url = new URL(process.env.PUBLIC_ORIGIN);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('PUBLIC_ORIGIN debe contener únicamente el origen del sitio');
    }
    origin = url.origin;
  }
  if (production && (!origin || !origin.startsWith('https://'))) throw new Error('En producción configura PUBLIC_ORIGIN con HTTPS');

  let secret = process.env.SESSION_SECRET;
  if (!secret) {
    const secretFile = path.join(dataDirectory, '.session-secret');
    if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, randomBytes(48).toString('hex'), { flag: 'wx', mode: 0o600 });
    secret = fs.readFileSync(secretFile, 'utf8').trim();
  }
  if (Buffer.byteLength(secret) < 32) throw new Error('SESSION_SECRET debe tener al menos 32 bytes');
  const trustedProxy = process.env.TRUST_PROXY || false;
  if (['true', '1'].includes(trustedProxy)) throw new Error('TRUST_PROXY debe indicar proxies concretos, por ejemplo loopback');

  return {
    root, port, production, origin, trustedProxy, secret, dataDirectory, admin,
    databaseFile: path.join(dataDirectory, 'library.db'),
    uploads: path.join(dataDirectory, 'uploads'),
    covers: path.join(dataDirectory, 'covers'),
    legacyStorage: !process.env.DATA_DIR
  };
}

module.exports = { loadConfig };
