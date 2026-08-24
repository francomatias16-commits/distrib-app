/* admin/js/cheques.js — Pantalla J: Gestión de Cheques */

let _sb = null; // FIX v125: usa authCtx.sb (patrón unificado)


let todosCheques = []; // cheques de la PÁGINA actual (ya no es el dataset completo — ver fn_cheques_lista, migración 259)
let clientes = [];

let paginaActualCheques = 1;
const ITEMS_POR_PAGINA_CHEQUES = 100;
let totalChequesFiltrados = 0;

// v908 — Pedido directo: "N cheques vencen en los próximos 3 días" (alerta
// + sello "$X — Vencen en 3 días") era de solo lectura, sin forma de ver
// esos cheques puntuales. Filtro nuevo, aparte de "Solo vencidos" (que es
// otra cosa: cheques YA vencidos). Ver fn_cheques_lista, migración 513.
let filtroProximosActivo = false;

const ESTADO_CHIP = {
  pendiente:   { cls: 'chip-gris',     label: 'Pendiente' },
  en_cartera:  { cls: 'chip-azul',     label: 'En cartera' },
  depositado:  { cls: 'chip-amarillo', label: 'Depositado' },
  cobrado:     { cls: 'chip-verde',    label: 'Cobrado' },
  rechazado:   { cls: 'chip-rojo',     label: 'Rechazado' },
  entregado_proveedor: { cls: 'chip-gris', label: 'Endosado' }, // FIX: la key debe ser el valor real del constraint (cheques_estado_check), no el sinónimo "endosado"
  anulado:     { cls: 'chip-rojo',     label: 'Anulado' },
};

window.authReady.then(async () => {
  const user = window.authCtx?.perfil;
  if (!user) { window.location.href = '/admin/login'; return; }
  _sb = window.authCtx.sb;

  const hoy = new Date();
  const elFecha = document.getElementById('topbar-fecha');
  if (elFecha) elFecha.textContent = hoy.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  document.getElementById('cheque-recepcion').value = window.hoyLocalISO ? window.hoyLocalISO() : hoy.toISOString().split('T')[0];
  (document.getElementById('topbar-usuario') || {}).textContent = user.nombre || user.email;

  try { inyectarControlesPaginacionCheques(); } catch(e) { console.warn('[cheques] paginacion init:', e.message); }

  initFiltroTabsCheques();

  // Buscador con debounce (250ms, mismo criterio que clientes.js/busqueda-global.js):
  // ahora que la búsqueda pega contra Supabase (fn_cheques_lista) en vez de
  // filtrar en memoria, disparar una query por tecla sería innecesario y lento.
  const inputBuscar = document.getElementById('buscar-cheque');
  if (inputBuscar) {
    let debounceBusquedaCheques = null;
    inputBuscar.addEventListener('input', () => {
      clearTimeout(debounceBusquedaCheques);
      debounceBusquedaCheques = setTimeout(() => filtrarCheques(), 250);
    });
  }

  await Promise.all([cargarContadoresCheques(), cargarClientes()]);

  // Prefiltro opcional desde otras pantallas, ej. riesgo-cheques.js:
  // /admin/cheques?buscar=Nombre+Cliente
  const buscarParam = new URLSearchParams(window.location.search).get('buscar');
  if (buscarParam) {
    document.getElementById('buscar-cheque').value = buscarParam;
  }

  // Prefiltro desde la alerta del dashboard: /admin/cheques.html?filtro=vencidos
  // o /admin/cheques.html?filtro=proximos (ver activarFiltroProximos, v908).
  const filtroParam = new URLSearchParams(window.location.search).get('filtro');
  if (filtroParam === 'vencidos') {
    const chk = document.getElementById('filtro-vencidos-cheque');
    if (chk) chk.checked = true;
  } else if (filtroParam === 'proximos') {
    filtroProximosActivo = true;
    marcarSelloProximosActivo(true);
  }

  await filtrarCheques();
}).catch(err => {
  console.error('[cheques] authReady falló:', err?.message);
  window.location.href = '/admin/login';
});

// Contadores de las 4 tarjetas KPI: sobre TODO el universo de cheques de la
// empresa (fn_cheques_contadores, migración 259), no sobre la página cargada
// ni sobre lo que había antes como recorte de 500 filas.
async function cargarContadoresCheques() {
  try {
    const { data, error } = await _sb.rpc('fn_cheques_contadores').single();
    if (error) throw error;
    actualizarKPIs(data);
    mostrarAlertasVencimiento(data);
  } catch(e) {
    console.error('[cheques] Error cargando contadores:', e);
  }
}

// Carga la página actual de la tabla según los filtros activos
// (búsqueda / estado / solo vencidos) vía fn_cheques_lista (migración 259).
async function cargarCheques() {
  try {
    const busq = document.getElementById('buscar-cheque').value.trim();
    const est  = document.getElementById('filtro-estado-cheque').value;
    const soloVencidos = !!document.getElementById('filtro-vencidos-cheque')?.checked;
    const desde = (paginaActualCheques - 1) * ITEMS_POR_PAGINA_CHEQUES;

    const { data, error } = await _sb.rpc('fn_cheques_lista', {
      p_busqueda: busq || null,
      p_estado: est || null,
      p_solo_vencidos: soloVencidos,
      p_limit: ITEMS_POR_PAGINA_CHEQUES,
      p_offset: desde,
      p_solo_proximos: filtroProximosActivo,
    });
    if (error) throw error;

    todosCheques = (data || []).map(c => ({
      ...c,
      clientes: (c.cliente_razon_social || c.cliente_nombre_fantasia)
        ? { razon_social: c.cliente_razon_social, nombre_fantasia: c.cliente_nombre_fantasia }
        : null,
    }));
    totalChequesFiltrados = data?.[0]?.total_count || 0;

    renderTabla(todosCheques);
    actualizarControlesPaginacionCheques();
  } catch(e) {
    console.error(e);
    mostrarToast('No se pudieron cargar los cheques', 'err');
  }
}

async function cargarClientes() {
  const { data: cliData } = await _sb
      .from('clientes')
      .select('id,razon_social,nombre_fantasia')
      .eq('activo', true)
      .order('razon_social');
    clientes = cliData || [];
  const sel = document.getElementById('cheque-cliente');
  sel.innerHTML = '<option value="">Seleccionar cliente...</option>' +
    clientes.map(c => `<option value="${c.id}">${window.sanitize(c.nombre_fantasia || c.razon_social)}</option>`).join('');
}

// ── KPIs ────────────────────────────────────────────────────────────
// `contadores` viene de fn_cheques_contadores() — ya trae los 8 totales
// agregados en SQL sobre el universo completo (ver migración 259).
function actualizarKPIs(contadores) {
  const c = contadores || {};
  FiltroTabs.actualizarContadores(document.getElementById('filtro-tabs-cheques'), {
    en_cartera: c.cant_cartera || 0,
    depositado: c.cant_depositado || 0,
    cobrado:    c.cant_cobrado_mes || 0,
    rechazado:  c.cant_rechazados || 0,
    anulado:    c.cant_anulado || 0,
  });
  document.getElementById('kpi-proximos').textContent = formatPeso(c.monto_proximos);
  document.getElementById('kpi-proximos-sub').textContent = `(${c.cant_proximos || 0} cheques)`;
}

function initFiltroTabsCheques() {
  FiltroTabs.crear(document.getElementById('filtro-tabs-cheques'), [
    { key: '',           label: 'Todos' },
    { key: 'en_cartera', label: 'En cartera' },
    // "Depositado" es un estado intermedio propio (cheque ya en el banco,
    // pendiente de acreditación) — antes no tenía tab ni contador, así que
    // un cheque en ese estado quedaba en la tabla pero invisible en los
    // chips de arriba y la suma de contadores no cerraba contra "Todos".
    { key: 'depositado', label: 'Depositados' },
    // El contador de "Cobrado" es del mes (fn_cheques_contadores), pero el
    // filtro real que dispara el tab trae TODOS los cobrados históricos
    // (fn_cheques_lista no tiene corte por mes) — mismo trade-off que ya
    // se aceptó en devoluciones/cobranzas: el número orienta, no es exacto
    // 1:1 con lo que muestra la tabla al hacer clic.
    { key: 'cobrado',    label: 'Cobrado (mes)' },
    { key: 'rechazado',  label: 'Rechazados' },
    { key: 'anulado',    label: 'Anulados' },
  ], '', (key) => {
    document.getElementById('filtro-estado-cheque').value = key;
    // v908: cambiar de pestaña es una elección explícita de otra categoría
    // — si el filtro "Vencen en 3 días" seguía activo, se desactiva para
    // que la tabla no quede combinando dos filtros sin indicarlo.
    filtroProximosActivo = false;
    marcarSelloProximosActivo(false);
    filtrarCheques();
  });
}

// ── "Vencen en 3 días": alerta + sello, ahora clickeables ──────────────
// v908 — Pedido directo: antes eran de solo lectura (ver comentario en
// cheques.html). Al hacer clic en cualquiera de los dos, se filtra la
// tabla a esos cheques puntuales (mismo criterio SQL que ya usa
// fn_cheques_contadores() para el número que muestran: en_cartera +
// vencimiento entre hoy y hoy+3 — ver fn_cheques_lista, migración 513).
function activarFiltroProximos() {
  filtroProximosActivo = true;
  marcarSelloProximosActivo(true);

  // Es un subconjunto de "en_cartera" por fecha, no un estado propio — se
  // limpian los otros filtros que podrían pisarlo o dejar la combinación
  // confusa (ej. quedar en la pestaña "Rechazados" con el sello marcado
  // como activo no tendría sentido: la tabla mostraría 0 resultados sin
  // que se entienda por qué).
  document.getElementById('filtro-estado-cheque').value = '';
  const chkVencidos = document.getElementById('filtro-vencidos-cheque');
  if (chkVencidos) chkVencidos.checked = false;
  const tabs = document.getElementById('filtro-tabs-cheques');
  if (tabs) {
    tabs.querySelectorAll('.filtro-tab').forEach((b) => {
      const esTodos = b.dataset.key === '';
      b.classList.toggle('activa', esTodos);
      b.setAttribute('aria-selected', esTodos ? 'true' : 'false');
    });
  }

  filtrarCheques();

  // Mismo patrón que irAClientesConAlerta() en riesgo-cheques.js: scroll a
  // la tabla + destello visual, para que quede claro que el filtro se
  // aplicó y dónde mirar (la tabla puede quedar fuera de la pantalla
  // arriba de la alerta en resoluciones chicas).
  const wrap = document.querySelector('.tabla-wrap');
  if (!wrap) return;
  wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  wrap.classList.remove('tabla-wrap--flash');
  void wrap.offsetWidth; // forzar reflow, reinicia la animación si se clickea 2 veces seguidas
  wrap.classList.add('tabla-wrap--flash');
  setTimeout(() => wrap.classList.remove('tabla-wrap--flash'), 1600);
}
window.activarFiltroProximos = activarFiltroProximos;

function marcarSelloProximosActivo(activo) {
  const sello = document.getElementById('sello-proximos');
  if (sello) sello.classList.toggle('sello-proximos-activo', activo);
}

function mostrarAlertasVencimiento(contadores) {
  const el = document.getElementById('alerta-vencimientos');
  const cant = contadores?.cant_proximos || 0;
  if (!cant) { el.style.display = 'none'; return; }

  el.style.display = 'block';
  // v908: la alerta ahora es un botón real (antes era un <div> de solo
  // lectura) — al hacer clic filtra la tabla a esos mismos cheques vía
  // activarFiltroProximos(). Mismo patrón visual/de interacción que ya usa
  // el banner de "caída de score" en riesgo-cheques.js (renderAlertasPanel):
  // <button> + chevron + scroll y destello sobre la tabla destino.
  el.innerHTML = `<button type="button" class="alerta-inline warning alerta-inline--clickable" onclick="activarFiltroProximos()">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
    <span><strong>${cant} cheque${cant>1?'s':''} vence${cant>1?'n':''} en los próximos 3 días</strong> — Total: ${formatPeso(contadores.monto_proximos)}. Recordá depositar a tiempo.</span>
    <svg class="alerta-inline-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
  </button>`;
}

// ── Paginación ──────────────────────────────────────────────────────
function inyectarControlesPaginacionCheques() {
  if (document.getElementById('paginacion-cheques')) return; // ya existe
  const contenedor = document.getElementById('vista-cheques') || document.body;
  const div = document.createElement('div');
  div.id = 'paginacion-cheques';
  div.className = 'paginacion-container';
  div.innerHTML = `
      <button id="btn-prev-cheques" class="btn-pag" onclick="cambiarPaginaCheques(-1)">Anterior</button>
      <span id="info-pag-cheques">Página 1</span>
      <button id="btn-next-cheques" class="btn-pag" onclick="cambiarPaginaCheques(1)">Siguiente</button>
  `;
  contenedor.appendChild(div);
}

function actualizarControlesPaginacionCheques() {
  const totalPaginas = Math.max(1, Math.ceil(totalChequesFiltrados / ITEMS_POR_PAGINA_CHEQUES));
  const info = document.getElementById('info-pag-cheques');
  if (info) info.textContent = `Página ${paginaActualCheques} de ${totalPaginas} (${totalChequesFiltrados} cheques)`;
  const btnPrev = document.getElementById('btn-prev-cheques');
  const btnNext = document.getElementById('btn-next-cheques');
  if (btnPrev) btnPrev.disabled = paginaActualCheques <= 1;
  if (btnNext) btnNext.disabled = paginaActualCheques >= totalPaginas;
}

function cambiarPaginaCheques(delta) {
  const totalPaginas = Math.max(1, Math.ceil(totalChequesFiltrados / ITEMS_POR_PAGINA_CHEQUES));
  const nueva = paginaActualCheques + delta;
  if (nueva < 1 || nueva > totalPaginas) return;
  paginaActualCheques = nueva;
  cargarCheques();
}
window.cambiarPaginaCheques = cambiarPaginaCheques;

// ── Tabla ────────────────────────────────────────────────────────────
function renderTabla(cheques) {
  const tbody = document.getElementById('tbody-cheques');
  if (!cheques.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
      Todavía no cargaste ningún cheque. Usá el botón "Nuevo cheque" arriba a la derecha para registrar el primero.</div></td></tr>`;
    return;
  }

  const hoy = new Date(); hoy.setHours(0,0,0,0);

  tbody.innerHTML = cheques.map(c => {
    const chip = ESTADO_CHIP[c.estado] || { cls: 'chip-gris', label: c.estado };
    const nombre = c.clientes?.nombre_fantasia || c.clientes?.razon_social || '—';
    const vto = c.vencimiento ? new Date(c.vencimiento) : null;
    const vencido = esVencido(c);
    const vtoStr = vto ? `<span ${vencido ? 'style="color:var(--color-danger);font-weight:600"' : ''}>${formatFecha(c.vencimiento)}${vencido ? ' <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' : ''}</span>` : '—';

    return `<tr data-testid="cheque-fila" data-id="${c.id}" class="fila-clickeable" onclick="if (event.target.closest('[onclick],a,select,input,textarea,button') === this) editarCheque('${c.id}')">
      <td data-label="N° Cheque" style="font-family:monospace;font-size:12px">${c.numero || '—'}</td>
      <td data-label="Cliente">${window.sanitize(nombre)}</td>
      <td data-label="Banco" style="font-size:12px">${c.banco || '—'}</td>
      <td class="monto" data-label="Monto">${formatPeso(c.monto)}</td>
      <td data-label="Vencimiento">${vtoStr}</td>
      <td data-label="Estado"><span class="chip ${chip.cls}">${chip.label}</span></td>
      <td class="col-sticky-end td-acciones-cheque" data-label="Acciones">
        <span class="fila-acciones">
          <button type="button" class="btn-tabla" onclick="editarCheque('${c.id}')">Editar</button>
          <button type="button" class="btn-tabla btn-verificar-bcra" onclick="abrirModalBcraDenuncia('${c.id}')">Verificar BCRA</button>
          <select class="select-estado-cheque" onchange="cambiarEstado('${c.id}', this.value, '${c.estado}')" title="Cambiar estado">
            <option value="">Estado...</option>
            <option value="en_cartera">En cartera</option>
            <option value="depositado">Depositado</option>
            <option value="cobrado">Cobrado</option>
            <option value="rechazado">Rechazado</option>
            <option value="entregado_proveedor">Endosado</option>
            <option value="anulado">Anulado</option>
          </select>
        </span>
      </td>
    </tr>`;
  }).join('');
}

// ── Filtros ──────────────────────────────────────────────────────────
// Mismo criterio que usa el backend para la alerta proactiva del dashboard
// (GET /api/admin/alertas → resumen_cheques_vencidos): en_cartera + fecha_vto
// vencida. Se usa fecha_vto (no vencimiento) porque es la columna que el
// cron y las migraciones garantizan completa — ver comentario en admin.js.
function esVencido(c) {
  if (c.estado !== 'en_cartera') return false;
  const vto = c.fecha_vto || c.vencimiento;
  if (!vto) return false;
  const hoyISO = new Date().toISOString().slice(0, 10);
  return String(vto).slice(0, 10) < hoyISO;
}

async function filtrarCheques() {
  paginaActualCheques = 1;
  await cargarCheques();
}

// Wrapper del checkbox "Solo vencidos": son dos filtros mutuamente
// excluyentes (cheques YA vencidos vs. cheques que vencen en los
// próximos 3 días) — activar uno desactiva el otro para no dejar la
// combinación sin sentido (ver activarFiltroProximos, v908).
function onFiltroVencidosChange() {
  filtroProximosActivo = false;
  marcarSelloProximosActivo(false);
  filtrarCheques();
}
window.onFiltroVencidosChange = onFiltroVencidosChange;

// ── Modal ────────────────────────────────────────────────────────────
function abrirModalNuevoCheque() {
  document.getElementById('modal-cheque-titulo').textContent = 'Nuevo cheque';
  document.getElementById('cheque-id-edit').value = '';
  document.getElementById('cheque-numero').value = '';
  document.getElementById('cheque-banco').value = '';
  document.getElementById('cheque-monto').value = '';
  document.getElementById('cheque-vencimiento').value = '';
  document.getElementById('cheque-estado').value = 'en_cartera';
  document.getElementById('cheque-obs').value = '';
  document.getElementById('modal-cheque').classList.remove('hidden');
}

function editarCheque(id) {
  const c = todosCheques.find(x => x.id === id);
  if (!c) return;
  document.getElementById('modal-cheque-titulo').textContent = 'Editar cheque';
  document.getElementById('cheque-id-edit').value = c.id;
  document.getElementById('cheque-cliente').value = c.cliente_id || '';
  document.getElementById('cheque-numero').value = c.numero || '';
  document.getElementById('cheque-banco').value = c.banco || '';
  document.getElementById('cheque-monto').value = c.monto || '';
  document.getElementById('cheque-vencimiento').value = c.vencimiento || '';
  document.getElementById('cheque-recepcion').value = c.fecha_recepcion || '';
  document.getElementById('cheque-estado').value = c.estado || 'en_cartera';
  document.getElementById('cheque-obs').value = c.notas || '';
  document.getElementById('modal-cheque').classList.remove('hidden');
}

function cerrarModalCheque() {
  document.getElementById('modal-cheque').classList.add('hidden');
}

async function guardarCheque() {
  const numero     = document.getElementById('cheque-numero').value.trim();
  const banco      = document.getElementById('cheque-banco').value.trim();
  const monto      = parseFloat(document.getElementById('cheque-monto').value);
  const vencimiento = document.getElementById('cheque-vencimiento').value;
  const cliente_id = document.getElementById('cheque-cliente').value;

  if (!numero)     { mostrarToast('Ingresá el número de cheque', 'err'); return; }
  if (!banco)      { mostrarToast('Ingresá el banco', 'err'); return; }
  if (!monto || monto <= 0) { mostrarToast('Ingresá un monto válido', 'err'); return; }
  if (!vencimiento){ mostrarToast('Ingresá la fecha de vencimiento', 'err'); return; }
  if (!cliente_id) { mostrarToast('Seleccioná el cliente', 'err'); return; }

  const editIdChk = document.getElementById('cheque-id-edit').value;
  const ok = await window.confirmar(
    editIdChk ? `¿Guardar los cambios de este cheque?` : `¿Confirmás registrar este cheque de $${monto} por ${banco}?`,
    { labelOk: editIdChk ? 'Guardar' : 'Registrar', labelCancel: 'Revisar' }
  );
  if (!ok) return;

  const payload = {
    empresa_id:     window.authCtx?.perfil?.empresa_id,
    cliente_id,
    numero,
    banco,
    monto,
    vencimiento,
    fecha_vto:      vencimiento,   // FIX: columna NOT NULL — se mantiene sincronizada con vencimiento
    fecha_recepcion: document.getElementById('cheque-recepcion').value || null,
    estado:         document.getElementById('cheque-estado').value,
    notas:          document.getElementById('cheque-obs').value || null,
  };

  const btn = document.getElementById('btn-guardar-cheque');
  btn.disabled = true; btn.textContent = 'Guardando...';

  try {
    const editId = document.getElementById('cheque-id-edit').value;
    let r;
    if (editId) {
      const _h1 = await (async()=>{const{data:{session}}=await _sb.auth.getSession();return{"apikey":window.ENV.SUPABASE_ANON_KEY,"Authorization":`Bearer ${session?.access_token}`,"Content-Type":"application/json"};})();
      r = await fetch(`${window.ENV.SUPABASE_URL}/rest/v1/cheques?id=eq.${editId}`, {
        method: 'PATCH',
        headers: { ..._h1, 'Prefer': 'return=minimal' },
        body: JSON.stringify(payload),
      });
    } else {
      const _h2 = await (async()=>{const{data:{session}}=await _sb.auth.getSession();return{"apikey":window.ENV.SUPABASE_ANON_KEY,"Authorization":`Bearer ${session?.access_token}`,"Content-Type":"application/json"};})();
      r = await fetch(`${window.ENV.SUPABASE_URL}/rest/v1/cheques`, {
        method: 'POST',
        headers: { ..._h2, 'Prefer': 'return=minimal' },
        body: JSON.stringify(payload),
      });
    }
    if (!r.ok) throw new Error(await r.text());
    mostrarToast(editId ? 'Cheque actualizado' : 'Cheque registrado', 'ok');
    cerrarModalCheque();
    await Promise.all([cargarCheques(), cargarContadoresCheques()]);
  } catch(e) {
    console.error(e);
    mostrarToast('No se pudo guardar el cheque', 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Guardar cheque';
  }
}

// ── Anular (solo cheques que todavía no se movieron: pendiente/en_cartera) ──
// FIX (hallazgo 3, auditoría CRUD 2026): antes hacía DELETE real contra la
// REST de Supabase, perdiendo el registro para siempre y sin poder
// deshacerlo — a diferencia de facturas/notas de crédito, que se anulan
// conservando el comprobante. Ahora hace PATCH a estado='anulado' (valor ya
// soportado por cheques_estado_check desde la migración 077); el cheque
// sigue existiendo, solo deja de contar como activo, y se puede reactivar
// (volver a "En cartera") desde el mismo botón si fue un error.
async function eliminarCheque(id) {
  const c = todosCheques.find(x => x.id === id);
  const mensaje = `¿Anular el cheque${c?.numero ? ' N° ' + c.numero : ''}? Podés reactivarlo después si fue un error.`;

  let motivo = null;
  let confirmado = false;
  if (window.confirmarConTexto) {
    const resultado = await window.confirmarConTexto(mensaje, {
      labelOk: 'Anular', labelCancel: 'Cancelar', placeholder: 'Motivo (opcional)', requerido: false,
    });
    confirmado = resultado !== null;
    motivo = resultado || null;
  } else if (window.confirmar) {
    confirmado = await window.confirmar(mensaje, { labelOk: 'Anular', labelCancel: 'Cancelar', tipo: 'danger' });
  } else {
    confirmado = confirm('¿Anular este cheque?');
  }
  if (!confirmado) return;

  try {
    const { data: { session } } = await _sb.auth.getSession();
    const r = await fetch(`${window.ENV.SUPABASE_URL}/rest/v1/cheques?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        apikey: window.ENV.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session?.access_token}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ estado: 'anulado', motivo_anulacion: motivo }),
    });
    if (!r.ok) throw new Error(await r.text());
    mostrarToast('Cheque anulado', 'ok');
    await Promise.all([cargarCheques(), cargarContadoresCheques()]);
  } catch (e) {
    console.error('[CHEQUES] eliminarCheque:', e);
    mostrarToast('No se pudo anular el cheque.', 'err');
  }
}
window.eliminarCheque = eliminarCheque;

// ── Reactivar un cheque anulado por error (deshacer la anulación) ───────
async function reactivarCheque(id) {
  const c = todosCheques.find(x => x.id === id);
  const ok = await (window.confirmar
    ? window.confirmar(`¿Reactivar el cheque${c?.numero ? ' N° ' + c.numero : ''}? Vuelve a "En cartera".`, { labelOk: 'Reactivar' })
    : Promise.resolve(confirm('¿Reactivar este cheque?')));
  if (!ok) return;

  try {
    const { data: { session } } = await _sb.auth.getSession();
    const r = await fetch(`${window.ENV.SUPABASE_URL}/rest/v1/cheques?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        apikey: window.ENV.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session?.access_token}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ estado: 'en_cartera', motivo_anulacion: null }),
    });
    if (!r.ok) throw new Error(await r.text());
    mostrarToast('Cheque reactivado', 'ok');
    await Promise.all([cargarCheques(), cargarContadoresCheques()]);
  } catch (e) {
    console.error('[CHEQUES] reactivarCheque:', e);
    mostrarToast('No se pudo reactivar el cheque.', 'err');
  }
}
window.reactivarCheque = reactivarCheque;

async function cambiarEstado(id, nuevoEstado, estadoActual) {
  if (!nuevoEstado) return;

  // "Anulado" y la reactivación desde "Anulado" piden confirmación + motivo
  // (mismo flujo que antes vivía en el menú "⋮" — ver eliminarCheque/reactivarCheque).
  if (nuevoEstado === 'anulado') {
    await eliminarCheque(id);
    return;
  }
  if (estadoActual === 'anulado' && nuevoEstado === 'en_cartera') {
    await reactivarCheque(id);
    return;
  }

  try {
    const _h3 = await (async()=>{const{data:{session}}=await _sb.auth.getSession();return{"apikey":window.ENV.SUPABASE_ANON_KEY,"Authorization":`Bearer ${session?.access_token}`,"Content-Type":"application/json"};})();
    const r = await fetch(`${window.ENV.SUPABASE_URL}/rest/v1/cheques?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ..._h3, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ estado: nuevoEstado }),
    });
    if (!r.ok) throw new Error(await r.text());

    // Si rechazado: disparar alerta
    if (nuevoEstado === 'rechazado') {
      const c = todosCheques.find(x => x.id === id);
      const nombre = c?.clientes?.nombre_fantasia || c?.clientes?.razon_social || 'Cliente';
      mostrarToast(`Cheque rechazado de ${nombre} — revisar crédito`, 'err');
    } else {
      mostrarToast('Estado actualizado', 'ok');
    }
    await Promise.all([cargarCheques(), cargarContadoresCheques()]);
  } catch(e) {
    mostrarToast('No se pudo cambiar el estado', 'err');
  }
}

// ── Helpers ──────────────────────────────────────────────────────────
function formatPeso(n) {
  return '$' + (n||0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatFecha(f) {
  if (!f) return '—';
  return new Date(f).toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' });
}

// [Etapa 3] mostrarToast local eliminado — usa window.mostrarToast global (ui-utils.js)

// ── Verificación de denuncia BCRA (robado/extraviado/adulterado) ─────────
// Distinto de "rechazado" (sin fondos): esto consulta si el cheque puntual
// fue denunciado. El campo `banco` hoy es texto libre en esta pantalla, así
// que el match contra el listado oficial de entidades es best-effort (el
// usuario puede corregir el banco en el selector si no matcheó bien).
let _entidadesBcra = null;
let _chequeBcraActual = null;

async function abrirModalBcraDenuncia(chequeId) {
  const cheque = todosCheques.find(c => c.id === chequeId);
  if (!cheque) return;
  _chequeBcraActual = cheque;

  document.getElementById('bcra-denuncia-numero').value = cheque.numero || '';
  document.getElementById('bcra-denuncia-resultado').innerHTML = '';
  document.getElementById('modal-bcra-denuncia').classList.remove('hidden');

  const select = document.getElementById('bcra-denuncia-entidad');
  select.innerHTML = '<option value="">Cargando bancos...</option>';

  try {
    if (!_entidadesBcra) {
      const token = await getFreshTokenBcra();
      const resp = await fetch('/api/bcra?accion=entidades', { headers: { Authorization: `Bearer ${token}` } });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error || 'Error al listar bancos');
      _entidadesBcra = json.entidades || [];
    }

    select.innerHTML = '<option value="">Seleccioná el banco...</option>' +
      _entidadesBcra.map(e => `<option value="${e.codigoEntidad}">${window.sanitize(e.denominacion || '')}</option>`).join('');

    // Preselección best-effort por coincidencia parcial de texto libre
    if (cheque.banco) {
      const bancoLower = cheque.banco.toLowerCase();
      const match = _entidadesBcra.find(e => (e.denominacion || '').toLowerCase().includes(bancoLower) || bancoLower.includes((e.denominacion || '').toLowerCase().split(' ')[0]));
      if (match) select.value = match.codigoEntidad;
    }
  } catch (e) {
    console.error('[cheques] entidades BCRA:', e);
    select.innerHTML = '<option value="">No se pudo cargar el listado</option>';
  }
}

function cerrarModalBcraDenuncia() {
  document.getElementById('modal-bcra-denuncia').classList.add('hidden');
  _chequeBcraActual = null;
}

async function consultarDenunciaBcra() {
  const codigoEntidad = document.getElementById('bcra-denuncia-entidad').value;
  const numeroCheque = document.getElementById('bcra-denuncia-numero').value.trim();
  const resultado = document.getElementById('bcra-denuncia-resultado');

  if (!codigoEntidad || !numeroCheque) {
    resultado.innerHTML = `<div class="alerta-inline warning">Elegí el banco e ingresá el número de cheque.</div>`;
    return;
  }

  resultado.innerHTML = 'Consultando al Banco Central...';
  try {
    const token = await getFreshTokenBcra();
    const resp = await fetch(`/api/bcra?accion=denunciado&codigoEntidad=${encodeURIComponent(codigoEntidad)}&numeroCheque=${encodeURIComponent(numeroCheque)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await resp.json();
    if (!resp.ok) throw new Error(json?.error || 'Error al consultar BCRA');

    // BCRA devuelve 200 (no 404) tanto para "sí denunciado" como para "no
    // denunciado" — el número de cheque/entidad existe en su base en ambos
    // casos. `json.encontrado` acá solo dice "la consulta resolvió", no "está
    // denunciado". Antes esto no se distinguía y CUALQUIER respuesta 200 se
    // mostraba como "Cheque denunciado", incluso cuando `denunciado: false`
    // (que además es el motivo por el que aparecía el placeholder fijo
    // "Motivo: ver detalle" — ni motivo ni denunciado tenían valor real para
    // mostrar, porque en rigor no había ninguna denuncia).
    const r = json.resultado || {};
    const estaDenunciado = json.encontrado && r.denunciado === true;

    if (!estaDenunciado) {
      resultado.innerHTML = `<div class="alerta-inline" style="background:var(--color-success-bg,#E2F0E5);color:var(--color-success,#487050)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Sin denuncia registrada para este cheque.</div>`;
    } else {
      // `detalles` viene de BCRA como un array (puede haber más de una
      // denuncia sobre el mismo número de cheque, en distintas cuentas) con
      // {sucursal, numeroCuenta, causal} — antes se descartaba por completo
      // y solo quedaba el texto fijo "ver detalle" sin nada detrás.
      const detalles = Array.isArray(r.detalles) ? r.detalles : [];
      const fecha = r.fechaProcesamiento ? formatFecha(r.fechaProcesamiento) : '';
      const filasDetalle = detalles.length
        ? detalles.map(d => `<tr>
            <td style="padding:4px 8px 4px 0">${window.sanitize(String(d.sucursal ?? '—'))}</td>
            <td style="padding:4px 8px 4px 0">${window.sanitize(String(d.numeroCuenta ?? '—'))}</td>
            <td style="padding:4px 0">${window.sanitize(d.causal || '—')}</td>
          </tr>`).join('')
        : `<tr><td colspan="3" style="padding:4px 0;color:var(--color-text-muted)">BCRA no informó el detalle de la denuncia.</td></tr>`;

      resultado.innerHTML = `<div class="alerta-inline warning">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><strong>Cheque denunciado.</strong>${detalles.length > 1 ? ` ${detalles.length} denuncias registradas.` : ''}${fecha ? ` Informado el ${fecha}.` : ''}
        ${detalles.length ? `<button type="button" onclick="this.nextElementSibling.classList.toggle('hidden')" style="display:block;margin-top:6px;background:none;border:none;padding:0;color:inherit;text-decoration:underline;cursor:pointer;font:inherit;">Ver detalle</button>
        <div class="hidden" style="margin-top:8px;overflow-x:auto;">
          <table style="width:100%;font-size:12px;border-collapse:collapse;white-space:nowrap;">
            <thead><tr><th style="text-align:left;padding:4px 8px 4px 0">Sucursal</th><th style="text-align:left;padding:4px 8px 4px 0">Cuenta</th><th style="text-align:left;padding:4px 0">Causal</th></tr></thead>
            <tbody>${filasDetalle}</tbody>
          </table>
        </div>` : ''}
      </div>`;
    }
  } catch (e) {
    console.error('[cheques] consultarDenunciaBcra:', e);
    resultado.innerHTML = `<div class="alerta-inline warning">No se pudo consultar al Banco Central. Probá de nuevo en un momento.</div>`;
  }
}

async function getFreshTokenBcra() {
  const { data: { session } } = await _sb.auth.getSession();
  return session?.access_token || '';
}

// Exponer funciones al scope global (requerido por los onclick del HTML)
window.abrirModalNuevoCheque = abrirModalNuevoCheque;
window.cerrarModalCheque = cerrarModalCheque;
window.guardarCheque = guardarCheque;
window.filtrarCheques = filtrarCheques;
window.cambiarEstado = cambiarEstado;
window.editarCheque = editarCheque;
window.abrirModalBcraDenuncia = abrirModalBcraDenuncia;
window.cerrarModalBcraDenuncia = cerrarModalBcraDenuncia;
window.consultarDenunciaBcra = consultarDenunciaBcra;
