const bcrypt = require('bcryptjs');

function adminCredentials(environment = process.env) {
  const username = environment.ADMIN_USERNAME;
  const password = environment.ADMIN_PASSWORD;
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,64}$/.test(username)) {
    throw new Error('Configura ADMIN_USERNAME en .env o en Dokploy: entre 3 y 64 letras, números, puntos, guiones o guiones bajos');
  }
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 72) {
    throw new Error('Configura ADMIN_PASSWORD en .env o en Dokploy: al menos 12 caracteres y como máximo 72 bytes');
  }
  return { username, password };
}

async function syncAdmin(database, credentials) {
  const users = database.all('SELECT * FROM admin_users');
  const existing = users.find(user => user.username === credentials.username);
  const matches = existing && await bcrypt.compare(credentials.password, existing.password_hash);
  if (matches && users.length === 1 && bcrypt.getRounds(existing.password_hash) >= 12) return false;
  const hash = await bcrypt.hash(credentials.password, 12);
  database.transaction(() => {
    database.run('DELETE FROM admin_users');
    database.run('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)', [credentials.username, hash]);
    database.run('DELETE FROM sessions');
  });
  return true;
}

module.exports = { adminCredentials, syncAdmin };
