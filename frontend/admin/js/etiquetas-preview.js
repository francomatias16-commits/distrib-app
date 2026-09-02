/* ============================================================
   etiquetas-preview.js — Vista previa e impresión de etiquetas de
   precio/código de barras (543).

   Módulo compartido: la lógica de "elegir copias por producto →
   vista previa → imprimir" vivía duplicada solo en productos.js
   (Etapa 2). Se extrae acá para que Compras (Etapa 3 — precarga
   desde una recepción de mercadería) la reutilice sin copiar el
   código, tal como pide el criterio general del proyecto de
   reutilizar patrones ya resueltos en vez de inventar uno nuevo
   (ver PLAN_ETIQUETAS_PRECIO_CODIGO_BARRAS.md).

   Nota (Etapa 3): el cuerpo del modal usaba clases con prefijo
   `prod-`/`etq-preview-` que en realidad NUNCA tuvieron CSS en
   ningún archivo del proyecto (ni siquiera en productos.css) — la
   Etapa 2 quedó funcional pero sin estilo propio. Al volverse un
   módulo compartido con Compras (que ni siquiera carga productos.css)
   eso ya no podía quedar así como "por las dudas algo hereda": se
   renombraron a clases propias del módulo (`etqp-*`) con su CSS
   autocontenido en etiquetas-preview.css, para que el módulo se vea
   bien en cualquier página que lo cargue sin depender de la página
   host. (Pendiente aparte, fuera de esta etapa: `.prod-barra-etiquetas`
   y `.prod-chk-fila` de Productos tienen el mismo problema — no se
   tocaron acá porque son propios de la Etapa 2, no de este módulo.)

   Requiere en la página que lo use (ver productos.html/compras.html):
     - etiquetas-preview.css → estilos del modal (ver arriba)
     - ui-utils.js        → window.toast, window.sanitize
     - auth.js            → window.authCtx.sb (token de la sesión)
     - etiquetas-print.js → window.EtiquetasPrint.imprimir()
     - el markup del modal #modal-etiquetas-preview +
       #modal-backdrop-etiquetas-preview (ver productos.html)

   API pública: window.EtiquetasPreview.abrir(ids, copiasPorId?, onCerrar?)
     - ids: string[] — ids de producto a incluir.
     - copiasPorId: { [producto_id]: copias } opcional — precarga la
       cantidad de copias (ej. Etapa 3: cantidad recién recibida en
       una recepción) en vez del default (1 copia por producto).
     - onCerrar: callback opcional, se dispara al cerrar el modal
       (cancelar o después de imprimir) — ej. Etapa 2 lo usa para
       limpiar la selección de la grilla de Productos.
   ============================================================ */

'use strict';

let _etqPreviewProductos = []; // [{ ...producto, _copias }] — estado del modal abierto
let _etqPreviewConfig    = null;
let _etqPreviewOnCerrar  = null;

async function _etqGetToken() {
  const { data: { session } } = await window.authCtx.sb.auth.getSession();
  return session?.access_token || '';
}

async function _etqGetConfig() {
  const token = await _etqGetToken();
  const r = await fetch('/api/etiquetas/config?_svc=config', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error || 'No se pudo cargar la configuración de etiquetas.');
  return d.config;
}

async function _etqGetProductos(ids) {
  const token = await _etqGetToken();
  const r = await fetch('/api/etiquetas/productos?_svc=productos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ids }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error || 'No se pudieron cargar los productos.');
  return d.productos || [];
}

// Mismo cálculo que precioConIva() en etiquetas-print.js — se duplica acá
// (sin depender de que EtiquetasPrint exponga esa función interna) para
// que la vista previa muestre el precio que realmente va a salir impreso.
// `base` es el precio sin IVA (regular o promocional — Etapa 4, 543).
function _etqPrecioConIva(base, producto, incluirIva) {
  const b = Number(base || 0);
  if (!incluirIva) return b;
  const ivaPct = Number(producto.iva || 0);
  return b * (1 + ivaPct / 100);
}

function _etqFormatPeso(n) {
  if (n == null) return '—';
  return '$' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 0 });
}

async function abrirVistaPreviaEtiquetas(ids, copiasPorId, onCerrar) {
  if (!ids || !ids.length) return;

  if (!window.EtiquetasPrint) {
    window.toast?.('El motor de impresión de etiquetas no cargó. Recargá la página.', 'error');
    return;
  }

  const modal  = document.getElementById('modal-etiquetas-preview');
  const cuerpo = document.getElementById('etiquetas-preview-cuerpo');
  if (!modal || !cuerpo) return;

  _etqPreviewOnCerrar = typeof onCerrar === 'function' ? onCerrar : null;

  modal.classList.add('open');
  document.getElementById('modal-backdrop-etiquetas-preview')?.style.setProperty('display', 'block');
  cuerpo.innerHTML = '<div class="etqp-spinner"></div>';

  try {
    const [config, productos] = await Promise.all([
      _etqGetConfig(),
      _etqGetProductos(ids),
    ]);

    if (productos.length < ids.length) {
      window.toast?.('Algunos productos seleccionados ya no existen y se excluyeron.', 'warning');
    }

    _etqPreviewProductos = productos.map(p => ({
      ...p,
      // Precarga de copias (Etapa 3: cantidad recibida en la recepción de
      // origen). Sin precarga (Etapa 2, selección manual) arranca en 1.
      _copias: Math.max(1, Math.round(Number(copiasPorId?.[p.id]) || 1)),
    }));
    _etqPreviewConfig = config;
    renderVistaPreviaEtiquetas();
  } catch (err) {
    console.error('[etiquetas-preview] Error abriendo vista previa:', err);
    cuerpo.innerHTML = `<p class="etqp-error">${window.sanitize ? window.sanitize(err.message) : (err.message || '')}</p>`;
  }
}

function renderVistaPreviaEtiquetas() {
  const cuerpo = document.getElementById('etiquetas-preview-cuerpo');
  if (!cuerpo) return;

  if (!_etqPreviewProductos.length) {
    cuerpo.innerHTML = '<p class="etqp-vacio">No quedan productos en la selección.</p>';
    return;
  }

  // Si ya se renderizó antes, respetar lo que el usuario haya tildado en
  // esta apertura del modal en vez de volver siempre al default de config.
  const chkIvaPrevio   = document.getElementById('etq-preview-incluir-iva');
  const incluirIva     = chkIvaPrevio ? chkIvaPrevio.checked : (_etqPreviewConfig?.incluir_iva !== false);
  // Etapa 4 (543): toggle de promociones — solo tiene sentido mostrarlo si
  // ALGÚN producto de la tanda tiene precio_promocional resuelto; si no,
  // no hay nada que tachar y el checkbox quedaría sin efecto visible.
  const hayAlgunaPromo  = _etqPreviewProductos.some(p => p.precio_promocional != null);
  const chkPromoPrevio  = document.getElementById('etq-preview-mostrar-promos');
  const mostrarPromos   = chkPromoPrevio ? chkPromoPrevio.checked : (_etqPreviewConfig?.mostrar_promociones !== false);
  const esc = (s) => (window.sanitize ? window.sanitize(s) : String(s ?? ''));

  cuerpo.innerHTML = `
    <label class="etqp-iva-toggle">
      <input type="checkbox" id="etq-preview-incluir-iva"
             ${incluirIva ? 'checked' : ''}
             onchange="renderVistaPreviaEtiquetas()" />
      Incluir IVA en el precio impreso (solo para esta impresión)
    </label>
    ${hayAlgunaPromo ? `
    <label class="etqp-iva-toggle">
      <input type="checkbox" id="etq-preview-mostrar-promos"
             ${mostrarPromos ? 'checked' : ''}
             onchange="renderVistaPreviaEtiquetas()" />
      Mostrar precio promocional tachado (donde haya una oferta vigente)
    </label>` : ''}
    <div class="etqp-lista">
      ${_etqPreviewProductos.map((p, i) => {
        const base       = p.precio_regular ?? p.precio_base;
        const precioReg  = _etqPrecioConIva(base, p, incluirIva);
        const hayPromo   = mostrarPromos && p.precio_promocional != null;
        const precioPromo = hayPromo ? _etqPrecioConIva(p.precio_promocional, p, incluirIva) : null;
        const unidad     = p.vendido_por_peso ? ' /' + esc(p.unidad || 'kg') : '';
        const bloquePrecio = hayPromo
          ? `<span class="etqp-precio">
               <span class="etqp-precio-regular">${esc(_etqFormatPeso(precioReg))}</span>
               <span class="etqp-precio-promo">${esc(_etqFormatPeso(precioPromo))}${unidad}</span>
             </span>`
          : `<span class="etqp-precio">${esc(_etqFormatPeso(precioReg))}${unidad}</span>`;
        return `
        <div class="etqp-fila">
          <span class="etqp-nombre" title="${esc(p.nombre)}">${esc(p.nombre)}</span>
          ${bloquePrecio}
          <label class="etqp-copias-label">
            Copias
            <input type="number" min="1" step="1" class="input-base etqp-copias"
                   value="${p._copias}" onchange="actualizarCopiasEtiqueta(${i}, this.value)" />
          </label>
        </div>
      `;}).join('')}
    </div>
  `;
}

function actualizarCopiasEtiqueta(idx, valor) {
  const n = Math.max(1, parseInt(valor, 10) || 1);
  if (_etqPreviewProductos[idx]) _etqPreviewProductos[idx]._copias = n;
}

function cerrarVistaPreviaEtiquetas() {
  document.getElementById('modal-etiquetas-preview')?.classList.remove('open');
  document.getElementById('modal-backdrop-etiquetas-preview')?.style.setProperty('display', 'none');
  _etqPreviewProductos = [];
  const cb = _etqPreviewOnCerrar;
  _etqPreviewOnCerrar = null;
  if (cb) cb();
}

async function imprimirEtiquetasSeleccionadas() {
  if (!_etqPreviewProductos.length) return;
  const incluirIva = document.getElementById('etq-preview-incluir-iva')?.checked !== false;
  // El toggle de promos solo se renderiza si hay alguna promo en la tanda
  // (ver renderVistaPreviaEtiquetas) — si no está en el DOM, se respeta el
  // default de config tal cual (no hay nada que el usuario haya podido
  // destildar).
  const chkPromo = document.getElementById('etq-preview-mostrar-promos');
  const mostrarPromociones = chkPromo ? chkPromo.checked : (_etqPreviewConfig?.mostrar_promociones !== false);
  const config = { ...(_etqPreviewConfig || {}), incluir_iva: incluirIva, mostrar_promociones: mostrarPromociones };
  await window.EtiquetasPrint.imprimir(_etqPreviewProductos, config);

  // Ciclo completo: una vez disparada la impresión, cerrar el modal (esto
  // dispara el onCerrar pasado a abrir(), ej. limpiar la selección de la
  // grilla de Productos en la Etapa 2) — sin esto quedaba todo abierto.
  cerrarVistaPreviaEtiquetas();
}

window.EtiquetasPreview = { abrir: abrirVistaPreviaEtiquetas };
