const path = require('node:path');
const lockfile = require('proper-lockfile');

function acquireDataLock(directory) {
  let unlock;
  try {
    // Filesystem lease, independent of container hostnames and recycled process IDs.
    unlock = lockfile.lockSync(directory, {
      lockfilePath: path.join(directory, '.library-lock'),
      realpath: false, stale: 30000, update: 10000
    });
  } catch (error) {
    if (error.code === 'ELOCKED') throw new Error('La base está en uso. Detén el servidor antes de iniciar otra instancia o modificar el administrador.');
    throw error;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    unlock();
  };
  process.once('exit', release);
  return release;
}

module.exports = { acquireDataLock };
