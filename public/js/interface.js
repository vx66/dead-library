(function () {
  function getTheme() {
    try { return localStorage.getItem('ds_theme') === 'light' ? 'light' : 'dark'; }
    catch (_) { return 'dark'; }
  }
  function setTheme(theme, { persist = true } = {}) {
    document.documentElement.setAttribute('data-theme', theme);
    if (persist) { try { localStorage.setItem('ds_theme', theme); } catch (_) {} }
  }
  setTheme(getTheme(), { persist: false });

  const inks = [
    ['white', 'blanco'],
    ['green', 'verde'], ['yellow', 'amarillo'], ['red', 'rojo'],
    ['blue', 'azul'], ['fuchsia', 'fucsia'], ['magenta', 'magenta']
  ];
  const isInk = value => inks.some(([key]) => key === value);
  function getInk() {
    try {
      const value = localStorage.getItem('ds_ink');
      return isInk(value) ? value : 'white';
    } catch (_) { return 'white'; }
  }
  function syncInkButtons() {
    const selected = document.documentElement.getAttribute('data-ink');
    document.querySelectorAll('[data-ink-value]').forEach(button => {
      const active = button.dataset.inkValue === selected;
      button.setAttribute('aria-pressed', String(active));
      button.title = button.dataset.inkLabel;
    });
  }
  function setInk(value, { persist = true } = {}) {
    const selected = isInk(value) ? value : 'white';
    document.documentElement.setAttribute('data-ink', selected);
    if (persist) { try { localStorage.setItem('ds_ink', selected); } catch (_) {} }
    syncInkButtons();
    window.dispatchEvent(new CustomEvent('library:inkchange', { detail: selected }));
  }
  setInk(getInk(), { persist: false });
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-ink-picker]').forEach(picker => {
      for (const [key, name] of inks) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'color-swatch';
        button.dataset.inkValue = key;
        button.dataset.inkLabel = key === 'white' ? 'Texto blanco' : `Texto ${name} neón`;
        button.setAttribute('aria-label', button.dataset.inkLabel);
        button.addEventListener('click', () => setInk(key));
        picker.appendChild(button);
      }
    });
    syncInkButtons();
  }, { once: true });

  let frame;
  function updateViewport() {
    const viewport = window.visualViewport;
    // Let browser pinch zoom work normally; only follow the keyboard/layout viewport at scale 1.
    if (viewport && Math.abs(viewport.scale - 1) > 0.02) return;
    document.documentElement.style.setProperty('--viewport-height', `${viewport ? viewport.height : innerHeight}px`);
    document.documentElement.style.setProperty('--viewport-top', `${viewport ? viewport.offsetTop : 0}px`);
  }
  const scheduleViewport = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(updateViewport);
  };
  updateViewport();
  window.addEventListener('resize', scheduleViewport, { passive: true });
  window.addEventListener('pageshow', scheduleViewport, { passive: true });
  window.visualViewport?.addEventListener('resize', scheduleViewport, { passive: true });
  window.visualViewport?.addEventListener('scroll', scheduleViewport, { passive: true });

  const dialogs = new Set();
  let savedPage;
  const styleKeys = ['position', 'top', 'left', 'right', 'width', 'overflow'];
  function openDialog(dialog) {
    const trigger = document.activeElement;
    if (!dialogs.size) {
      savedPage = { x: scrollX, y: scrollY, focus: trigger, styles: Object.fromEntries(styleKeys.map(key => [key, document.body.style[key]])) };
      Object.assign(document.body.style, { position: 'fixed', top: `${-savedPage.y}px`, left: '0', right: '0', width: '100%', overflow: 'hidden' });
    }
    dialogs.add(dialog);
    dialog.addEventListener('close', () => {
      dialogs.delete(dialog);
      dialog.remove();
      if (!dialogs.size && savedPage) {
        const page = savedPage;
        savedPage = null;
        const behavior = document.documentElement.style.scrollBehavior;
        document.documentElement.style.scrollBehavior = 'auto';
        Object.assign(document.body.style, page.styles);
        window.scrollTo(page.x, page.y);
        if (page.focus?.isConnected) page.focus.focus({ preventScroll: true });
        requestAnimationFrame(() => { document.documentElement.style.scrollBehavior = behavior; });
      } else if (trigger?.isConnected && trigger.closest('dialog[open]')) trigger.focus({ preventScroll: true });
    }, { once: true });
    document.body.appendChild(dialog);
    dialog.showModal();
    updateViewport();
    return dialog;
  }

  window.DeadLibraryUI = Object.freeze({ getTheme, setTheme, getInk, setInk, openDialog });
})();
