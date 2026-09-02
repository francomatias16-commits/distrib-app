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
  productos:         'Productos',
  cobros:            'Cobros',
  facturas:          'Facturas',
  cheques:           'Cheques',
  cta_cte:           'Cta. Cte.',
  movimientos_stock: 'Mov. de stock',
  stock:             'Stock',
  entregas:          'Entregas',
  cajas_pos:         'Cajas (POS)',
  categorias:        'Categorías',
  clientes:          'Clientes',
  depositos:         'Depósitos',
  empresas:          'Datos de la empresa',
  facturas_proveedor:'Facturas de proveedor',
  listas_precios:    'Listas de precio',
  lotes:             'Lotes',
  pagos_proveedor:   'Pagos a proveedor',
  precios_clientes:  'Precios por cliente',
  ventas_pos:        'Ventas (POS)',
  zonas:             'Zonas',
  fn_reset_demo_cron:'Mantenimiento automático',
};

// Entidades que NO son cambios hechos por una persona sino procesos
// internos del sistema (ej: el mantenimiento automático que recalcula
// alertas de stock). Para estas, nunca mostramos el detalle técnico
// (nombres de función, rutas de archivo, texto de migración) — solo
// una frase fija en criollo. Ver pedido del dueño (ago/2026): la
// pantalla no debe mostrar tecnicismos bajo ningún caso.
const ENTIDADES_SISTEMA = new Set(['fn_reset_demo_cron']);

// Campos que jamás se muestran en el detalle de un cambio, porque son
// referencias internas (ids sin nombre, duplicados de otra columna) y
// no le dicen nada al dueño del negocio.
const CAMPOS_OCULTOS = new Set([
  'id', 'usuario_id', 'sesion_id', 'offline_local_id', 'created_at',
  'fix', 'alertas_regeneradas_post_fix', 'alertas_regeneradas',
]);

// FIX (pedido del dueño): el modal de detalle mostraba nombres de columna
// de la base de datos tal cual (orden_id, items_reemplazados, numero_factura)
// y valores sin traducir (true/false, UUIDs enteros, "undefined" literal
// cuando un campo no existía de un lado del cambio). Mismo criterio que se
// usó para humanizar el detalle de Movimientos raros (anomalias.js):
// diccionario de labels + formateo de valores según tipo de dato.
const CAMPO_LABELS = {
  id: 'ID', usuario_id: 'Usuario', cliente_id: 'Cliente', cliente: 'Cliente',
  proveedor_id: 'Proveedor', producto_id: 'Producto', cheque_id: 'Cheque',
  deposito_id: 'Depósito', orden_id: 'Orden de compra', referencia_id: 'Referencia',
  referencia: 'Referencia', sesion_id: 'Sesión de caja', offline_local_id: 'ID local (offline)',
  estado: 'Estado', estado_factura: 'Estado de la factura', tipo: 'Tipo', entidad: 'Entidad',
  motivo: 'Motivo', notas: 'Notas', nombre: 'Nombre', numero_factura: 'N° de factura',
  monto: 'Monto', subtotal: 'Subtotal', total: 'Total', total_pagado: 'Total pagado',
  iva_total: 'IVA', costo_unitario: 'Costo unitario', cantidad: 'Cantidad',
  medio_pago: 'Medio de pago', medios_pago: 'Medios de pago', items: 'Ítems',
  items_reemplazados: 'Ítems reemplazados', creados: 'Creados', actualizados: 'Actualizados',
  errores: 'Errores', fix: 'Corrección aplicada', alertas_regeneradas_post_fix: 'Alertas regeneradas',
  pin_supervisor_activo: 'PIN de supervisor activo', created_at: 'Creado el',
};

function humanizarClaveAuditoria(k) {
  if (CAMPO_LABELS[k]) return CAMPO_LABELS[k];
  return String(k).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const CAMPOS_MONEDA = new Set(['monto', 'subtotal', 'total', 'total_pagado', 'iva_total', 'costo_unitario']);
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_FECHA_ISO = /^\d{4}-\d{2}-\d{2}[T ]/;

function fmtPesoAuditoria(n) {
  return '$' + Math.round(+n || 0).toLocaleString('es-AR');
}

// Devuelve { texto, mono } listo para insertar en el HTML (ya escapado).
// `mono` marca los valores que conviene mostrar en fuente monoespaciada
// (IDs internos) para que se lean como referencia técnica, no como dato.
function humanizarValorAuditoria(campo, valor) {
  if (valor === null || valor === undefined || valor === '') return { texto: '—', mono: false };
  if (typeof valor === 'boolean') return { texto: valor ? 'Sí' : 'No', mono: false };
  if (Array.isArray(valor)) {
    return { texto: valor.length ? `${valor.length} elemento${valor.length === 1 ? '' : 's'}` : 'Ninguno', mono: false };
  }
  if (typeof valor === 'object') {
    const n = Object.keys(valor).length;
    return { texto: n ? `${n} dato${n === 1 ? '' : 's'} adicionales` : 'Sin datos', mono: false };
  }
  if (typeof valor === 'number') {
    return { texto: CAMPOS_MONEDA.has(campo) ? fmtPesoAuditoria(valor) : valor.toLocaleString('es-AR'), mono: false };
  }
  if (typeof valor === 'string') {
    if (RE_FECHA_ISO.test(valor)) {
      const d = new Date(valor);
      if (!isNaN(d)) {
        return { texto: d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }), mono: false };
      }
    }
    if (CAMPOS_MONEDA.has(campo) && !isNaN(Number(valor)) && valor.trim() !== '') {
      return { texto: fmtPesoAuditoria(Number(valor)), mono: false };
    }
    if (RE_UUID.test(valor)) return { texto: valor.slice(0, 8) + '…', mono: true };
    return { texto: esc(valor), mono: false };
  }
  return { texto: esc(String(valor)), mono: false };
}

const ACCION_LABELS = {
  INSERT: { texto: 'Alta',         clase: 'chip-verde' },
  UPDATE: { texto: 'Modificación', clase: 'chip-amarillo' },
  DELETE: { texto: 'Baja',         clase: 'chip-rojo' },
};

// Texto en criollo para la columna "Qué pasó": va al lado del chip de
// acción (Alta/Modificación/Baja), así que acá solo va la entidad en
// lenguaje llano — sin nombres de tabla ni jerga técnica. Pedido del
// dueño: cero tecnicismo, incluso en la lista.
function resumirQuePaso(r) {
  if (ENTIDADES_SISTEMA.has(r.tabla)) return 'de alertas de stock';
  return `en ${(TABLA_LABELS[r.tabla] || r.tabla || 'un registro').toLowerCase()}`;
}

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
  // v903: sidebar-empresa/sidebar-logo los pinta nav.js (pintarEmpresaSidebar,
  // corre en cada renderConRol) — no duplicar acá, pisaba el valor bueno.

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
  tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">Cargando…</div></td></tr>`;

  try {
    const tabla = document.getElementById('filtro-tabla-aud').value;
    const desde = (pagina - 1) * PAGE_SIZE;
    const hasta = desde + PAGE_SIZE - 1;

    let q = _sb.from('audit_log')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(desde, hasta);
    if (tabla) q = q.eq('tabla', tabla);
    const { data, error, count } = await window.conTimeoutRed(q, 10000);
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
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">No se pudo cargar el historial.</div></td></tr>`;
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
    const { data: usuarios = [] } = await window.conTimeoutRed(_sb.from('usuarios')
      .select('id,nombre,email')
      .in('id', ids), 10000);
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
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">No hay registros en el historial todavía. Acá vas a ver cambios de precios, anulaciones y otras acciones sensibles a medida que ocurran.</div></td></tr>`;
    return;
  }

  tbody.innerHTML = lista.map((r, idx) => {
    const idxReal = registros.indexOf(r);
    const accionInfo = ACCION_LABELS[r.accion] || { texto: r.accion, clase: 'chip-gris' };
    const esSistema = ENTIDADES_SISTEMA.has(r.tabla);
    const usuario = esSistema ? 'Sistema' : (cacheUsuarios[r.usuario_id] || (r.usuario_id ? '—' : 'Sistema'));
    const registroCorto = (!esSistema && r.registro_id) ? r.registro_id.substring(0, 8).toUpperCase() : '—';

    return `<tr class="fila-clickeable" onclick="if (event.target.closest('[onclick],a,select,input,textarea,button') === this) abrirModalDetalle(${idxReal})">
      <td data-label="Fecha">${formatFechaHora(r.created_at)}</td>
      <td data-label="Qué pasó"><span class="chip ${accionInfo.clase}">${sanitize(accionInfo.texto)}</span> ${esc(resumirQuePaso(r))}</td>
      <td data-label="Referencia" style="font-family:monospace">${registroCorto}</td>
      <td data-label="Usuario">${esc(usuario)}</td>
      <td class="col-sticky-end" data-label="Detalle">
        <span class="fila-acciones">
          <button type="button" class="btn-tabla" onclick="abrirModalDetalle(${idxReal})">Ver</button>
        </span>
      </td>
    </tr>`;
  }).join('');
}

function abrirModalDetalle(idx) {
  const r = registros[idx];
  if (!r) return;

  const accionInfo = ACCION_LABELS[r.accion] || { texto: r.accion, clase: 'chip-gris' };
  const esSistema = ENTIDADES_SISTEMA.has(r.tabla);
  const tablaLabel = TABLA_LABELS[r.tabla] || r.tabla;
  const usuario = esSistema ? 'Sistema' : (cacheUsuarios[r.usuario_id] || (r.usuario_id ? r.usuario_id : 'Sistema'));

  document.getElementById('modal-detalle-titulo').textContent =
    `${tablaLabel} — ${sanitize(accionInfo.texto)}`;

  document.getElementById('modal-detalle-meta').innerHTML = `
    <div><strong>Fecha:</strong> ${formatFechaHora(r.created_at)}</div>
    <div><strong>Usuario:</strong> ${esc(usuario)}</div>
    ${(!esSistema && r.registro_id) ? `<div><strong>Referencia:</strong> <span style="font-family:monospace">${r.registro_id.substring(0, 8).toUpperCase()}</span></div>` : ''}
  `;

  // Procesos internos del sistema (mantenimiento automático): nunca se
  // muestra el detalle técnico, solo una explicación fija en criollo.
  if (esSistema) {
    document.getElementById('modal-detalle-diff').innerHTML = `
      <div class="diff-col"><div class="diff-campos" style="padding:12px;">
        Esto es una tarea de mantenimiento que corre sola todos los días para
        mantener al día las alertas de stock. No modifica ningún dato de tu
        negocio (ni precios, ni facturas, ni clientes).
      </div></div>`;
    document.getElementById('modal-detalle-aud').classList.remove('hidden');
    return;
  }

  const antes = r.datos_antes || {};
  const despues = r.datos_despues || {};

  let diffHtml = '';
  if (r.accion === 'UPDATE') {
    diffHtml = `<div class="diff-col"><div class="diff-campos">${renderCambios(antes, despues)}</div></div>`;
  } else if (r.accion === 'INSERT') {
    diffHtml = `<div class="diff-col"><h4>Se cargó con estos datos</h4><div class="diff-campos">${renderCampos(Object.keys(despues).sort(), despues, {})}</div></div>`;
  } else {
    diffHtml = `<div class="diff-col"><h4>Tenía estos datos antes de eliminarse</h4><div class="diff-campos">${renderCampos(Object.keys(antes).sort(), antes, {})}</div></div>`;
  }

  document.getElementById('modal-detalle-diff').innerHTML = diffHtml;
  document.getElementById('modal-detalle-aud').classList.remove('hidden');
}

// Pinta cada campo en lenguaje llano (label humanizado + valor formateado
// según su tipo), marcando los que cambiaron entre "obj" y "otro". Antes
// esto era un <pre>k: JSON.stringify(v)</pre> con nombres de columna y
// valores crudos (incluido el string "undefined" cuando un campo no
// existía de un lado) — ver comentario junto a CAMPO_LABELS más arriba.
function renderCampos(claves, obj, otro) {
  const visibles = claves.filter((k) => !CAMPOS_OCULTOS.has(k));
  if (!visibles.length) return '<div class="diff-campo"><span class="diff-campo-lbl">Sin datos para mostrar</span></div>';
  return visibles.map((k) => {
    const otroTieneCampo = Object.prototype.hasOwnProperty.call(otro, k);
    const cambio = otroTieneCampo && JSON.stringify(obj[k]) !== JSON.stringify(otro[k]);
    const { texto, mono } = humanizarValorAuditoria(k, obj[k]);
    return `<div class="diff-campo${cambio ? ' cambiado' : ''}">
      <span class="diff-campo-lbl">${esc(humanizarClaveAuditoria(k))}</span>
      <span class="diff-campo-val${mono ? ' mono' : ''}">${texto}</span>
    </div>`;
  }).join('');
}

// Para una MODIFICACIÓN: en vez de la vieja grilla técnica "Antes/Después"
// lado a lado, arma una lista de frases en criollo — solo de los campos
// que realmente cambiaron ("Total pagado: de $1.200 a $1.500"). Pedido
// del dueño: la pantalla no debe requerir interpretar dos columnas.
function renderCambios(antes, despues) {
  const claves = [...new Set([...Object.keys(antes), ...Object.keys(despues)])]
    .filter((k) => !CAMPOS_OCULTOS.has(k))
    .filter((k) => JSON.stringify(antes[k]) !== JSON.stringify(despues[k]))
    .sort();

  if (!claves.length) {
    return '<div class="diff-campo"><span class="diff-campo-lbl">No hubo cambios visibles en los datos del negocio.</span></div>';
  }

  return claves.map((k) => {
    const antesFmt = humanizarValorAuditoria(k, antes[k]);
    const despuesFmt = humanizarValorAuditoria(k, despues[k]);
    return `<div class="diff-campo cambiado">
      <span class="diff-campo-lbl">${esc(humanizarClaveAuditoria(k))}</span>
      <span class="diff-campo-val${despuesFmt.mono ? ' mono' : ''}">de ${antesFmt.texto} a ${despuesFmt.texto}</span>
    </div>`;
  }).join('');
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

    const { data, error, count } = await window.conTimeoutRed(q, 10000);
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

    return `<tr class="fila-clickeable" onclick="if (event.target.closest('[onclick],a,select,input,textarea,button') === this) abrirModalDetalleEvento(${idx})">
      <td data-label="Fecha">${formatFechaHora(ev.creado_en)}</td>
      <td data-label="Tipo de evento">${esc(tipoLabel)}</td>
      <td data-label="Estado"><span class="chip ${estadoInfo.clase}">${esc(estadoInfo.texto)}</span></td>
      <td data-label="Origen">${esc(ev.origen || '—')}</td>
      <td class="col-sticky-end" data-label="Detalle">
        <span class="fila-acciones">
          <button type="button" class="btn-tabla" onclick="abrirModalDetalleEvento(${idx})">Ver</button>
        </span>
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
  document.getElementById('modal-detalle-evt-payload').innerHTML =
    renderCampos(Object.keys(ev.payload || {}).sort(), ev.payload || {}, {});
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

  const { data, error } = await window.conTimeoutRed(q, 10000);
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
