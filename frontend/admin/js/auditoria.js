/* admin/js/auditoria.js — Visor de audit_log (fase 2, patch v7)
   Acceso restringido a roles: dueno, admin, contador.
   Lee public.audit_log (creado por patch_v7_auditoria_geoloc.sql),
   protegido por RLS para que cada empresa vea solo sus registros. */

let _sb = null; // FIX v125: usa authCtx.sb (patrón unificado)


const ROLES_AUDITORIA = ['dueno', 'admin', 'contador'];
const PAGE_SIZE = 50;

let registros = [];       // registros de la página actual
let paginaActual = 1;
let totalRegistros = 0;

const TABLA_LABELS = {
  productos:        'Productos',
  cobros:           'Cobros',
  facturas:         'Facturas',
  cheques:          'Cheques',
  cta_cte:          'Cta. Cte.',
  movimientos_stock:'Mov. de stock',
  stock:            'Stock',
  entregas:         'Entregas',
};

const ACCION_LABELS = {
  INSERT: { texto: 'Alta',         clase: 'chip-verde' },
  UPDATE: { texto: 'Modificación', clase: 'chip-amarillo' },
  DELETE: { texto: 'Baja',         clase: 'chip-rojo' },
};

// Fase 5 (plan ERP): "Eventos de negocio" — segunda pestaña, lee
// public.eventos_negocio (RLS ya restringido a dueño/admin, misma regla
// que audit_log_select_unificada — ver migración
// fase5_eventos_negocio_rls_dueno_admin).
const TIPO_EVENTO_LABELS = {
  pedido_creado:      'Pedido creado',
  pedido_facturado:   'Pedido facturado',
  factura_anulada:    'Factura anulada',
  cliente_en_mora:    'Cliente en mora',
  cheques_por_vencer: 'Cheques por vencer',
};

const ESTADO_EVENTO_LABELS = {
  pendiente: { texto: 'Pendiente', clase: 'chip-amarillo' },
  procesado: { texto: 'Procesado', clase: 'chip-verde' },
  error:     { texto: 'Error',     clase: 'chip-rojo' },
};

const PAGE_SIZE_EVENTOS = 50;
let eventos = [];
let paginaActualEventos = 1;
let totalEventos = 0;
let tabActiva = 'registro';

window.authReady.then(async () => {
  const user = window.authCtx?.perfil;
  if (!user) { window.location.href = '/admin/login'; return; }
  _sb = window.authCtx.sb;

  const hoy = new Date();
  const elFecha = document.getElementById('topbar-fecha');
  if (elFecha) elFecha.textContent = hoy.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  (document.getElementById('topbar-usuario') || {}).textContent = user.nombre || user.email;
  const _elEmp = document.getElementById('sidebar-empresa'); if (_elEmp) _elEmp.textContent = user.empresa_nombre || user.empresas?.nombre || 'Distribuidora';

  if (!ROLES_AUDITORIA.includes(user.rol)) {
    document.getElementById('contenido-auditoria').classList.add('hidden');
    document.getElementById('sin-permiso').classList.remove('hidden');
    return;
  }

  await cargarAuditoria();
}).catch(err => {
  console.error('[auditoria] authReady falló:', err?.message);
  window.location.href = '/admin/login';
});

// Fase 5: switch entre "Registro de cambios" y "Eventos de negocio".
// Carga eventos on-demand (recién la primera vez que se abre la pestaña)
// para no pagar esa consulta si el usuario nunca la mira.
let eventosCargadosAlMenosUnaVez = false;
function cambiarTab(tab) {
  if (tab === tabActiva) return;
  tabActiva = tab;

  document.getElementById('tab-registro').classList.toggle('activo', tab === 'registro');
  document.getElementById('tab-registro').setAttribute('aria-selected', tab === 'registro');
  document.getElementById('tab-eventos').classList.toggle('activo', tab === 'eventos');
  document.getElementById('tab-eventos').setAttribute('aria-selected', tab === 'eventos');

  document.getElementById('panel-registro').classList.toggle('hidden', tab !== 'registro');
  document.getElementById('panel-eventos').classList.toggle('hidden', tab !== 'eventos');

  if (tab === 'eventos' && !eventosCargadosAlMenosUnaVez) {
    eventosCargadosAlMenosUnaVez = true;
    cargarEventos();
  }
}

async function cargarAuditoria() {
  paginaActual = 1;
  await cargarPagina(1);
}

async function cargarPagina(pagina) {
  const tbody = document.getElementById('tbody-auditoria');
  tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">Cargando…</div></td></tr>`;

  try {
    const tabla = document.getElementById('filtro-tabla-aud').value;
    const desde = (pagina - 1) * PAGE_SIZE;
    const hasta = desde + PAGE_SIZE - 1;

    let q = _sb.from('audit_log')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(desde, hasta);
    if (tabla) q = q.eq('tabla', tabla);
    const { data, error, count } = await q;
    if (error) throw new Error(error.message);

    registros = data || [];
    totalRegistros = count || 0;
    paginaActual = pagina;

    await resolverUsuarios(registros);
    filtrarAuditoria();
    renderPaginacion();
  } catch (e) {
    console.error(e);
    mostrarToast('Error al cargar el historial', 'err');
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">No se pudo cargar el historial.</div></td></tr>`;
  }
}

function renderPaginacion() {
  const totalPaginas = Math.max(1, Math.ceil(totalRegistros / PAGE_SIZE));
  const info = document.getElementById('paginacion-info');
  const cont = document.getElementById('paginacion-controles');
  if (!info || !cont) return;

  if (!totalRegistros) {
    info.textContent = 'Sin registros';
    cont.innerHTML = '';
    return;
  }

  const desde = (paginaActual - 1) * PAGE_SIZE + 1;
  const hasta = Math.min(paginaActual * PAGE_SIZE, totalRegistros);
  info.textContent = `Mostrando ${desde}–${hasta} de ${totalRegistros}`;

  const botones = [];
  botones.push(`<button ${paginaActual === 1 ? 'disabled' : ''} onclick="cargarPagina(${paginaActual - 1})" aria-label="Página anterior">‹</button>`);

  const paginas = paginasAMostrar(paginaActual, totalPaginas);
  paginas.forEach(p => {
    if (p === '…') {
      botones.push(`<span class="paginacion-puntos">…</span>`);
    } else {
      botones.push(`<button class="${p === paginaActual ? 'activo' : ''}" onclick="cargarPagina(${p})">${p}</button>`);
    }
  });

  botones.push(`<button ${paginaActual === totalPaginas ? 'disabled' : ''} onclick="cargarPagina(${paginaActual + 1})" aria-label="Página siguiente">›</button>`);
  cont.innerHTML = botones.join('');
}

// Devuelve la lista de páginas/puntos suspensivos a mostrar (máx. 7 elementos visibles)
function paginasAMostrar(actual, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const paginas = new Set([1, total, actual, actual - 1, actual + 1]);
  const ordenadas = [...paginas].filter(p => p >= 1 && p <= total).sort((a, b) => a - b);

  const resultado = [];
  ordenadas.forEach((p, i) => {
    if (i > 0 && p - ordenadas[i - 1] > 1) resultado.push('…');
    resultado.push(p);
  });
  return resultado;
}

// Cachea nombres de usuario por id para no repetir consultas
const cacheUsuarios = {};
async function resolverUsuarios(data) {
  const ids = [...new Set(data.map(r => r.usuario_id).filter(Boolean))]
    .filter(id => !cacheUsuarios[id]);
  if (!ids.length) return;

  try {
    const { data: usuarios = [] } = await _sb.from('usuarios')
      .select('id,nombre,email')
      .in('id', ids);
    if (!usuarios.length) return;
    usuarios.forEach(u => { cacheUsuarios[u.id] = u.nombre || u.email; });
  } catch (e) {
    console.warn('No se pudieron resolver usuarios:', e.message);
  }
}

function filtrarAuditoria() {
  const q = document.getElementById('buscar-aud').value.toLowerCase();
  const accion = document.getElementById('filtro-accion-aud').value;

  const filtrado = registros.filter(r => {
    if (accion && r.accion !== accion) return false;
    if (q) {
      const nombreUsuario = (cacheUsuarios[r.usuario_id] || '').toLowerCase();
      const registroId = (r.registro_id || '').toLowerCase();
      if (!nombreUsuario.includes(q) && !registroId.includes(q)) return false;
    }
    return true;
  });

  renderTabla(filtrado);
}

function renderTabla(lista) {
  const tbody = document.getElementById('tbody-auditoria');
  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">No hay registros en el historial todavía. Acá vas a ver cambios de precios, anulaciones y otras acciones sensibles a medida que ocurran.</div></td></tr>`;
    return;
  }

  tbody.innerHTML = lista.map((r, idx) => {
    const idxReal = registros.indexOf(r);
    const accionInfo = ACCION_LABELS[r.accion] || { texto: r.accion, clase: 'chip-gris' };
    const tablaLabel = TABLA_LABELS[r.tabla] || r.tabla;
    const usuario = cacheUsuarios[r.usuario_id] || (r.usuario_id ? '—' : 'Sistema');
    const registroCorto = r.registro_id ? r.registro_id.substring(0, 8).toUpperCase() : '—';

    return `<tr>
      <td>${formatFechaHora(r.created_at)}</td>
      <td>${esc(tablaLabel)}</td>
      <td><span class="chip ${accionInfo.clase}">${sanitize(accionInfo.texto)}</span></td>
      <td style="font-family:monospace">${registroCorto}</td>
      <td>${esc(usuario)}</td>
      <td class="col-sticky-end">
        <button class="btn-icon" title="Ver detalle" onclick="abrirModalDetalle(${idxReal})">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </td>
    </tr>`;
  }).join('');
}

function abrirModalDetalle(idx) {
  const r = registros[idx];
  if (!r) return;

  const accionInfo = ACCION_LABELS[r.accion] || { texto: r.accion, clase: 'chip-gris' };
  const tablaLabel = TABLA_LABELS[r.tabla] || r.tabla;
  const usuario = cacheUsuarios[r.usuario_id] || (r.usuario_id ? r.usuario_id : 'Sistema');

  document.getElementById('modal-detalle-titulo').textContent =
    `${tablaLabel} — ${sanitize(accionInfo.texto)}`;

  document.getElementById('modal-detalle-meta').innerHTML = `
    <div><strong>Fecha:</strong> ${formatFechaHora(r.created_at)}</div>
    <div><strong>Usuario:</strong> ${esc(usuario)}</div>
    <div><strong>ID de registro:</strong> <span style="font-family:monospace">${r.registro_id || '—'}</span></div>
  `;

  const antes = r.datos_antes || {};
  const despues = r.datos_despues || {};
  const claves = [...new Set([...Object.keys(antes), ...Object.keys(despues)])].sort();

  let diffHtml = '';
  if (r.accion === 'UPDATE') {
    diffHtml = `
      <div class="diff-grid">
        <div class="diff-col"><h4>Antes</h4><pre>${renderCampos(claves, antes, despues)}</pre></div>
        <div class="diff-col"><h4>Después</h4><pre>${renderCampos(claves, despues, antes)}</pre></div>
      </div>`;
  } else if (r.accion === 'INSERT') {
    diffHtml = `<div class="diff-col"><h4>Datos creados</h4><pre>${esc(JSON.stringify(despues, null, 2))}</pre></div>`;
  } else {
    diffHtml = `<div class="diff-col"><h4>Datos eliminados</h4><pre>${esc(JSON.stringify(antes, null, 2))}</pre></div>`;
  }

  document.getElementById('modal-detalle-diff').innerHTML = diffHtml;
  document.getElementById('modal-detalle-aud').classList.remove('hidden');
}

// Pinta cada campo, marcando los que cambiaron entre "obj" y "otro"
function renderCampos(claves, obj, otro) {
  return claves.map(k => {
    const val = JSON.stringify(obj[k], null, 2);
    const valOtro = JSON.stringify(otro[k], null, 2);
    const cambio = val !== valOtro;
    const linea = `${k}: ${val}`;
    return cambio ? `<span class="diff-field-changed">${esc(linea)}</span>` : esc(linea);
  }).join('\n');
}

function cerrarModalDetalle() {
  document.getElementById('modal-detalle-aud').classList.add('hidden');
}

function formatFechaHora(s) {
  if (!s) return '—';
  return new Date(s).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function esc(s) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(s);
}

/* ── Fase 5: Eventos de negocio ─────────────────────────────────────── */

async function cargarEventos() {
  paginaActualEventos = 1;
  await cargarPaginaEventos(1);
}

async function cargarPaginaEventos(pagina) {
  const tbody = document.getElementById('tbody-eventos');
  tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">Cargando…</div></td></tr>`;

  try {
    const tipo   = document.getElementById('filtro-tipo-evt').value;
    const estado = document.getElementById('filtro-estado-evt').value;
    const desde = (pagina - 1) * PAGE_SIZE_EVENTOS;
    const hasta = desde + PAGE_SIZE_EVENTOS - 1;

    let q = _sb.from('eventos_negocio')
      .select('*', { count: 'exact' })
      .order('creado_en', { ascending: false })
      .range(desde, hasta);
    if (tipo)   q = q.eq('tipo_evento', tipo);
    if (estado) q = q.eq('estado', estado);

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);

    eventos = data || [];
    totalEventos = count || 0;
    paginaActualEventos = pagina;

    renderTablaEventos();
    renderPaginacionEventos();
  } catch (e) {
    console.error(e);
    mostrarToast('Error al cargar los eventos de negocio', 'err');
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">No se pudieron cargar los eventos de negocio.</div></td></tr>`;
  }
}

function renderTablaEventos() {
  const tbody = document.getElementById('tbody-eventos');
  if (!eventos.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">No hay eventos de negocio todavía. Acá vas a ver pedidos, facturas, cheques por vencer y clientes en mora a medida que ocurran.</div></td></tr>`;
    return;
  }

  tbody.innerHTML = eventos.map((ev, idx) => {
    const estadoInfo = ESTADO_EVENTO_LABELS[ev.estado] || { texto: ev.estado, clase: 'chip-gris' };
    const tipoLabel = TIPO_EVENTO_LABELS[ev.tipo_evento] || ev.tipo_evento;

    return `<tr>
      <td>${formatFechaHora(ev.creado_en)}</td>
      <td>${esc(tipoLabel)}</td>
      <td><span class="chip ${estadoInfo.clase}">${esc(estadoInfo.texto)}</span></td>
      <td>${esc(ev.origen || '—')}</td>
      <td class="col-sticky-end">
        <button class="btn-icon" title="Ver detalle" onclick="abrirModalDetalleEvento(${idx})">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </td>
    </tr>`;
  }).join('');
}

function renderPaginacionEventos() {
  const totalPaginas = Math.max(1, Math.ceil(totalEventos / PAGE_SIZE_EVENTOS));
  const info = document.getElementById('paginacion-info-evt');
  const cont = document.getElementById('paginacion-controles-evt');
  if (!info || !cont) return;

  if (!totalEventos) {
    info.textContent = 'Sin eventos';
    cont.innerHTML = '';
    return;
  }

  const desde = (paginaActualEventos - 1) * PAGE_SIZE_EVENTOS + 1;
  const hasta = Math.min(paginaActualEventos * PAGE_SIZE_EVENTOS, totalEventos);
  info.textContent = `Mostrando ${desde}–${hasta} de ${totalEventos}`;

  const botones = [];
  botones.push(`<button ${paginaActualEventos === 1 ? 'disabled' : ''} onclick="cargarPaginaEventos(${paginaActualEventos - 1})" aria-label="Página anterior">‹</button>`);

  const paginas = paginasAMostrar(paginaActualEventos, totalPaginas);
  paginas.forEach(p => {
    if (p === '…') {
      botones.push(`<span class="paginacion-puntos">…</span>`);
    } else {
      botones.push(`<button class="${p === paginaActualEventos ? 'activo' : ''}" onclick="cargarPaginaEventos(${p})">${p}</button>`);
    }
  });

  botones.push(`<button ${paginaActualEventos === totalPaginas ? 'disabled' : ''} onclick="cargarPaginaEventos(${paginaActualEventos + 1})" aria-label="Página siguiente">›</button>`);
  cont.innerHTML = botones.join('');
}

function abrirModalDetalleEvento(idx) {
  const ev = eventos[idx];
  if (!ev) return;

  const estadoInfo = ESTADO_EVENTO_LABELS[ev.estado] || { texto: ev.estado, clase: 'chip-gris' };
  const tipoLabel = TIPO_EVENTO_LABELS[ev.tipo_evento] || ev.tipo_evento;

  document.getElementById('modal-detalle-evt-titulo').textContent = `${tipoLabel} — ${estadoInfo.texto}`;
  document.getElementById('modal-detalle-evt-meta').innerHTML = `
    <div><strong>Fecha:</strong> ${formatFechaHora(ev.creado_en)}</div>
    <div><strong>Origen:</strong> ${esc(ev.origen || '—')}</div>
    <div><strong>Procesado el:</strong> ${ev.procesado_en ? formatFechaHora(ev.procesado_en) : '—'}</div>
  `;
  document.getElementById('modal-detalle-evt-payload').textContent = JSON.stringify(ev.payload || {}, null, 2);
  document.getElementById('modal-detalle-evt').classList.remove('hidden');
}

function cerrarModalDetalleEvento() {
  document.getElementById('modal-detalle-evt').classList.add('hidden');
}

// Exporta TODOS los eventos que matchean los filtros activos (no solo la
// página visible) — tope de 5000 filas, más que suficiente para un CSV de
// auditoría y evita traer una tabla entera por error de filtro.
const EXPORT_CSV_TOPE = 5000;
async function exportarEventosCSV() {
  const tipo   = document.getElementById('filtro-tipo-evt').value;
  const estado = document.getElementById('filtro-estado-evt').value;

  let q = _sb.from('eventos_negocio')
    .select('*')
    .order('creado_en', { ascending: false })
    .limit(EXPORT_CSV_TOPE);
  if (tipo)   q = q.eq('tipo_evento', tipo);
  if (estado) q = q.eq('estado', estado);

  const { data, error } = await q;
  if (error) {
    console.error(error);
    mostrarToast('Error al exportar los eventos', 'err');
    return;
  }
  if (!data?.length) {
    mostrarToast('No hay eventos para exportar con los filtros actuales', 'err');
    return;
  }

  const filas = data.map(ev => ({
    Fecha:            formatFechaHora(ev.creado_en),
    'Tipo de evento':  TIPO_EVENTO_LABELS[ev.tipo_evento] || ev.tipo_evento,
    Estado:           (ESTADO_EVENTO_LABELS[ev.estado] || {}).texto || ev.estado,
    Origen:           ev.origen || '',
    'Procesado el':    ev.procesado_en ? formatFechaHora(ev.procesado_en) : '',
    Payload:          JSON.stringify(ev.payload || {}),
  }));

  const fecha = new Date().toISOString().slice(0, 10);
  ExportUtils.exportDataToCSV(
    filas,
    ['Fecha', 'Tipo de evento', 'Estado', 'Origen', 'Procesado el', 'Payload'],
    `eventos_negocio_${fecha}.csv`
  );
}

// [Etapa 3] mostrarToast local eliminado — usa window.mostrarToast global (ui-utils.js)
