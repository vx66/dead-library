(function () {
  const securityReady = window.fetch('/admin/csrf', { cache: 'no-store' }).then(async response => {
    if (!response.ok) throw new Error('No se pudo iniciar la sesión de seguridad');
    return (await response.json()).csrfToken;
  });
  async function fetch(url, options = {}) {
    const token = await securityReady;
    const headers = new Headers(options.headers);
    if (!['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase())) headers.set('X-CSRF-Token', token);
    const response = await window.fetch(url, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) {
      location.assign('/admin/login');
      throw new Error('La sesión ha caducado');
    }
    return response;
  }
  const themeToggle = document.getElementById('themeToggle');
  const themeLabel = document.getElementById('themeLabel');

  const UI = window.DeadLibraryUI;
  const savedTheme = UI.getTheme();
  themeLabel.textContent = savedTheme === 'dark' ? 'oscuro' : 'claro';

  themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    UI.setTheme(next);
    themeLabel.textContent = next === 'dark' ? 'oscuro' : 'claro';
    if (lastTrafficStats && document.getElementById('trafficTable')) renderTrafficCharts(lastTrafficStats);
  });

  const adminMain = document.getElementById('adminMain');
  let chartCountry = null;
  let chartDay = null;
  let chartClassification = null;
  let statsRefreshTimer = null;
  let statsSequence = 0;
  let lastTrafficStats = null;
  window.addEventListener('library:inkchange', () => {
    if (lastTrafficStats && document.getElementById('trafficTable')) renderTrafficCharts(lastTrafficStats);
  });
  let allCategories = [];
  let catalogWorks = [];

  async function showSection(name) {
    clearInterval(statsRefreshTimer);
    statsSequence++;
    for (const chart of [chartCountry, chartDay, chartClassification]) if (chart) chart.destroy();
    chartCountry = chartDay = chartClassification = null;
    lastTrafficStats = null;
    document.querySelectorAll('.admin-sidebar a').forEach(a => {
      if (a.dataset.section === name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });

    try {
      if (name === 'subir') await renderUpload();
      else if (name === 'catalogo') await renderCatalog();
      else if (name === 'categorias') await renderCategories();
      else if (name === 'stats') await renderStats();
    } catch (error) { adminMain.textContent = error.message; }
  }

  window.showSection = showSection;
  document.querySelectorAll('[data-section]').forEach(link => {
    link.addEventListener('click', event => { event.preventDefault(); showSection(link.dataset.section); });
  });
  document.getElementById('logoutButton').addEventListener('click', async () => {
    try {
      const response = await fetch('/admin/logout', { method: 'POST' });
      if (!response.ok) throw new Error('No se pudo cerrar la sesión');
      location.assign('/admin/login');
    } catch (error) { alertModal('error', error.message); }
  });

  async function loadCategories() {
    const res = await fetch('/admin/categories');
    allCategories = await res.json();
    return allCategories;
  }

  function renderCatSelect(categories, selected) {
    let html = '<option value="">sin categoría</option>';
    for (const c of categories) {
      const sel = c.name === selected ? 'selected' : '';
      html += `<option value="${escapeHtml(c.name)}" ${sel}>${escapeHtml(c.name)}</option>`;
    }
    return html;
  }

  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /* ---------- Modal helpers ---------- */
  function openModal(contentHtml, title, size = 'large') {
    const backdrop = document.createElement('dialog');
    backdrop.className = `modal-backdrop admin-dialog dialog-${size}`;
    backdrop.setAttribute('aria-label', title || 'Aviso');
    backdrop.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3 class="modal-title">${escapeHtml(title || '')}</h3>
          <button type="button" class="modal-close" aria-label="Cerrar ventana">&times;</button>
        </div>
        <div class="modal-body">${contentHtml}</div>
      </div>
    `;
    const close = () => backdrop.close();
    backdrop.querySelector('.modal-close').onclick = close;
    backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
    backdrop.addEventListener('click', event => { if (event.target.closest('[data-close-modal]')) close(); });
    UI.openDialog(backdrop);
    return backdrop;
  }

  function alertModal(title, message) {
    return openModal(`
      <div class="dialog-message">
        <p>${escapeHtml(message)}</p>
        <button class="btn primary" data-close-modal>aceptar</button>
      </div>
    `, title, 'compact');
  }

  function confirmModal(title, message, onConfirm) {
    const dialog = openModal(`
      <div class="dialog-message">
        <p>${escapeHtml(message)}</p>
        <p class="file-hint">esta acción no se puede deshacer.</p>
        <div class="modal-actions">
          <button type="button" class="btn secondary" data-close-modal>cancelar</button>
          <button type="button" class="btn danger" data-confirm>eliminar</button>
        </div>
      </div>
    `, title, 'compact');
    dialog.querySelector('[data-confirm]').addEventListener('click', async event => {
      event.target.disabled = true;
      try {
        await onConfirm();
        dialog.close();
      } catch (error) {
        dialog.close();
        alertModal('error', error.message);
      }
    });
    return dialog;
  }

  function filePickerHtml(required) {
    return `<div class="file-picker" data-required="${required}">
      <div class="file-picker-rows"></div>
      <button type="button" class="btn secondary add-download">+ agregar otra descarga / formato</button>
      <div class="file-hint">Cada archivo tendrá su propio botón de descarga. Máximo 250 MB por archivo y 100 archivos por envío.</div>
    </div>`;
  }

  function setupFilePicker(root) {
    const picker = root.querySelector('.file-picker');
    const rows = picker.querySelector('.file-picker-rows');
    const addRow = () => {
      const row = document.createElement('div');
      row.className = 'download-input-row';
      row.innerHTML = `<input type="file" name="files" multiple aria-label="Archivos de descarga">
        <button type="button" class="btn secondary" aria-label="Quitar opción de descarga">×</button>
        <div class="file-hint selected-files"></div>`;
      const input = row.querySelector('input');
      input.addEventListener('change', () => {
        input.setCustomValidity(Array.from(input.files).some(file => file.size > 250 * 1024 * 1024) ? 'Cada archivo puede pesar como máximo 250 MB' : '');
        row.querySelector('.selected-files').textContent = Array.from(input.files).map(file => `${file.name} (${formatBytes(file.size)})`).join(' · ');
      });
      row.querySelector('button').onclick = () => {
        row.remove();
        if (!rows.children.length) addRow();
        updateRequired();
      };
      rows.appendChild(row);
      updateRequired();
    };
    const updateRequired = () => rows.querySelectorAll('input').forEach((input, index) => {
      input.required = picker.dataset.required === 'true' && index === 0;
    });
    picker.querySelector('.add-download').onclick = addRow;
    addRow();
  }

  /* ---------- Upload ---------- */
  async function renderUpload() {
    await loadCategories();
    adminMain.innerHTML = `
      <h3>subir obra</h3>
      <form id="uploadForm" class="upload-form">
        <div class="form-group">
          <label for="uploadTitle">título</label>
          <input id="uploadTitle" type="text" name="title" maxlength="300" required placeholder="título de la obra">
        </div>
        <div class="form-group">
          <label for="uploadAuthor">autor</label>
          <input id="uploadAuthor" type="text" name="author" maxlength="200" required placeholder="autor">
        </div>
        <div class="form-group">
          <label for="uploadYear">año</label>
          <input id="uploadYear" type="number" name="year" inputmode="numeric" placeholder="año de publicación">
        </div>
        <div class="form-group">
          <label for="uploadCategory">categoría</label>
          <select id="uploadCategory" name="category">${renderCatSelect(allCategories)}</select>
          <div class="file-hint">selecciona una categoría o deja sin categoría</div>
        </div>
        <div class="form-group">
          <label for="uploadDescription">descripción</label>
          <textarea id="uploadDescription" name="description" maxlength="20000" rows="4" placeholder="descripción de la obra"></textarea>
        </div>
        <div class="form-group">
          <label>archivos (máx 250mb cada uno · múltiples permitidos)</label>
          ${filePickerHtml(true)}
          <div class="file-hint">puedes subir varios archivos a la vez (ej. epub, pdf, txt de la misma obra)</div>
        </div>
        <div class="form-group">
          <label for="uploadCover">portada (jpg, png, webp, gif · máx. 8 MB · opcional)</label>
          <input id="uploadCover" type="file" name="cover" accept=".jpg,.jpeg,.png,.webp,.gif">
        </div>
        <button type="submit" class="btn primary">subir obra</button>
      </form>
      <div id="uploadMsg" style="margin-top:1rem;"></div>
    `;
    setupFilePicker(document.getElementById('uploadForm'));

    document.getElementById('uploadForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const fd = new FormData(form);
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.textContent = 'subiendo...';
      const msg = document.getElementById('uploadMsg');
      try {
        const res = await fetch('/admin/upload', { method: 'POST', body: fd });
        const data = await res.json();
        if (res.ok) {
          msg.style.color = 'var(--accent)';
          msg.textContent = 'obra subida correctamente';
          form.reset();
          form.querySelectorAll('.selected-files').forEach(element => { element.textContent = ''; });
        } else {
          msg.style.color = 'var(--danger)';
          msg.textContent = data.error || 'error al subir';
        }
      } catch (err) {
        msg.style.color = 'var(--danger)';
        msg.textContent = 'error de red';
      } finally {
        btn.disabled = false;
        btn.textContent = 'subir obra';
      }
    });
  }

  /* ---------- Catalog ---------- */
  async function renderCatalog() {
    await loadCategories();
    adminMain.innerHTML = `
      <h3>catálogo completo</h3>
      <div class="catalog-groups" id="catalogTableWrap">cargando...</div>
    `;
    try {
      const res = await fetch('/admin/works');
      const works = await res.json();
      if (!res.ok) throw new Error('No se pudo cargar el catálogo');
      catalogWorks = works;
      const wrap = document.getElementById('catalogTableWrap');
      if (works.length === 0) {
        wrap.innerHTML = '<p>no hay obras.</p>';
        return;
      }

      let html = '';
      let lastCategory = null;
      const groupedWorks = [...works].sort((a, b) => {
        if (!a.category) return b.category ? 1 : 0;
        if (!b.category) return -1;
        return a.category.localeCompare(b.category, 'es');
      });
      groupedWorks.forEach(w => {
        const category = w.category || 'sin categoría';
        if (category !== lastCategory) {
          html += `<h4 class="cat-title">${escapeHtml(category)}</h4>`;
          lastCategory = category;
        }
        const filesRows = w.files.map(f => `
          <tr role="row">
            <td role="cell" data-label="Archivo">${escapeHtml(f.original_name)}</td>
            <td role="cell" data-label="Formato">${escapeHtml(f.format.toUpperCase() || 'ARCHIVO')}</td>
            <td role="cell" data-label="Tamaño">${formatBytes(f.size)}</td>
            <td role="cell" data-label="Acciones" class="table-actions">
              <a href="${escapeHtml(f.download_url)}" class="btn">descargar</a>
              <button class="btn danger" data-delete-file="${f.id}">eliminar archivo</button>
            </td>
          </tr>
        `).join('');

        const cover = w.cover ? `<img src="${escapeHtml(w.cover)}?t=${Date.now()}" class="admin-work-cover" alt="Portada">` : '<span class="admin-work-cover">—</span>';

        html += `
          <section class="admin-work">
            <div class="admin-work-header">
              ${cover}
              <div class="admin-work-info">
                <h4>${escapeHtml(w.title)}</h4>
                <p>${escapeHtml(w.author)} · ${w.year || '—'} · ${escapeHtml(w.category || 'sin categoría')}</p>
              </div>
              <div class="admin-work-actions">
                <button class="btn secondary" data-edit-work="${w.id}">editar obra</button>
                <button class="btn danger" data-delete-work="${w.id}">eliminar obra</button>
              </div>
            </div>
            ${w.description ? `<p class="admin-work-description">${escapeHtml(w.description)}</p>` : ''}
            <div class="table-wrap" role="region" aria-label="Descargas de ${escapeHtml(w.title)}" tabindex="0">
            <table class="responsive-table download-table" role="table">
              <thead role="rowgroup">
                <tr role="row"><th scope="col" role="columnheader">archivo</th><th scope="col" role="columnheader">formato</th><th scope="col" role="columnheader">tamaño</th><th scope="col" role="columnheader">acciones</th></tr>
              </thead>
              <tbody role="rowgroup">${filesRows}</tbody>
            </table>
            </div>
          </section>
        `;
      });

      wrap.innerHTML = html;
      wrap.querySelectorAll('[data-edit-work]').forEach(button => {
        button.onclick = () => openEditModal(Number(button.dataset.editWork)).catch(error => alertModal('error', error.message));
      });
      wrap.querySelectorAll('[data-delete-file]').forEach(button => {
        button.onclick = () => window.deleteFile(Number(button.dataset.deleteFile));
      });
      wrap.querySelectorAll('[data-delete-work]').forEach(button => {
        button.onclick = () => window.deleteWork(Number(button.dataset.deleteWork));
      });
    } catch (e) {
      document.getElementById('catalogTableWrap').innerHTML = '<p style="color:var(--danger);">error cargando catálogo</p>';
    }
  }

  window.deleteFile = (fileId, onDeleted) => {
    const file = catalogWorks.flatMap(work => work.files).find(file => file.id === fileId);
    confirmModal('eliminar descarga', `¿Quieres eliminar ${file ? file.original_name : 'este archivo'}?`, async () => {
      const res = await fetch(`/admin/files/${fileId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('No se pudo eliminar el archivo');
      if (onDeleted) onDeleted();
      await renderCatalog();
    });
  };

  window.deleteWork = (workId) => {
    const work = catalogWorks.find(work => work.id === workId);
    confirmModal('eliminar obra', `¿Quieres eliminar «${work ? work.title : 'esta obra'}» y todas sus descargas?`, async () => {
      const res = await fetch(`/admin/works/${workId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('No se pudo eliminar la obra');
      await renderCatalog();
    });
  };

  async function openEditModal(workId) {
    const res = await fetch('/admin/works');
    const works = await res.json();
    const w = works.find(x => x.id == workId);
    if (!w) return alertModal('error', 'obra no encontrada');

    const catHtml = renderCatSelect(allCategories, w.category || '');
    const filesHtml = w.files.map(f => `
      <div class="existing-download">
        <span>${escapeHtml(f.original_name)} (${escapeHtml(f.format.toUpperCase())}, ${formatBytes(f.size)})</span>
        <button type="button" class="btn danger" data-delete-file="${f.id}" aria-label="Eliminar descarga">×</button>
      </div>
    `).join('');

    const content = `
      <form id="editForm" class="edit-form">
        <div class="form-group">
          <label for="editTitle">título</label>
          <input id="editTitle" type="text" name="title" maxlength="300" value="${escapeHtml(w.title)}" required>
        </div>
        <div class="form-group">
          <label for="editAuthor">autor</label>
          <input id="editAuthor" type="text" name="author" maxlength="200" value="${escapeHtml(w.author)}" required>
        </div>
        <div class="form-group">
          <label for="editYear">año</label>
          <input id="editYear" type="number" name="year" inputmode="numeric" value="${w.year || ''}">
        </div>
        <div class="form-group">
          <label for="editCategory">categoría</label>
          <select id="editCategory" name="category">${catHtml}</select>
        </div>
        <div class="form-group">
          <label for="editDescription">descripción</label>
          <textarea id="editDescription" name="description" maxlength="20000" rows="4">${escapeHtml(w.description || '')}</textarea>
        </div>
        <div class="form-group">
          <label for="editCover">portada actual (nueva portada: máx. 8 MB)</label>
          <div style="margin-bottom:0.5rem;">
            ${w.cover ? `<img src="${escapeHtml(w.cover)}?t=${Date.now()}" style="width:80px;height:80px;object-fit:cover;border:1px solid var(--border);">` : '<span>sin portada</span>'}
          </div>
          <input id="editCover" type="file" name="cover" accept=".jpg,.jpeg,.png,.webp,.gif">
        </div>
        <div class="form-group">
          <label>archivos actuales</label>
          <div class="existing-downloads">
            ${filesHtml || '<span style="font-size:0.8rem;color:var(--text-muted);">sin archivos</span>'}
          </div>
          <div class="file-hint">agrega más archivos abajo si deseas</div>
        </div>
        <div class="form-group">
          <label>agregar más archivos (opcional)</label>
          ${filePickerHtml(false)}
        </div>
        <div class="modal-actions">
          <button type="button" class="btn secondary" data-close-modal>cancelar</button>
          <button type="submit" class="btn primary">guardar cambios</button>
        </div>
      </form>
    `;

    const backdrop = openModal(content, 'editar obra');
    setupFilePicker(backdrop);
    backdrop.querySelectorAll('[data-delete-file]').forEach(button => {
      button.onclick = () => window.deleteFile(Number(button.dataset.deleteFile), () => button.parentElement.remove());
    });

    document.getElementById('editForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const fd = new FormData(form);
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.textContent = 'guardando...';
      try {
        const res = await fetch(`/admin/works/${workId}`, { method: 'PUT', body: fd });
        const data = await res.json();
        if (res.ok) {
          backdrop.close();
          alertModal('éxito', 'obra actualizada correctamente');
          renderCatalog();
        } else {
          btn.disabled = false;
          btn.textContent = 'guardar cambios';
          alertModal('error', data.error || 'error al actualizar');
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'guardar cambios';
        alertModal('error', 'error de red');
      }
    });
  }

  window.openEditModal = openEditModal;

  /* ---------- Categories ---------- */
  async function renderCategories() {
    await loadCategories();
    adminMain.innerHTML = `
      <h3>gestión de categorías</h3>
      <div style="max-width:400px;">
        <div class="form-group" style="margin-bottom:1rem;">
          <label for="newCatName">Nombre de la categoría</label>
          <input type="text" id="newCatName" maxlength="80" placeholder="nombre de categoría nueva" class="form-input">
        </div>
        <button class="btn primary" id="addCatBtn">agregar categoría</button>
      </div>
      <div class="table-wrap" role="region" aria-label="Categorías existentes" tabindex="0">
      <table class="categories-table">
        <thead>
          <tr><th>nombre</th><th>obras</th><th>acciones</th></tr>
        </thead>
        <tbody id="catList"></tbody>
      </table>
      </div>
    `;

    document.getElementById('addCatBtn').addEventListener('click', async () => {
      const input = document.getElementById('newCatName');
      const name = input.value.trim();
      if (!name) return;
      const res = await fetch('/admin/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      if (res.ok) {
        input.value = '';
        renderCategories();
      } else {
        const data = await res.json();
        alertModal('error', data.error || 'error al agregar');
      }
    });

    loadCatList();
  }

  async function loadCatList() {
    const res = await fetch('/admin/categories');
    const cats = await res.json();
    allCategories = cats;
    const worksRes = await fetch('/admin/works');
    const works = await worksRes.json();
    const tbody = document.getElementById('catList');
    tbody.innerHTML = cats.map(c => {
      const count = works.filter(w => w.category === c.name).length;
      return `<tr>
        <td>${escapeHtml(c.name)}</td>
        <td>${count}</td>
        <td><button class="btn danger" data-delete-category="${c.id}">eliminar</button></td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('[data-delete-category]').forEach(button => {
      button.onclick = () => window.deleteCategory(Number(button.dataset.deleteCategory));
    });
  }

  window.deleteCategory = (id) => {
    const category = allCategories.find(category => category.id === id);
    const name = category ? `«${category.name}»` : 'esta categoría';
    let deleted = false;
    const dialog = confirmModal('eliminar categoría', `¿Estás seguro de que quieres eliminar ${name}?`, async () => {
      const response = await fetch(`/admin/categories/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('No se pudo eliminar la categoría. Inténtalo nuevamente.');
      if (document.getElementById('catList')) await loadCatList();
      deleted = true;
    });
    dialog.addEventListener('close', () => {
      if (deleted) alertModal('categoría eliminada', `La categoría ${name} se eliminó correctamente.`);
    }, { once: true });
  };

  /* ---------- Traffic ---------- */
  const trafficCategories = {
    browser: { label: 'Navegador probable', color: '#17c987' },
    bot: { label: 'Bot declarado', color: '#e8b354' },
    automated: { label: 'Automatizado probable', color: '#729dff' },
    suspicious: { label: 'Sospechoso', color: '#ff5c70' },
    unknown: { label: 'Sin clasificar', color: '#929292' }
  };
  const trafficTypes = { page: 'Portada', download: 'Descarga', api: 'API', asset: 'Recurso', admin: 'Admin', other: 'Otra ruta' };
  const integer = value => new Intl.NumberFormat('es').format(value || 0);
  function countryFlag(code) {
    return typeof code === 'string' && /^[A-Z]{2}$/.test(code)
      ? String.fromCodePoint(...[...code].map(letter => 127397 + letter.charCodeAt(0))) : '🌐';
  }
  function flagHtml(code, country) {
    const label = country || 'Sin geolocalización';
    return `<span class="country-flag" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${countryFlag(code)}</span>`;
  }
  function trafficDate(value) {
    const date = new Date(String(value).replace(' ', 'T') + (/Z$/.test(value) ? '' : 'Z'));
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('es', { dateStyle: 'short', timeStyle: 'medium' }).format(date);
  }

  async function renderStats() {
    const metrics = [
      ['requests', 'Solicitudes registradas'], ['pageViews', 'Páginas de inicio'],
      ['browserPageViews', 'Páginas de navegador probable'], ['jsPageViews', 'Páginas con señal JavaScript'],
      ['automationRequests', 'Bots + automatización'], ['suspiciousRequests', 'Solicitudes sospechosas'],
      ['uniqueIps', 'IPs distintas'], ['downloadRequests', 'Solicitudes de descarga'], ['measuredBytes', 'Bytes de respuesta medidos']
    ];
    adminMain.innerHTML = `
      <h3>tráfico y visitas</h3>
      <p class="traffic-explanation">Una solicitud no equivale a una persona. La clasificación combina User-Agent, cabeceras, señal JavaScript y patrones de actividad; es una estimación, no una verificación de identidad.</p>
      <form id="trafficFilters" class="traffic-filters">
        <label>Período (UTC)<select name="days"><option value="1">Hoy</option><option value="7" selected>Últimos 7 días</option><option value="30">Últimos 30 días</option><option value="90">Últimos 90 días</option></select></label>
        <label>Clasificación<select name="category"><option value="">Todo el tráfico</option>${Object.entries(trafficCategories).map(([key, item]) => `<option value="${key}">${item.label}</option>`).join('')}</select></label>
        <label>Tipo de petición<select name="type"><option value="">Todos los tipos</option>${Object.entries(trafficTypes).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label>
        <label>IP exacta<input name="ip" type="search" maxlength="45" placeholder="IPv4 o IPv6" autocomplete="off"></label>
        <button class="btn primary" type="submit">actualizar</button>
      </form>
      <div class="traffic-toolbar"><label><input type="checkbox" id="trafficAutoRefresh" checked> Actualizar cada 30 s</label><span id="trafficConnection">Tu conexión: cargando…</span></div>
      <p id="trafficStatus" class="traffic-status" role="status" aria-live="polite"></p>
      <div class="stats-grid traffic-metrics">${metrics.map(([key, label]) => `<div class="stat-card"><h4>${label}</h4><div class="value" data-metric="${key}" ${key === 'requests' ? 'id="totalVisits"' : ''}>—</div></div>`).join('')}</div>
      <p id="trafficLegacyNotice" class="traffic-notice" hidden></p>
      <div class="traffic-charts">
        <div class="chart-wrap traffic-chart-wide"><canvas id="chartDay" aria-label="Solicitudes diarias por clasificación" role="img"></canvas></div>
        <div class="chart-wrap"><canvas id="chartClassification" aria-label="Distribución de tráfico" role="img"></canvas></div>
        <div class="chart-wrap"><canvas id="chartCountry" aria-label="Solicitudes por país" role="img"></canvas></div>
      </div>
      <p class="traffic-explanation">Se excluyen healthchecks, la señal JavaScript y consultas autenticadas del panel. IPs distintas no significa personas distintas. Las solicitudes de descarga pueden incluir rangos parciales; no certifican una lectura completa. 🌐 indica ubicación no disponible. País al pasar el cursor sobre la bandera. Fechas de tabla en tu zona horaria; gráficas por día UTC.</p>
      <p class="table-scroll-hint">Puedes deslizar la tabla horizontalmente para consultar todas las columnas.</p>
      <div class="table-wrap" role="region" aria-label="Solicitudes de tráfico" tabindex="0"><table id="trafficTable" class="traffic-table responsive-table" role="table"><thead role="rowgroup"><tr role="row">
        <th scope="col" role="columnheader">IP</th><th scope="col" role="columnheader">País</th><th scope="col" role="columnheader">Ciudad</th><th scope="col" role="columnheader">Región</th><th scope="col" role="columnheader">ISP</th><th scope="col" role="columnheader">Clasificación</th><th scope="col" role="columnheader">Petición</th><th scope="col" role="columnheader">Respuesta</th><th scope="col" role="columnheader">Agente / señal</th><th scope="col" role="columnheader">Fecha</th>
      </tr></thead><tbody id="ipTableBody" role="rowgroup"></tbody></table></div>
      <div class="traffic-pagination"><button class="btn secondary" id="trafficPrevious" type="button">← anterior</button><span id="trafficPage"></span><button class="btn secondary" id="trafficNext" type="button">siguiente →</button></div>
    `;
    let currentPage = 1;
    const form = document.getElementById('trafficFilters');
    const load = async (requestedPage = 1) => {
      const sequence = ++statsSequence;
      const status = document.getElementById('trafficStatus');
      status.textContent = 'Cargando tráfico…';
      const params = new URLSearchParams(new FormData(form));
      params.set('page', requestedPage);
      try {
        const response = await fetch('/admin/stats?' + params.toString());
        const stats = await response.json();
        if (!response.ok) throw new Error(stats.error || 'No se pudo cargar el tráfico');
        if (sequence !== statsSequence || !document.getElementById('trafficTable')) return;
        currentPage = stats.page;
        lastTrafficStats = stats;
        const values = { ...stats.counts, automationRequests: stats.byCategory.filter(row => ['bot', 'automated'].includes(row.category)).reduce((sum, row) => sum + row.c, 0) };
        document.querySelectorAll('[data-metric]').forEach(element => {
          const key = element.dataset.metric;
          element.textContent = key === 'measuredBytes' ? formatBytes(values[key]) : integer(values[key]);
        });
        const notice = document.getElementById('trafficLegacyNotice');
        notice.hidden = !stats.counts.legacyRows && !stats.droppedEvents;
        notice.textContent = [
          stats.counts.legacyRows ? `${integer(stats.counts.legacyRows)} registros históricos no tenían cabeceras ni estado HTTP: se conservan sin clasificar y no permiten reconstruir todas las solicitudes anteriores.` : '',
          stats.droppedEvents ? `${integer(stats.droppedEvents)} solicitudes omitidas por saturación del registro desde el último reinicio; los contadores representan solo los registros guardados.` : ''
        ].filter(Boolean).join(' ');
        renderTrafficRows(stats.recent);
        renderTrafficCharts(stats);
        document.getElementById('trafficPage').textContent = `Página ${stats.page} de ${stats.pages} · ${integer(stats.total)} registros`;
        document.getElementById('trafficPrevious').disabled = stats.page <= 1;
        document.getElementById('trafficNext').disabled = stats.page >= stats.pages;
        status.textContent = `Actualizado: ${new Date().toLocaleTimeString('es')} · contadores y gráficas según los filtros seleccionados`;
      } catch (error) {
        if (sequence === statsSequence && status.isConnected) status.textContent = error.message;
      }
    };
    form.addEventListener('submit', event => { event.preventDefault(); load(1); });
    form.querySelectorAll('select').forEach(select => select.addEventListener('change', () => load(1)));
    document.getElementById('trafficPrevious').onclick = () => load(currentPage - 1);
    document.getElementById('trafficNext').onclick = () => load(currentPage + 1);
    statsRefreshTimer = setInterval(() => {
      if (!document.hidden && document.getElementById('trafficAutoRefresh')?.checked) load(currentPage);
    }, 30000);
    fetch('/admin/ip-info').then(response => response.ok ? response.json() : null).then(info => {
      const connection = document.getElementById('trafficConnection');
      if (connection && info) connection.innerHTML = `Tu conexión: <code>${escapeHtml(info.ip)}</code> ${flagHtml(info.country_code, info.country)} ${escapeHtml(info.city)}`;
    }).catch(() => {
      const connection = document.getElementById('trafficConnection');
      if (connection) connection.textContent = 'Tu conexión: ubicación no disponible';
    });
    await load();
  }

  function renderTrafficRows(rows) {
    const tbody = document.getElementById('ipTableBody');
    tbody.innerHTML = rows.length ? rows.map(row => {
      const category = Object.hasOwn(trafficCategories, row.classification) ? row.classification : 'unknown';
      const status = Number.isInteger(row.status_code) ? row.status_code : null;
      return `<tr role="row">
        <td role="cell" data-label="IP"><code class="traffic-ip">${escapeHtml(row.ip)}</code>${row.source === 'legacy' ? '<small class="traffic-muted">histórico</small>' : ''}</td>
        <td role="cell" data-label="País" class="traffic-country">${flagHtml(row.country_code, row.country)}</td>
        <td role="cell" data-label="Ciudad">${escapeHtml(row.city || '—')}</td><td role="cell" data-label="Región">${escapeHtml(row.region || '—')}</td><td role="cell" data-label="ISP">${escapeHtml(row.isp || '—')}</td>
        <td role="cell" data-label="Clasificación"><span class="traffic-badge traffic-${category}">${trafficCategories[category].label}</span><small class="traffic-reason">${escapeHtml(row.classification_reason)}</small></td>
        <td role="cell" data-label="Petición"><strong>${escapeHtml(row.method || '—')}</strong> <code class="traffic-path">${escapeHtml(row.page || '/')}</code><small>${escapeHtml(trafficTypes[row.request_type] || 'Otra ruta')}</small>${row.referrer ? `<small class="traffic-muted">Desde: ${escapeHtml(row.referrer)}</small>` : ''}</td>
        <td role="cell" data-label="Respuesta"><span class="traffic-http ${status >= 400 ? 'traffic-http-error' : ''}">${status || '—'}${row.aborted ? ' · interrumpida' : ''}</span><small>${row.duration_ms === null ? '—' : integer(row.duration_ms) + ' ms'}</small><small>${row.response_bytes === null ? 'bytes no medidos' : formatBytes(row.response_bytes)}</small></td>
        <td role="cell" data-label="Agente / señal">${row.js_confirmed ? '<span class="traffic-js">JS recibido</span>' : '<span class="traffic-muted">Sin señal JS</span>'}<details><summary>Ver agente</summary><code class="traffic-agent">${escapeHtml(row.user_agent || 'No disponible')}</code></details></td>
        <td role="cell" data-label="Fecha" class="traffic-date">${escapeHtml(trafficDate(row.visited_at))}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="10" class="empty-state">No hay solicitudes que coincidan con estos filtros.</td></tr>';
  }

  function renderTrafficCharts(stats) {
    if (typeof Chart === 'undefined') return;
    for (const chart of [chartCountry, chartDay, chartClassification]) if (chart) chart.destroy();
    const styles = getComputedStyle(document.documentElement);
    const color = styles.getPropertyValue('--text').trim();
    const grid = styles.getPropertyValue('--border').trim();
    const plugins = title => ({ legend: { labels: { color, font: { family: 'IBM Plex Mono', size: 12 } } }, title: { display: true, text: title.length > 32 ? ['Solicitudes por día', 'y clasificación (UTC)'] : title, color, font: { family: 'IBM Plex Mono', size: 12 } } });
    const base = { responsive: true, maintainAspectRatio: false, animation: false };
    chartClassification = new Chart(document.getElementById('chartClassification'), {
      type: 'doughnut', data: {
        labels: stats.byCategory.map(row => trafficCategories[row.category].label),
        datasets: [{ data: stats.byCategory.map(row => row.c), backgroundColor: stats.byCategory.map(row => trafficCategories[row.category].color), borderWidth: 0 }]
      }, options: { ...base, plugins: { ...plugins('Clasificación de solicitudes'), legend: { position: 'bottom', labels: { color, font: { family: 'IBM Plex Mono', size: 12 } } } } }
    });
    chartCountry = new Chart(document.getElementById('chartCountry'), {
      type: 'bar', data: { labels: stats.byCountry.map(row => countryFlag(row.country_code)), datasets: [{ data: stats.byCountry.map(row => row.c), backgroundColor: styles.getPropertyValue('--accent').trim() }] },
      options: { ...base, plugins: { ...plugins('Solicitudes por país'), legend: { display: false }, tooltip: { callbacks: { title: items => { const row = stats.byCountry[items[0].dataIndex]; return `${countryFlag(row.country_code)} ${row.country}`; } } } },
        scales: { y: { beginAtZero: true, ticks: { color, precision: 0 }, grid: { color: grid } }, x: { ticks: { color, font: { size: 20 } }, grid: { display: false } } } }
    });
    const start = new Date(stats.since.replace(' ', 'T') + 'Z');
    const days = Array.from({ length: stats.days }, (_, index) => {
      const day = new Date(start); day.setUTCDate(day.getUTCDate() + index); return day.toISOString().slice(0, 10);
    });
    chartDay = new Chart(document.getElementById('chartDay'), {
      type: 'bar', data: {
        labels: days,
        datasets: Object.entries(trafficCategories).map(([category, item]) => ({ label: item.label, backgroundColor: item.color,
          data: days.map(day => stats.byDay.find(row => row.day === day && row.classification === category)?.c || 0) }))
      }, options: { ...base, plugins: plugins('Solicitudes por día y clasificación (UTC)'),
        scales: { y: { stacked: true, beginAtZero: true, ticks: { color, precision: 0 }, grid: { color: grid } }, x: { stacked: true, ticks: { color, maxTicksLimit: 14 }, grid: { display: false } } } }
    });
  }

  showSection('subir');
})();
