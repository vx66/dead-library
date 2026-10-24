const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const multer = require('multer');
const sharp = require('sharp');
const { HttpError } = require('./errors');

function storedPath(directory, filename) {
  if (typeof filename !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(filename) || filename.includes('..')) {
    throw new HttpError(404, 'Archivo no encontrado');
  }
  return path.join(directory, filename);
}

function safeRemove(filename) {
  try { if (fs.existsSync(filename)) fs.unlinkSync(filename); }
  catch (_) { console.error('[Storage] No se pudo retirar un archivo obsoleto'); }
}

function createStorage(config, database) {
  for (const directory of [config.uploads, config.covers]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (config.legacyStorage) {
    const migrations = [
      [database.all('SELECT filename AS name FROM files'), path.join(config.root, 'public/uploads'), config.uploads],
      [database.all('SELECT cover_filename AS name FROM works WHERE cover_filename IS NOT NULL'), path.join(config.root, 'public/covers'), config.covers]
    ];
    for (const [records, source, target] of migrations) {
      for (const { name } of records) {
        const original = storedPath(source, name);
        const destination = storedPath(target, name);
        if (fs.existsSync(original) && !fs.existsSync(destination)) fs.renameSync(original, destination);
      }
    }
  }
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, done) => done(null, file.fieldname === 'cover' ? config.covers : config.uploads),
      filename: (req, file, done) => {
        const extension = path.extname(file.originalname).toLowerCase();
        done(null, randomBytes(32).toString('hex') + (/^\.[a-z0-9]{1,12}$/.test(extension) ? extension : ''));
      }
    }),
    limits: { fileSize: 250 * 1024 * 1024, files: 101, fields: 8, fieldSize: 128 * 1024, parts: 109 },
    fileFilter: (req, file, done) => {
      file.originalname = path.basename(file.originalname.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 255);
      if (!file.originalname) return done(new HttpError(400, 'El archivo debe tener un nombre válido'));
      if (file.fieldname === 'cover' && !/\.(png|jpe?g|gif|webp)$/i.test(file.originalname)) {
        return done(new HttpError(400, 'La portada debe ser PNG, JPEG, GIF o WebP'));
      }
      done(null, true);
    }
  }).fields([{ name: 'cover', maxCount: 1 }, { name: 'files', maxCount: 100 }]);

  function cleanup(req) {
    if (req.uploadsCommitted) return;
    for (const file of Object.values(req.files || {}).flat()) safeRemove(file.path);
  }

  async function prepare(req) {
    const cover = req.files && req.files.cover && req.files.cover[0];
    if (!cover) return null;
    if (cover.size > 8 * 1024 * 1024) throw new HttpError(400, 'La portada puede pesar como máximo 8 MB');
    const newPath = path.join(config.covers, randomBytes(32).toString('hex') + '.webp');
    try {
      const image = sharp(cover.path, { limitInputPixels: 16000000, animated: false });
      const metadata = await image.metadata();
      if (!['jpeg', 'png', 'gif', 'webp'].includes(metadata.format)) throw new Error('Unsupported image');
      await image.rotate().webp({ quality: 85 }).toFile(newPath);
    } catch (_) {
      safeRemove(newPath);
      throw new HttpError(400, 'La portada no es una imagen válida o es demasiado grande');
    }
    safeRemove(cover.path);
    cover.path = newPath;
    cover.filename = path.basename(newPath);
    return cover.filename;
  }

  return { upload, prepare, cleanup };
}

module.exports = { createStorage, storedPath, safeRemove };
