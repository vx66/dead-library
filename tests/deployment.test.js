const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const { root, tempRoot, start, stop, rawFetch } = require('./helpers');

test('Compose de Dokploy: entorno explícito, dominio, volumen y puerto exclusivamente interno', () => {
  const document = YAML.parseDocument(fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8'));
  assert.deepEqual(document.errors, []);
  const config = document.toJS();
  const service = config.services.library;
  assert.equal(service.build.dockerfile, 'Dockerfile');
  assert.equal(service.environment.NODE_ENV, 'production');
  assert.equal(service.environment.DATA_DIR, '/data');
  assert.match(service.environment.PUBLIC_ORIGIN, /https:\/\/library\.deadsmile\.org/);
  assert.match(service.environment.ADMIN_USERNAME, /^\$\{ADMIN_USERNAME:\?/);
  assert.match(service.environment.ADMIN_PASSWORD, /^\$\{ADMIN_PASSWORD:\?/);
  assert.match(service.environment.TRUST_PROXY, /^\$\{TRUST_PROXY:\?/);
  assert.equal(service.ports, undefined);
  assert.deepEqual(service.expose, ['3000']);
  assert.deepEqual(service.volumes, ['library-data:/data']);
  assert.equal(service.read_only, true);
  assert.equal(service.init, true);
  assert.deepEqual(service.cap_drop, ['ALL']);
  assert.ok(Object.hasOwn(config.volumes, 'library-data'));
});

test('Docker local y CI se mantienen separados del despliegue de producción', () => {
  const compose = YAML.parse(fs.readFileSync(path.join(root, 'docker-compose.local.yml'), 'utf8'));
  assert.equal(compose.services.library.environment.NODE_ENV, 'development');
  assert.deepEqual(compose.services.library.ports, ['127.0.0.1:3000:3000']);
  assert.deepEqual(compose.services.library.volumes, ['library-data-local:/data']);
  const document = YAML.parseDocument(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
  assert.deepEqual(document.errors, []);
  const workflow = document.toJS();
  assert.equal(workflow.permissions.contents, 'read');
  assert.deepEqual(workflow.jobs.test.strategy.matrix.os, ['ubuntu-latest', 'windows-latest']);
  assert.ok(workflow.jobs.docker);
  assert.doesNotMatch(JSON.stringify(workflow), /docker push|push:\s*true|dokploy-action|application\.deploy/);
});

test('Dockerfile y contexto de construcción no incorporan credenciales ni biblioteca personal', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /FROM node:24-bookworm-slim AS dependencies/);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /CMD \["node", "server\.js"\]/);
  assert.doesNotMatch(dockerfile, /COPY\s+\.\s+\.|ARG\s+(ADMIN_|SESSION_)|ENV\s+(ADMIN_USERNAME|ADMIN_PASSWORD)/);
  const ignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
  assert.ok(ignore.split('\n').includes('**'));
  assert.doesNotMatch(ignore, /^!.*(?:\.env|uploads|covers|db\/|data\/|\.git\/)/m);
  for (const name of ['.env.example', '.env.dokploy.example']) {
    const template = fs.readFileSync(path.join(root, name), 'utf8');
    assert.match(template, /^ADMIN_USERNAME=$/m);
    assert.match(template, /^ADMIN_PASSWORD=$/m);
  }
});

test('La revisión del índice bloquea un .env real y permite las plantillas', () => {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'library-git-check-'));
  try {
    assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: directory }).status, 0);
    fs.writeFileSync(path.join(directory, '.env.example'), 'ADMIN_USERNAME=\nADMIN_PASSWORD=\n');
    assert.equal(spawnSync('git', ['add', '.env.example'], { cwd: directory }).status, 0);
    const check = () => spawnSync(process.execPath, [path.join(root, 'scripts/check-repository.js')], { cwd: directory, encoding: 'utf8' });
    assert.equal(check().status, 0);
    fs.writeFileSync(path.join(directory, '.env'), 'PRIVATE=test-fixture-only\n');
    assert.equal(spawnSync('git', ['add', '.env'], { cwd: directory }).status, 0);
    const blocked = check();
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /\.env/);
    assert.doesNotMatch(blocked.stderr, /test-fixture-only/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('El healthcheck funciona sin el Host público ni credenciales en la solicitud', async () => {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'library-health-'));
  let server;
  try {
    server = await start(directory, { env: { PUBLIC_ORIGIN: 'https://library.deadsmile.org' }, probeHeaders: { host: 'library.deadsmile.org' } });
    const response = await rawFetch(server.base + '/healthz');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.equal(response.headers.get('set-cookie'), null);
    const check = spawnSync(process.execPath, [path.join(root, 'scripts/healthcheck.js')], {
      cwd: root, env: { ...process.env, PORT: new URL(server.base).port }, encoding: 'utf8', timeout: 5000
    });
    assert.equal(check.status, 0, check.stderr);
  } finally {
    if (server) await stop(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
