(function () {
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

  const rotaryTexts = [
    'デッド・スマイル・ライブラリー',
    'UNA COSA ROTA A LA VEZ',
    'EL CONOCIMIENTO SE COMPARTE',
    'HARUHI SE ESTÁ ABURRIENDO',
    'EL DENPA NOS MANTIENE VIVOS',
    'QUE MI SEÑAL LLEGUE A TODOS',
    'R.I.P. RYU MURAKAMI',
    'LARP LARP LARP SAHUR',
    'QUE VIVAN LAS FERIAS LIBRES',
    'LAIN ESTABA EN LO CORRECTO',
    'TE EXTRAÑAMOS SATOSHI KON',
    'QUESTION EVERYTHING',
    'LOVE YOUR CHAOS',
    'LLENAR DE STICKERS EL THINKPAD',
    'VEAN LEGO BATMAN ES UNA EXCELENTE PELÍCULA',
    'ISRAEL ESTADO ILEGÍTIMO',
    'NOVELAS VISUALES, CAFÉ Y GATOS',
    '୧((#Φ益Φ#))୨ ୧((#Φ益Φ#))୨ ୧((#Φ益Φ#))୨ ୧((#Φ益Φ#))୨',
    'ヽ(￣～￣　)ノ σ(￣、￣〃) (・∀・)ノ'
  ];

  const rotaryEl = document.getElementById('rotaryText');
  let idx = -1;

  function typeWriter(text, cb) {
    let i = 0;
    rotaryEl.textContent = '';
    const cursor = document.createElement('span');
    cursor.className = 'rotary-cursor';
    cursor.textContent = '█';
    rotaryEl.appendChild(cursor);
    function step() {
      if (i < text.length) {
        rotaryEl.textContent = text.slice(0, i);
        rotaryEl.appendChild(cursor);
        i++;
        setTimeout(step, 40);
      } else {
        rotaryEl.textContent = text;
        rotaryEl.appendChild(cursor);
        setTimeout(() => {
          eraseWriter(() => cb());
        }, 5000);
      }
    }
    step();
  }

  function eraseWriter(cb) {
    const text = rotaryEl.textContent.replace('█', '');
    let i = text.length;
    function step() {
      if (i > 0) {
        rotaryEl.textContent = text.slice(0, i - 1);
        rotaryEl.appendChild(document.createElement('span'));
        rotaryEl.lastChild.className = 'rotary-cursor';
        rotaryEl.lastChild.textContent = '█';
        i--;
        setTimeout(step, 25);
      } else {
        cb();
      }
    }
    step();
  }

  function next() {
    idx = idx < 0
      ? Math.floor(Math.random() * rotaryTexts.length)
      : (idx + 1 + Math.floor(Math.random() * (rotaryTexts.length - 1))) % rotaryTexts.length;
    const text = rotaryTexts[idx];
    typeWriter(text, () => {
      setTimeout(next, 500);
    });
  }

  next();

  const grid = document.getElementById('catalogGrid');
  const emptyState = document.getElementById('emptyState');
  const fileCount = document.getElementById('fileCount');
  const orderSelect = document.getElementById('orderSelect');
  const catSelect = document.getElementById('catSelect');
  const catFilters = document.getElementById('catFilters');

  let currentOrder = 'desc';
  let currentCat = '';
  let allWorks = [];
  let categories = [];

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

  async function loadCategories() {
    try {
      const res = await fetch('/api/categories');
      if (res.ok) {
        categories = await res.json();
        renderCatFilters();
        renderCatSelect();
      }
    } catch (e) {}
  }

  async function loadWorks() {
    try {
      const params = new URLSearchParams({ order: currentOrder });
      const res = await fetch('/api/works?' + params.toString());
      if (!res.ok) throw new Error('No se pudo cargar el catálogo');
      allWorks = await res.json();
      renderCatSelect();
      render(allWorks.filter(work => !currentCat || work.category === currentCat));
    } catch (e) {
      grid.innerHTML = '<p style="color:var(--danger);">error cargando el catálogo</p>';
    }
  }

  function renderCatFilters() {
    catFilters.innerHTML = '';
    const btnAll = document.createElement('button');
    btnAll.className = 'btn cat-btn' + (currentCat ? '' : ' active');
    btnAll.textContent = 'todas';
    btnAll.onclick = () => setCat('', btnAll);
    catFilters.appendChild(btnAll);

    const worksByCat = new Set();
    allWorks.forEach(w => {
      if (w.category && w.files.length) worksByCat.add(w.category);
    });

    for (const c of categories) {
      if (!worksByCat.has(c.name)) continue;
      const btn = document.createElement('button');
      btn.className = 'btn cat-btn' + (currentCat === c.name ? ' active' : '');
      btn.setAttribute('aria-pressed', String(currentCat === c.name));
      btn.textContent = c.name;
      btn.onclick = () => setCat(c.name, btn);
      catFilters.appendChild(btn);
    }
  }

  function renderCatSelect() {
    catSelect.innerHTML = '<option value="">todas las categorías</option>';
    for (const c of categories) {
      if (!allWorks.some(work => work.category === c.name && work.files.length)) continue;
      const opt = document.createElement('option');
      opt.value = c.name;
      opt.textContent = c.name;
      catSelect.appendChild(opt);
    }
    catSelect.value = currentCat;
  }

  function setCat(cat, btn) {
    currentCat = cat;
    catSelect.value = cat;
    render(allWorks.filter(work => !cat || work.category === cat));
  }

  orderSelect.addEventListener('change', (e) => {
    currentOrder = e.target.value;
    loadWorks();
  });

  catSelect.addEventListener('change', (e) => {
    setCat(e.target.value);
  });

  function openDetailModal(workId) {
    const work = allWorks.find(w => w.id == workId);
    if (!work) return;
    const filesHtml = work.files.map(f => `
      <div class="detail-file">
        <span class="detail-file-name">${escapeHtml(f.original_name)}</span>
        <span class="detail-file-format">${escapeHtml(f.format.toUpperCase() || 'ARCHIVO')}</span>
        <span class="detail-file-size">${formatBytes(f.size)}</span>
        <a href="${escapeHtml(f.download_url)}" class="btn">descargar ${escapeHtml(f.format.toUpperCase() || 'archivo')}</a>
      </div>
    `).join('');

    const content = `
      <div class="detail-body">
        ${work.cover ? `<img src="${escapeHtml(work.cover)}?t=${Date.now()}" class="detail-cover" alt="portada">` : '<div class="detail-cover-placeholder">sin portada</div>'}
        <div class="detail-info">
          <h2 class="detail-title" id="detailTitle">${escapeHtml(work.title)}</h2>
          <div class="detail-meta"><strong>autor:</strong> ${escapeHtml(work.author)}</div>
          <div class="detail-meta"><strong>año:</strong> ${work.year || '—'}</div>
          <div class="detail-meta"><strong>categoría:</strong> ${escapeHtml(work.category || '—')}</div>
          <div class="detail-meta"><strong>subido:</strong> ${escapeHtml(work.uploaded_at)}</div>
          <div class="detail-meta"><strong>archivos:</strong> ${work.files.length}</div>
          <div class="detail-meta"><strong>tamaño total:</strong> ${formatBytes(work.files.reduce((total, file) => total + file.size, 0))}</div>
          <div class="detail-desc">
            <strong>descripción:</strong><br>
            ${escapeHtml(work.description || 'sin descripción')}
          </div>
          <div class="detail-files">
            <strong>descargas disponibles:</strong>
            ${filesHtml}
          </div>
        </div>
      </div>
    `;

    const backdrop = document.createElement('dialog');
    backdrop.className = 'detail-dialog';
    backdrop.setAttribute('aria-labelledby', 'detailTitle');
    backdrop.innerHTML = `
      <div class="modal detail-modal">
        <div class="modal-header">
          <h3 class="modal-title">detalle de la obra</h3>
          <button class="modal-close" aria-label="Cerrar detalle" autofocus>&times;</button>
        </div>
        <div class="modal-body" style="padding:0;">${content}</div>
      </div>
    `;
    document.body.appendChild(backdrop);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    backdrop.addEventListener('close', () => {
      document.body.style.overflow = previousOverflow;
      backdrop.remove();
    }, { once: true });
    const close = () => backdrop.close();
    backdrop.querySelector('.modal-close').onclick = close;
    backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
    backdrop.showModal();
  }

  function render(works) {
    fileCount.textContent = works.length + ' archivos';
    renderCatFilters();
    if (works.length === 0) {
      grid.style.display = 'none';
      emptyState.style.display = 'block';
      return;
    }
    grid.style.display = 'grid';
    emptyState.style.display = 'none';

    grid.innerHTML = works.map(w => {
      const totalSize = w.files.reduce((sum, f) => sum + f.size, 0);
      return `
        <article class="card work-card" data-work-id="${w.id}" tabindex="0" aria-label="Ver detalles de ${escapeHtml(w.title)}">
          <div class="card-cover">
            ${w.cover ? `<img src="${escapeHtml(w.cover)}" alt="portada de ${escapeHtml(w.title)}" loading="lazy">` : '<div class="card-cover-placeholder">sin portada</div>'}
            ${w.category ? `<span class="cat-badge">${escapeHtml(w.category)}</span>` : ''}
          </div>
          <div class="card-body">
            <div class="card-title">${escapeHtml(w.title)}</div>
            <div class="card-meta"><strong>autor:</strong> ${escapeHtml(w.author)}</div>
            <div class="card-meta"><strong>año:</strong> ${w.year || '—'}</div>
            <div class="card-meta"><strong>formato(s):</strong> ${w.files.map(f => escapeHtml(f.format.toUpperCase() || 'ARCHIVO')).join(' · ')}</div>
            <div class="card-meta"><strong>tamaño:</strong> ${formatBytes(totalSize)}</div>
          </div>
        </article>
      `;
    }).join('');
  }

  grid.addEventListener('click', event => {
    if (event.target.closest('a')) return;
    const card = event.target.closest('[data-work-id]');
    if (card) openDetailModal(Number(card.dataset.workId));
  });
  grid.addEventListener('keydown', event => {
    if (event.target.matches('[data-work-id]') && ['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      openDetailModal(Number(event.target.dataset.workId));
    }
  });

  // Exponer para onclick en HTML
  window.openDetailModal = openDetailModal;

  loadCategories();
  loadWorks();
})();
