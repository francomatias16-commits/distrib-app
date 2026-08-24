(() => {
  'use strict';

  let deferredPrompt = null;

  function patchLandingLinks() {
    document.querySelectorAll('a').forEach((link) => {
      if (link.textContent.trim() === 'Inicio de sesión') {
        link.href = '/admin/login';
      }
      if (link.href.includes('mailto:hola@fluxo.app')) {
        link.href = 'mailto:soporte@distrib.com.ar';
        link.textContent = 'soporte@distrib.com.ar';
      }
    });

    const moduleSlugs = {
      'Tienda online con Mercado Pago': 'tienda-online',
      'WhatsApp Business integrado': 'whatsapp-business',
      'Punto de venta y medios de pago': 'punto-de-venta',
      'Facturación ARCA homologada': 'facturacion-arca',
      'Sistema de reparto en vivo': 'reparto-en-vivo',
      'Asistente IA incluido': 'asistente-ia',
      'Importación y migración en un clic': 'importacion-migracion',
      'Automatización del pedido al cobro': 'automatizacion-pedido-cobro',
    };

    document.querySelectorAll('.hero-offer').forEach((offer) => {
      const title = offer.querySelector('h2')?.textContent.trim();
      const slug = moduleSlugs[title];
      const foot = offer.querySelector('.offer-foot');
      if (!slug || !foot || foot.querySelector('.module-detail-link')) return;
      const label = foot.querySelector('span');
      if (!label) return;
      const link = document.createElement('a');
      link.className = 'module-detail-link';
      link.href = `/modulos/${slug}`;
      link.textContent = label.textContent;
      link.setAttribute('aria-label', `Explorar ${title}`);
      label.replaceWith(link);
    });
  }

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  if (isStandalone) return;

  patchLandingLinks();
  new MutationObserver(patchLandingLinks).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  function initHeroScroll() {
    const hero = document.querySelector('.hero-stage');
    if (!hero) {
      window.setTimeout(initHeroScroll, 50);
      return;
    }
    const railButtons = [...hero.querySelectorAll('.hero-rail button')];
    if (!railButtons.length) {
      window.setTimeout(initHeroScroll, 50);
      return;
    }
    if (hero.dataset.scrollLocked === 'true') return;
    hero.dataset.scrollLocked = 'true';

    const slideCount = railButtons.length || 8;
    let transitioning = false;
    let touchStartY = null;
    let currentIndex = 0;

    function getState() {
      const maxScroll = Math.max(0, hero.offsetHeight - window.innerHeight);
      const start = hero.offsetTop;
      const progress = maxScroll
        ? Math.max(0, Math.min(1, (window.scrollY - start) / maxScroll))
        : 0;
      const activeIndex = railButtons.findIndex((button) =>
        button.classList.contains('is-active'));
      if (activeIndex >= 0) currentIndex = activeIndex;
      return { maxScroll, start, index: currentIndex };
    }

    function goToSlide(index) {
      const state = getState();
      const next = Math.max(0, Math.min(slideCount - 1, index));
      if (next === state.index || transitioning) return;
      transitioning = true;
      currentIndex = next;

      // Cambiar el estado de React explícitamente es lo que actualiza la
      // diapositiva. El scroll solo determina en qué tramo queda el hero.
      railButtons[next]?.click();

      const target = state.start + state.maxScroll * (next / (slideCount - 1));
      window.scrollTo({ top: target, behavior: 'smooth' });
      window.setTimeout(() => { transitioning = false; }, 720);
    }

    function isHeroActive() {
      const rect = hero.getBoundingClientRect();
      return rect.top <= window.innerHeight * 0.55 &&
        rect.bottom >= window.innerHeight * 0.45;
    }

    window.addEventListener('wheel', (event) => {
      if (!isHeroActive() || Math.abs(event.deltaY) < 8) return;
      const state = getState();
      const next = state.index + (event.deltaY > 0 ? 1 : -1);
      if (next < 0 || next >= slideCount) return;
      event.preventDefault();
      goToSlide(next);
    }, { capture: true, passive: false });

    window.addEventListener('keydown', (event) => {
      if (!isHeroActive()) return;
      const direction = event.key === 'PageDown' || event.key === ' '
        ? 1 : event.key === 'PageUp' ? -1 : 0;
      if (!direction) return;
      const next = getState().index + direction;
      if (next < 0 || next >= slideCount) return;
      event.preventDefault();
      goToSlide(next);
    }, { capture: true });

    window.addEventListener('touchstart', (event) => {
      if (isHeroActive()) touchStartY = event.touches[0].clientY;
    }, { passive: true });

    window.addEventListener('touchend', (event) => {
      if (touchStartY === null || !isHeroActive()) {
        touchStartY = null;
        return;
      }
      const delta = touchStartY - event.changedTouches[0].clientY;
      touchStartY = null;
      if (Math.abs(delta) < 42) return;
      const next = getState().index + (delta > 0 ? 1 : -1);
      if (next < 0 || next >= slideCount) return;
      goToSlide(next);
    }, { passive: true });
  }

  window.setTimeout(initHeroScroll, 0);

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    document.getElementById('fluxo-install-button')?.remove();
  });

  function showInstallHelp() {
    if (document.getElementById('fluxo-install-modal')) return;

    const overlay = document.createElement('div');
    overlay.id = 'fluxo-install-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="fluxo-install-card">
        <button class="fluxo-install-close" type="button" aria-label="Cerrar">×</button>
        <div class="fluxo-install-icon">↗</div>
        <h2>Instalá Fluxo</h2>
        <p>${isIOS
          ? 'En Safari, tocá Compartir y elegí “Agregar a pantalla de inicio”.'
          : 'Usá el menú de tu navegador y elegí “Instalar Fluxo” o “Agregar a pantalla de inicio”.'}</p>
      </div>`;

    const close = () => overlay.remove();
    overlay.querySelector('.fluxo-install-close').addEventListener('click', close);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    document.body.appendChild(overlay);
  }

  async function install() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      document.getElementById('fluxo-install-button')?.remove();
      return;
    }
    showInstallHelp();
  }

  // Usado por la pestaña "Descargar app" del nav (renderizada por React en
  // app.js), así ambos disparadores comparten el mismo flujo de instalación.
  window.fluxoInstallApp = install;
})();