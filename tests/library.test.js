const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');
const sharp = require('sharp');
const { tempRoot, start, stop, login, readDatabase } = require('./helpers');
const { openDatabase } = require('../lib/database');
const { createStorage } = require('../lib/storage');

function form(files = []) {
  const body = new FormData();
  body.set('title', 'Libro "doble" de O\'Brien');
  body.set('author', 'Autora de prueba');
  body.set('year', '2026');
  body.set('category', 'epub');
  body.set('description', 'Una descripción con saltos.\nEPUB y PDF de la misma obra.');
  for (const [name, content] of files) body.append('files', new Blob([content]), name);
  return body;
}

test('Obra multiformato: datos, tokens, portada saneada, persistencia y eliminación', async () => {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'library-api-'));
  let server;
  try {
    server = await start(directory);
    let headers = await login(server.base);
    const upload = await fetch(server.base + '/admin/upload', {
      method: 'POST', headers, body: form([['libro.epub', 'EPUB fixture'], ['libro.pdf', '%PDF fixture']])
    });
    assert.equal(upload.status, 200, await upload.clone().text());
    const { workId } = await upload.json();
    let work = await (await fetch(`${server.base}/api/works/${workId}`)).json();
    assert.equal(work.title, 'Libro "doble" de O\'Brien');
    assert.match(work.description, /saltos\.\r?\nEPUB/);
    assert.deepEqual(work.files.map(file => file.format), ['epub', 'pdf']);
    assert.equal(work.uploader_ip, undefined);
    assert.equal(new Set(work.files.map(file => file.download_url)).size, 2);
    for (const file of work.files) {
      assert.equal(file.id, undefined);
      assert.equal(file.filename, undefined);
      assert.match(file.download_url, /^\/download\/[a-f0-9]{64}$/);
      const response = await fetch(server.base + file.download_url);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-disposition'), /^attachment/);
      assert.equal(response.headers.get('content-type'), 'application/octet-stream');
      assert.equal(await response.text(), file.format === 'epub' ? 'EPUB fixture' : '%PDF fixture');
    }
    const initialUrls = work.files.map(file => file.download_url);
    for (const file of await readDatabase(directory, 'SELECT id, filename FROM files')) {
      assert.match(file.filename, /^[a-f0-9]{64}\.(epub|pdf)$/);
      for (const url of [`/download/${file.id}`, `/view/${file.id}`, `/uploads/${file.filename}`, `/%75ploads/${file.filename}`]) {
        assert.equal((await fetch(server.base + url)).status, 404);
      }
    }
    for (const token of ['1', '42', 'unknown', 'a'.repeat(64), 'x'.repeat(64)]) {
      assert.equal((await fetch(`${server.base}/download/${token}`)).status, 404);
    }
    const update = form(Array.from({ length: 11 }, (_, index) => [`extra-${index}.txt`, `texto ${index}`]));
    update.set('description', 'Descripción editada');
    const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).png().toBuffer();
    update.append('cover', new Blob([image], { type: 'image/png' }), 'cover.png');
    const edited = await fetch(`${server.base}/admin/works/${workId}`, { method: 'PUT', headers, body: update });
    assert.equal(edited.status, 200, await edited.clone().text());
    work = await (await fetch(`${server.base}/api/works/${workId}`)).json();
    assert.equal(work.files.length, 13);
    assert.equal(new Set(work.files.map(file => file.download_url)).size, 13);
    assert.deepEqual(work.files.slice(0, 2).map(file => file.download_url), initialUrls);
    assert.equal(work.description, 'Descripción editada');
    assert.match(work.cover, /\.webp$/);
    assert.equal((await fetch(server.base + work.cover)).status, 200);
    const invalid = form([['unrelated.zip', 'payload']]);
    invalid.set('title', '');
    assert.equal((await fetch(server.base + '/admin/upload', { method: 'POST', headers, body: invalid })).status, 400);
    assert.equal(fs.readdirSync(path.join(directory, 'uploads')).length, 13);
    assert.equal((await (await fetch(server.base + '/api/works?category=software')).json()).length, 0);

    await stop(server);
    server = await start(directory);
    // Signed sessions and random secrets survive restarts.
    assert.equal((await fetch(server.base + '/admin/works', { headers })).status, 200);
    const persisted = await (await fetch(`${server.base}/api/works/${workId}`)).json();
    assert.deepEqual(persisted.files.map(file => file.download_url), work.files.map(file => file.download_url));
    headers = await login(server.base);
    const adminWorks = await (await fetch(server.base + '/admin/works', { headers })).json();
    const removedFile = adminWorks[0].files[0];
    assert.equal((await fetch(`${server.base}/admin/files/${removedFile.id}`, { method: 'DELETE', headers })).status, 200);
    assert.equal((await fetch(server.base + removedFile.download_url)).status, 404);
    assert.equal((await fetch(`${server.base}/admin/works/${workId}`, { method: 'DELETE', headers })).status, 200);
    assert.deepEqual(await (await fetch(server.base + '/api/works')).json(), []);
    assert.deepEqual(fs.readdirSync(path.join(directory, 'uploads')), []);
    assert.deepEqual(fs.readdirSync(path.join(directory, 'covers')), []);
    assert.equal((await readDatabase(directory, 'SELECT COUNT(*) AS count FROM files'))[0].count, 0);
  } finally {
    if (server) await stop(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Migración del esquema original: archivo y metadatos conservados con token', async () => {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'library-migration-'));
  let server;
  try {
    fs.mkdirSync(path.join(directory, 'uploads'));
    fs.writeFileSync(path.join(directory, 'uploads', 'legacy.epub'), 'legacy content');
    const SQL = await initSqlJs();
    const database = new SQL.Database();
    database.run(`CREATE TABLE files (
      id INTEGER PRIMARY KEY, title TEXT, author TEXT, year INTEGER, category TEXT,
      format TEXT, size INTEGER, filename TEXT, original_name TEXT, cover_filename TEXT,
      uploaded_at TEXT, uploader_ip TEXT
    )`);
    database.run(`INSERT INTO files VALUES (42, 'Obra existente', 'Autor', 2005, 'epub', 'epub', 14,
      'legacy.epub', 'original.epub', NULL, '2025-01-01 00:00:00', '127.0.0.1')`);
    fs.writeFileSync(path.join(directory, 'library.db'), Buffer.from(database.export()));
    database.close();
    server = await start(directory);
    const works = await (await fetch(server.base + '/api/works')).json();
    assert.equal(works.length, 1);
    assert.equal(works[0].title, 'Obra existente');
    assert.equal(works[0].files[0].id, undefined);
    assert.match(works[0].files[0].download_url, /^\/download\/[a-f0-9]{64}$/);
    assert.equal(await (await fetch(server.base + works[0].files[0].download_url)).text(), 'legacy content');
    assert.equal((await fetch(server.base + '/download/42')).status, 404);
    assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.bak')).length, 1);
  } finally {
    if (server) await stop(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Migración de obras existentes sin tokens: descarga estable sin volver a subir', async () => {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'library-token-migration-'));
  let server;
  try {
    fs.mkdirSync(path.join(directory, 'uploads'));
    fs.writeFileSync(path.join(directory, 'uploads', 'old-file.pdf'), 'existing PDF');
    const SQL = await initSqlJs();
    const database = new SQL.Database();
    database.run(`CREATE TABLE works (id INTEGER PRIMARY KEY, title TEXT, author TEXT, year INTEGER, category TEXT,
      description TEXT, cover_filename TEXT, uploaded_at TEXT, uploader_ip TEXT)`);
    database.run(`CREATE TABLE files (id INTEGER PRIMARY KEY, work_id INTEGER, filename TEXT, original_name TEXT,
      format TEXT, size INTEGER, uploaded_at TEXT)`);
    database.run(`INSERT INTO works VALUES (3, 'Obra con formatos', 'Autor', 2026, 'pdf', 'Descripción conservada', NULL, '2026-01-01', '127.0.0.1')`);
    database.run(`INSERT INTO files VALUES (7, 3, 'old-file.pdf', 'original.pdf', 'pdf', 12, '2026-01-01')`);
    fs.writeFileSync(path.join(directory, 'library.db'), Buffer.from(database.export()));
    database.close();
    server = await start(directory);
    const work = await (await fetch(server.base + '/api/works/3')).json();
    assert.equal(work.description, 'Descripción conservada');
    assert.match(work.files[0].download_url, /^\/download\/[a-f0-9]{64}$/);
    assert.equal(await (await fetch(server.base + work.files[0].download_url)).text(), 'existing PDF');
    assert.equal((await fetch(server.base + '/download/7')).status, 404);
    assert.equal((await fetch(server.base + '/uploads/old-file.pdf')).status, 404);
    const headers = await login(server.base);
    const adminWork = (await (await fetch(server.base + '/admin/works', { headers })).json())[0];
    assert.equal(adminWork.files[0].id, 7);
    assert.equal(adminWork.files[0].download_url, work.files[0].download_url);
    await stop(server);
    server = await start(directory);
    assert.equal((await (await fetch(server.base + '/api/works/3')).json()).files[0].download_url, work.files[0].download_url);
    assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.bak')).length, 1);
  } finally {
    if (server) await stop(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('El almacenamiento antiguo se mueve fuera de public conservando archivos y enlaces', async () => {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'library-storage-migration-'));
  const data = path.join(directory, 'private');
  let server;
  try {
    fs.mkdirSync(data);
    fs.mkdirSync(path.join(directory, 'public/uploads'), { recursive: true });
    fs.mkdirSync(path.join(directory, 'public/covers'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'public/uploads', 'old-file.epub'), 'original epub');
    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } }).png().toBuffer();
    fs.writeFileSync(path.join(directory, 'public/covers', 'old-cover.png'), image);
    const database = await openDatabase(path.join(data, 'library.db'));
    const token = '8'.repeat(64);
    database.transaction(() => {
      database.run("INSERT INTO works (id, title, author, cover_filename) VALUES (1, 'Obra conservada', 'Autora', 'old-cover.png')");
      database.run('INSERT INTO files (work_id, filename, original_name, format, size, download_token) VALUES (?, ?, ?, ?, ?, ?)',
        [1, 'old-file.epub', 'original.epub', 'epub', 13, token]);
    });
    createStorage({ root: directory, uploads: path.join(data, 'uploads'), covers: path.join(data, 'covers'), legacyStorage: true }, database);
    database.close();
    assert.equal(fs.existsSync(path.join(directory, 'public/uploads', 'old-file.epub')), false);
    assert.equal(fs.existsSync(path.join(directory, 'public/covers', 'old-cover.png')), false);
    assert.equal(fs.readFileSync(path.join(data, 'uploads', 'old-file.epub'), 'utf8'), 'original epub');
    server = await start(data);
    assert.equal(await (await fetch(`${server.base}/download/${token}`)).text(), 'original epub');
    assert.equal((await fetch(server.base + '/covers/old-cover.png')).status, 200);
    assert.equal((await fetch(server.base + '/uploads/old-file.epub')).status, 404);
  } finally {
    if (server) await stop(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
