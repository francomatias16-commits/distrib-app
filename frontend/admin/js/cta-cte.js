/* admin/js/cta-cte.js — Pantalla I: Cuenta Corriente */
/* REQ-10: enviarEstado() reemplazado por modal real + llamada a /api/estado-cuenta */

let _sbCte = null; // FIX v125: usa authCtx.sb (patrón unificado)


let clienteActivo = null;
let todosClientes = []; // clientes de la página actual (server-side, ya no el listado completo)

// Plan offline — Etapa 3, ítem 4: mismo criterio que stock.js/remito.html —
// distingue "el servidor respondió con un error de negocio" (mostrarlo tal
// cual) de "la llamada nunca llegó a completarse" (encolar y reintentar
// solo). sb.rpc() no rechaza la promesa cuando falla la red: postgrest-js
// atrapa el TypeError original y lo devuelve como `error`.
function esErrorDeRed(e) {
  return e instanceof TypeError || /failed to fetch|network/i.test(e?.message || '');
}

// migración 266: listado + KPIs paginados en SQL (fn_cta_cte_kpis / fn_cta_cte_lista)
let paginaActualCC = 1;
const ITEMS_POR_PAGINA_CC = 50;
let totalCCFiltrados = 0;

// FIX: getHeaders() no estaba definida en ningún lado del proyecto,
// rompía cargarCtaCte() con "ReferenceError: getHeaders is not defined".
async function getHeaders() {
  const { data: { session } } = await _sbCte.auth.getSession();
  return {
    apikey: window.ENV.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${session?.access_token}`,
    'Content-Type': 'application/json',
  };
}

// ── Init ────────────────────────────────────────────────────────────
window.authReady.then(async () => {
  const user = window.authCtx?.perfil;
  if (!user) { window.location.href = '/admin/login'; return; }
  _sbCte = window.authCtx.sb;

  // Plan offline — Etapa 3, ítem 4: la cola de cobros pendientes usa el
  // mismo cliente sb ya autenticado de esta página.
  window.CobrosOffline?.init({ getSb: () => _sbCte });

  const hoy = new Date();
  const elFecha = document.getElementById('topbar-fecha');
  if (elFecha) elFecha.textContent = hoy.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  // FIX (auditoría UX etapa 16, Hallazgo 1): toISOString() (UTC) precargaba
  // la fecha de mañana entre las 21:00 y las 00:00 hora Argentina.
  document.getElementById('cobro-fecha').value = window.hoyLocalISO ? window.hoyLocalISO() : hoy.toISOString().split('T')[0];

  (document.getElementById('topbar-usuario') || {}).textContent = user.nombre || user.email;
  const _elEmp = document.getElementById('sidebar-empresa'); if (_elEmp) _elEmp.textContent = user.empresa_nombre || 'Distribuidora';

  initFiltroTabsSaldos();
  await cargarCtaCte();
});

function initFiltroTabsSaldos() {
  FiltroTabs.crear(document.getElementById('filtro-tabs-saldos'), [
    { key: '',            label: 'Deuda total' },
    { key: 'vencido',     label: 'Vencido' },
    { key: 'por_vencer',  label: 'Por vencer (7 días)' },
    { key: 'al_dia',      label: 'Al día' },
  ], '', (key) => {
    document.getElementById('filtro-estado').value = key;
    filtrarClientes();
  });
}

// ── Cargar datos ────────────────────────────────────────────────────
// Antes: resumen_cta_cte() traía el listado COMPLETO de deudores (sin
// paginar, sin filtro en SQL) y los 4 KPIs se sumaban en JS sobre ese
// array entero, recalculando todo en cada búsqueda/filtro.
// Ahora (migración 266): fn_cta_cte_kpis() trae los 4 totales ya
// agregados en SQL (una sola fila), y fn_cta_cte_lista() trae solo la
// página filtrada (búsqueda + estado) con LIMIT/OFFSET real y
// total_count vía COUNT(*) OVER(). resumen_cta_cte() sigue existiendo
// y no se tocó; queda como fallback si las RPC nuevas no están
// disponibles (p. ej. tenant sin la migración 266 aplicada todavía).
async function cargarCtaCte() {
  try {
    const busq = document.getElementById('buscar-cliente')?.value.trim() || '';
    const estado = document.getElementById('filtro-estado')?.value || '';
    const desde = (paginaActualCC - 1) * ITEMS_POR_PAGINA_CC;

    const [kpisRes, listaRes] = await Promise.all([
      _sbCte.rpc('fn_cta_cte_kpis'),
      _sbCte.rpc('fn_cta_cte_lista', {
        p_busqueda: busq || null,
        p_estado: estado || null,
        p_limit: ITEMS_POR_PAGINA_CC,
        p_offset: desde,
      }),
    ]);

    if (kpisRes.error || listaRes.error) {
      console.warn('[cta-cte] RPC server-side no disponible, uso fallback:', kpisRes.error || listaRes.error);
      const datos = await cargarCtaCteFallback();
      todosClientes = datos;
      totalCCFiltrados = datos.length;
      actualizarKPIsSaldosFallback(datos);
      renderTabla(datos);
      actualizarControlesPaginacionCC();
      return;
    }

    const kpis = kpisRes.data?.[0] || {};
    const lista = listaRes.data || [];

    todosClientes = lista.map(c => ({
      cliente_id: c.cliente_id,
      razon_social: c.razon_social,
      nombre_fantasia: c.nombre_fantasia,
      deuda_total: c.deuda_total,
      deuda_vencida: c.deuda_vencida,
      deuda_por_vencer: c.deuda_por_vencer,
      ultimo_pago: c.ultimo_pago,
      facturas_pendientes: c.facturas_pendientes,
    }));
    totalCCFiltrados = lista?.[0]?.total_count || 0;

    actualizarKPIsSaldos(kpis);
    renderTabla(todosClientes);
    actualizarControlesPaginacionCC();
  } catch (e) {
    console.error(e);
    mostrarToast('Error al cargar cuenta corriente', 'err');
  }
}

async function cargarCtaCteFallback() {
  const rFact = await fetch(
    `${window.ENV.SUPABASE_URL}/rest/v1/facturas?empresa_id=eq.${window.authCtx?.perfil?.empresa_id}&estado=in.(emitida,parcial)&select=id,cliente_id,total,total_cobrado,vencimiento,clientes(razon_social,nombre_fantasia)&order=vencimiento.asc&limit=1000`,
    { headers: await getHeaders() }
  );
  const facturas = rFact.ok ? await rFact.json() : [];
  // Etapa 3, Hallazgo 2: este fallback (solo se usa si las RPC fn_cta_cte_*
  // no están disponibles) trae como máximo 1000 facturas impagas y antes
  // no avisaba si se llegaba a ese techo — los KPIs se calculaban sobre un
  // subconjunto silenciosamente incompleto para empresas con mucha deuda
  // acumulada. Ahora al menos queda en consola para quien lo esté debugueando.
  if (facturas.length === 1000) {
    console.warn('[cta-cte] Fallback trajo el máximo de 1000 facturas impagas: los KPIs pueden estar incompletos. Revisar por qué fn_cta_cte_kpis/fn_cta_cte_lista no están disponibles.');
  }

  const mapa = {};
  const hoy = new Date();
  hoy.setHours(0,0,0,0);

  for (const f of facturas) {
    const cid = f.cliente_id;
    if (!mapa[cid]) {
      mapa[cid] = {
        cliente_id: cid,
        razon_social: f.clientes?.razon_social || 'Sin nombre',
        nombre_fantasia: f.clientes?.nombre_fantasia || '',
        deuda_total: 0, deuda_vencida: 0, deuda_por_vencer: 0,
        facturas_pendientes: 0,
      };
    }
    const pendiente = (f.total || 0) - (f.total_cobrado || 0);
    if (pendiente <= 0) continue;
    mapa[cid].deuda_total += pendiente;
    mapa[cid].facturas_pendientes++;
    const vto = f.vencimiento ? new Date(f.vencimiento) : null;
    if (vto) {
      if (vto < hoy) mapa[cid].deuda_vencida += pendiente;
      else if ((vto - hoy) <= 7 * 86400000) mapa[cid].deuda_por_vencer += pendiente;
    }
  }

  return Object.values(mapa).sort((a,b) => b.deuda_vencida - a.deuda_vencida);
}

// ── KPIs ─────────────────────────────────────────────────────────────
// fn_cta_cte_kpis() ya devuelve los 4 totales + conteos agregados en SQL
// (una sola fila), no hace falta sumar en JS sobre el array de la página.
function actualizarKPIsSaldos(kpis) {
  const total     = Number(kpis.deuda_total || 0);
  const vencido   = Number(kpis.deuda_vencida || 0);
  const porVencer = Number(kpis.deuda_por_vencer || 0);
  const alDia     = Number(kpis.deuda_al_dia || 0);

  // FiltroTabs.actualizarContadores() formatea como número plano — acá
  // necesitamos "$ 1.234" (peso), así que se escribe directo en los spans
  // que genera el componente (mismo selector que usa esa función).
  const cont = document.getElementById('filtro-tabs-saldos');
  const setMonto = (key, monto) => {
    const span = cont?.querySelector(`.filtro-tab-count[data-key-count="${key}"]`);
    if (span) span.textContent = formatPeso(monto);
  };
  setMonto('',           total);
  setMonto('vencido',    vencido);
  setMonto('por_vencer', porVencer);
  setMonto('al_dia',     alDia > 0 ? alDia : 0);
}

// Fallback (misma lógica que antes de la migración 266): agrega en JS
// sobre el listado completo, solo se usa si fn_cta_cte_kpis() no está
// disponible.
function actualizarKPIsSaldosFallback(datos) {
  let total = 0, vencido = 0, porVencer = 0, alDia = 0;
  let cTotal = 0, cVencido = 0, cPorVencer = 0, cAlDia = 0;

  for (const d of datos) {
    total    += d.deuda_total || 0;
    vencido  += d.deuda_vencida || 0;
    porVencer += d.deuda_por_vencer || 0;
    cTotal++;
    if ((d.deuda_vencida || 0) > 0) cVencido++;
    else if ((d.deuda_por_vencer || 0) > 0) cPorVencer++;
    else cAlDia++;
  }
  alDia = total - vencido - porVencer;

  actualizarKPIsSaldos({
    deuda_total: total, deuda_vencida: vencido, deuda_por_vencer: porVencer,
    deuda_al_dia: alDia, clientes_total: cTotal, clientes_vencido: cVencido,
    clientes_por_vencer: cPorVencer, clientes_al_dia: cAlDia,
  });
}

// ── Tabla ────────────────────────────────────────────────────────────
function renderTabla(datos) {
  const tbody = document.getElementById('tbody-clientes');
  if (!datos.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/></svg>
      No hay clientes con saldo pendiente</div></td></tr>`;
    return;
  }

  tbody.innerHTML = datos.map(c => {
    const estado = estadoSaldo(c);
    const nombre = c.nombre_fantasia || c.razon_social;
    return `<tr onclick="abrirCliente('${c.cliente_id}')" data-testid="cc-fila" data-cliente-id="${c.cliente_id}">
      <td>
        <div style="font-weight:600">${nombre}</div>
        ${c.razon_social !== nombre ? `<div style="font-size:11px;color:var(--color-text-light)">${sanitize(c.razon_social)}</div>` : ''}
      </td>
      <td><span class="semaforo ${estado.cls}"><span class="semaforo-dot"></span>${estado.label}</span></td>
      <td class="monto ${(c.deuda_total||0) > 0 ? 'monto-rojo' : ''}">${formatPeso(c.deuda_total || 0)}</td>
      <td class="monto ${(c.deuda_vencida||0) > 0 ? 'monto-rojo' : 'monto-verde'}">${formatPeso(c.deuda_vencida || 0)}</td>
      <td style="font-size:12px;color:var(--color-text-muted)">${c.ultimo_pago ? formatFecha(c.ultimo_pago) : '—'}</td>
      <td class="col-sticky-end">
        <button class="btn btn-sm btn-primary" onclick="event.stopPropagation();abrirModalCobroDirecto('${c.cliente_id}')">Cobrar</button>
      </td>
    </tr>`;
  }).join('');
}

function estadoSaldo(c) {
  if ((c.deuda_vencida || 0) > 0) return { cls: 'rojo', label: 'Vencido' };
  if ((c.deuda_por_vencer || 0) > 0) return { cls: 'amarillo', label: 'Por vencer' };
  return { cls: 'verde', label: 'Al día' };
}

// ── Filtros y paginación (server-side, migración 266) ──────────────────
// Antes: filtraba en JS sobre todosClientes (listado completo ya en
// memoria). Ahora ese array es solo la página actual, así que
// búsqueda/filtro disparan una nueva carga contra fn_cta_cte_lista().
function filtrarClientes() {
  paginaActualCC = 1;
  cargarCtaCte();
}

let _debounceBusquedaCC = null;
function onBusquedaClienteInput() {
  clearTimeout(_debounceBusquedaCC);
  _debounceBusquedaCC = setTimeout(() => filtrarClientes(), 250);
}
window.onBusquedaClienteInput = onBusquedaClienteInput;

function inyectarControlesPaginacionCC() {
  if (document.getElementById('paginacion-cc')) return; // ya existe
  const contenedor = document.querySelector('#vista-saldos .tabla-wrap');
  if (!contenedor) return;
  const div = document.createElement('div');
  div.id = 'paginacion-cc';
  div.className = 'paginacion-container';
  div.innerHTML = `
      <button id="btn-prev-cc" class="btn-pag" onclick="cambiarPaginaCC(-1)">Anterior</button>
      <span id="info-pag-cc">Página 1</span>
      <button id="btn-next-cc" class="btn-pag" onclick="cambiarPaginaCC(1)">Siguiente</button>
  `;
  contenedor.appendChild(div);
}

function actualizarControlesPaginacionCC() {
  inyectarControlesPaginacionCC();
  const totalPaginas = Math.max(1, Math.ceil(totalCCFiltrados / ITEMS_POR_PAGINA_CC));
  const info = document.getElementById('info-pag-cc');
  if (info) info.textContent = `Página ${paginaActualCC} de ${totalPaginas} (${totalCCFiltrados} clientes)`;
  const btnPrev = document.getElementById('btn-prev-cc');
  const btnNext = document.getElementById('btn-next-cc');
  if (btnPrev) btnPrev.disabled = paginaActualCC <= 1;
  if (btnNext) btnNext.disabled = paginaActualCC >= totalPaginas;
}

function cambiarPaginaCC(delta) {
  const totalPaginas = Math.max(1, Math.ceil(totalCCFiltrados / ITEMS_POR_PAGINA_CC));
  const nueva = paginaActualCC + delta;
  if (nueva < 1 || nueva > totalPaginas) return;
  paginaActualCC = nueva;
  cargarCtaCte();
}
window.cambiarPaginaCC = cambiarPaginaCC;

// ── Panel detalle ────────────────────────────────────────────────────
async function abrirCliente(clienteId) {
  const c = todosClientes.find(x => x.cliente_id === clienteId);
  if (!c) {
    // No estaba en la página/filtro actual de "Saldos por cliente" (p. ej.
    // quedó afuera por paginación o por un filtro de estado activo).
    // Avisar en vez de cambiar de pestaña sin que pase nada.
    if (typeof window.mostrarToast === 'function') {
      window.mostrarToast('No se encontró el cliente en Saldos por cliente. Probá limpiar el filtro de búsqueda/estado.', 'err');
    }
    return;
  }
  clienteActivo = c;

  document.getElementById('panel-nombre').textContent = c.nombre_fantasia || c.razon_social;
  document.getElementById('panel-body').innerHTML = '<div style="padding:20px;color:var(--color-text-muted);font-size:13px">Cargando movimientos...</div>';
  document.getElementById('panel-cliente').classList.add('open');

  try {
    const r = await fetch(
      `${window.ENV.SUPABASE_URL}/rest/v1/cta_cte?empresa_id=eq.${window.authCtx?.perfil?.empresa_id}&cliente_id=eq.${clienteId}&order=fecha.desc&limit=50`,
      { headers: await getHeaders() }
    );
    const movs = r.ok ? await r.json() : [];
    renderPanelBody(c, movs);
  } catch(e) {
    renderPanelBody(c, []);
  }
}

function renderPanelBody(c, movs) {
  const vencido   = c.deuda_vencida || 0;
  const porVencer = c.deuda_por_vencer || 0;
  const total     = c.deuda_total || 0;

  let html = `
    <div class="detalle-seccion">
      <h4>Resumen de saldo</h4>
      <div class="saldo-resumen">
        <div class="detalle-fila">
          <span class="detalle-fila-label">Deuda vencida</span>
          <span class="detalle-fila-val" style="color:var(--color-danger)">${formatPeso(vencido)}</span>
        </div>
        <div class="detalle-fila">
          <span class="detalle-fila-label">Por vencer (7 días)</span>
          <span class="detalle-fila-val" style="color:var(--color-warning)">${formatPeso(porVencer)}</span>
        </div>
        <div class="saldo-total-fila">
          <span>Total adeudado</span>
          <span style="color:var(--color-danger)">${formatPeso(total)}</span>
        </div>
      </div>
    </div>`;

  if (vencido > 0) {
    html += `<div class="alerta-inline danger">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      Este cliente tiene deuda vencida. Considerar bloquear nuevos pedidos.
    </div>`;
  }

  html += `<div class="detalle-seccion"><h4>Últimos movimientos</h4>`;
  if (!movs.length) {
    html += '<div style="font-size:13px;color:var(--color-text-light);padding:8px 0">Sin movimientos registrados</div>';
  } else {
    html += movs.map(m => {
      const esCobro = m.tipo === 'cobro' || m.monto > 0;
      const cls = esCobro ? 'credito' : 'debito';
      const signo = esCobro ? '+' : '-';
      const abs = Math.abs(m.monto || 0);
      return `<div class="movimiento-row">
        <div class="movimiento-icono ${cls}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            ${esCobro
              ? '<polyline points="20 6 9 17 4 12"/>'
              : '<line x1="5" y1="12" x2="19" y2="12"/>'}
          </svg>
        </div>
        <div class="movimiento-info">
          <span class="movimiento-desc">${window.sanitize(m.descripcion || (esCobro ? 'Cobro' : 'Factura'))}</span>
          <span class="movimiento-fecha">${formatFecha(m.fecha)}</span>
        </div>
        <span class="movimiento-monto ${cls}">${signo}${formatPeso(abs)}</span>
      </div>`;
    }).join('');
  }
  html += '</div>';

  document.getElementById('panel-body').innerHTML = html;
}

function cerrarPanel() {
  document.getElementById('panel-cliente').classList.remove('open');
  clienteActivo = null;
}

// ── Modal cobro ──────────────────────────────────────────────────────
// facturaVinculadaCobro: id de la factura puntual a la que se le va a
// aplicar el próximo cobro (null = cobro genérico a cuenta del cliente,
// como era el comportamiento único antes de este fix). Se setea desde
// abrirModalCobroParaFactura (llamada por cobranzas.js al tocar "Cobrar"
// en "Facturas pendientes") y se resetea acá cada vez que se abre el
// modal desde el flujo genérico de "Saldos por cliente".
let facturaVinculadaCobro = null;

function abrirModalCobro() {
  if (!clienteActivo) return;
  facturaVinculadaCobro = null;
  const aviso = document.getElementById('cobro-factura-vinculada');
  if (aviso) { aviso.textContent = ''; aviso.classList.add('hidden'); }
  document.getElementById('cobro-cliente-nombre').value =
    clienteActivo.nombre_fantasia || clienteActivo.razon_social;
  document.getElementById('cobro-monto').value = '';
  document.getElementById('cobro-medio').value = '';
  document.getElementById('cobro-comprobante').value = '';
  document.getElementById('cobro-obs').value = '';
  document.getElementById('alerta-credito-cobro').innerHTML = '';
  document.getElementById('modal-cobro').classList.remove('hidden');
}

// Entrada usada por cobranzas.js desde "Facturas pendientes" — a diferencia
// de abrirModalCobroDirecto, no depende de que el cliente ya esté cargado
// en todosClientes (la tabla de "Saldos por cliente" puede no haberse
// pedido todavía), porque cobranzas.js ya trae cliente_id/nombre/monto de
// la fila que el usuario tocó.
function abrirModalCobroParaFactura(facturaId, clienteId, clienteNombre, montoPendiente) {
  clienteActivo = todosClientes.find(x => x.cliente_id === clienteId)
    || { cliente_id: clienteId, nombre_fantasia: clienteNombre };

  abrirModalCobro(); // limpia el form y resetea facturaVinculadaCobro a null

  if (facturaId) {
    facturaVinculadaCobro = facturaId;
    const aviso = document.getElementById('cobro-factura-vinculada');
    if (aviso) {
      aviso.textContent = 'Este cobro se va a aplicar a la factura seleccionada en "Facturas pendientes" — no queda como saldo genérico.';
      aviso.classList.remove('hidden');
    }
  }
  if (montoPendiente != null) {
    document.getElementById('cobro-monto').value =
      Math.round(Number(montoPendiente) * 100) / 100;
  }
}
window.abrirModalCobroParaFactura = abrirModalCobroParaFactura;

function abrirModalCobroDirecto(clienteId) {
  const c = todosClientes.find(x => x.cliente_id === clienteId);
  if (!c) return;
  clienteActivo = c;
  abrirModalCobro();
}

function cerrarModalCobro() {
  document.getElementById('modal-cobro').classList.add('hidden');
}

async function guardarCobro() {
  const monto = parseFloat(document.getElementById('cobro-monto').value);
  const medio = document.getElementById('cobro-medio').value;
  const fecha = document.getElementById('cobro-fecha').value;

  if (!monto || monto <= 0) { mostrarToast('Ingresá un monto válido', 'err'); return; }
  if (!medio)               { mostrarToast('Seleccioná el medio de pago', 'err'); return; }
  if (!fecha)               { mostrarToast('Indicá la fecha', 'err'); return; }

  const okCobro = await window.confirmar(`¿Confirmás registrar un cobro de $${monto} por ${medio}?`, { labelOk: 'Registrar cobro', labelCancel: 'Revisar' });
  if (!okCobro) return;

  const btn = document.getElementById('btn-guardar-cobro');
  btn.disabled = true;
  btn.textContent = 'Guardando...';

  try {
    const sb = window.authCtx?.sb;
    const perfil = window.authCtx?.perfil;
    if (!sb || !perfil) throw new Error('Sin sesión');

    const payloadCobro = {
      p_empresa_id:  perfil.empresa_id,
      p_cliente_id:  clienteActivo.cliente_id,
      p_usuario_id:  perfil.id,
      p_monto:       monto,
      p_medio:       medio,
      p_referencia:  document.getElementById('cobro-comprobante').value || null,
      p_notas:       document.getElementById('cobro-obs').value || null,
      p_factura_id:  facturaVinculadaCobro || null,
    };

    const { data, error } = await sb.rpc('registrar_cobro_completo', payloadCobro);

    if (error) {
      // Plan offline — Etapa 3, ítem 4: si la RPC no llegó a responder por
      // falta de red, encolamos el cobro en vez de perderlo — se envía
      // solo apenas vuelve la señal (idempotente por offline_local_id).
      if (esErrorDeRed(error) && window.CobrosOffline) {
        await window.CobrosOffline.encolarAccion('registrar_cobro_completo', payloadCobro);
        cerrarModalCobro();
        mostrarToast('Sin conexión: guardamos el cobro en el dispositivo. Se va a enviar solo cuando vuelva internet.', 'warning', 6000);
        return;
      }
      throw new Error(error.message);
    }
    if (!data?.ok) throw new Error(data?.error || 'Error desconocido');

    if (facturaVinculadaCobro && data.factura_saldada === false) {
      mostrarToast(`Cobro ${data.nro} registrado — la factura queda con saldo parcial`, 'ok');
    } else if (facturaVinculadaCobro && data.factura_saldada === true) {
      mostrarToast(`Cobro ${data.nro} registrado — factura saldada`, 'ok');
    } else {
      mostrarToast(`Cobro ${data.nro} registrado`, 'ok');
    }
    sb.rpc('registrar_auditoria', {
      p_tabla: 'cobros', p_accion: 'INSERT',
      p_registro_id: data.cobro_id || null,
      p_datos_despues: { monto, medio, cliente_id: clienteActivo.cliente_id, numero: data.nro, factura_id: facturaVinculadaCobro || null },
    }).then(() => {}, () => {});
    cerrarModalCobro();
    // FIX F3-04: invalidar siempre, no solo cuando hay factura vinculada.
    // Un cobro genérico también deja el caché de priorizada sucio (la deuda
    // del cliente baja, puede salir del top). Y además refrescar los KPIs
    // del dashboard de cobranzas ("Cobrado hoy", "Vence hoy", medios de pago)
    // que quedaban stale hasta que el usuario recargaba la página manualmente.
    if (typeof window.invalidarCobranzaPriorizada === 'function') {
      window.invalidarCobranzaPriorizada();
    }
    if (typeof window.refrescarKPIsCobranzas === 'function') {
      window.refrescarKPIsCobranzas();
    }
    const clienteIdGuardado = clienteActivo?.cliente_id;
    await cargarCtaCte();
    // FIX: si el cobro saldó al cliente (o quedó fuera de la página actual),
    // ya no aparece en la lista recién recargada — antes esto disparaba el
    // toast de error "No se encontró el cliente...", tapando el toast de
    // éxito de arriba y dando la falsa impresión de que el cobro no se guardó.
    // Ahora solo reabrimos el panel si el cliente sigue en la lista.
    if (clienteIdGuardado && todosClientes.some(c => c.cliente_id === clienteIdGuardado)) {
      abrirCliente(clienteIdGuardado);
    } else {
      cerrarPanel();
    }
  } catch(e) {
    console.error(e);
    mostrarToast('Error: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar cobro';
  }
}

// ── REQ-10: Enviar estado de cuenta por email ─────────────────────────────
function enviarEstado() {
  if (!clienteActivo) return;

  const email = clienteActivo.email || '';
  const nombre = clienteActivo.nombre_fantasia || clienteActivo.razon_social;

  // Pre-llenar el modal
  document.getElementById('ec-cliente-nombre').textContent = nombre;
  document.getElementById('ec-email-display').textContent  = email || 'Sin email registrado';
  document.getElementById('ec-deuda-display').textContent  = formatPeso(clienteActivo.deuda_total || 0);
  document.getElementById('ec-email-override').value       = '';
  document.getElementById('ec-alert').innerHTML            = '';

  // Advertencia si no tiene email
  if (!email) {
    document.getElementById('ec-alert').innerHTML = `
      <div class="alerta-inline danger" style="margin-bottom:12px">
        Este cliente no tiene email registrado. Podés ingresar uno abajo para este envío puntual.
      </div>`;
    document.getElementById('ec-email-override').placeholder = 'Ingresar email manualmente *';
  } else {
    document.getElementById('ec-email-override').placeholder = 'Dejar vacío para usar el email del cliente';
  }

  document.getElementById('modal-estado-cuenta').classList.remove('hidden');
}

function cerrarModalEstado() {
  document.getElementById('modal-estado-cuenta').classList.add('hidden');
}

async function confirmarEnvioEstado() {
  if (!clienteActivo) return;

  const emailOverride = document.getElementById('ec-email-override').value.trim();
  const emailFinal    = emailOverride || clienteActivo.email;

  if (!emailFinal) {
    mostrarToast('Ingresá un email para el envío', 'err');
    return;
  }

  // Validación básica de formato
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailFinal)) {
    mostrarToast('El email ingresado no es válido', 'err');
    return;
  }

  const btn = document.getElementById('btn-confirmar-envio-ec');
  btn.disabled    = true;
  btn.textContent = 'Enviando…';

  try {
    const { data: { session } } = await window.authCtx.sb.auth.getSession();
    const token = session?.access_token || SB_KEY;

    const resp = await fetch('/api/estado-cuenta', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body:    JSON.stringify({
        cliente_id:          clienteActivo.cliente_id,
        empresa_id:          window.authCtx?.perfil?.empresa_id,
        incluir_movimientos: document.getElementById('ec-incluir-movs').checked,
        // Si el admin ingresó un email manual, se lo mandamos al backend para que
        // el endpoint lo use en lugar del email registrado en la BD del cliente.
        // (El endpoint actual usa el email de la BD; si necesitás el override,
        //  podés extender el handler para aceptar este campo.)
        email_override: emailOverride || undefined,
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      throw new Error(data.error || `Error ${resp.status}`);
    }

    mostrarToast(`Estado de cuenta enviado a ${data.destinatario}`, 'ok');
    cerrarModalEstado();

  } catch (e) {
    console.error('[ESTADO-CUENTA]', e);
    mostrarToast('Error al enviar: ' + e.message, 'err');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Enviar estado de cuenta';
  }
}

// ── Helpers ──────────────────────────────────────────────────────────
function formatPeso(n) {
  return '$' + (n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatFecha(f) {
  if (!f) return '—';
  return new Date(f).toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' });
}

// [Etapa 3] mostrarToast local eliminado — usa window.mostrarToast global (ui-utils.js)

// Exponer funciones al scope global (requerido por los onclick del HTML)
window.abrirModalCobro = abrirModalCobro;
window.abrirCliente = abrirCliente;
window.cerrarModalCobro = cerrarModalCobro;
window.cerrarModalEstado = cerrarModalEstado;
window.cerrarPanel = cerrarPanel;
window.confirmarEnvioEstado = confirmarEnvioEstado;
window.enviarEstado = enviarEstado;
window.guardarCobro = guardarCobro;
