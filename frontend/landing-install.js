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
      'Etiquetas de precio y código de barras': 'etiquetas-precio-codigo-barras',
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

  // El carrusel del hero ya no bloquea el scroll de la página: las
  // diapositivas avanzan solas por tiempo (setInterval en el bundle React)
  // y el usuario puede desplazarse con normalidad para salir del hero en
  // cualquier momento, sin captura de wheel/teclado/touch ni preventDefault.

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