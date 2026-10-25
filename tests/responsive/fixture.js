const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const sharp = require('sharp');
const { openDatabase } = require('../../lib/database');
const { tempRoot, start, stop } = require('../helpers');

async function createLibrary() {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'library-responsive-'));
  const database = await openDatabase(path.join(directory, 'library.db'));
  fs.mkdirSync(path.join(directory, 'uploads'));
  fs.mkdirSync(path.join(directory, 'covers'));
  const longCategory = 'ArchivosDeUnaCategoriaConUnNombreEspecialmenteExtensoParaProbarElDisenoMovil';
  database.run('INSERT INTO categories (name) VALUES (?)', [longCategory]);
  const titles = ['BibliotecaDeSenalesSinEspacios'.repeat(8), 'Manual de señales', 'Mapas para una biblioteca', 'Notas al margen'];
  const description = ('Descripción con varias líneas para comprobar la lectura y el desplazamiento.\n').repeat(24) + '\nhttps://example.org/' + 'un-enlace-largo-sin-espacios'.repeat(24);
  for (let index = 0; index < titles.length; index++) {
    const cover = `${randomBytes(32).toString('hex')}.png`;
    await sharp({ create: { width: 320, height: 480, channels: 3, background: ['#142d21', '#322037', '#1b2c3f', '#403225'][index] } }).png().toFile(path.join(directory, 'covers', cover));
    database.run('INSERT INTO works (title, author, year, category, description, cover_filename) VALUES (?, ?, ?, ?, ?, ?)',
      [titles[index], 'AutoraDePruebaConUnNombreLargo'.repeat(5), 2026, [longCategory, 'epub', 'pdf', 'software'][index], description, cover]);
    const workId = database.get('SELECT last_insert_rowid() AS id').id;
    for (const format of ['epub', 'pdf']) {
      const filename = `${randomBytes(32).toString('hex')}.${format}`;
      const content = `Responsive test ${format}`;
      fs.writeFileSync(path.join(directory, 'uploads', filename), content);
      database.run('INSERT INTO files (work_id, filename, original_name, format, size, download_token) VALUES (?, ?, ?, ?, ?, ?)',
        [workId, filename, 'NombreDelArchivoSinEspacios'.repeat(8) + '.' + format, format, Buffer.byteLength(content), randomBytes(32).toString('hex')]);
    }
  }
  database.run(`INSERT INTO visits (ip, country, country_code, city, region, isp, page, classification, classification_reason,
    method, status_code, user_agent, is_page_view, request_type, source, referrer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ['203.0.113.17', 'Chile', 'CL', 'Una ciudad de prueba', 'Región de prueba', 'ProveedorDeConexionConUnNombreExtenso'.repeat(3),
    '/ruta-de-prueba/' + 'segmento'.repeat(30), 'browser', 'Clasificación orientativa de prueba', 'GET', 200,
    'Mozilla/5.0 ' + 'UserAgentDePrueba'.repeat(28), 0, 'other', 'http', 'https://example.org/' + 'referencia'.repeat(25)]);
  database.save();
  database.close();
  try {
    const server = await start(directory);
    return {
      ...server, directory, longCategory,
      dispose: async () => { await stop(server); fs.rmSync(directory, { recursive: true, force: true }); }
    };
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}

module.exports = { createLibrary };
