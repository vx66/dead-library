const { test: base, expect } = require('@playwright/test');
const { createLibrary } = require('./fixture');
const { login, username, password } = require('../helpers');

const test = base.extend({
  library: [async ({}, use) => {
    const library = await createLibrary();
    try { await use(library); } finally { await library.dispose(); }
  }, { scope: 'worker' }],
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
    await use(page);
    expect(errors, 'No debe haber errores JavaScript').toEqual([]);
  }
});

const profiles = [
  { width: 320, height: 568 }, { width: 360, height: 800 }, { width: 375, height: 667 },
  { width: 390, height: 844 }, { width: 414, height: 896 }, { width: 600, height: 960 },
  { width: 768, height: 1024 }, { width: 820, height: 1180 }, { width: 1024, height: 768 },
  { width: 1180, height: 820 }, { width: 667, height: 375 }, { width: 844, height: 390 },
  { width: 1280, height: 800 }
];

async function noPageOverflow(page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), {
    message: 'El documento no debe necesitar desplazamiento horizontal'
  }).toBeLessThanOrEqual(1);
}

async function touchControls(page, scope = 'body') {
  const undersized = await page.locator(scope).evaluate(element => [...element.querySelectorAll('button:not(.color-swatch), select, input:not([type=checkbox]), summary')].filter(control => {
    const box = control.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(control).visibility !== 'hidden' && box.height < 43.5;
  }).map(control => control.outerHTML.slice(0, 160)));
  expect(undersized, 'Los controles visibles deben tener al menos 44 px de altura').toEqual([]);
  const compactSwatches = await page.locator(scope).evaluate(element => [...element.querySelectorAll('.color-swatch')].filter(control => {
    const box = control.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && (box.width < 24 || box.height < 24);
  }).length);
  expect(compactSwatches, 'La paleta compacta debe conservar botones de al menos 24 px').toBe(0);
  const smallInputs = await page.locator(scope).evaluate(element => [...element.querySelectorAll('input:not([type=checkbox]), select, textarea')].filter(control => {
    const box = control.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && parseFloat(getComputedStyle(control).fontSize) < 16;
  }).map(control => control.name || control.id));
  expect(smallInputs, 'El texto de entradas debe evitar el zoom automático de iOS').toEqual([]);
}

async function usableDialog(page) {
  const dialog = page.locator('dialog[open]').last();
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate(element => {
    const box = element.querySelector('.modal').getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop || 0;
    const height = viewport?.height || innerHeight;
    return box.left >= -1 && box.right <= document.documentElement.clientWidth + 1 && box.top >= top - 1 && box.bottom <= top + height + 1;
  }), { message: 'El popup debe caber dentro del área visible' }).toBe(true);
  const close = dialog.locator('.modal-close');
  await expect(close).toBeInViewport();
  expect(await dialog.locator('.modal-body').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'El contenido del popup debe ajustarse al ancho').toBe(true);
  await touchControls(page, 'dialog[open]');
  return dialog;
}

async function authenticate(page, library) {
  const headers = await login(library.base);
  await page.context().addCookies([{ name: 'dsl.sid', value: headers.cookie.slice(headers.cookie.indexOf('=') + 1), url: library.base }]);
  await page.goto(library.base + '/admin');
  await expect(page.locator('#uploadForm')).toBeVisible();
}

async function stableHero(page) {
  const measurements = await page.evaluate(() => {
    const prefix = document.querySelector('.rotary-prefix');
    const tail = document.querySelector('.rotary-message .rotary-tail > span:first-child');
    const message = document.querySelector('.rotary-message');
    const rotary = document.querySelector('.rotary');
    const subtitle = document.querySelector('.hero .sub');
    const original = [prefix.textContent, tail.textContent];
    const samples = [...document.querySelectorAll('.rotary-sizing-text')].map(element => [element.firstChild.textContent, element.querySelector('.rotary-tail').firstChild.textContent]);
    samples.push(['', '']);
    const values = samples.map(([text, last]) => {
      prefix.textContent = text;
      tail.textContent = last;
      return { top: subtitle.getBoundingClientRect().top, fits: message.getBoundingClientRect().height <= rotary.getBoundingClientRect().height + 1 };
    });
    [prefix.textContent, tail.textContent] = original;
    return values;
  });
  expect(measurements.every(value => value.fits), 'Todas las frases deben caber en el espacio reservado').toBe(true);
  expect(Math.max(...measurements.map(value => value.top)) - Math.min(...measurements.map(value => value.top)), 'El subtítulo no debe moverse durante la rotación').toBeLessThan(1);
}

for (const profile of profiles) {
  test.describe(`${profile.width}x${profile.height}`, () => {
    test.use({ viewport: profile, isMobile: profile.width <= 1024, hasTouch: profile.width <= 1024 });

    test('catálogo, filtros y popup con contenido largo', async ({ page, library }) => {
      await page.goto(library.base + '/');
      await expect(page.locator('.work-card')).toHaveCount(4);
      await noPageOverflow(page);
      await touchControls(page);
      await stableHero(page);
      await page.locator('#catSelect').selectOption(library.longCategory);
      await expect(page.locator('.work-card')).toHaveCount(1);
      await page.locator('#orderSelect').selectOption('alpha');
      await expect(page.locator('#catalogGrid')).toHaveAttribute('aria-busy', 'false');
      await expect(page.locator('.work-card')).toHaveCount(1);
      const card = page.locator('.work-card').first();
      await card.scrollIntoViewIfNeeded();
      const before = await page.evaluate(() => scrollY);
      await card.click();
      const dialog = await usableDialog(page);
      await dialog.locator('.modal-body').evaluate(element => { element.scrollTop = element.scrollHeight; });
      await expect(dialog.locator('.modal-close')).toBeInViewport();
      const downloading = page.waitForEvent('download');
      await dialog.getByRole('link', { name: 'descargar EPUB', exact: true }).click();
      expect((await downloading).suggestedFilename()).toMatch(/\.epub$/);
      await dialog.locator('.modal-close').click();
      await expect(page.locator('dialog')).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(before, 0);
      await noPageOverflow(page);
    });

    test('dashboard completo, edición, categorías y tráfico', async ({ page, library }) => {
      await authenticate(page, library);
      await noPageOverflow(page);
      await touchControls(page);
      await expect(page.locator('[data-section]')).toHaveCount(4);
      await page.locator('[data-section=catalogo]').click();
      await expect(page.locator('[data-edit-work]')).toHaveCount(4);
      await noPageOverflow(page);
      await touchControls(page);
      await page.locator('[data-edit-work]').first().click();
      const dialog = await usableDialog(page);
      await dialog.locator('[name=title]').fill('Título que se puede editar cómodamente');
      await dialog.locator('.add-download').click();
      await expect(dialog.locator('[name=files]')).toHaveCount(2);
      await usableDialog(page);
      await dialog.locator('.modal-close').click();
      await page.locator('[data-section=categorias]').click();
      await expect(page.locator('#catList tr')).not.toHaveCount(0);
      await noPageOverflow(page);
      await touchControls(page);
      await page.locator('[data-delete-category]').first().click();
      const confirmation = await usableDialog(page);
      await confirmation.getByRole('button', { name: 'cancelar', exact: true }).click();
      await page.locator('[data-section=stats]').click();
      await expect(page.locator('#trafficStatus')).toContainText('Actualizado:');
      await expect(page.locator('canvas')).toHaveCount(3);
      await noPageOverflow(page);
      await touchControls(page);
      await page.locator('#ipTableBody details').first().locator('summary').click();
      await noPageOverflow(page);
      await page.locator('#themeToggle').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await noPageOverflow(page);
    });
  });
}

test.describe('interacción y accesibilidad', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('login y subida real desde móvil', async ({ page, library }) => {
    await page.goto(library.base + '/admin/login');
    await noPageOverflow(page);
    await touchControls(page);
    await page.getByLabel('usuario', { exact: true }).fill(username);
    await page.getByLabel('contraseña', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'entrar', exact: true }).click();
    await expect(page.locator('#uploadForm')).toBeVisible();
    await page.getByLabel('título', { exact: true }).fill('Subida móvil de prueba');
    await page.getByLabel('autor', { exact: true }).fill('Autora de prueba');
    await page.getByLabel('descripción', { exact: true }).fill('Descripción escrita desde una pantalla pequeña.');
    await page.locator('[name=files]').setInputFiles({ name: 'mobile.txt', mimeType: 'text/plain', buffer: Buffer.from('archivo de prueba') });
    await page.locator('#uploadForm [type=submit]').click();
    await expect(page.locator('#uploadMsg')).toContainText('correctamente');
    await page.locator('[data-section=catalogo]').click();
    const work = page.locator('.admin-work').filter({ hasText: 'Subida móvil de prueba' });
    await work.locator('[data-delete-work]').click();
    await usableDialog(page);
    await page.locator('dialog[open] [data-confirm]').click();
    await expect(work).toHaveCount(0);
    await page.locator('#logoutButton').click();
    await expect(page).toHaveURL(library.base + '/admin/login');
  });

  test('popup de edición con altura reducida y cambio de orientación', async ({ page, library }) => {
    await authenticate(page, library);
    await page.locator('[data-section=catalogo]').click();
    await page.locator('[data-edit-work]').first().click();
    await usableDialog(page);
    await page.getByLabel('descripción', { exact: true }).focus();
    await page.setViewportSize({ width: 390, height: 340 });
    const dialog = await usableDialog(page);
    await dialog.locator('[type=submit]').scrollIntoViewIfNeeded();
    await expect(dialog.locator('[type=submit]')).toBeInViewport();
    await expect(dialog.locator('.modal-close')).toBeInViewport();
    await page.setViewportSize({ width: 844, height: 390 });
    await usableDialog(page);
    await dialog.locator('.modal-close').click();
    await noPageOverflow(page);
  });

  test('movimiento reducido, frases largas y ampliación del texto', async ({ page, library }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(library.base + '/');
    await expect(page.locator('.work-card')).toHaveCount(4);
    const text = await page.locator('.rotary-message').textContent();
    expect(text.replace('█', '').length).toBeGreaterThan(10);
    expect(await page.locator('.rotary-message .rotary-cursor').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
    await stableHero(page);
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await noPageOverflow(page);
    await stableHero(page);
    await page.locator('.work-card').first().click();
    await usableDialog(page);
  });

  test('paleta neón, blanco predeterminado, contenedor negro y persistencia', async ({ page, library }) => {
    await page.goto(library.base + '/');
    await expect(page.locator('.work-card')).toHaveCount(4);
    await expect(page.locator('html')).toHaveAttribute('data-ink', 'white');
    const inheritedInk = await page.evaluate(() => {
      const paragraph = document.createElement('p');
      paragraph.textContent = 'Texto de prueba';
      document.body.appendChild(paragraph);
      const color = getComputedStyle(paragraph).color;
      paragraph.remove();
      return color;
    });
    expect(inheritedInk).toBe('rgb(255, 255, 255)');
    await expect(page.locator('.brand')).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(page.locator('.rotary')).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(page.locator('.card-title').first()).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(page.locator('.catalog-shell')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    await expect(page.locator('.color-swatch')).toHaveCount(7);
    await expect(page.getByText('Repite → blanco', { exact: true })).toHaveCount(0);
    const colors = [
      ['white', 'rgb(255, 255, 255)'],
      ['green', 'rgb(57, 255, 20)'], ['yellow', 'rgb(255, 255, 51)'], ['red', 'rgb(255, 77, 90)'],
      ['blue', 'rgb(77, 157, 255)'], ['fuchsia', 'rgb(255, 79, 163)'], ['magenta', 'rgb(255, 0, 255)']
    ];
    for (const [name, color] of colors) {
      const button = page.locator(`[data-ink-value="${name}"]`);
      expect(await button.evaluate(element => getComputedStyle(element, '::before').backgroundColor)).toBe(color);
      expect(await button.evaluate(element => getComputedStyle(element, '::before').width)).toBe('16px');
      expect(await button.evaluate(element => getComputedStyle(element, '::before').height)).toBe('16px');
      const box = await button.boundingBox();
      expect(box.width).toBe(24);
      expect(box.height).toBe(24);
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.color-swatch[aria-pressed=true]')).toHaveCount(1);
      await expect(page.locator('.brand')).toHaveCSS('color', color);
      await expect(page.locator('.card-title').first()).toHaveCSS('color', color);
      await expect(page.locator('.rotary')).toHaveCSS('color', color);
    }
    await page.reload();
    await expect(page.locator('.work-card')).toHaveCount(4);
    await expect(page.locator('[data-ink-value=magenta]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.work-card').first().click();
    const dialog = await usableDialog(page);
    await expect(dialog.locator('.detail-title')).toHaveCSS('color', 'rgb(255, 0, 255)');
    await dialog.locator('.modal-close').click();
    await page.locator('#themeToggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('.catalog-shell')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    await expect(page.locator('.card-title').first()).toHaveCSS('color', 'rgb(255, 0, 255)');
    await page.locator('[data-ink-value=white]').click();
    await expect(page.locator('html')).toHaveAttribute('data-ink', 'white');
    await expect(page.locator('[data-ink-value=white]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.color-swatch[aria-pressed=true]')).toHaveCount(1);
    await expect(page.locator('.card-title').first()).toHaveCSS('color', 'rgb(255, 255, 255)');
    await noPageOverflow(page);
    await authenticate(page, library);
    await expect(page.locator('#uploadTitle')).toHaveCSS('color', 'rgb(17, 17, 17)');
    await page.locator('[data-ink-value=green]').click();
    await expect(page.locator('#uploadTitle')).toHaveCSS('color', 'rgb(8, 117, 43)');
    await page.locator('[data-section=stats]').click();
    await expect(page.locator('#trafficStatus')).toContainText('Actualizado:');
    await page.locator('[data-ink-value=blue]').click();
    expect(await page.evaluate(() => Object.keys(Chart.instances).length)).toBe(3);
    await noPageOverflow(page);
  });

  test('paleta operativa aunque el navegador bloquee el almacenamiento local', async ({ page, library }) => {
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new Error('Storage disabled'); };
      Storage.prototype.setItem = () => { throw new Error('Storage disabled'); };
    });
    await page.goto(library.base + '/');
    await expect(page.locator('.work-card')).toHaveCount(4);
    await expect(page.locator('html')).toHaveAttribute('data-ink', 'white');
    await page.locator('[data-ink-value=green]').click();
    await expect(page.locator('html')).toHaveAttribute('data-ink', 'green');
    await page.locator('[data-ink-value=green]').click();
    await expect(page.locator('html')).toHaveAttribute('data-ink', 'green');
    await page.locator('[data-ink-value=white]').click();
    await expect(page.locator('html')).toHaveAttribute('data-ink', 'white');
  });
});
