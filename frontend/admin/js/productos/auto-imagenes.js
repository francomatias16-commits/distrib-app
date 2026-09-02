// frontend/admin/js/productos/auto-imagenes.js
// Parte del split de frontend/admin/js/productos.js (25/08/2026) — Auto-carga de imágenes de productos vía banco de códigos / búsqueda automática (Serper), con progreso, resultado y deshacer.
// Se carga como <script> clásico (no ES module) en productos.html, en el
// mismo orden que ocupaba en el archivo original, para preservar el scope
// global compartido entre secciones (variables de estado, funciones
// window.*). Repite 'use strict' porque el pragma es por-script (el
// original lo tenía una sola vez porque era un solo script). Ver
// docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

// ── Auto-carga de imágenes ──────────────────────────────────────────────
// Llama a /api/auto-imagenes en lotes chicos hasta que no queden productos
// sin foto_url. Cada lote procesa lo que puede: los que no encontraron
// match quedan con foto_url = null a propósito (la ficha del producto
// muestra el ícono de la categoría como respaldo, no una URL inventada).
//
// v2 (post-confusión con el confirm() nativo): antes esto era un
// confirm()/toast() de una sola pasada, sin forma de frenar a mitad de
// camino ni de deshacer si tocabas la opción equivocada por error. Ahora:
//   1) elegirModoImagenes() — modal propio con las dos opciones bien
//      diferenciadas en vez de un bloque de texto en un confirm() nativo.
//   2) mostrarProgresoImagenes() — panel con botón "Detener" que corta el
//      proceso antes de arrancar el siguiente lote (no cancela un lote ya
//      en vuelo, pero no arranca uno nuevo).
//   3) mostrarResultadoImagenes() — resumen final con botón "Deshacer esta
//      búsqueda", que revierte SOLO los productos tocados en esta corrida
//      (vuelve foto_url a null y borra el archivo subido al bucket).
async function buscarImagenesAutomaticas() {
  const token = await getToken();
  if (!token) { toast('No se pudo verificar la sesión.', 'error'); return; }

  const contadorPrevio = await obtenerContadorSerper(token);
  const modo = await elegirModoImagenes(contadorPrevio);
  if (!modo) return; // el usuario cerró/canceló el modal, no se hace nada

  // v394: se sacó la opción de banco genérico (Pexels) por completo — solo
  // queda el opt-in de foto real por nombre (Serper), además de la Capa 1
  // de código de barras que siempre está activa.
  const incluirBusquedaReal = modo === 'con_busqueda_real';
  const progreso = mostrarProgresoImagenes();

  let totalConFoto = 0;
  let totalConFotoBusqueda = 0;
  let totalProcesados = 0;
  let restantes = null;
  let tandas = 0;
  let detenidoPorUsuario = false;
  let errorMsg = null;
  let contadorSerper = contadorPrevio;
  const productosTocados = []; // [{id, fuente}] — para poder deshacer solo esto
  // v397: IDs de productos ya intentados en ESTA corrida (con o sin match).
  // Sin esto, un producto que no matchea en ninguna capa se queda con
  // foto_url null para siempre y la query del backend lo vuelve a traer en
  // cada tanda del loop — el loop nunca converge porque "restantes" (el
  // total de la empresa sin foto) no baja. Se manda de vuelta en cada POST
  // para que el backend lo excluya y el próximo lote siempre traiga
  // productos nuevos. Ver auto-imagenes.js, nota en procesarLote().
  const excluirIds = [];

  do {
    if (progreso.fueDetenido()) { detenidoPorUsuario = true; break; }

    tandas++;
    progreso.actualizar({ fase: 'procesando', tandas, totalConFoto, totalProcesados });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 55_000); // por debajo del límite de 60s de la función

    let r;
    try {
      r = await fetch('/api/auto-imagenes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ lote: 8, incluirBusquedaReal, excluirIds }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      errorMsg = err?.name === 'AbortError'
        ? `Se colgó el lote #${tandas} (más de 55s sin respuesta). Se detuvo el proceso — podés reintentar, va a seguir desde donde quedó.`
        : 'Error de red buscando imágenes. Se detuvo el proceso.';
      break;
    }
    clearTimeout(timeoutId);

    const d = await r.json().catch(() => null);

    // El backend limita a 20 lotes por minuto por IP (rate-limit.js) — con
    // catálogos grandes (varios cientos de productos) es normal pisar ese
    // límite antes de terminar. Antes esto cortaba el proceso entero como
    // si fuera un error fatal; ahora se espera el tiempo que indica el
    // propio backend (header Retry-After) y se reintenta el mismo lote,
    // sin perder lo ya procesado ni molestar a la persona con un error por
    // algo que se resuelve solo en unos segundos.
    if (r.status === 429) {
      const esperaSeg = Number(r.headers.get('Retry-After')) || 5;
      progreso.actualizar({
        fase: 'esperando',
        tandas, totalConFoto, totalProcesados,
        mensaje: `Pausando ${esperaSeg}s (límite de solicitudes por minuto) antes de seguir...`,
      });
      await new Promise(resolve => setTimeout(resolve, (esperaSeg + 1) * 1000));
      tandas--; // este intento no contó como lote real, se reintenta
      continue;
    }

    if (!r.ok || !d?.ok) {
      errorMsg = d?.error || `No se pudo completar la búsqueda de imágenes (lote #${tandas}).`;
      break;
    }

    for (const item of d.detalle || []) {
      excluirIds.push(item.id); // ya se intentó en esta corrida, no se vuelve a pedir
      if (item.resultado === 'ok') {
        productosTocados.push({ id: item.id, fuente: item.fuente || null });
        // v396: la Capa 2 ahora puede devolver 'busqueda_web_mercadolibre'
        // (etapa 1, restringida a ML) o 'busqueda_web' (etapa 2, general) —
        // ambas cuentan para el resumen, la distinción es solo interna/debug.
        if (item.fuente === 'busqueda_web' || item.fuente === 'busqueda_web_mercadolibre') totalConFotoBusqueda++;
      }
    }

    totalConFoto    += d.con_foto;
    totalProcesados += d.procesados;
    restantes = d.restantes;
    if (d.contadorSerper?.usados != null) contadorSerper = d.contadorSerper.usados;

    if (d.procesados === 0) break; // nada más para procesar

    // Pequeño respiro entre lotes para no pisar el límite de 20/min del
    // backend en catálogos grandes (con lote=8, 20/min alcanza para ~160
    // productos/min sin pausa — con este delay se reparte mejor y hace
    // falta pausar por 429 con mucha menos frecuencia).
    if (restantes > 0) await new Promise(resolve => setTimeout(resolve, 1500));
  } while (restantes > 0);

  progreso.cerrar();
  await cargarProductos();

  await mostrarResultadoImagenes({
    detenidoPorUsuario,
    errorMsg,
    totalConFoto,
    totalConFotoBusqueda,
    totalProcesados,
    productosTocados,
    contadorSerper,
    token,
  });
}

// v395: consulta liviana (GET) al mismo endpoint solo para leer cuántas
// consultas a Serper se llevan hechas hasta ahora — no dispara ninguna
// búsqueda. Si falla (red, permisos), no bloquea el flujo: se muestra el
// modal igual, simplemente sin el dato del contador.
async function obtenerContadorSerper(token) {
  try {
    const r = await fetch('/api/auto-imagenes', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    return d?.contadorSerper?.usados ?? null;
  } catch {
    return null;
  }
}

// Modal de elección (reemplaza el confirm() nativo). Devuelve
// 'solo_barcode' | 'con_busqueda_real' | null (null = canceló).
//
// v394: se sacó la tarjeta de "banco de fotos genérico" (Pexels) por
// completo — devolvía imágenes representativas, no la foto real del
// producto, y terminaba siendo la única capa que corría en la práctica.
// Ahora solo hay dos niveles: código de barras (match exacto) y foto real
// por nombre (búsqueda web vía Serper) — lo que no matchea en ninguno de
// los dos queda con el ícono de categoría, sin excepción.
function elegirModoImagenes(contadorPrevio) {
  return new Promise((resolve) => {
    // v395: aviso informativo del contador interno de uso de Serper — no es
    // el saldo exacto de la cuenta (eso solo lo tiene serper.dev), es una
    // referencia aproximada para no arrancar una corrida grande a ciegas.
    const avisoContador = (contadorPrevio == null) ? '' : `
      <div style="font-size:11.5px;color:var(--color-text-muted);background:rgba(22,24,29,.03);
                  border-radius:var(--radius-sm,6px);padding:7px 10px;margin-bottom:14px;line-height:1.4">
        Consultas a Serper registradas hasta ahora: <strong>${contadorPrevio}</strong>
        de las 2.500 gratis iniciales (conteo interno aproximado, no el saldo exacto de la cuenta).
      </div>`;

    const overlay = document.createElement('div');
    overlay.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="ei-titulo"
           style="position:fixed;inset:0;z-index:var(--z-modal,400);
                  display:flex;align-items:center;justify-content:center;
                  background:rgba(22,24,29,.45);padding:1rem">
        <div style="background:var(--color-surface);border-radius:var(--radius-lg);
                    padding:1.5rem;max-width:480px;width:100%;box-shadow:var(--shadow-xl)">
          <h3 id="ei-titulo" style="margin:0 0 4px;font-size:17px;font-weight:700;color:var(--color-text)">
            Buscar imágenes automáticamente
          </h3>
          <p style="margin:0 0 16px;font-size:13px;color:var(--color-text-muted);line-height:1.45">
            Elegí cómo buscar. Podés detener el proceso en cualquier momento y también deshacerlo
            al final si el resultado no te convence.
          </p>
          ${avisoContador}
          <button type="button" data-action="solo_barcode" style="all:unset;box-sizing:border-box;display:block;width:100%;
                    text-align:left;padding:14px;margin-bottom:10px;border-radius:var(--radius-md);
                    border:1.5px solid var(--color-primary);background:rgba(22,24,29,.015);cursor:pointer">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <span style="font-size:16px;display:inline-flex"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></span>
              <strong style="font-size:14px;color:var(--color-text)">Solo código de barras</strong>
              <span style="margin-left:auto;font-size:10px;font-weight:700;text-transform:uppercase;
                    color:var(--color-primary);background:var(--color-primary-bg,rgba(106,152,115,.14));padding:3px 7px;border-radius:999px">
                Más confiable
              </span>
            </div>
            <div style="font-size:12.5px;color:var(--color-text-muted);line-height:1.4">
              Usa la foto real del producto por match exacto de código de barras. Lo que no
              tiene match real queda con el ícono de categoría, sin fotos inventadas.
            </div>
          </button>

          <button type="button" data-action="con_busqueda_real" style="all:unset;box-sizing:border-box;display:block;width:100%;
                    text-align:left;padding:14px;margin-bottom:16px;border-radius:var(--radius-md);
                    border:1.5px solid rgba(22,24,29,.1);cursor:pointer">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <span style="font-size:16px;display:inline-flex"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span>
              <strong style="font-size:14px;color:var(--color-text)">+ Buscar foto real por nombre</strong>
              <span style="margin-left:auto;font-size:10px;font-weight:700;text-transform:uppercase;
                    color:var(--color-success,#487050);background:var(--color-success-bg,#E2F0E5);padding:3px 7px;border-radius:999px">
                Recomendado
              </span>
            </div>
            <div style="font-size:12.5px;color:var(--color-text-muted);line-height:1.4">
              Para los productos sin match por código, busca en la web la foto real del producto
              puntual por nombre (sitios de venta, fabricantes) — no usa banco de fotos genérico.
              Lo que tampoco matchea acá queda con el ícono de categoría.
            </div>
          </button>

          <div style="display:flex;justify-content:flex-end">
            <button data-action="cancel" class="btn btn--ghost btn--sm">Cancelar</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const onKeydown = (e) => { if (e.key === 'Escape') cleanup(null); };

    function cleanup(result) {
      document.removeEventListener('keydown', onKeydown);
      document.body.removeChild(overlay);
      resolve(result);
    }

    overlay.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      if (action === 'cancel') return cleanup(null);
      cleanup(action); // 'solo_barcode' | 'con_busqueda_real'
    });

    document.addEventListener('keydown', onKeydown);
  });
}

// Panel de progreso con botón "Detener". No usa Promise porque conviene
// poder actualizarlo en vivo desde el loop de lotes; expone
// { actualizar(info), fueDetenido(), cerrar() }.
function mostrarProgresoImagenes() {
  let detenido = false;

  const overlay = document.createElement('div');
  overlay.innerHTML = `
    <div role="status" aria-live="polite"
         style="position:fixed;inset:0;z-index:var(--z-modal,400);
                display:flex;align-items:center;justify-content:center;
                background:rgba(22,24,29,.45);padding:1rem">
      <div style="background:var(--color-surface);border-radius:var(--radius-lg);
                  padding:1.5rem;max-width:380px;width:100%;box-shadow:var(--shadow-xl);text-align:center">
        <div style="width:36px;height:36px;margin:0 auto 14px;border-radius:50%;
                    border:3px solid rgba(22,24,29,.08);border-top-color:var(--color-primary);
                    animation:ei-spin 0.8s linear infinite"></div>
        <style>@keyframes ei-spin { to { transform: rotate(360deg); } }</style>
        <h3 style="margin:0 0 6px;font-size:15px;font-weight:700;color:var(--color-text)">
          Buscando imágenes…
        </h3>
        <p id="ei-progreso-texto" style="margin:0 0 16px;font-size:12.5px;color:var(--color-text-muted);line-height:1.4">
          Arrancando…
        </p>
        <button type="button" data-action="detener" class="btn btn--ghost btn--sm">Detener</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('[data-action="detener"]').addEventListener('click', () => {
    detenido = true;
    const p = overlay.querySelector('#ei-progreso-texto');
    if (p) p.textContent = 'Deteniendo… termina el lote actual y para.';
  });

  return {
    fueDetenido: () => detenido,
    actualizar: ({ tandas, totalConFoto, totalProcesados, mensaje }) => {
      const p = overlay.querySelector('#ei-progreso-texto');
      if (p) p.textContent = mensaje || `Tanda ${tandas} — ${totalConFoto}/${totalProcesados} productos con foto hasta ahora.`;
    },
    cerrar: () => { if (overlay.isConnected) document.body.removeChild(overlay); },
  };
}

// Resumen final con opción de deshacer SOLO lo tocado en esta corrida.
function mostrarResultadoImagenes({ detenidoPorUsuario, errorMsg, totalConFoto, totalConFotoBusqueda, totalProcesados, productosTocados, contadorSerper, token }) {
  return new Promise((resolve) => {
    let estado = 'resultado'; // 'resultado' | 'deshecho'

    const tituloInicial = errorMsg
      ? 'Se detuvo por un error'
      : detenidoPorUsuario
        ? 'Búsqueda detenida'
        : 'Búsqueda completada';

    const detalleFuente = totalConFotoBusqueda > 0
      ? `<div style="font-size:12px;color:var(--color-text-muted);margin-top:4px">
           Incluye ${totalConFotoBusqueda} imagen${totalConFotoBusqueda === 1 ? '' : 'es'} encontrada${totalConFotoBusqueda === 1 ? '' : 's'} por nombre (búsqueda web) — conviene revisarlas.
         </div>`
      : '';

    // v395: solo tiene sentido mostrar el contador si esta corrida usó la
    // Capa 2 (Serper) — con "solo código de barras" no se consumió nada.
    const detalleContador = (contadorSerper != null && totalConFotoBusqueda > 0)
      ? `<div style="font-size:11.5px;color:var(--color-text-muted);margin-top:8px">
           Consultas a Serper acumuladas: <strong>${contadorSerper}</strong> (conteo interno aproximado).
         </div>`
      : '';

    const overlay = document.createElement('div');
    overlay.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="ei-res-titulo"
           style="position:fixed;inset:0;z-index:var(--z-modal,400);
                  display:flex;align-items:center;justify-content:center;
                  background:rgba(22,24,29,.45);padding:1rem">
        <div style="background:var(--color-surface);border-radius:var(--radius-lg);
                    padding:1.5rem;max-width:400px;width:100%;box-shadow:var(--shadow-xl)">
          <h3 id="ei-res-titulo" style="margin:0 0 8px;font-size:16px;font-weight:700;color:var(--color-text)">
            ${tituloInicial}
          </h3>
          <div id="ei-res-cuerpo">
            <p style="margin:0;font-size:13.5px;color:var(--color-text);line-height:1.5">
              ${errorMsg ? escHtml(errorMsg) : `${totalConFoto} de ${totalProcesados} producto${totalProcesados === 1 ? '' : 's'} consiguieron imagen automáticamente.`}
            </p>
            ${errorMsg ? '' : detalleFuente}
            ${errorMsg ? '' : detalleContador}
          </div>
          <div id="ei-res-acciones" style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
            ${productosTocados.length > 0 ? '<button data-action="deshacer" class="btn btn--danger btn--sm">Deshacer esta búsqueda</button>' : ''}
            <button data-action="cerrar" class="btn btn--primary btn--sm">Cerrar</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', async (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (!action) return;

      if (action === 'cerrar') {
        document.body.removeChild(overlay);
        resolve();
        return;
      }

      if (action === 'deshacer' && estado === 'resultado') {
        const btn = e.target.closest('[data-action="deshacer"]');
        btn.disabled = true;
        btn.textContent = 'Deshaciendo…';
        const okCount = await deshacerBusquedaImagenes(productosTocados, token);
        estado = 'deshecho';
        overlay.querySelector('#ei-res-titulo').textContent = 'Búsqueda deshecha';
        overlay.querySelector('#ei-res-cuerpo').innerHTML = `
          <p style="margin:0;font-size:13.5px;color:var(--color-text);line-height:1.5">
            Se revirtieron ${okCount} de ${productosTocados.length} producto${productosTocados.length === 1 ? '' : 's'}
            a "sin foto". Podés volver a intentar cuando quieras.
          </p>`;
        overlay.querySelector('#ei-res-acciones').innerHTML =
          '<button data-action="cerrar" class="btn btn--primary btn--sm">Cerrar</button>';
        await cargarProductos();
      }
    });
  });
}

// Revierte foto_url a null y borra el archivo del bucket, solo para los
// productos tocados en la corrida actual (no toca fotos cargadas antes).
async function deshacerBusquedaImagenes(productosTocados, token) {
  if (!productosTocados.length) return 0;

  const ids = productosTocados.map(p => p.id);

  const { error: errUpdate } = await window.conTimeoutRed(sb.from('productos')
    .update({ foto_url: null, foto_fuente: null })
    .in('id', ids), 10000);

  if (errUpdate) {
    toast('No se pudo deshacer la búsqueda. Probá de nuevo.', 'error');
    return 0;
  }

  // Borrado de los archivos del bucket (best-effort: si falla el storage,
  // el producto igual queda sin foto_url, que es lo que importa para el catálogo).
  if (empresaData?.id) {
    const paths = ids.map(id => `${empresaData.id}/${id}.jpg`);
    try { await sb.storage.from('productos-fotos').remove(paths); } catch (_) { /* best-effort */ }
  }

  toast(`Se deshizo la búsqueda: ${ids.length} producto${ids.length === 1 ? '' : 's'} volvió a quedar sin foto.`, 'success');
  return ids.length;
}

async function getToken() {
  const { data: { session } } = await sb.auth.getSession();
  return session?.access_token || '';
}
