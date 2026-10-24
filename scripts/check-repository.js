const { spawnSync } = require('node:child_process');

const result = spawnSync('git', ['ls-files', '--cached', '-z'], { encoding: 'utf8' });
if (result.status !== 0) {
  console.error('Ejecuta primero git init y git add para revisar los archivos preparados.');
  process.exitCode = 1;
} else {
  const forbidden = result.stdout.split('\0').filter(Boolean).filter(filename => {
    const normalized = filename.replace(/\\/g, '/');
    if (['.env.example', '.env.dokploy.example'].includes(normalized)) return false;
    return /(^|\/)\.env($|\.)/.test(normalized) ||
      /(^|\/)(node_modules|db|data|uploads|covers|backups|exports)(\/|$)/.test(normalized) ||
      /(^|\/)(\.session-secret|\.data-lock|\.library-lock)(\/|$)/.test(normalized) ||
      /\.(db|sqlite3?|bak|log|pem|key|p12|pfx|tar|tar\.gz)([-.]|$)/i.test(normalized);
  });
  if (forbidden.length) {
    console.error('Retira estos archivos privados del índice con git restore --staged -- <ruta>:');
    console.error(forbidden.join('\n'));
    process.exitCode = 1;
  } else console.log('Índice de Git revisado: no hay rutas privadas ni datos de ejecución. Revisa también el contenido con git diff --cached antes de publicar.');
}
