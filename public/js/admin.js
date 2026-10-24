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

  const savedTheme = localStorage.getItem('ds_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  themeLabel.textContent = savedTheme === 'dark' ? 'oscuro' : 'claro';

  themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('ds_theme', next);
    themeLabel.textContent = next === 'dark' ? 'oscuro' : 'claro';
  });

  const adminMain = document.getElementById('adminMain');
  let chartCountry = null;
  let chartDay = null;
  let allCategories = [];
  let catalogWorks = [];

  async function showSection(name) {
    document.querySelectorAll('.admin-sidebar a').forEach(a => {
      a.style.border = '1px solid transparent';
      a.style.background = 'transparent';
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
  function openModal(contentHtml, title) {
    const backdrop = document.createElement('dialog');
    backdrop.className = 'modal-backdrop admin-dialog';
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
    document.body.appendChild(backdrop);
    const close = () => backdrop.close();
    document.body.style.overflow = 'hidden';
    backdrop.addEventListener('close', () => {
      backdrop.remove();
      document.body.style.overflow = document.querySelector('dialog[open]') ? 'hidden' : '';
    }, { once: true });
    backdrop.querySelector('.modal-close').onclick = close;
    backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
    backdrop.addEventListener('click', event => { if (event.target.closest('[data-close-modal]')) close(); });
    backdrop.showModal();
    return backdrop;
  }

  function alertModal(title, message) {
    return openModal(`
      <div style="text-align:center; padding:1rem 0;">
        <div style="font-size:1.1rem; color:var(--text); margin-bottom:1rem;">${escapeHtml(message)}</div>
        <button class="btn primary" data-close-modal>aceptar</button>
      </div>
    `, title);
  }

  function confirmModal(title, message, onConfirm) {
    const dialog = openModal(`
      <div style="text-align:center; padding:1rem 0;">
        <div style="font-size:1.1rem; color:var(--text); margin-bottom:0.5rem;">${escapeHtml(message)}</div>
        <div style="color:var(--text-muted); font-size:0.9rem; margin-bottom:1.5rem;">esta acción no se puede deshacer.</div>
        <div style="display:flex; gap:0.75rem; justify-content:center;">
          <button type="button" class="btn secondary" data-close-modal>cancelar</button>
          <button type="button" class="btn danger" data-confirm>eliminar</button>
        </div>
      </div>
    `, title);
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
          <label>título</label>
          <input type="text" name="title" required placeholder="título de la obra">
        </div>
        <div class="form-group">
          <label>autor</label>
          <input type="text" name="author" required placeholder="autor">
        </div>
        <div class="form-group">
          <label>año</label>
          <input type="number" name="year" placeholder="año de publicación">
        </div>
        <div class="form-group">
          <label>categoría</label>
          <select name="category">${renderCatSelect(allCategories)}</select>
          <div class="file-hint">selecciona una categoría o deja sin categoría</div>
        </div>
        <div class="form-group">
          <label>descripción</label>
          <textarea name="description" rows="3" placeholder="descripción de la obra"></textarea>
        </div>
        <div class="form-group">
          <label>archivos (máx 250mb cada uno · múltiples permitidos)</label>
          ${filePickerHtml(true)}
          <div class="file-hint">puedes subir varios archivos a la vez (ej. epub, pdf, txt de la misma obra)</div>
        </div>
        <div class="form-group">
          <label>portada (jpg, png, webp, gif · máx. 8 MB · opcional)</label>
          <input type="file" name="cover" accept=".jpg,.jpeg,.png,.webp,.gif">
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
      <div class="table-wrap" id="catalogTableWrap">cargando...</div>
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
          <tr>
            <td>${escapeHtml(f.original_name)}</td>
            <td>${escapeHtml(f.format.toUpperCase() || 'ARCHIVO')}</td>
            <td>${formatBytes(f.size)}</td>
            <td>
              <a href="${escapeHtml(f.download_url)}" class="btn" style="padding:0.2rem 0.5rem;font-size:0.75rem;">descargar</a>
              <button class="btn danger" style="padding:0.2rem 0.5rem;font-size:0.75rem;" data-delete-file="${f.id}">eliminar archivo</button>
            </td>
          </tr>
        `).join('');

        const cover = w.cover ? `<img src="${escapeHtml(w.cover)}?t=${Date.now()}" style="width:48px;height:48px;object-fit:cover;border:1px solid var(--border);">` : '<span>—</span>';

        html += `
          <div class="cat-section" style="margin-bottom:1.5rem;border:1px solid var(--border);padding:1rem;">
            <div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap;">
              ${cover}
              <div>
                <div style="font-weight:bold;color:var(--accent);">${escapeHtml(w.title)}</div>
                <div style="font-size:0.85rem;color:var(--text-muted);">${escapeHtml(w.author)} · ${w.year || '—'} · ${escapeHtml(w.category || 'sin categoría')}</div>
              </div>
              <div style="margin-left:auto;display:flex;gap:0.5rem;">
                <button class="btn secondary" style="padding:0.3rem 0.7rem;font-size:0.75rem;" data-edit-work="${w.id}">editar obra</button>
                <button class="btn danger" style="padding:0.3rem 0.7rem;font-size:0.75rem;" data-delete-work="${w.id}">eliminar obra</button>
              </div>
            </div>
            ${w.description ? `<div style="margin-top:0.5rem;font-size:0.85rem;color:var(--text-muted);">${escapeHtml(w.description)}</div>` : ''}
            <table style="width:100%;margin-top:0.75rem;font-size:0.8rem;">
              <thead>
                <tr><th>archivo</th><th>formato</th><th>tamaño</th><th>acciones</th></tr>
              </thead>
              <tbody>${filesRows}</tbody>
            </table>
          </div>
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
      <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.5rem;">
        <span style="font-size:0.8rem;">${escapeHtml(f.original_name)} (${escapeHtml(f.format.toUpperCase())}, ${formatBytes(f.size)})</span>
        <button type="button" class="btn danger" style="padding:0.15rem 0.4rem;font-size:0.7rem;" data-delete-file="${f.id}" aria-label="Eliminar descarga">×</button>
      </div>
    `).join('');

    const content = `
      <form id="editForm" style="display:flex; flex-direction:column; gap:1rem; max-width:700px;">
        <div class="form-group">
          <label>título</label>
          <input type="text" name="title" value="${escapeHtml(w.title)}" required>
        </div>
        <div class="form-group">
          <label>autor</label>
          <input type="text" name="author" value="${escapeHtml(w.author)}" required>
        </div>
        <div class="form-group">
          <label>año</label>
          <input type="number" name="year" value="${w.year || ''}">
        </div>
        <div class="form-group">
          <label>categoría</label>
          <select name="category">${catHtml}</select>
        </div>
        <div class="form-group">
          <label>descripción</label>
          <textarea name="description" rows="3">${escapeHtml(w.description || '')}</textarea>
        </div>
        <div class="form-group">
          <label>portada actual (nueva portada: máx. 8 MB)</label>
          <div style="margin-bottom:0.5rem;">
            ${w.cover ? `<img src="${escapeHtml(w.cover)}?t=${Date.now()}" style="width:80px;height:80px;object-fit:cover;border:1px solid var(--border);">` : '<span>sin portada</span>'}
          </div>
          <input type="file" name="cover" accept=".jpg,.jpeg,.png,.webp,.gif">
        </div>
        <div class="form-group">
          <label>archivos actuales</label>
          <div style="max-height:150px;overflow-y:auto;border:1px solid var(--border);padding:0.5rem;background:var(--input-bg);">
            ${filesHtml || '<span style="font-size:0.8rem;color:var(--text-muted);">sin archivos</span>'}
          </div>
          <div class="file-hint">agrega más archivos abajo si deseas</div>
        </div>
        <div class="form-group">
          <label>agregar más archivos (opcional)</label>
          ${filePickerHtml(false)}
        </div>
        <div style="display:flex; gap:0.75rem; justify-content:flex-end;">
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
          <input type="text" id="newCatName" placeholder="nombre de categoría nueva" class="form-input">
        </div>
        <button class="btn primary" id="addCatBtn">agregar categoría</button>
      </div>
      <table style="margin-top:1.5rem;">
        <thead>
          <tr><th>nombre</th><th>obras</th><th>acciones</th></tr>
        </thead>
        <tbody id="catList"></tbody>
      </table>
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
        <td><button class="btn danger" style="padding:0.2rem 0.5rem;font-size:0.75rem;" data-delete-category="${c.id}">eliminar</button></td>
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

  /* ---------- Stats ---------- */
  async function renderStats() {
    adminMain.innerHTML = `
      <h3>ip y estadísticas de visitantes</h3>
      <div class="stats-grid" id="statsGrid">
        <div class="stat-card"><h4>visitas totales</h4><div class="value" id="totalVisits">—</div></div>
        <div class="stat-card"><h4>ip actual</h4><div class="value" id="currentIp">—</div></div>
        <div class="stat-card"><h4>país actual</h4><div class="value" id="currentCountry">—</div></div>
        <div class="stat-card"><h4>ciudad actual</h4><div class="value" id="currentCity">—</div></div>
      </div>
      <div class="chart-wrap">
        <canvas id="chartCountry"></canvas>
      </div>
      <div class="chart-wrap">
        <canvas id="chartDay"></canvas>
      </div>
      <div class="table-wrap ip-table">
        <table>
          <thead>
            <tr><th>ip</th><th>país</th><th>ciudad</th><th>región</th><th>isp</th><th>fecha</th></tr>
          </thead>
          <tbody id="ipTableBody"></tbody>
        </table>
      </div>
    `;

    try {
      const [statsRes, ipRes] = await Promise.all([
        fetch('/admin/stats'),
        fetch('/admin/ip-info')
      ]);
      const stats = await statsRes.json();
      const ipInfo = await ipRes.json();

      document.getElementById('totalVisits').textContent = stats.total;
      document.getElementById('currentIp').textContent = ipInfo.ip;
      document.getElementById('currentCountry').textContent = ipInfo.country;
      document.getElementById('currentCity').textContent = ipInfo.city;

      renderCountryChart(stats.byCountry);
      renderDayChart(stats.byDay);

      const tbody = document.getElementById('ipTableBody');
      tbody.innerHTML = stats.recent.map(v => {
        const isLocal = v.ip === '127.0.0.1' || v.ip.startsWith('::1') || v.ip.startsWith('192.168.') || v.ip.startsWith('10.');
        return `<tr>
          <td><span class="badge ${isLocal ? 'local' : 'remote'}">${escapeHtml(v.ip)}</span></td>
          <td>${escapeHtml(v.country || '—')}</td>
          <td>${escapeHtml(v.city || '—')}</td>
          <td>${escapeHtml(v.region || '—')}</td>
          <td>${escapeHtml(v.isp || '—')}</td>
          <td>${escapeHtml(v.visited_at)}</td>
        </tr>`;
      }).join('');
    } catch (e) {
      console.error(e);
    }
  }

  function renderCountryChart(data) {
    const ctx = document.getElementById('chartCountry').getContext('2d');
    if (chartCountry) chartCountry.destroy();
    chartCountry = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map(d => d.country),
        datasets: [{
          label: 'visitas por país',
          data: data.map(d => d.c),
          backgroundColor: '#00ff41',
          borderColor: '#00aa2b',
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, title: { display: true, text: 'visitas por país', color: '#e0e0e0', font: { family: 'Courier New' } } },
        scales: {
          y: { beginAtZero: true, ticks: { color: '#888' }, grid: { color: '#222' } },
          x: { ticks: { color: '#888' }, grid: { display: false } }
        }
      }
    });
  }

  function renderDayChart(data) {
    const ctx = document.getElementById('chartDay').getContext('2d');
    if (chartDay) chartDay.destroy();
    chartDay = new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.map(d => d.day),
        datasets: [{
          label: 'visitas por día',
          data: data.map(d => d.c),
          borderColor: '#00ff41',
          backgroundColor: 'rgba(0, 255, 65, 0.1)',
          fill: true,
          tension: 0.3,
          pointBackgroundColor: '#00ff41'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, title: { display: true, text: 'visitas por día (últimos 14)', color: '#e0e0e0', font: { family: 'Courier New' } } },
        scales: {
          y: { beginAtZero: true, ticks: { color: '#888' }, grid: { color: '#222' } },
          x: { ticks: { color: '#888' }, grid: { display: false } }
        }
      }
    });
  }

  showSection('subir');
})();
