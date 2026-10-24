const { loadConfig } = require('../lib/config');
const { openDatabase } = require('../lib/database');
const { acquireDataLock } = require('../lib/data-lock');
const { syncAdmin } = require('../lib/admin');

(async () => {
  const config = loadConfig();
  const release = acquireDataLock(config.dataDirectory);
  const database = await openDatabase(config.databaseFile);
  try {
    const changed = await syncAdmin(database, config.admin);
    console.log(changed ? 'Administrador sincronizado desde el entorno. Sesiones anteriores invalidadas.' : 'El administrador ya coincide con la configuración de entorno.');
  } finally { database.close(); release(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
