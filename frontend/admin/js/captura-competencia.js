// frontend/admin/js/captura-competencia.js
// Fase 1 (Capa 2 — MVP) de PLAN_CAPTURA_COMPETENCIA.md — pantalla de
// revisión pendiente del changelog v1013. Habla con
// /api/captura-competencia (ver lib/handlers/captura-competencia.js).
//
// Flujo de la pantalla (plan, 1.2 y 1.5):
//   lista → nueva captura (foto) → panel de revisión (renglones con badge
//   de confianza, ajuste manual obligatorio) → cerrar (piso de margen) →
//   convertir en cliente + pedido.

let ccCapturas = [];
let ccFiltroEstadoActual = '';
let ccPanelCapturaActual = null; // detalle completo de la captura abierta en el panel
let ccFotoBase64 = null;
let ccFotoMimeType = null;
let ccTabCliente = 'existente'; // 'existente' | 'nuevo'
let ccClienteSeleccionado = null;
let ccBuscarClienteTimer = null;
let ccBuscarProductoTimers = {};
// Vínculo con Fase 3 (prospección geográfica): cuando se llega acá desde el
// deep-link de "Iniciar captura" en prospectos-competencia.js
// (?proveedor=X&prospecto_id=Y), guardamos el prospecto de origen para
// completar el vínculo prospecto↔captura solo/automáticamente al convertir
// — antes quedaba pendiente de un accion=marcar_estado manual (ver
// changelog v1018, sección "Pendiente"). Se consume una sola vez, en
// ccCrearCaptura, y de ahí en más viaja colgado del objeto de la captura en
// curso (no queda como estado global) para no vincular por error una
// captura distinta que el vendedor arranque después en la misma sesión.
let ccProspectoIdDesdeQuery = null;

// ── Estado de la pestaña "Prospección" (ex prospectos-competencia.js) ────
// sb/empresaId: prospectos-competencia.js sí los usaba como globales
// (pcCargarRutasDeHoy pega directo contra Supabase, mismo criterio que
// rutas.js); captura-competencia.js no los necesitaba antes. Se declaran
// acá una sola vez y se setean en el bootstrap de authReady de más abajo.
let sb = null;
let empresaId = null;
let pcTabActual = 'bandeja';
let pcProspectos = [];
let pcCoordsElegidas = null; // { lat, lng } — set por geolocalización o tipeado manual

const PC_ESTADO_LABEL = {
  pendiente: 'Pendiente',
  visita_planificada: 'Visita planificada',
  visitado: 'Visitado',
  convertido: 'Convertido',
  descartado: 'Descartado',
};
const PC_ESTADO_CHIP = {
  pendiente: 'chip-amarillo',
  visita_planificada: 'chip-azul',
  visitado: 'chip-verde',
  convertido: 'chip-verde',
  descartado: 'chip-gris',
};

const CC_ESTADO_LABEL = {
  pendiente_revision: 'Pendiente de revisión',
  revisado: 'Revisado',
  convertido_pedido: 'Convertido en pedido',
  descartado: 'Descartado',
};
const CC_ESTADO_CHIP = {
  pendiente_revision: 'chip-amarillo',
  revisado: 'chip-azul',
  convertido_pedido: 'chip-verde',
  descartado: 'chip-gris',
};

// ── Helpers de API (mismo criterio que pos.js) ────────────────────────────
function ccAuthHeader() {
  const token = window.authCtx?.session?.access_token || '';
  return { Authorization: `Bearer ${token}` };
}
async function ccApiGet(url) {
  const resp = await fetch(url, { headers: ccAuthHeader() });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error(data?.error || 'Error de red'), data, { status: resp.status });
  return data;
}
async function ccApiPost(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ccAuthHeader() },
    body: JSON.stringify(body || {}),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error(data?.error || 'Error de red'), data, { status: resp.status });
  return data;
}

// esc() estaba duplicada idéntica en captura-competencia.js y
// prospectos-competencia.js — queda una sola acá, usada por ambas mitades
// de la pantalla.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Helpers de API de la pestaña "Prospección" (idénticos a ccApiGet/
// ccApiPost salvo el nombre, se mantienen separados por si el día de
// mañana alguno de los dos endpoints necesita un manejo de error propio). ──
function pcAuthHeader() {
  const token = window.authCtx?.session?.access_token || '';
  return { Authorization: `Bearer ${token}` };
}
async function pcApiGet(url) {
  const resp = await fetch(url, { headers: pcAuthHeader() });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error(data?.error || 'Error de red'), data, { status: resp.status });
  return data;
}
async function pcApiPost(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...pcAuthHeader() },
    body: JSON.stringify(body || {}),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error(data?.error || 'Error de red'), data, { status: resp.status });
  return data;
}

function fmt(n) { return window.formatARS ? window.formatARS(n) : `$ ${Math.round(Number(n) || 0).toLocaleString('es-AR')}`; }
function fmtFecha(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ── Vista principal (fusión UX): "Captura" y "Prospección" dejaron de ser
// dos páginas/secciones de menú separadas — ahora son dos pestañas de esta
// misma puerta de entrada (mismo criterio que cobranzas.html fusionó
// 'Cobranzas' + 'Cuenta corriente' con cambiarVistaPrincipal/?vista=).
// /admin/prospectos-competencia quedó como redirect acá con ?vista=prospeccion.
function cambiarVistaPrincipal(vista) {
  const esProspeccion = vista === 'prospeccion';
  document.getElementById('vista-captura-competencia').style.display = esProspeccion ? 'none' : '';
  document.getElementById('vista-prospectos-competencia').style.display = esProspeccion ? '' : 'none';
  document.getElementById('vptab-captura').classList.toggle('active', !esProspeccion);
  document.getElementById('vptab-prospeccion').classList.toggle('active', esProspeccion);
  document.querySelector('.topbar-title').textContent = esProspeccion ? 'Prospección de competencia' : 'Captura de competencia';
}
window.cambiarVistaPrincipal = cambiarVistaPrincipal;

// ── Init ───────────────────────────────────────────────────────────────────
window.authReady.then(async () => {
  const perfil = window.authCtx.perfil;
  sb = window.authCtx.sb;
  empresaId = window.authCtx.perfil.empresa_id;

  // El vendedor de campo solo ve lo suyo (accion=listar ya scopea server-side
  // por rol); a dueño/admin les mostramos también la columna de vendedor
  // porque su bandeja trae capturas/prospectos de toda la empresa.
  if (perfil?.rol !== 'vendedor') {
    document.getElementById('cc-th-vendedor').style.display = '';
    document.getElementById('pc-th-vendedor').style.display = '';
  }
  await ccCargarLista();

  try {
    await pcCargarBandeja();
    await pcCargarMetricas();
  } catch (e) {
    // Ex-manejo del 403 CAPTURA_COMPETENCIA_DESHABILITADA: el handler ya
    // no devuelve ese error (el flag se sacó también del backend), así
    // que cualquier error acá es un error real de red/servidor.
    console.error('[prospectos-competencia] error inicial:', e);
  }

  const params = new URLSearchParams(window.location.search);

  // Deep-link desde prospección geográfica (Fase 3): abrir directamente el
  // modal de nueva captura con el proveedor precargado, en vez de esperar
  // a que el vendedor toque "+ Nueva captura" y vuelva a tipear el nombre
  // que ya cargó en la bandeja de prospectos. Al vivir ahora las dos en la
  // misma página, esto ya no es una navegación cross-page — pcIniciarCaptura
  // solo cambia de pestaña y agrega estos mismos query params.
  const proveedorQuery = params.get('proveedor');
  const prospectoIdQuery = params.get('prospecto_id');
  if (prospectoIdQuery) ccProspectoIdDesdeQuery = prospectoIdQuery;
  if (proveedorQuery) {
    cambiarVistaPrincipal('captura');
    window.ccAbrirModalNueva(proveedorQuery);
    // Limpiamos la URL para que un F5 posterior no vuelva a abrir el modal
    // ni reintente el vínculo — ccProspectoIdDesdeQuery ya quedó en memoria.
    window.history.replaceState({}, '', window.location.pathname);
  } else if (params.get('vista') === 'prospeccion') {
    // Soporta el redirect de /admin/prospectos-competencia (bookmarks viejos)
    // y los links directos con ?vista=prospeccion.
    cambiarVistaPrincipal('prospeccion');
  }
}).catch((e) => console.error('[captura-competencia] auth no disponible:', e));

// ── Pestaña "Prospección" (ex prospectos-competencia.js) ──────────────────

// Plan 3.5 — métrica de éxito de la prospección: % de prospectos que
// reciben visita y % que terminan en una captura. Mismo componente
// .franja-resumen-sololectura / .dato-sello que ccCargarMetricas.
async function pcCargarMetricas() {
  const cont = document.getElementById('pc-kpis');
  if (!cont) return;
  try {
    const m = await pcApiGet('/api/prospectos-competencia?accion=metricas');
    cont.innerHTML = `
      <div class="dato-sello" data-tono="verde"><div class="dato-sello-valor">${m.total_prospectos ?? 0}</div><div class="dato-sello-etiqueta">Prospectos cargados</div></div>
      <div class="dato-sello" data-tono="verde"><div class="dato-sello-valor">${(m.tasa_visita_pct ?? 0).toFixed(1)}%</div><div class="dato-sello-etiqueta">Reciben visita</div><div class="dato-sello-nota">${m.total_visitados ?? 0} de ${m.total_prospectos ?? 0} visitados</div></div>
      <div class="dato-sello" data-tono="ambar"><div class="dato-sello-valor">${(m.tasa_captura_pct ?? 0).toFixed(1)}%</div><div class="dato-sello-etiqueta">Terminan en captura</div><div class="dato-sello-nota">${m.total_con_captura ?? 0} de ${m.total_prospectos ?? 0} con captura</div></div>
    `;
    cont.style.display = '';
  } catch (e) {
    console.error('[prospectos-competencia] no se pudieron cargar las métricas:', e);
  }
}

window.pcCambiarTab = function (tab) {
  pcTabActual = tab;
  document.getElementById('pc-tab-bandeja').classList.toggle('activo', tab === 'bandeja');
  document.getElementById('pc-tab-ranking').classList.toggle('activo', tab === 'ranking');
  document.getElementById('pc-vista-bandeja').style.display = tab === 'bandeja' ? '' : 'none';
  document.getElementById('pc-vista-ranking').style.display = tab === 'ranking' ? '' : 'none';
  if (tab === 'ranking' && !document.getElementById('pc-select-ruta').dataset.cargado) {
    pcCargarRutasDeHoy();
  }
};

async function pcCargarBandeja() {
  const data = await pcApiGet('/api/prospectos-competencia?accion=listar');
  pcProspectos = data.prospectos || [];
  pcRenderBandeja();
}

function pcRenderBandeja() {
  const tbody = document.getElementById('pc-bandeja-tbody');
  const conVendedor = document.getElementById('pc-th-vendedor').style.display !== 'none';

  if (!pcProspectos.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="tabla-loading">Sin prospectos todavía — cargá el primero con "+ Nuevo prospecto".</td></tr>`;
    return;
  }

  tbody.innerHTML = pcProspectos.map(p => {
    const chip = PC_ESTADO_CHIP[p.estado] || 'chip-gris';
    const label = PC_ESTADO_LABEL[p.estado] || p.estado;
    return `
      <tr data-id="${p.id}">
        <td>${esc(p.nombre)}</td>
        ${conVendedor ? `<td class="col-fit">${esc(p.usuarios?.nombre || '—')}</td>` : ''}
        <td>${esc(p.rubro || '—')}</td>
        <td class="col-fit"><span class="chip ${chip}">${label}</span></td>
        <td class="col-sticky-end col-fit">
          ${pcAccionesBandeja(p)}
        </td>
      </tr>`;
  }).join('');
}

function pcAccionesBandeja(p) {
  if (p.estado === 'descartado' || p.estado === 'convertido') return '—';
  const botones = [];
  if (p.estado === 'pendiente') {
    botones.push(`<button type="button" class="btn btn--ghost" onclick="pcMarcarEstado('${p.id}', 'visita_planificada')">Planificar visita</button>`);
  }
  if (p.estado === 'visita_planificada') {
    botones.push(`<button type="button" class="btn btn--ghost" onclick="pcMarcarEstado('${p.id}', 'visitado')">Marcar visitado</button>`);
  }
  botones.push(`<button type="button" class="btn btn--ghost" onclick="pcIniciarCaptura('${p.id}', '${esc(p.nombre).replace(/'/g, "\\'")}')">Iniciar captura</button>`);
  botones.push(`<button type="button" class="btn btn--ghost" onclick="pcMarcarEstado('${p.id}', 'descartado')">Descartar</button>`);
  return `<span class="fila-acciones">${botones.join('')}</span>`;
}

window.pcMarcarEstado = async function (id, estado) {
  try {
    await pcApiPost('/api/prospectos-competencia?accion=marcar_estado', { id, estado });
    window.toast('Estado actualizado', 'success', 1500);
    await pcCargarBandeja();
    await pcCargarMetricas();
    if (pcTabActual === 'ranking') await pcCargarRanking();
  } catch (e) {
    console.error(e);
    window.toast(e.message || 'No se pudo actualizar el estado', 'error');
  }
};

// Deep-link al flujo de captura (Fase 1): antes era una navegación
// cross-page a captura-competencia.html?proveedor=X&prospecto_id=Y. Ahora
// que las dos viven en la misma página, alcanza con cambiar de pestaña y
// abrir el modal directo en memoria — sin recargar ni tocar la URL. Sigue
// existiendo el soporte por query params (?proveedor=&prospecto_id=) en el
// bootstrap de más arriba para links viejos guardados fuera de la app.
window.pcIniciarCaptura = function (id, nombre) {
  cambiarVistaPrincipal('captura');
  ccProspectoIdDesdeQuery = id;
  window.ccAbrirModalNueva(nombre);
};

// ── Modal: nuevo prospecto ──────────────────────────────────────────────
window.pcAbrirModalNuevo = function () {
  document.getElementById('pc-nuevo-nombre').value = '';
  document.getElementById('pc-nuevo-rubro').value = '';
  document.getElementById('pc-nuevo-direccion').value = '';
  document.getElementById('pc-nuevo-lat').value = '';
  document.getElementById('pc-nuevo-lng').value = '';
  document.getElementById('pc-nuevo-notas').value = '';
  document.getElementById('pc-coords-estado').textContent = '';
  document.getElementById('pc-coords-estado').className = 'pc-coords-estado';
  pcCoordsElegidas = null;
  document.getElementById('pc-backdrop-nuevo').style.display = 'block';
  document.getElementById('pc-modal-nuevo').style.display = '';
};
window.pcCerrarModalNuevo = function () {
  document.getElementById('pc-backdrop-nuevo').style.display = 'none';
  document.getElementById('pc-modal-nuevo').style.display = 'none';
};

window.pcUsarUbicacionActual = function () {
  const estado = document.getElementById('pc-coords-estado');
  if (!navigator.geolocation) {
    estado.textContent = 'Este dispositivo no soporta geolocalización — cargá las coordenadas a mano.';
    estado.className = 'pc-coords-estado err';
    return;
  }
  estado.textContent = 'Buscando tu ubicación...';
  estado.className = 'pc-coords-estado';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      document.getElementById('pc-nuevo-lat').value = pos.coords.latitude.toFixed(6);
      document.getElementById('pc-nuevo-lng').value = pos.coords.longitude.toFixed(6);
      estado.textContent = `Ubicación cargada (precisión ~${Math.round(pos.coords.accuracy)}m)`;
      estado.className = 'pc-coords-estado ok';
    },
    (err) => {
      estado.textContent = 'No se pudo obtener tu ubicación — cargá las coordenadas a mano.';
      estado.className = 'pc-coords-estado err';
      console.error('[prospectos-competencia] geolocation:', err);
    },
    { enableHighAccuracy: true, timeout: 10000 },
  );
};

window.pcGuardarNuevo = async function () {
  const nombre = document.getElementById('pc-nuevo-nombre').value.trim();
  const lat = document.getElementById('pc-nuevo-lat').value;
  const lng = document.getElementById('pc-nuevo-lng').value;
  if (!nombre) { window.toast('Falta el nombre del comercio', 'error'); return; }
  if (lat === '' || lng === '') { window.toast('Faltan las coordenadas — usá el botón de ubicación o cargalas a mano', 'error'); return; }

  const btn = document.getElementById('pc-btn-guardar-nuevo');
  btn.disabled = true;
  btn.textContent = 'Guardando...';
  try {
    await pcApiPost('/api/prospectos-competencia?accion=crear', {
      nombre,
      rubro: document.getElementById('pc-nuevo-rubro').value.trim() || undefined,
      direccion: document.getElementById('pc-nuevo-direccion').value.trim() || undefined,
      lat: Number(lat),
      lng: Number(lng),
      notas: document.getElementById('pc-nuevo-notas').value.trim() || undefined,
    });
    window.pcCerrarModalNuevo();
    window.toast('Prospecto cargado', 'success');
    await pcCargarBandeja();
  } catch (e) {
    console.error(e);
    window.toast(e.message || 'No se pudo guardar el prospecto', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar';
  }
};

// ── Tab: ranking sobre una ruta ───────────────────────────────────────────
async function pcCargarRutasDeHoy() {
  const select = document.getElementById('pc-select-ruta');
  const hoy = window.hoyLocalISO ? window.hoyLocalISO() : new Date().toISOString().split('T')[0];
  try {
    const { data } = await sb
      .from('rutas')
      .select('id, fecha, estado, usuarios(nombre)')
      .eq('empresa_id', empresaId)
      .eq('fecha', hoy)
      .neq('estado', 'cancelada')
      .order('created_at', { ascending: false });

    const rutas = data || [];
    select.innerHTML = '<option value="">Elegí una ruta del día...</option>' +
      rutas.map(r => `<option value="${r.id}">Ruta de ${esc(r.usuarios?.nombre || 'chofer sin asignar')} — ${esc(r.estado)}</option>`).join('');
    select.dataset.cargado = '1';
    if (!rutas.length) {
      document.getElementById('pc-ranking-tbody').innerHTML =
        '<tr><td colspan="5" class="tabla-loading">No hay rutas armadas para hoy todavía.</td></tr>';
    }
  } catch (e) {
    console.error('[prospectos-competencia] error cargando rutas:', e);
  }
}

window.pcCargarRanking = async function () {
  const rutaId = document.getElementById('pc-select-ruta').value;
  const tbody = document.getElementById('pc-ranking-tbody');
  if (!rutaId) {
    tbody.innerHTML = '<tr><td colspan="5" class="tabla-loading">Elegí una ruta para ver oportunidades.</td></tr>';
    return;
  }
  tbody.innerHTML = '<tr><td colspan="5" class="tabla-loading">Buscando prospectos cerca de esa ruta...</td></tr>';
  try {
    const data = await pcApiGet(`/api/prospectos-competencia?accion=ranking_ruta&ruta_id=${encodeURIComponent(rutaId)}`);
    const prospectos = data.prospectos || [];
    if (!prospectos.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="tabla-loading">Ningún prospecto cargado queda cerca de las paradas de esta ruta.</td></tr>';
      return;
    }
    tbody.innerHTML = prospectos.map(p => {
      const chip = PC_ESTADO_CHIP[p.estado] || 'chip-gris';
      const label = PC_ESTADO_LABEL[p.estado] || p.estado;
      return `
        <tr data-id="${p.id}">
          <td>${esc(p.nombre)}</td>
          <td>${esc(p.rubro || '—')}</td>
          <td class="col-fit pc-distancia">${p.distancia_metros} m</td>
          <td class="col-fit"><span class="chip ${chip}">${label}</span></td>
          <td class="col-sticky-end col-fit">
            <span class="fila-acciones">
              ${p.estado === 'pendiente' ? `<button type="button" class="btn btn--ghost" onclick="pcMarcarEstado('${p.id}', 'visita_planificada')">Planificar visita</button>` : ''}
              <button type="button" class="btn btn--ghost" onclick="pcIniciarCaptura('${p.id}', '${esc(p.nombre).replace(/'/g, "\\'")}')">Iniciar captura</button>
            </span>
          </td>
        </tr>`;
    }).join('');
  } catch (e) {
    console.error(e);
    tbody.innerHTML = `<tr><td colspan="5" class="tabla-loading">${esc(e.message || 'No se pudo cargar el ranking.')}</td></tr>`;
  }
};

async function ccCargarLista() {
  const tbody = document.getElementById('cc-tbody');
  try {
    const data = await ccApiGet('/api/captura-competencia?accion=listar');
    ccCapturas = data.capturas || [];
    ccRenderLista();
    await ccCargarMetricas();
    await ccCargarAhorroRanking();
  } catch (e) {
    console.error(e);
    // Ex-manejo del 403 CAPTURA_COMPETENCIA_DESHABILITADA: el handler ya
    // no devuelve ese error (el flag se sacó también del backend), así
    // que cualquier error acá es un error real de red/servidor.
    tbody.innerHTML = `<tr><td colspan="6" class="tabla-loading">${esc(e.message || 'No se pudieron cargar las capturas.')}</td></tr>`;
  }
}

// Plan 1.7 — métrica de éxito del piloto: % de capturas convertidas en
// pedido, y tiempo promedio foto→cierre. Mismo componente
// .franja-resumen-sololectura / .dato-sello que ya usa riesgo-cheques.js —
// acá se arma dinámico (no hay un número fijo de KPIs conocido de
// antemano como en esas pantallas) en vez de dejarlo hardcodeado en el HTML.
async function ccCargarMetricas() {
  const cont = document.getElementById('cc-kpis');
  if (!cont) return;
  try {
    const m = await ccApiGet('/api/captura-competencia?accion=metricas');
    const tiempoTxt = m.tiempo_promedio_foto_cierre_horas != null
      ? (m.tiempo_promedio_foto_cierre_horas < 24
          ? `${m.tiempo_promedio_foto_cierre_horas.toFixed(1)} hs`
          : `${(m.tiempo_promedio_foto_cierre_horas / 24).toFixed(1)} días`)
      : '—';
    cont.innerHTML = `
      <div class="dato-sello" data-tono="verde"><div class="dato-sello-valor">${m.total_capturas ?? 0}</div><div class="dato-sello-etiqueta">Capturas totales</div></div>
      <div class="dato-sello" data-tono="verde"><div class="dato-sello-valor">${(m.tasa_conversion_pct ?? 0).toFixed(1)}%</div><div class="dato-sello-etiqueta">Tasa de cierre</div><div class="dato-sello-nota">${m.total_convertidas ?? 0} de ${m.total_capturas ?? 0} convertidas</div></div>
      <div class="dato-sello" data-tono="ambar"><div class="dato-sello-valor">${tiempoTxt}</div><div class="dato-sello-etiqueta">Tiempo promedio foto→cierre</div></div>
    `;
    cont.style.display = '';
  } catch (e) {
    // No bloquea la pantalla: la lista de capturas ya se mostró. Si el 403
    // de flag deshabilitado llegó acá primero (ccCargarLista ya lo maneja),
    // solo lo logueamos.
    console.error('[captura-competencia] no se pudieron cargar las métricas:', e);
  }
}

// Fase 2 (PLAN_CAPTURA_COMPETENCIA.md, plan 2.5): ranking de ahorro
// acumulado por cliente. El endpoint devuelve 403 para el rol vendedor
// (es un reporte agregado de toda la empresa, no de sus propias capturas)
// — en ese caso la sección se queda oculta en vez de mostrar un error, no
// es una falla, es simplemente que este usuario no la ve.
async function ccCargarAhorroRanking() {
  const wrap = document.getElementById('cc-ahorro-wrap');
  if (!wrap) return;
  try {
    const data = await ccApiGet('/api/captura-competencia?accion=ahorro_ranking');
    const clientes = data.clientes || [];

    const totalCont = document.getElementById('cc-ahorro-total');
    if (totalCont) {
      totalCont.innerHTML = `<div class="dato-sello" data-tono="verde"><div class="dato-sello-valor">${fmt(data.ahorro_total_empresa)}</div><div class="dato-sello-etiqueta">Ahorro total generado</div><div class="dato-sello-nota">${clientes.length} cliente${clientes.length === 1 ? '' : 's'} con ahorro acumulado</div></div>`;
      totalCont.style.display = clientes.length ? '' : 'none';
    }

    const tbody = document.getElementById('cc-ahorro-tbody');
    if (tbody) {
      tbody.innerHTML = clientes.length
        ? clientes.map(c => `
            <tr>
              <td data-label="Cliente">${esc(c.razon_social || 'Cliente sin nombre')}</td>
              <td class="col-fit" data-label="Ahorro acumulado"><span class="cc-ahorro-pos">${fmt(c.ahorro_acumulado)}</span></td>
              <td class="col-fit" data-label="Pedidos">${c.pedidos_con_ahorro}</td>
              <td class="col-fit" data-label="Actualizado">${c.ultima_actualizacion ? new Date(c.ultima_actualizacion).toLocaleDateString('es-AR') : '—'}</td>
            </tr>
          `).join('')
        : `<tr><td colspan="4" class="tabla-loading">Todavía ningún cliente acreditó ahorro.</td></tr>`;
    }

    wrap.style.display = '';
  } catch (e) {
    if (e.status === 403) return; // rol sin permiso (vendedor) — sección se queda oculta, no es un error
    console.error('[captura-competencia] no se pudo cargar el ranking de ahorro:', e);
  }
}

window.ccFiltrar = function () {
  ccFiltroEstadoActual = document.getElementById('cc-filtro-estado').value;
  ccRenderLista();
};

// Descartar una captura completa (no un renglón — ver ccToggleDescartar).
// Soft-delete: el handler pasa el estado a 'descartado', no borra la fila.
window.ccDescartarCaptura = async function (id) {
  const ok = await window.confirmar(
    'Se va a descartar esta captura. No vas a poder revertirlo desde acá.',
    { labelOk: 'Descartar', tipo: 'danger' }
  );
  if (!ok) return;
  try {
    await ccApiPost('/api/captura-competencia?accion=descartar', { id });
    window.toast('Captura descartada', 'success');
    await ccCargarLista();
  } catch (e) {
    console.error(e);
    window.toast(e.message || 'No se pudo descartar la captura', 'error');
  }
};

function ccRenderLista() {
  const tbody = document.getElementById('cc-tbody');
  const conVendedor = document.getElementById('cc-th-vendedor').style.display !== 'none';
  const filas = ccCapturas.filter(c => !ccFiltroEstadoActual || c.estado === ccFiltroEstadoActual);

  if (!filas.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="tabla-loading">Sin capturas${ccFiltroEstadoActual ? ' con ese estado' : ' todavía'}.</td></tr>`;
    return;
  }

  tbody.innerHTML = filas.map(c => {
    const chip = CC_ESTADO_CHIP[c.estado] || 'chip-gris';
    const label = CC_ESTADO_LABEL[c.estado] || c.estado;
    const ahorroTxt = c.ahorro_absoluto != null
      ? `<span class="${Number(c.ahorro_absoluto) > 0 ? 'cc-ahorro-pos' : 'cc-ahorro-neg'}">${fmt(c.ahorro_absoluto)}${c.ahorro_porcentual != null ? ` (${Number(c.ahorro_porcentual).toFixed(1)}%)` : ''}</span>`
      : '—';
    const accionLabel = c.estado === 'pendiente_revision' ? 'Revisar' : 'Ver';
    // Se puede descartar mientras no haya un pedido real detrás (ver
    // accionDescartar en el handler) — una vez convertido_pedido o ya
    // descartado, no tiene sentido ofrecer el botón de nuevo.
    const puedeDescartar = c.estado !== 'convertido_pedido' && c.estado !== 'descartado';
    return `
      <tr data-testid="cc-fila" data-id="${c.id}">
        <td class="col-fit" data-label="Fecha">${fmtFecha(c.fecha_captura)}</td>
        ${conVendedor ? `<td class="col-fit" data-label="Vendedor">${esc(c.usuarios?.nombre || '—')}</td>` : ''}
        <td data-label="Proveedor">${esc(c.proveedor_competencia_nombre || 'Sin especificar')}</td>
        <td class="col-fit" data-label="Estado"><span class="chip ${chip}">${label}</span></td>
        <td class="col-fit" data-label="Ahorro">${ahorroTxt}</td>
        <td class="col-sticky-end col-fit" data-label="Acciones">
          <div class="fila-acciones" style="display:flex;gap:6px;flex-wrap:wrap">
            <button type="button" class="btn btn--ghost" onclick="ccAbrirPanelRevision('${c.id}')">${accionLabel}</button>
            ${puedeDescartar ? `<button type="button" class="btn btn--ghost" onclick="ccDescartarCaptura('${c.id}')" title="Descartar esta captura">Eliminar</button>` : ''}
          </div>
        </td>
      </tr>`;
  }).join('');
}

// ── Modal: nueva captura ───────────────────────────────────────────────────
window.ccAbrirModalNueva = function (proveedorPrefill) {
  ccFotoBase64 = null;
  ccFotoMimeType = null;
  document.getElementById('cc-nueva-proveedor').value = proveedorPrefill || '';
  document.getElementById('cc-preview-foto').style.display = 'none';
  document.getElementById('cc-nueva-alerta').style.display = 'none';
  document.getElementById('cc-input-foto').value = '';
  document.getElementById('cc-backdrop-nueva').style.display = 'block';
  document.getElementById('cc-modal-nueva').style.display = '';
};
window.ccCerrarModalNueva = function () {
  document.getElementById('cc-backdrop-nueva').style.display = 'none';
  document.getElementById('cc-modal-nueva').style.display = 'none';
};

document.getElementById('cc-btn-tomar-foto').addEventListener('click', () => {
  document.getElementById('cc-input-foto').click();
});
document.getElementById('cc-input-foto').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { ccAlertaNueva('La imagen no puede superar 8MB'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const [prefijo, base64] = String(reader.result).split(',');
    ccFotoMimeType = (prefijo.match(/data:(.*);base64/) || [])[1] || file.type;
    ccFotoBase64 = base64;
    const preview = document.getElementById('cc-preview-foto');
    preview.src = reader.result;
    preview.style.display = 'block';
  };
  reader.readAsDataURL(file);
});

function ccAlertaNueva(msg) {
  const el = document.getElementById('cc-nueva-alerta');
  el.className = 'alerta alerta-err';
  el.textContent = msg;
  el.style.display = 'block';
}

window.ccCrearCaptura = async function () {
  if (!ccFotoBase64) { ccAlertaNueva('Falta la foto de la factura'); return; }
  const btn = document.getElementById('cc-btn-crear-captura');
  btn.disabled = true;
  btn.textContent = 'Analizando factura...';
  // Se consume acá (no en ccConvertir) para que quede atado a ESTA captura
  // puntual y no a "la próxima que se convierta" si el vendedor cancela y
  // arranca otra distinta en la misma sesión.
  const prospectoIdOrigen = ccProspectoIdDesdeQuery;
  ccProspectoIdDesdeQuery = null;
  try {
    const proveedor = document.getElementById('cc-nueva-proveedor').value.trim();
    const resp = await ccApiPost('/api/captura-competencia?accion=crear', {
      imagen_base64: ccFotoBase64,
      imagen_mime_type: ccFotoMimeType,
      proveedor_competencia_nombre: proveedor || undefined,
    });
    window.ccCerrarModalNueva();
    window.toast('Factura analizada — revisá los renglones', 'success');
    await ccCargarLista();
    await ccAbrirPanelRevision(resp.captura.id);
    if (prospectoIdOrigen && ccPanelCapturaActual) {
      ccPanelCapturaActual.prospecto_id_origen = prospectoIdOrigen;
    }
  } catch (e) {
    console.error(e);
    ccAlertaNueva(e.message || 'No se pudo analizar la factura.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Analizar factura';
  }
};

// ── Zoom de foto ───────────────────────────────────────────────────────────
window.ccVerFotoGrande = function (url) {
  document.getElementById('cc-zoom-img').src = url;
  document.getElementById('cc-backdrop-zoom').style.display = 'block';
  document.getElementById('cc-modal-zoom').style.display = '';
};
window.ccCerrarZoom = function () {
  document.getElementById('cc-backdrop-zoom').style.display = 'none';
  document.getElementById('cc-modal-zoom').style.display = 'none';
};

// ── Panel de revisión ────────────────────────────────────────────────────
window.ccAbrirPanelRevision = async function (id) {
  const panel = document.getElementById('panel-captura');
  const body = document.getElementById('cc-panel-body');
  panel.classList.add('open');
  body.innerHTML = '<div class="tabla-loading">Cargando...</div>';
  ccClienteSeleccionado = null;
  ccTabCliente = 'existente';
  try {
    const data = await ccApiGet(`/api/captura-competencia?accion=detalle&id=${encodeURIComponent(id)}`);
    ccPanelCapturaActual = data.captura;
    ccRenderPanel();
  } catch (e) {
    console.error(e);
    body.innerHTML = `<div class="tabla-loading">${esc(e.message || 'No se pudo cargar la captura.')}</div>`;
  }
};
window.ccCerrarPanel = function () {
  document.getElementById('panel-captura').classList.remove('open');
  ccPanelCapturaActual = null;
};

function ccBadgeConfianza(score) {
  if (score == null) return '<span class="chip chip-gris">Sin match</span>';
  const s = Number(score);
  if (s >= 0.85) return `<span class="chip chip-verde">Alta (${(s * 100).toFixed(0)}%)</span>`;
  if (s >= 0.5) return `<span class="chip chip-amarillo">Media (${(s * 100).toFixed(0)}%)</span>`;
  return `<span class="chip chip-rojo">Baja (${(s * 100).toFixed(0)}%)</span>`;
}

function ccRenderPanel() {
  const c = ccPanelCapturaActual;
  if (!c) return;
  document.getElementById('cc-panel-titulo').textContent = `Captura — ${CC_ESTADO_LABEL[c.estado] || c.estado}`;

  const items = c.captura_competencia_items || [];
  const violacionesMap = c._violacionesMargen || {};
  const pendientesSet = c._itemsPendientes || new Set();
  const sospechososMap = c._preciosSospechosos || {};

  const itemsHtml = items.map(it => {
    const violacion = violacionesMap[it.id];
    const pendiente = pendientesSet.has ? pendientesSet.has(it.id) : false;
    const sospechoso = sospechososMap[it.id];
    const nombreProducto = it.productos?.nombre || (it.producto_id ? 'Producto' : '');
    return `
      <div class="cc-item ${it.descartado ? 'cc-item-descartado' : ''}" data-item-id="${it.id}" style="${violacion || pendiente || sospechoso ? 'border-color:var(--color-danger)' : ''}">
        <div class="cc-item-top">
          <div>
            ${ccBadgeConfianza(it.confianza_match)}
            <div class="cc-item-original">"${esc(it.texto_original)}"</div>
          </div>
          <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--color-text-muted);white-space:nowrap">
            <input type="checkbox" ${it.descartado ? 'checked' : ''} onchange="ccToggleDescartar('${it.id}', this.checked)">
            Descartar
          </label>
        </div>
        <div class="cc-item-grid">
          <div class="cc-buscador-prod">
            <label>Producto propio</label>
            <input type="text" value="${esc(nombreProducto)}" placeholder="Buscar producto..." data-rol="buscar-producto"
                   oninput="ccBuscarProducto('${it.id}', this.value)" autocomplete="off">
            <div class="cc-buscador-resultados" id="cc-buscador-${it.id}" style="display:none"></div>
          </div>
          <div>
            <label>Cantidad</label>
            <input type="number" min="0" step="0.01" value="${it.cantidad ?? ''}" data-testid="cc-item-cantidad" onchange="ccActualizarItem('${it.id}', { cantidad: this.value })">
          </div>
          <div>
            <label>Precio competencia</label>
            <input type="number" value="${it.precio_unitario_competencia ?? ''}" readonly style="background:var(--color-bg)">
          </div>
          <div>
            <label>Precio propio</label>
            <input type="number" min="0" step="0.01" value="${it.precio_unitario_propio ?? ''}" data-testid="cc-item-precio-propio" onchange="ccActualizarItem('${it.id}', { precio_unitario_propio: this.value })">
          </div>
        </div>
        <div class="cc-item-footer">
          <span></span>
          ${violacion ? `<span class="cc-item-margen-warn">Margen actual ${violacion.margen_actual_pct}% — por debajo del mínimo</span>` : ''}
          ${pendiente ? `<span class="cc-item-margen-warn">Falta asignar producto propio</span>` : ''}
          ${sospechoso ? `<span class="cc-item-margen-warn">Precio propio muy distinto al de competencia (¿producto equivocado?)</span>` : ''}
        </div>
      </div>`;
  }).join('') || '<div class="tabla-loading">No se detectaron renglones en la foto.</div>';

  let resumenHtml = '';
  if (c.estado === 'revisado' || c.estado === 'convertido_pedido') {
    resumenHtml = `
      <div class="cc-resumen-box">
        <div class="cc-resumen-linea"><span>Total competencia</span><span>${fmt(c.total_competencia)}</span></div>
        <div class="cc-resumen-linea"><span>Total propio</span><span>${fmt(c.total_propio_cotizado)}</span></div>
        <div class="cc-resumen-linea total"><span>Ahorro</span><span class="${Number(c.ahorro_absoluto) > 0 ? 'cc-ahorro-pos' : ''}">${fmt(c.ahorro_absoluto)} (${Number(c.ahorro_porcentual || 0).toFixed(1)}%)</span></div>
      </div>`;
  }

  let accionesHtml = '';
  if (c.estado === 'pendiente_revision') {
    accionesHtml = `<button type="button" class="btn btn-primary" style="width:100%;margin-top:10px" onclick="ccCerrarCotizacion()">Cerrar cotización</button>`;
  } else if (c.estado === 'revisado') {
    accionesHtml = ccRenderConvertirBox(c);
  } else if (c.estado === 'convertido_pedido') {
    accionesHtml = `<div class="alerta alerta-ok" style="display:block;margin-top:10px">Convertida en pedido${c.pedido_id ? ` #${esc(c.pedido_id)}` : ''}.</div>`;
  }

  document.getElementById('cc-panel-body').innerHTML = `
    ${c.imagen_original_url ? `
      <div class="cc-panel-foto-wrap">
        <img src="${esc(c.imagen_original_url)}" alt="Factura de competencia" onclick="ccVerFotoGrande('${esc(c.imagen_original_url)}')">
      </div>` : ''}
    <div class="cc-meta-row">
      <span>Vendedor: <strong>${esc(c.usuarios?.nombre || '—')}</strong></span>
      <span>Proveedor: <strong>${esc(c.proveedor_competencia_nombre || 'Sin especificar')}</strong></span>
      <span>Fecha: <strong>${fmtFecha(c.fecha_captura)}</strong></span>
    </div>
    ${itemsHtml}
    ${resumenHtml}
    ${accionesHtml}
  `;
}

// ── Edición de renglones (auto-guardado, plan 1.5: revisión obligatoria) ──
window.ccActualizarItem = async function (itemId, cambios) {
  const payload = { item_id: itemId };
  if (cambios.cantidad !== undefined) payload.cantidad = Number(cambios.cantidad) || 0;
  if (cambios.precio_unitario_propio !== undefined) payload.precio_unitario_propio = Number(cambios.precio_unitario_propio) || 0;
  if (cambios.producto_id !== undefined) payload.producto_id = cambios.producto_id;
  if (cambios.descartado !== undefined) payload.descartado = cambios.descartado;

  try {
    await ccApiPost('/api/captura-competencia?accion=confirmar_item', payload);
    const item = (ccPanelCapturaActual.captura_competencia_items || []).find(it => it.id === itemId);
    if (item) Object.assign(item, cambios);
    window.toast('Renglón actualizado', 'success', 1500);
  } catch (e) {
    console.error(e);
    window.toast(e.message || 'No se pudo guardar el cambio', 'error');
    ccRenderPanel(); // revierte visualmente al último estado conocido
  }
};

window.ccToggleDescartar = function (itemId, checked) {
  ccActualizarItem(itemId, { descartado: checked }).then(() => ccRenderPanel());
};

window.ccBuscarProducto = function (itemId, texto) {
  clearTimeout(ccBuscarProductoTimers[itemId]);
  const cont = document.getElementById(`cc-buscador-${itemId}`);
  if (!texto || texto.trim().length < 2) { cont.style.display = 'none'; cont.innerHTML = ''; return; }
  ccBuscarProductoTimers[itemId] = setTimeout(async () => {
    try {
      const resultados = await ccApiGet(`/api/pos/productos?q=${encodeURIComponent(texto.trim())}`);
      if (!resultados.length) {
        cont.innerHTML = '<div class="cc-buscador-resultado" style="color:var(--color-text-light)">Sin resultados</div>';
      } else {
        cont.innerHTML = resultados.slice(0, 10).map(p => `
          <div class="cc-buscador-resultado" data-id="${p.id}" data-nombre="${esc(p.nombre)}" data-precio="${p.precio_base}">
            ${esc(p.nombre)} <span style="color:var(--color-text-light)">— ${fmt(p.precio_base)}</span>
          </div>`).join('');
        cont.querySelectorAll('.cc-buscador-resultado[data-id]').forEach(el => {
          el.addEventListener('click', () => ccElegirProducto(itemId, el.dataset));
        });
      }
      cont.style.display = 'block';
    } catch (e) {
      console.error(e);
    }
  }, 220);
};

async function ccElegirProducto(itemId, dataset) {
  const item = (ccPanelCapturaActual.captura_competencia_items || []).find(it => it.id === itemId);
  const cambios = { producto_id: dataset.id };
  // Si todavía no tenía un precio propio cargado, se sugiere el precio base
  // como punto de partida — el vendedor lo puede seguir ajustando (el precio
  // AUTORITATIVO de todos modos se recalcula recién al convertir, ver
  // nota de arquitectura en accionConvertir).
  if (!item?.precio_unitario_propio) cambios.precio_unitario_propio = dataset.precio;
  await ccActualizarItem(itemId, cambios);
  if (item) item.productos = { id: dataset.id, nombre: dataset.nombre, precio_base: dataset.precio };
  document.getElementById(`cc-buscador-${itemId}`).style.display = 'none';
  ccRenderPanel();
}

// ── Cerrar cotización (piso de margen, plan "Riesgos transversales") ─────
window.ccCerrarCotizacion = async function () {
  try {
    const resp = await ccApiPost('/api/captura-competencia?accion=cerrar', { id: ccPanelCapturaActual.id });
    Object.assign(ccPanelCapturaActual, resp, { estado: 'revisado' });
    ccPanelCapturaActual._violacionesMargen = {};
    ccPanelCapturaActual._itemsPendientes = new Set();
    ccPanelCapturaActual._preciosSospechosos = {};
    window.toast('Cotización cerrada — ahorro calculado', 'success');
    ccRenderPanel();
    await ccCargarLista();
  } catch (e) {
    console.error(e);
    if (e.precios_sospechosos?.length) {
      ccPanelCapturaActual._preciosSospechosos = Object.fromEntries(e.precios_sospechosos.map(v => [v.item_id, v]));
      window.toast(e.message || 'Hay renglones con precio propio muy distinto al de competencia', 'error', 6000);
    } else if (e.violaciones_margen?.length) {
      ccPanelCapturaActual._violacionesMargen = Object.fromEntries(e.violaciones_margen.map(v => [v.item_id, v]));
      window.toast(e.message || 'Hay renglones por debajo del margen mínimo', 'error', 5000);
    } else if (e.items_pendientes?.length) {
      ccPanelCapturaActual._itemsPendientes = new Set(e.items_pendientes);
      window.toast(e.message || 'Faltan productos por asignar', 'error', 5000);
    } else {
      window.toast(e.message || 'No se pudo cerrar la cotización', 'error');
    }
    ccRenderPanel();
  }
};

// ── Convertir en cliente + pedido ─────────────────────────────────────────
function ccRenderConvertirBox() {
  return `
    <div class="cc-convertir-box">
      <div style="font-weight:600;margin-bottom:8px">Convertir en cliente + pedido</div>
      <div class="cc-tabs-cliente">
        <button type="button" class="btn btn--ghost ${ccTabCliente === 'existente' ? 'activo' : ''}" onclick="ccSetTabCliente('existente')">Cliente existente</button>
        <button type="button" class="btn btn--ghost ${ccTabCliente === 'nuevo' ? 'activo' : ''}" onclick="ccSetTabCliente('nuevo')">Cliente nuevo</button>
      </div>
      <div id="cc-tab-existente" style="display:${ccTabCliente === 'existente' ? '' : 'none'}">
        <input type="text" id="cc-buscar-cliente" placeholder="Buscar cliente por razón social..." style="width:100%" oninput="ccBuscarCliente(this.value)" autocomplete="off">
        <div class="cc-buscador-resultados" id="cc-resultados-cliente" style="position:static;display:none;margin-top:6px"></div>
        <div id="cc-cliente-elegido" style="margin-top:8px;font-size:13px;color:var(--color-text-muted)">${ccClienteSeleccionado ? `Elegido: <strong>${esc(ccClienteSeleccionado.razon_social)}</strong>` : 'Ningún cliente elegido todavía.'}</div>
      </div>
      <div id="cc-tab-nuevo" style="display:${ccTabCliente === 'nuevo' ? '' : 'none'}">
        <label style="font-size:13px;color:var(--color-text-muted)">Razón social *</label>
        <input type="text" id="cc-nuevo-razon-social" style="width:100%;margin-bottom:8px">
        <label style="font-size:13px;color:var(--color-text-muted)">Teléfono (opcional)</label>
        <input type="text" id="cc-nuevo-telefono" style="width:100%;margin-bottom:8px">
        <label style="font-size:13px;color:var(--color-text-muted)">Dirección (opcional)</label>
        <input type="text" id="cc-nuevo-direccion" style="width:100%">
      </div>
      <button type="button" class="btn btn-success" style="width:100%;margin-top:12px" onclick="ccConvertir()">Convertir en cliente + pedido</button>
    </div>`;
}

window.ccSetTabCliente = function (tab) {
  ccTabCliente = tab;
  ccRenderPanel();
};

window.ccBuscarCliente = function (texto) {
  clearTimeout(ccBuscarClienteTimer);
  const cont = document.getElementById('cc-resultados-cliente');
  if (!texto || texto.trim().length < 2) { cont.style.display = 'none'; cont.innerHTML = ''; return; }
  ccBuscarClienteTimer = setTimeout(async () => {
    try {
      const resultados = await ccApiGet(`/api/clientes?busqueda=${encodeURIComponent(texto.trim())}&activo=true`);
      cont.innerHTML = (resultados || []).slice(0, 10).map(c => `
        <div class="cc-buscador-resultado" data-id="${c.id}">${esc(c.razon_social)}</div>
      `).join('') || '<div class="cc-buscador-resultado" style="color:var(--color-text-light)">Sin resultados</div>';
      cont.querySelectorAll('.cc-buscador-resultado[data-id]').forEach(el => {
        el.addEventListener('click', () => {
          ccClienteSeleccionado = (resultados || []).find(r => r.id === el.dataset.id) || null;
          cont.style.display = 'none';
          ccRenderPanel();
        });
      });
      cont.style.display = 'block';
    } catch (e) {
      console.error(e);
    }
  }, 220);
};

window.ccConvertir = async function () {
  const payload = { id: ccPanelCapturaActual.id };
  if (ccTabCliente === 'existente') {
    if (!ccClienteSeleccionado) { window.toast('Elegí un cliente antes de convertir', 'error'); return; }
    payload.cliente_id = ccClienteSeleccionado.id;
  } else {
    const razonSocial = document.getElementById('cc-nuevo-razon-social').value.trim();
    if (!razonSocial) { window.toast('Falta la razón social del cliente nuevo', 'error'); return; }
    payload.cliente_nuevo = {
      razon_social: razonSocial,
      telefono: document.getElementById('cc-nuevo-telefono').value.trim() || undefined,
      direccion: document.getElementById('cc-nuevo-direccion').value.trim() || undefined,
    };
  }
  try {
    const resp = await ccApiPost('/api/captura-competencia?accion=convertir', payload);
    const prospectoIdOrigen = ccPanelCapturaActual.prospecto_id_origen;
    const capturaId = ccPanelCapturaActual.id;
    ccPanelCapturaActual.estado = 'convertido_pedido';
    ccPanelCapturaActual.pedido_id = resp.pedido?.pedido_id;
    window.toast('Cliente y pedido creados', 'success');
    ccRenderPanel();
    await ccCargarLista();

    // Cierre del loop de Fase 3 (prospección geográfica): si esta captura
    // vino de "Iniciar captura" desde un prospecto, completamos acá el
    // vínculo que antes quedaba pendiente de un accion=marcar_estado
    // manual — la conversión de la captura ya implica que el prospecto
    // recibió la visita y terminó en captura, así que directamente pasa a
    // 'convertido' con el captura_id resultante.
    if (prospectoIdOrigen) {
      try {
        await ccApiPost('/api/prospectos-competencia?accion=marcar_estado', {
          id: prospectoIdOrigen,
          estado: 'convertido',
          captura_id: capturaId,
        });
      } catch (e) {
        // No bloquea el flujo principal: la captura ya se convirtió. Si
        // esto falla (por ejemplo, el prospecto ya fue tocado por otro
        // lado), el vínculo se puede completar a mano como antes.
        console.error('[captura-competencia] no se pudo vincular el prospecto de origen:', e);
      }
    }
  } catch (e) {
    console.error(e);
    window.toast(e.message || 'No se pudo convertir la captura', 'error', 5000);
  }
};
