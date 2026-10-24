const { HttpError } = require('./errors');

function text(value, name, maximum, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `${name} es obligatorio`);
    return '';
  }
  if (typeof value !== 'string' || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new HttpError(400, `${name} no es válido`);
  }
  const result = value.trim();
  if (required && !result) throw new HttpError(400, `${name} es obligatorio`);
  return result;
}

function workData(body, database) {
  const title = text(body.title, 'El título', 300, true);
  const author = text(body.author, 'El autor', 200, true);
  const description = text(body.description, 'La descripción', 20000);
  const category = text(body.category, 'La categoría', 80) || null;
  if (category && !database.get('SELECT id FROM categories WHERE name = ?', [category])) throw new HttpError(400, 'Selecciona una categoría existente');
  const yearText = text(body.year, 'El año', 6);
  if (yearText && !/^-?\d{1,4}$/.test(yearText)) throw new HttpError(400, 'El año no es válido');
  return [title, author, yearText ? Number(yearText) : null, category, description];
}

function validateId(req, res, next, value) {
  if (!/^[1-9]\d{0,14}$/.test(value) || !Number.isSafeInteger(Number(value))) return next(new HttpError(404, 'Registro no encontrado'));
  next();
}

module.exports = { text, workData, validateId };
