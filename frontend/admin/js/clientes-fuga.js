/* admin/js/clientes-fuga.js — Fase 3 de PLAN_CLIENTES_EN_FUGA.md
 *
 * Fuente de datos: GET /api/clientes-fuga (lib/handlers/clientes-fuga.js),
 * que a su vez llama a listarClientesEnFuga (lib/repos/clientes-fuga.js).
 * No se llama a fn_clientes_en_fuga por RPC directo desde el cliente
 * Supabase del frontend: tiene el EXECUTE revocado para authenticated/anon
 * (mismo criterio que v_cobranza_priorizada en riesgo-cheques.js) — por
 * eso pasa por este endpoint backend con service_role, filtrado por
 * empresa_id del token.
 *
 * "Acción ya disparada" (accion_disparada) viene resuelta desde el
 * backend contra tareas_automatizacion / notif_log, no se recalcula acá:
 * 'sin_accion' | 'tarea_pendiente' | 'tarea_completada' | 'whatsapp_enviado'.
 */

let _sb = null;
let esVendedorFuga = false;
let todosClientesFuga = [];
let filtroMotivoFuga = 'todos'; // 'todos' | 'deuda' | 'competencia' — ver initFiltroTabsFuga()

// ── Paginación cliente ("Cargar más") ───────────────────────────────────
const FUGA_MOSTRAR_INICIAL = 20;
const FUGA_PAGINA = 40;
let _fugaVisibles = FUGA_MOSTRAR_INICIAL;

function piePaginacionHTML(colspan, total, visibles, mostrarInicial, pagina, cargarMasFn, colapsarFn) {
  const hayMas = total > visibles;
  const puedeColapsar = visibles > mostrarInicial;
  if (!hayMas && !puedeColapsar) return '';
  const restantes = total - visibles;
  return `<tr class="paginar-fila"><td colspan="${colspan}"><div class="paginar-foot">
    ${hayMas ? `<button type="button" class="paginar-btn" onclick="${cargarMasFn}()">Cargar ${Math.min(pagina, restantes)} más (quedan ${restantes})</button>` : ''}
    ${puedeColapsar ? `<button type="button" class="paginar-btn paginar-btn--ghost" onclick="${colapsarFn}()">Ver menos</button>` : ''}
  </div></td></tr>`;
}

const ACCION_ESTADOS = {
  sin_accion:       { cls: 'badge-critico', label: 'Sin acción todavía' },
  tarea_pendiente:  { cls: 'badge-warning', label: 'Tarea pendiente' },
  tarea_completada: { cls: 'badge-ok',      label: 'Tarea resuelta' },
  whatsapp_enviado: { cls: 'badge-info',    label: 'WhatsApp enviado' },
};

const MOTIVO_LABEL = {
  posible_freno_por_deuda:     'Freno por deuda',
  posible_fuga_a_competencia:  'Posible fuga a competencia',
};

window.authReady.then(async () => {
  const user = window.authCtx?.perfil;
  if (!user) { window.location.href = '/admin/login'; return; }
  _sb = window.authCtx.sb;
  esVendedorFuga = user.rol === 'vendedor';

  const hoy = new Date();
  const elFecha = document.getElementById('topbar-fecha');
  if (elFecha) elFecha.textContent = hoy.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  (document.getElementById('topbar-usuario') || {}).textContent = user.nombre || user.email;

  if (esVendedorFuga) {
    const label = document.getElementById('label-solo-mio-fuga');
    if (label) label.style.display = 'flex';
  }

  initFiltroTabsFuga();
  await cargarClientesFuga();
}).catch(err => {
  console.error('[clientes-fuga] authReady falló:', err?.message);
  window.location.href = '/admin/login';
});

// ── Carga principal ─────────────────────────────────────────────────────
async function getFreshToken() {
  const { data: { session } } = await _sb.auth.getSession();
  return session?.access_token || '';
}

async function cargarClientesFuga() {
  try {
    window.mostrarSkeletonTabla('tbody-clientes-fuga', 5, 6);

    const soloMio = esVendedorFuga && document.getElementById('filtro-solo-mio-fuga')?.checked;
    const qs = soloMio ? '?solo_mio=1' : '';
    const token = await getFreshToken();
    const resp = await window.conTimeoutRed(
      fetch(`/api/clientes-fuga${qs}`, { headers: { Authorization: `Bearer ${token}` } }),
      10000
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || 'Error al cargar clientes en fuga');
    }
    const resultado = await resp.json();

    todosClientesFuga = resultado.clientes || [];
    _fugaVisibles = FUGA_MOSTRAR_INICIAL;
    actualizarKPIsFuga(resultado, todosClientesFuga);
    renderTablaFuga(todosClientesFuga);
  } catch (e) {
    console.error('[clientes-fuga] Error cargando:', e);
    mostrarToast('No se pudo cargar la lista de clientes en fuga', 'err');
    document.getElementById('tbody-clientes-fuga').innerHTML =
      `<tr><td colspan="6"><div class="empty-state">No se pudo cargar la lista</div></td></tr>`;
  }
}

async function recargarClientesFuga() {
  await cargarClientesFuga();
  mostrarToast('Lista actualizada', 'ok');
}

// ── KPIs ─────────────────────────────────────────────────────────────────
function formatPeso(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
}

function actualizarKPIsFuga(resultado, listaMostrada) {
  const sinAccion = listaMostrada.filter(c => c.accion_disparada === 'sin_accion').length;

  document.getElementById('kpi-total-fuga').textContent = resultado.total_clientes_en_fuga || 0;
  document.getElementById('kpi-total-fuga-sub').textContent =
    resultado.clientes_mostrados < resultado.total_clientes_en_fuga
      ? `Mostrando los ${resultado.clientes_mostrados} de mayor valor`
      : '';
  document.getElementById('kpi-valor-riesgo').textContent = formatPeso(resultado.valor_anual_total_en_riesgo);
  document.getElementById('kpi-sin-accion').textContent = sinAccion;

  FiltroTabs.actualizarContadores(document.getElementById('filtro-tabs-fuga'), {
    todos: listaMostrada.length,
    deuda: listaMostrada.filter(c => c.motivo_probable === 'posible_freno_por_deuda').length,
    competencia: listaMostrada.filter(c => c.motivo_probable === 'posible_fuga_a_competencia').length,
  });
}

function initFiltroTabsFuga() {
  FiltroTabs.crear(document.getElementById('filtro-tabs-fuga'), [
    { key: 'todos',       label: 'Todos' },
    { key: 'deuda',       label: 'Freno por deuda' },
    { key: 'competencia', label: 'Posible fuga a competencia' },
  ], filtroMotivoFuga, (key) => {
    filtroMotivoFuga = key;
    _fugaVisibles = FUGA_MOSTRAR_INICIAL;
    renderTablaFuga(todosClientesFuga);
  });
}

// ── Filtro de búsqueda + motivo ─────────────────────────────────────────
function listaFiltradaFuga() {
  const q = (document.getElementById('buscar-fuga')?.value || '').trim().toLowerCase();
  return todosClientesFuga.filter(c => {
    if (filtroMotivoFuga === 'deuda' && c.motivo_probable !== 'posible_freno_por_deuda') return false;
    if (filtroMotivoFuga === 'competencia' && c.motivo_probable !== 'posible_fuga_a_competencia') return false;
    if (q && !String(c.razon_social || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

function filtrarClientesFuga() {
  _fugaVisibles = FUGA_MOSTRAR_INICIAL;
  renderTablaFuga(todosClientesFuga);
}

function cargarMasFuga() {
  _fugaVisibles = Math.min(_fugaVisibles + FUGA_PAGINA, listaFiltradaFuga().length);
  renderTablaFuga(todosClientesFuga);
}

function colapsarFuga() {
  _fugaVisibles = FUGA_MOSTRAR_INICIAL;
  renderTablaFuga(todosClientesFuga);
  document.getElementById('tabla-fuga-wrap')?.scrollIntoView({ block: 'nearest' });
}

// ── Render ───────────────────────────────────────────────────────────────
function renderTablaFuga() {
  const tbody = document.getElementById('tbody-clientes-fuga');
  const lista = listaFiltradaFuga();

  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 6 9 17l-5-5"/></svg>
      Ningún cliente rompió su ritmo de compra habitual — todo en orden.
    </div></td></tr>`;
    return;
  }

  const visibles = lista.slice(0, _fugaVisibles);

  tbody.innerHTML = visibles.map(c => {
    const accion = ACCION_ESTADOS[c.accion_disparada] || ACCION_ESTADOS.sin_accion;
    const motivoLabel = MOTIVO_LABEL[c.motivo_probable] || c.motivo_probable || '—';
    const accionFecha = c.accion_fecha
      ? `<small class="empty-hint" style="display:block;margin-top:2px;">${new Date(c.accion_fecha).toLocaleDateString('es-AR')}</small>`
      : '';

    return `
      <tr>
        <td data-label="Cliente"><strong>${window.sanitize(c.razon_social || '—')}</strong></td>
        <td data-label="Hace">${c.dias_atraso ?? '—'} días</td>
        <td data-label="Solía pedir">${window.sanitize(c.producto_principal || '—')}</td>
        <td data-label="Valor anual">${formatPeso(c.valor_anual_estimado)}</td>
        <td data-label="Motivo probable" class="thead-sep">${window.sanitize(motivoLabel)}</td>
        <td data-label="Acción ya disparada">
          <span class="badge-estado ${accion.cls}"><span class="badge-dot"></span>${accion.label}</span>
          ${accionFecha}
        </td>
      </tr>`;
  }).join('') + piePaginacionHTML(6, lista.length, visibles.length, FUGA_MOSTRAR_INICIAL, FUGA_PAGINA, 'cargarMasFuga', 'colapsarFuga');
}
