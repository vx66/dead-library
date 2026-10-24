const { isIP } = require('node:net');

const unknown = () => ({ country: 'Desconocido', city: 'Desconocido', region: 'Desconocido', lat: null, lon: null, isp: 'Desconocido' });
const clean = value => typeof value === 'string' ? value.slice(0, 150) : 'Desconocido';

function publicAddress(address) {
  if (!isIP(address)) return false;
  if (isIP(address) === 6) return !/^(::|fc|fd|fe[89ab])/i.test(address);
  const [a, b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
    (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127));
}

function createVisits(database) {
  const recent = new Map();
  const cache = new Map();
  let pending = 0;
  const ip = req => (req.ip || '').replace(/^::ffff:/, '');
  async function lookup(address) {
    if (!publicAddress(address)) return unknown();
    const saved = cache.get(address);
    if (saved && saved.expires > Date.now()) return saved.data;
    if (pending >= 4) return unknown();
    pending++;
    try {
      const response = await fetch(`https://ipwho.is/${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) return unknown();
      const data = await response.json();
      if (!data.success) return unknown();
      const result = {
        country: clean(data.country), city: clean(data.city), region: clean(data.region),
        lat: typeof data.latitude === 'number' ? data.latitude : null,
        lon: typeof data.longitude === 'number' ? data.longitude : null, isp: clean(data.connection && data.connection.isp)
      };
      if (cache.size >= 1000) cache.delete(cache.keys().next().value);
      cache.set(address, { expires: Date.now() + 86400000, data: result });
      return result;
    } catch (_) { return unknown(); }
    finally { pending--; }
  }
  async function record(req) {
    const address = ip(req);
    if (!isIP(address)) return;
    if (Date.now() - (recent.get(address) || 0) < 30 * 60 * 1000) return;
    if (recent.size >= 2000) recent.delete(recent.keys().next().value);
    recent.set(address, Date.now());
    const data = await lookup(address);
    database.transaction(() => {
      database.run('INSERT INTO visits (ip, country, city, region, lat, lon, isp, page) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [address, data.country, data.city, data.region, data.lat, data.lon, data.isp, '/']);
      database.run("DELETE FROM visits WHERE visited_at < datetime('now', '-90 days') OR id <= (SELECT MAX(id) - 50000 FROM visits)");
    });
  }
  return { ip, lookup, record };
}

module.exports = { createVisits };
