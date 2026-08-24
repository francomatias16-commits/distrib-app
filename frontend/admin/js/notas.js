/* admin/js/notas.js — Pantalla L: Notas de Crédito y Débito */

let _sb = null; // FIX v125: usa authCtx.sb (patrón unificado)


let notas = []; // página actual (ver fn_notas_lista, migración 263) — ya no es el recorte fijo de 500
let clientes = [];
let tipoSeleccionado = null;

let paginaActualNotas = 1;
const ITEMS_POR_PAGINA_NOTAS = 200;
let totalNotasFiltradas = 0;

// FIX: getHeaders() no estaba definida en ningún lado del proyecto,
// rompía cargarNotas()/cargarClientes() con "ReferenceError: getHeaders is not defined".
async function getHeaders() {
  const { data: { session } } = await _sb.auth.getSession();
  return {
    apikey: window.ENV.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${session?.access_token}`,
    'Content-Type': 'application/json',
  };
}

window.authReady.then(async () => {
  const user = window.authCtx?.perfil;
  if (!user) { window.location.href = '/admin/login'; return; }
  _sb = window.authCtx.sb;

  const hoy = new Date();
  const elFecha = document.getElementById('topbar-fecha');
  if (elFecha) elFecha.textContent = hoy.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  // FIX (auditoría UX etapa 16, Hallazgo 1): toISOString() (UTC) precargaba
  // la fecha de mañana entre las 21:00 y las 00:00 hora Argentina.
  document.getElementById('nota-fecha').value = window.hoyLocalISO ? window.hoyLocalISO() : hoy.toISOString().split('T')[0];

  if (!user) return;
  (document.getElementById('topbar-usuario') || {}).textContent = user.nombre || user.email;

  try { inyectarControlesPaginacionNotas(); } catch(e) { console.warn('[notas] paginacion init:', e.message); }

  // Buscador con debounce (250ms, mismo criterio que clientes.js/facturacion.js):
  // la búsqueda ahora pega contra Supabase (fn_notas_lista) en vez de filtrar
  // en memoria sobre el recorte fijo de 500.
  const inputBusqueda = document.getElementById('buscar-nota');
  if (inputBusqueda) {
    let debounceBusquedaNotas = null;
    inputBusqueda.addEventListener('input', () => {
      clearTimeout(debounceBusquedaNotas);
      debounceBusquedaNotas = setTimeout(() => filtrarNotas(), 250);
    });
  }

  await Promise.all([cargarNotas(), cargarClientes()]);
});

// Trae la página actual ya filtrada/ordenada por Supabase (fn_notas_lista,
// migración 263): búsqueda y tipo se resuelven en SQL. Antes traía hasta
// 500 filas fijas de cta_cte (tipo in nota_credito/nota_debito) y filtraba
// todo en el navegador con Array.filter() — con más de 500 notas, buscar
// o filtrar por tipo dejaba resultados afuera silenciosamente.
async function cargarNotas() {
  try {
    const busq = document.getElementById('buscar-nota').value.trim();
    const tipoSel = document.getElementById('filtro-tipo-nota').value;
    const tipoRpc = tipoSel === 'credito' ? 'nota_credito' : (tipoSel === 'debito' ? 'nota_debito' : null);
    const desde = (paginaActualNotas - 1) * ITEMS_POR_PAGINA_NOTAS;

    const { data, error } = await _sb.rpc('fn_notas_lista', {
      p_busqueda: busq || null,
      p_tipo: tipoRpc,
      p_limit: ITEMS_POR_PAGINA_NOTAS,
      p_offset: desde,
    });
    if (error) throw error;

    notas = (data || []).map(n => ({
      ...n,
      descripcion: n.descripcion || null,
      clientes: (n.cliente_razon_social || n.cliente_nombre_fantasia)
        ? { razon_social: n.cliente_razon_social, nombre_fantasia: n.cliente_nombre_fantasia }
        : null,
    }));
    totalNotasFiltradas = data?.[0]?.total_count || 0;

    renderTabla(notas);
    actualizarControlesPaginacionNotas();
  } catch(e) {
    console.error(e);
    mostrarToast('No se pudieron cargar las notas', 'err');
  }
}

async function cargarClientes() {
  const r = await fetch(
    `${window.ENV.SUPABASE_URL}/rest/v1/clientes?empresa_id=eq.${window.authCtx?.perfil?.empresa_id}&activo=eq.true&order=razon_social.asc&select=id,razon_social,nombre_fantasia`,
    { headers: await getHeaders() }
  );
  clientes = r.ok ? await r.json() : [];
  const sel = document.getElementById('nota-cliente');
  sel.innerHTML = '<option value="">Seleccionar cliente...</option>' +
    clientes.map(c => `<option value="${c.id}">${window.sanitize(c.nombre_fantasia || c.razon_social)}</option>`).join('');
}

function renderTabla(notas) {
  const tbody = document.getElementById('tbody-notas');
  if (!notas.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">Todavía no generaste notas de crédito o débito. Usá el botón "Nueva Nota" arriba a la derecha cuando necesites bonificar o corregir una factura.</div></td></tr>`;
    return;
  }

  tbody.innerHTML = notas.map(n => {
    const esCredito = n.tipo === 'nota_credito';
    const tipoLabel = esCredito ? 'Nota de Crédito' : 'Nota de Débito';
    const tipoCls = esCredito ? 'chip-verde' : 'chip-rojo';
    const montoCls = esCredito ? 'monto-verde' : 'monto-rojo';

    return `<tr data-testid="notas-fila" data-id="${n.id}" class="fila-clickeable" onclick="if (event.target.closest('[onclick],a,select,input,textarea,button') === this) verDetalleNota('${n.id}')" style="${n.anulado ? 'opacity:.55' : ''}">
      <td data-label="Fecha">${formatFecha(n.fecha)}</td>
      <td data-label="Número" style="font-family:monospace">${n.nro_comprobante || '—'}</td>
      <td data-label="Tipo"><span class="chip ${tipoCls}">${tipoLabel}</span></td>
      <td data-label="Cliente">${window.sanitize(n.clientes?.nombre_fantasia || n.clientes?.razon_social || '—')}</td>
      <td class="monto ${montoCls}" data-label="Monto">${formatPeso(n.importe)}</td>
      <td data-label="Estado">${n.anulado ? '<span class="chip chip-gris">Anulada</span>' : '<span class="chip chip-azul">Emitida</span>'}</td>
      <td class="col-sticky-end" data-label="Acciones">
        <span class="fila-acciones">
          <button type="button" class="btn-tabla" onclick="verDetalleNota('${n.id}')">Ver</button>
          ${!n.anulado ? `<button type="button" class="btn-kebab btn-kebab-nota" data-nota-id="${n.id}" title="Más acciones" aria-label="Más acciones" aria-haspopup="menu" aria-expanded="false"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg></button>` : ''}
        </span>
      </td>
    </tr>`;
  }).join('');
}

// ── Menú "⋮" de acciones secundarias por fila (Anular) ──────────────────────
// Mismo patrón de menú flotante compartido que Facturación/Cheques/NC — ver
// PLAN_UNIFICACION_UX_ADMIN.md §2 y §5.
(function iniciarMenuAccionesNota() {
  const menu = document.getElementById('menu-acciones-nota');
  if (!menu) return;

  const cerrar = () => {
    menu.hidden = true;
    document.querySelectorAll('.btn-kebab-nota[aria-expanded="true"]')
      .forEach(b => b.setAttribute('aria-expanded', 'false'));
  };

  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.btn-kebab-nota');
    if (!btn) { if (!ev.target.closest('#menu-acciones-nota')) cerrar(); return; }
    ev.stopPropagation();

    const yaAbiertoParaEsteBtn = !menu.hidden && menu.dataset.notaId === btn.dataset.notaId;
    cerrar();
    if (yaAbiertoParaEsteBtn) return;

    const notaId = btn.dataset.notaId;
    menu.innerHTML = `<button type="button" class="dropdown-item danger" role="menuitem" onclick="anularNota('${notaId}')">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="10"/><line x1="4.9" y1="4.9" x2="19.1" y2="19.1"/></svg>
      Anular
    </button>`;
    menu.dataset.notaId = notaId;

    const r = btn.getBoundingClientRect();
    menu.style.top   = `${r.bottom + 4}px`;
    menu.style.left  = 'auto';
    menu.style.right = `${window.innerWidth - r.right}px`;
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  });

  menu.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (ev.target.closest('.dropdown-item')) cerrar();
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') cerrar(); });
  window.addEventListener('resize', cerrar);
  document.getElementById('tbody-notas')?.addEventListener('scroll', cerrar);
})();

// Antes filtraba en memoria sobre `todasNotas` (el recorte fijo de 500).
// Ahora dispara una nueva carga server-side, resetea a la página 1.
function filtrarNotas() {
  paginaActualNotas = 1;
  cargarNotas();
}

// ── Paginación ──────────────────────────────────────────────────────────
function inyectarControlesPaginacionNotas() {
  if (document.getElementById('paginacion-notas')) return; // ya existe
  const contenedor = document.querySelector('#vista-notas .tabla-wrap') || document.getElementById('vista-notas') || document.body;
  const div = document.createElement('div');
  div.id = 'paginacion-notas';
  div.className = 'paginacion-container';
  div.innerHTML = `
      <button id="btn-prev-notas" class="btn-pag" onclick="cambiarPaginaNotas(-1)">Anterior</button>
      <span id="info-pag-notas">Página 1</span>
      <button id="btn-next-notas" class="btn-pag" onclick="cambiarPaginaNotas(1)">Siguiente</button>
  `;
  contenedor.appendChild(div);
}

function actualizarControlesPaginacionNotas() {
  const totalPaginas = Math.max(1, Math.ceil(totalNotasFiltradas / ITEMS_POR_PAGINA_NOTAS));
  const info = document.getElementById('info-pag-notas');
  if (info) info.textContent = `Página ${paginaActualNotas} de ${totalPaginas} (${totalNotasFiltradas} notas)`;
  const btnPrev = document.getElementById('btn-prev-notas');
  const btnNext = document.getElementById('btn-next-notas');
  if (btnPrev) btnPrev.disabled = paginaActualNotas <= 1;
  if (btnNext) btnNext.disabled = paginaActualNotas >= totalPaginas;
}

function cambiarPaginaNotas(delta) {
  const totalPaginas = Math.max(1, Math.ceil(totalNotasFiltradas / ITEMS_POR_PAGINA_NOTAS));
  const nueva = paginaActualNotas + delta;
  if (nueva < 1 || nueva > totalPaginas) return;
  paginaActualNotas = nueva;
  cargarNotas();
}
window.cambiarPaginaNotas = cambiarPaginaNotas;

function abrirModalNota() {
  tipoSeleccionado = null;
  document.getElementById('btn-tipo-credito').className = 'nota-tipo-btn';
  document.getElementById('btn-tipo-debito').className = 'nota-tipo-btn';
  document.getElementById('nota-cliente').value = '';
  document.getElementById('nota-monto').value = '';
  document.getElementById('nota-motivo').value = '';
  document.getElementById('modal-nota').classList.remove('hidden');
}

function cerrarModalNota() {
  document.getElementById('modal-nota').classList.add('hidden');
}

function setTipoNota(tipo) {
  tipoSeleccionado = tipo;
  document.getElementById('btn-tipo-credito').className = 'nota-tipo-btn' + (tipo === 'credito' ? ' selected-credito' : '');
  document.getElementById('btn-tipo-debito').className = 'nota-tipo-btn' + (tipo === 'debito' ? ' selected-debito' : '');
}

async function guardarNota() {
  if (!tipoSeleccionado) { mostrarToast('Seleccioná el tipo de nota', 'err'); return; }
  const cliente_id = document.getElementById('nota-cliente').value;
  const monto = parseFloat(document.getElementById('nota-monto').value);
  const fecha = document.getElementById('nota-fecha').value;
  const motivo = document.getElementById('nota-motivo').value.trim();

  if (!cliente_id) { mostrarToast('Seleccioná el cliente', 'err'); return; }
  if (!monto || monto <= 0) { mostrarToast('Ingresá un monto válido', 'err'); return; }
  if (!fecha) { mostrarToast('Ingresá la fecha', 'err'); return; }

  const okNota = await window.confirmar(
    `¿Confirmás emitir esta nota de ${tipoSeleccionado === 'credito' ? 'crédito' : 'débito'} por $${monto}? Impacta directo en la cuenta corriente del cliente.`,
    { labelOk: 'Emitir', labelCancel: 'Revisar' }
  );
  if (!okNota) return;

  const btn = document.getElementById('btn-guardar-nota');
  btn.disabled = true; btn.textContent = 'Procesando...';

  try {
    // Numeración secuencial real (RPC siguiente_numero_comprobante,
    // atómica vía SELECT...FOR UPDATE) en lugar de 'PROV-' + Date.now()
    const sb = window.authCtx?.sb;
    const { data, error } = await sb.rpc('emitir_nota_cta_cte', {
      p_empresa_id:  window.authCtx?.perfil?.empresa_id,
      p_cliente_id:  cliente_id,
      p_tipo:        tipoSeleccionado === 'credito' ? 'nota_credito' : 'nota_debito',
      p_importe:     monto,
      p_descripcion: motivo || null,
      p_fecha:       fecha,
    });

    if (error) throw new Error(error.message);
    if (!data?.ok) throw new Error(data?.error || 'Error desconocido al emitir la nota');

    mostrarToast(`Nota ${data.nro} emitida e impactada en la cuenta corriente`, 'ok');
    cerrarModalNota();
    paginaActualNotas = 1;
    await cargarNotas();
  } catch(e) {
    console.error(e);
    mostrarToast('No se pudo emitir la nota. Probá de nuevo.', 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Emitir Nota';
  }
}

// ── Detalle de nota ──────────────────────────────────────────────────────
// No hace falta un fetch aparte: fn_notas_lista ya trae todos los campos
// necesarios y quedan en memoria en `notas` desde cargarNotas().
function verDetalleNota(id) {
  const n = notas.find(x => String(x.id) === String(id));
  if (!n) { mostrarToast('No se encontró la nota', 'err'); return; }

  const esCredito = n.tipo === 'nota_credito';
  document.getElementById('detalle-nota-tipo').innerHTML =
    `<span class="chip ${esCredito ? 'chip-verde' : 'chip-rojo'}">${esCredito ? 'Nota de Crédito' : 'Nota de Débito'}</span>${n.anulado ? ' <span class="chip chip-gris">Anulada</span>' : ''}`;
  document.getElementById('detalle-nota-numero').textContent = n.nro_comprobante || '—';
  document.getElementById('detalle-nota-fecha').textContent = formatFecha(n.fecha);
  document.getElementById('detalle-nota-monto').innerHTML =
    `<span class="${esCredito ? 'monto-verde' : 'monto-rojo'}">${formatPeso(n.importe)}</span>`;
  document.getElementById('detalle-nota-cliente').textContent =
    window.sanitize(n.clientes?.nombre_fantasia || n.clientes?.razon_social || '—');
  document.getElementById('detalle-nota-motivo').textContent = n.descripcion || 'Sin motivo especificado';

  const btnAnular = document.getElementById('btn-anular-nota-detalle');
  if (btnAnular) {
    btnAnular.style.display = n.anulado ? 'none' : '';
    btnAnular.onclick = () => anularNota(id);
  }

  document.getElementById('modal-detalle-nota').classList.remove('hidden');
}
window.verDetalleNota = verDetalleNota;

// ── Anular (la fila queda, solo se marca — mantiene la numeración fiscal) ──
async function anularNota(id) {
  const n = notas.find(x => String(x.id) === String(id));
  if (!n) return;

  const motivo = prompt('Motivo de la anulación (opcional):') || null;
  const ok = await window.confirmar(
    `¿Anular la nota N° ${n.nro_comprobante || ''}? El saldo del cliente se va a recalcular sin este movimiento. Esta acción no se puede deshacer.`,
    { labelOk: 'Anular', labelCancel: 'Cancelar', tipo: 'danger' }
  );
  if (!ok) return;

  try {
    const sb = window.authCtx?.sb;
    const { data, error } = await sb.rpc('anular_nota_cta_cte', {
      p_empresa_id: window.authCtx?.perfil?.empresa_id,
      p_id: id,
      p_usuario_id: window.authCtx?.perfil?.id,
      p_motivo: motivo,
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || 'No se pudo anular la nota');

    mostrarToast('Nota anulada', 'ok');
    document.getElementById('modal-detalle-nota').classList.add('hidden');
    await cargarNotas();
  } catch (e) {
    console.error('[NOTAS] anularNota:', e);
    mostrarToast(e.message || 'No se pudo anular la nota.', 'err');
  }
}
window.anularNota = anularNota;

function cerrarModalDetalleNota() {
  document.getElementById('modal-detalle-nota').classList.add('hidden');
}
window.cerrarModalDetalleNota = cerrarModalDetalleNota;

function formatPeso(n) {
  return '$' + (n||0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatFecha(s) {
  if (!s) return '—';
  const d = new Date(s);
  return d.toLocaleDateString('es-AR');
}

// [Etapa 3] mostrarToast local eliminado — usa window.mostrarToast global (ui-utils.js)

// Exponer funciones al scope global (requerido por los onclick del HTML)
window.abrirModalNota = abrirModalNota;
window.cerrarModalNota = cerrarModalNota;
window.guardarNota = guardarNota;
window.setTipoNota = setTipoNota;
