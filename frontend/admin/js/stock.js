// frontend/admin/js/stock.js — v43
// Patrón: Supabase cliente directo con paginación, igual que productos.js.
// La RLS de `stock` filtra por empresa automáticamente (STABLE, indexada).
// Sin round-trips extra de auth en el backend. Sin .in() masivos.
//
// v42: la tabla principal ahora agrupa por producto (RPC fn_stock_lista_agrupada,
// migración 396) en vez de traer una fila por cada combinación producto+depósito.
// Con un depósito puntual filtrado sigue siendo 1 fila = 1 depósito (igual que antes);
// con "Todos los depósitos" cada producto aparece una sola vez con sus cantidades
// sumadas y un botón para expandir el detalle por depósito (RPC
// fn_stock_depositos_producto), sin importar cuántos depósitos nuevos se agreguen.
//
// v43: Plan offline — Etapa 3, ítem 2. guardarAjuste() ahora encola en
// StockOffline (stock-offline.js) los ingresos/egresos (ajustar_stock) y
// ajustes/conteos (registrar_conteo_stock) que fallan por corte de red, en
// vez de perderlos — mismo patrón que chofer-offline.js / cliente-offline.js.
// Transferencias y producción con insumos quedan fuera de este alcance
// (no tienen idempotencia offline todavía).

// ── Estado ─────────────────────────────────────────────────────────────────
let sb          = null;
let usuario     = null;
let empresaData = null;
let depositos   = [];

let _page      = 1;
let _total     = 0;
let _cargando  = false;
let _busqTimer = null;
const PAGE_SIZE = 50;

// Modal
let _modalAC         = null;
let modalProductoId  = null;
let modalDepositoId  = null;
let modalStockActual    = 0; // Disponible (cantidad_disponible)
let modalStockTotal     = 0; // Total físico (cantidad)
let modalStockReservado = 0; // Reservado (cantidad_reservada)
let modalNombre      = '';
let modalUnidad       = 'u';
let tipoActivo       = 'ingreso';

const UMBRAL_BAJO    = 5;
const UMBRAL_CRITICO = 0;

// Cache de IDs de producto bajo su stock mínimo (mismo criterio que la alerta
// del dashboard, GET /api/admin/stock/bajo). Se resuelve una sola vez por
// carga de página y se reutiliza mientras el pill "Bajo su mínimo" esté activo.
let _idsBajoMinimo = null;
async function obtenerIdsBajoMinimo() {
  if (_idsBajoMinimo) return _idsBajoMinimo;
  try {
    const data = await window.api.get('/api/admin/stock/bajo?limit=50');
    _idsBajoMinimo = (data.items || data || []).map(i => i.producto_id);
  } catch (err) {
    console.error('[stock] obtenerIdsBajoMinimo:', err?.message);
    _idsBajoMinimo = [];
  }
  return _idsBajoMinimo;
}

function createAC() { return new AbortController(); }
const toast = (msg, tipo='default') => window.mostrarToast(msg, tipo);

// Plan offline — Etapa 3, ítem 2: mismo criterio que chofer-offline.js /
// cliente-offline.js — distingue "el servidor respondió con un error de
// negocio" (mostrarlo tal cual) de "la llamada nunca llegó a completarse"
// (encolar y reintentar solo). window.conTimeoutRed(sb.rpc(), 10000) no rechaza la promesa cuando falla
// la red: postgrest-js atrapa el TypeError original y lo devuelve como
// `error`, así que el `throw error;` de más abajo termina lanzando esa
// misma instancia — por eso alcanza con este mismo chequeo.
function esErrorDeRed(e) {
  return e instanceof TypeError || /failed to fetch|network/i.test(e?.message || '');
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  if (!window.authCtx) { window.location.href = '/admin/login'; return; }

  sb          = window.authCtx.sb;
  usuario     = window.authCtx.perfil;
  empresaData = window.authCtx.perfil?.empresas
    || { id: window.authCtx.perfil?.empresa_id, nombre: '', config: {} };

  if (!empresaData?.id) {
    document.getElementById('tabla-body').innerHTML =
      '<tr><td colspan="9" class="tabla-empty">No se pudo cargar la empresa. Recargá la página.</td></tr>';
    return;
  }

  if (empresaData.nombre) document.title = `Stock — ${sanitize(empresaData.nombre)}`;

  // Plan offline — Etapa 3, ítem 2: la cola de ajustes/conteos pendientes
  // usa el mismo cliente sb ya autenticado de esta página.
  window.StockOffline?.init({ getSb: () => sb });

  // Prefiltro desde el dashboard: /admin/stock.html?filtro=bajo_minimo
  // (alerta "Stock crítico" → mismo criterio que /api/admin/stock/bajo)
  const filtroParam = new URLSearchParams(window.location.search).get('filtro');
  if (filtroParam) {
    const pill = document.querySelector(`.e-pill[data-f="${filtroParam}"]`);
    if (pill) {
      document.querySelectorAll('.e-pill').forEach(b => b.classList.remove('activa'));
      pill.classList.add('activa');
    }
  }

  // Depósitos y categorías son listas cortas — van en paralelo con la primera página
  await Promise.all([cargarDepositos(), cargarCategorias(), cargarStock()]);

  // Alertas autónomas no bloquean la carga principal
  cargarAlertasStockAuto().catch(() => {});

  // Productos modificados (período "hoy" por defecto) — tampoco bloquea
  cargarProductosModificados('hoy').catch(err => console.error('[stock] modificados:', err));

  // Overview (franja de KPIs) — no bloquea la tabla principal.
  // El gráfico de movimientos y la card de cobertura de catálogo se
  // trasladaron a /admin/reportes-stock (ver reportes-stock.js).
  cargarOverviewKPIs().catch(err => console.error('[stock] overview KPIs:', err));

  // Deep-link desde el viejo /admin/depositos (ahora redirect, ver vercel.json)
  // hacia el modal de gestión de depósitos.
  if (new URLSearchParams(window.location.search).get('modal') === 'depositos') {
    abrirModalDepositos();
  }

  // Deep-link desde el botón "Reabastecer" de /admin/reportes-stock (tabla
  // "Productos con Stock Crítico"): abre directo el modal de ajuste de ese
  // producto, sin que el usuario tenga que buscarlo de nuevo acá.
  const abrirAjusteId = new URLSearchParams(window.location.search).get('abrirAjuste');
  if (abrirAjusteId) {
    abrirModalDesdeProductoId(abrirAjusteId);
  }
}

// ── Overview: contador de "Sin stock" para el pill del filtro de tabla ─────
// Antes esta función también traía y pintaba la franja de KPIs de solo
// lectura (Valorización de stock / Productos en stock / Rotación promedio)
// que estaba arriba de la tabla — se sacó de la UI (no aportaba valor
// operativo para el día a día) y como nada más los usaba, se saca también
// el RPC fn_reportes_stock_kpis de acá para no pedir datos que ya no se
// muestran. Lo único que sigue haciendo falta es el conteo real de "Sin
// stock" (disponible <= 0), que alimenta el pill rojo del filtro de la
// tabla más abajo.
async function cargarOverviewKPIs() {
  // Antes esto siempre calculaba sobre TODA la empresa (p_deposito_id: null),
  // ignorando el filtro de depósito de la tabla principal (#filtro-deposito).
  // Efecto: un producto con stock en cero en el depósito que el dueño está
  // mirando no aparecía como "Stock crítico" si tenía stock en OTRO depósito,
  // porque el RPC suma el disponible entre depósitos antes de comparar contra
  // el mínimo. Ahora la tarjeta refleja el mismo depósito que la tabla.
  const depFiltro = document.getElementById('filtro-deposito')?.value || null;

  // Conteo real de "Sin stock" (disponible <= 0), con el MISMO criterio que
  // usa el filtro de la tabla al hacer clic en el pill (fn_stock_lista_agrupada
  // con p_estado='critico', ver migración 396: v_umbral_critico = 0).
  // Antes este número salía de fn_reportes_stock_kpis.productos_criticos,
  // que en realidad cuenta "disponible <= stock_minimo (o 5)" — un criterio
  // más amplio que "sin stock" — por eso el pill mostraba un número distinto
  // (mayor) al del resumen "En esta página: N sin stock", que sí compara
  // contra 0. Ver fn_stock_lista_agrupada / mostrarAlertasResumen.
  const sinStockRes = await window.conTimeoutRed(sb.rpc('fn_stock_lista_agrupada', {
    p_estado: 'critico',
    p_deposito_id: depFiltro,
    p_limit: 1,
    p_offset: 0,
  }), 10000);
  if (sinStockRes.error) throw sinStockRes.error;

  const sinStock = Number(sinStockRes.data?.[0]?.total_count) || 0;
  setTxt('pill-count-critico', sinStock.toLocaleString('es-AR'));
}

function setTxt(id, txt) {
  const el = document.getElementById(id);
  if (el) el.textContent = txt;
}

function setDelta(id, valor, sufijo) {
  const el = document.getElementById(id);
  if (!el) return;
  const n = Number(valor) || 0;
  el.textContent = `${n > 0 ? '+' : ''}${n}${sufijo}`;
  el.classList.remove('up', 'down');
  el.classList.add(n >= 0 ? 'up' : 'down');
}

// Nota: el gráfico "Movimientos de stock — últimos 6 meses" (ECharts) y la
// card "Cobertura de catálogo con stock" con avatares de depósitos vivían
// acá antes. Se trasladaron a /admin/reportes-stock (ver
// cargarOverviewChart() y renderAvataresDepositos() en reportes-stock.js),
// que es la página de analítica de stock — este archivo quedó enfocado en
// la operatoria de la tabla (ajustes, transferencias, alertas).

// ── Productos modificados recientemente (hoy / semana / mes) ───────────────
// Agrupa movimientos_stock por (producto, depósito) dentro del período y
// muestra el delta neto + cantidad de movimientos. No reemplaza el historial
// por producto (cargarHistorial) — es una vista transversal para detectar
// qué cambió sin tener que buscar producto por producto.
let _periodoModificados = 'hoy';

function inicioPeriodoModificados(periodo) {
  const ahora = new Date();
  if (periodo === 'hoy') {
    return new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate()).toISOString();
  }
  const dias = periodo === 'semana' ? 7 : 30;
  return new Date(ahora.getTime() - dias * 24 * 60 * 60 * 1000).toISOString();
}

async function cargarProductosModificados(periodo = _periodoModificados) {
  _periodoModificados = periodo;
  const cont = document.getElementById('modif-lista');
  if (!cont) return;
  cont.innerHTML = '<div class="loading-row"><span class="loading-spinner"></span> Cargando…</div>';

  try {
    const { data, error } = await window.conTimeoutRed(sb
      .from('movimientos_stock')
      .select('producto_id, deposito_id, tipo, cantidad, created_at, productos!inner(id, nombre, unidad, activo), depositos(nombre)')
      .eq('productos.activo', true)
      .in('tipo', ['ingreso', 'egreso', 'ajuste', 'transferencia'])
      .gte('created_at', inicioPeriodoModificados(periodo))
      .order('created_at', { ascending: false })
      .limit(300), 10000);

    if (error) throw error;

    // Agrupar por producto + depósito: delta neto, cantidad de movimientos
    // y timestamp del más reciente (para ordenar y mostrar "hace cuánto").
    //
    // IMPORTANTE (v403): movimientos_stock.cantidad NO siempre trae el signo.
    // ajustar_stock() guarda ABS(delta) y codifica la dirección en `tipo`
    // ('ingreso' | 'egreso'); sumar la cantidad cruda hacía que un egreso de
    // corrección cancelara mal un ingreso de igual magnitud (250 devolución +
    // 250 corrección egreso daba +500 en vez de neto 0). 'ajuste' (desde
    // v399) y 'transferencia' (desde v400) sí guardan la diferencia CON
    // SIGNO directamente en `cantidad`, así que esos se suman tal cual.
    // 'reserva' / 'liberacion' se excluyen de la consulta: solo tocan
    // cantidad_reservada, no el stock físico, y no pertenecen a este panel.
    const signoPorTipo = { ingreso: 1, egreso: -1, ajuste: 1, transferencia: 1 };

    const grupos = new Map();
    for (const m of (data || [])) {
      const key = `${m.producto_id}|${m.deposito_id || ''}`;
      let g = grupos.get(key);
      if (!g) {
        g = {
          prodId: m.producto_id,
          depId: m.deposito_id || '',
          nombre: m.productos?.nombre || '?',
          unidad: m.productos?.unidad || 'u',
          deposito: m.depositos?.nombre || '—',
          neto: 0,
          movimientos: 0,
          ultimaFecha: m.created_at
        };
        grupos.set(key, g);
      }
      const signo = signoPorTipo[m.tipo] ?? 1;
      g.neto += signo * (Number(m.cantidad) || 0);
      g.movimientos += 1;
      if (m.created_at > g.ultimaFecha) g.ultimaFecha = m.created_at;
    }

    const lista = Array.from(grupos.values())
      .sort((a, b) => new Date(b.ultimaFecha) - new Date(a.ultimaFecha));

    actualizarBadgeModificados(lista.length);

    if (!lista.length) {
      cont.innerHTML = '<div class="empty-row">Sin movimientos en este período</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    lista.slice(0, 25).forEach(g => {
      const signo = g.neto > 0 ? '+' : '';
      const cls   = g.neto > 0 ? 'mov-positivo' : (g.neto < 0 ? 'mov-negativo' : '');
      const fecha = new Date(g.ultimaFecha).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });

      const tmp = document.createElement('template');
      tmp.innerHTML = `
        <button type="button" class="modif-item"
          data-prod-id="${g.prodId}" data-dep-id="${g.depId}" data-nombre="${escHtml(g.nombre)}">
          <div>
            <div class="modif-item__nombre">${escHtml(g.nombre)}</div>
            <div class="modif-item__meta">${escHtml(g.deposito)} · ${fecha} · ${g.movimientos} mov.${g.movimientos !== 1 ? 's' : ''}</div>
          </div>
          <div class="modif-item__cant ${cls}">${signo}${fmt(g.neto)} <span class="unidad">${escHtml(g.unidad)}</span></div>
        </button>`.trim();
      frag.appendChild(tmp.content.cloneNode(true));
    });

    cont.innerHTML = '';
    cont.appendChild(frag);

  } catch (err) {
    console.error('[stock] cargarProductosModificados:', err);
    cont.innerHTML = `<div class="empty-row">Error al cargar.
      <button class="btn-link" onclick="cargarProductosModificados()">Reintentar</button></div>`;
  }
}

function actualizarBadgeModificados(n) {
  const badge = document.getElementById('modif-badge');
  if (badge) badge.textContent = `${n} producto${n !== 1 ? 's' : ''}`;
}

function selPeriodoModificados(periodo, btn) {
  document.querySelectorAll('.modif-tab').forEach(b => b.classList.remove('activa'));
  btn.classList.add('activa');
  cargarProductosModificados(periodo);
}

function toggleModificados() {
  const panel  = document.getElementById('modif-panel');
  const toggle = document.getElementById('modif-toggle');
  const abierto = panel.classList.toggle('modif-panel--abierto');
  toggle.setAttribute('aria-expanded', abierto ? 'true' : 'false');
}

// Delegación (mismo criterio que las acciones de fila: nunca interpolar
// texto libre de la base de datos dentro de un atributo onclick="").
document.getElementById('modif-lista')?.addEventListener('click', async (ev) => {
  const item = ev.target.closest('.modif-item');
  if (!item) return;

  const prodId = item.dataset.prodId;
  const depId  = item.dataset.depId;

  // Llevar al usuario hasta la fila real en la tabla de stock: mismo patrón
  // que usa guardarAjuste() para resaltar el resultado de un ajuste.
  document.getElementById('input-busqueda').value = item.dataset.nombre;
  document.getElementById('filtro-deposito').value = depId || '';
  document.querySelectorAll('.e-pill').forEach(b => b.classList.remove('activa'));
  document.querySelector('.e-pill[data-f=""]')?.classList.add('activa');
  _page = 1;
  await cargarStock();
  if (!resaltarFilaActualizada(prodId, depId)) {
    document.querySelector('.tabla-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

// ── Depósitos ──────────────────────────────────────────────────────────────
async function cargarDepositos() {
  const { data } = await window.conTimeoutRed(sb.from('depositos')
    .select('id, nombre, es_principal')
    .eq('empresa_id', empresaData.id), 10000);
  depositos = data || [];

  // Reconstruye el select desde cero (no solo agregar) para poder reusar esta
  // función como "refresco" después de crear/editar/dar de baja un depósito
  // desde el modal de gestión, sin duplicar opciones.
  const sel = document.getElementById('filtro-deposito');
  const valorPrevio = sel.value;
  sel.innerHTML = '<option value="">Todos los depósitos</option>';
  depositos.forEach(d => {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.nombre + (d.es_principal ? ' (principal)' : '');
    sel.appendChild(o);
  });
  if ([...sel.options].some(o => o.value === valorPrevio)) sel.value = valorPrevio;
}

// ── Gestión de depósitos (ex /admin/depositos.html — pedido del dueño: era
// una página aparte solo para un ABM chico de 4 campos, ahora vive como modal
// dentro de Stock, que es donde realmente se consumen/eligen los depósitos.
// Mismo endpoint /api/maestros?recurso=depositos que usaba la página vieja. ──
let depositosAdminData = [];
let depAdminFormId     = null; // distinto de modalDepositoId (usado por el modal de ajuste de stock)

async function abrirModalDepositos() {
  document.getElementById('modal-depositos').style.display = 'flex';
  await cargarDepositosAdmin();
}

function cerrarModalDepositos() {
  document.getElementById('modal-depositos').style.display = 'none';
}

function cerrarModalDepositosSiFondo(event) {
  if (event.target.id === 'modal-depositos') cerrarModalDepositos();
}

async function cargarDepositosAdmin() {
  const tbody = document.getElementById('tbody-depositos-admin');
  try {
    const token  = (await sb.auth.getSession()).data.session?.access_token;
    const activa = document.getElementById('filtro-deposito-admin-estado')?.value ?? 'true';
    const params = new URLSearchParams({ recurso: 'depositos' });
    if (activa !== '') params.set('activa', activa);

    const res = await fetch(`/api/maestros?${params}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('No se pudo cargar la lista de depósitos.');
    const data = await res.json();
    depositosAdminData = data.data || [];
    renderTablaDepositosAdmin();
  } catch (err) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="tabla-empty">No se pudo cargar la lista.</td></tr>';
    toast(err.message || 'No se pudo cargar la lista de depósitos.', 'error');
  }
}

function renderTablaDepositosAdmin() {
  const tbody = document.getElementById('tbody-depositos-admin');
  if (!tbody) return;

  if (!depositosAdminData.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="tabla-empty">Todavía no cargaste ningún depósito. Creá el primero con «Nuevo depósito».</td></tr>';
    return;
  }

  tbody.innerHTML = depositosAdminData.map(d => `
    <tr class="fila-clickeable" onclick="if (event.target.closest('[onclick],a,select,input,textarea,button') === this) abrirModalDepositoEditar('${d.id}')">
      <td style="font-weight:600;color:var(--color-text)">${escHtml(d.nombre)}</td>
      <td class="td-text">${escHtml(d.direccion || '—')}</td>
      <td class="td-text">${escHtml(d.responsable || '—')}</td>
      <td style="text-align:center">${d.es_principal ? '<span class="badge-estado badge-ok"><span class="badge-dot"></span>Sí</span>' : '—'}</td>
      <td><span class="badge-estado ${d.activa ? 'badge-ok' : 'badge-critico'}"><span class="badge-dot"></span>${d.activa ? 'Activo' : 'Inactivo'}</span></td>
      <td class="td-acciones">
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn-ajustar" onclick="abrirModalDepositoEditar('${d.id}')">Editar</button>
          ${d.activa
            ? `<button class="btn-ajustar btn-ajustar--peligro" onclick="desactivarDeposito('${d.id}')">Dar de baja</button>`
            : `<button class="btn-ajustar btn-ajustar--exito" onclick="activarDeposito('${d.id}')">Activar</button>`
          }
        </div>
      </td>
    </tr>
  `).join('');
}

function abrirModalDepositoNuevo() {
  depAdminFormId = null;
  ['nombre', 'direccion', 'responsable'].forEach(id => document.getElementById('dep-f-' + id).value = '');
  document.getElementById('dep-f-es-principal').checked = false;
  document.getElementById('modal-deposito-form-tit').textContent = 'Nuevo depósito';
  document.getElementById('btn-guardar-deposito').textContent    = 'Guardar depósito';
  document.getElementById('modal-deposito-form').style.display   = 'flex';
}

function abrirModalDepositoEditar(id) {
  const d = depositosAdminData.find(x => x.id === id);
  if (!d) { toast('No se pudo cargar el depósito', 'error'); return; }

  depAdminFormId = id;
  document.getElementById('dep-f-nombre').value      = d.nombre || '';
  document.getElementById('dep-f-direccion').value   = d.direccion || '';
  document.getElementById('dep-f-responsable').value = d.responsable || '';
  document.getElementById('dep-f-es-principal').checked = !!d.es_principal;

  document.getElementById('modal-deposito-form-tit').textContent = 'Editar depósito';
  document.getElementById('btn-guardar-deposito').textContent    = 'Guardar cambios';
  document.getElementById('modal-deposito-form').style.display   = 'flex';
}

function cerrarModalDepositoForm() {
  document.getElementById('modal-deposito-form').style.display = 'none';
  depAdminFormId = null;
}

function cerrarModalDepositoFormSiFondo(event) {
  if (event.target.id === 'modal-deposito-form') cerrarModalDepositoForm();
}

async function guardarDeposito() {
  const body = {
    nombre:       document.getElementById('dep-f-nombre').value.trim(),
    direccion:    document.getElementById('dep-f-direccion').value.trim(),
    responsable:  document.getElementById('dep-f-responsable').value.trim(),
    es_principal: document.getElementById('dep-f-es-principal').checked,
  };

  if (!body.nombre) {
    toast('El nombre es requerido', 'error');
    return;
  }

  const ok = await window.confirmar(
    depAdminFormId ? `¿Guardar los cambios del depósito "${body.nombre}"?` : `¿Confirmás crear el depósito "${body.nombre}"?`,
    { labelOk: depAdminFormId ? 'Guardar' : 'Crear', labelCancel: 'Revisar' }
  );
  if (!ok) return;

  try {
    const token  = (await sb.auth.getSession()).data.session?.access_token;
    const method = depAdminFormId ? 'PATCH' : 'POST';
    if (depAdminFormId) body.id = depAdminFormId;

    const res = await fetch('/api/maestros?recurso=depositos', {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast(err.error || 'No se pudo guardar el depósito', 'error');
      return;
    }

    toast(depAdminFormId ? 'Depósito actualizado' : 'Depósito creado', 'exito');
    cerrarModalDepositoForm();
    await cargarDepositosAdmin();
    await cargarDepositos();   // refresca el filtro de Stock y los selects del modal de ajuste
  } catch (err) {
    toast(err.message || 'No se pudo guardar el depósito', 'error');
  }
}

async function desactivarDeposito(id) {
  if (!(await window.confirmar('¿Dar de baja este depósito? El stock existente no se pierde, pero dejará de estar disponible para elegir en productos nuevos.', { labelOk: 'Dar de baja', tipo: 'danger' }))) return;
  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const res = await fetch(`/api/maestros?recurso=depositos&id=${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast(err.error || 'No se pudo dar de baja el depósito', 'error');
      return;
    }
    toast('Depósito dado de baja', 'exito');
    await cargarDepositosAdmin();
    await cargarDepositos();
  } catch (err) {
    toast(err.message || 'No se pudo dar de baja el depósito', 'error');
  }
}

async function activarDeposito(id) {
  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const res = await fetch('/api/maestros?recurso=depositos', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, activa: true })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast(err.error || 'No se pudo activar el depósito', 'error');
      return;
    }
    toast('Depósito activado', 'exito');
    await cargarDepositosAdmin();
    await cargarDepositos();
  } catch (err) {
    toast(err.message || 'No se pudo activar el depósito', 'error');
  }
}

// ── Categorías ─────────────────────────────────────────────────────────────
async function cargarCategorias() {
  const { data } = await window.conTimeoutRed(sb.from('categorias')
    .select('id, nombre')
    .eq('empresa_id', empresaData.id)
    .order('nombre'), 10000);

  const sel = document.getElementById('filtro-categoria');
  (data || []).forEach(c => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.nombre;
    sel.appendChild(o);
  });
}

// ── Carga principal: RPC agrupada por producto ─────────────────────────────
// fn_stock_lista_agrupada (migración 396) suma disponible/reservado/total de
// todos los depósitos de cada producto en una sola fila. Si se filtra por un
// depósito puntual, la función ya se comporta igual que antes (1 fila = 1
// depósito, porque solo ese depósito aporta a la suma). Máx PAGE_SIZE filas en DOM.
async function cargarStock() {
  if (_cargando) return;
  _cargando = true;

  // Skeleton en primera carga
  const tbody = document.getElementById('tabla-body');
  tbody.innerHTML = `<tr><td colspan="9" class="tabla-loading">
    <span class="loading-spinner"></span> Cargando…
  </td></tr>`;

  const desde = (_page - 1) * PAGE_SIZE;

  const busq      = document.getElementById('input-busqueda').value.trim();
  const depFiltro = document.getElementById('filtro-deposito').value;
  const catFiltro = document.getElementById('filtro-categoria').value;
  const estadoBtn = document.querySelector('.e-pill.activa')?.dataset?.f || '';

  try {
    let productoIds = null;

    if (estadoBtn === 'bajo_minimo') {
      // No es un umbral fijo: compara contra el stock_minimo propio de cada
      // producto (mismo cálculo que la alerta del dashboard). Se resuelve
      // vía API y se pasa como filtro de IDs a la RPC agrupada.
      const ids = await obtenerIdsBajoMinimo();
      if (!ids.length) {
        tbody.innerHTML = '<tr><td colspan="9" class="tabla-empty">Ningún producto está por debajo de su stock mínimo.</td></tr>';
        actualizarContador(0);
        actualizarPaginacion(0);
        _cargando = false;
        return;
      }
      productoIds = ids;
    }

    const { data, error } = await window.conTimeoutRed(sb.rpc('fn_stock_lista_agrupada', {
      p_busqueda:     busq || null,
      p_categoria_id: catFiltro || null,
      p_deposito_id:  depFiltro || null,
      p_estado:       (estadoBtn && estadoBtn !== 'bajo_minimo') ? estadoBtn : null,
      p_producto_ids: productoIds,
      p_limit:        PAGE_SIZE,
      p_offset:       desde,
    }), 10000);

    if (error) throw error;

    const rows = data || [];
    _total = rows.length ? Number(rows[0].total_count) || 0 : 0;

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="tabla-empty">No se encontraron productos con esos filtros. Probá con otro nombre, código o depósito.</td></tr>';
      actualizarContador(0);
      actualizarPaginacion(0);
      _cargando = false;
      return;
    }

    renderTabla(rows);
    actualizarContador(_total);
    actualizarPaginacion(_total);
    mostrarAlertasResumen(rows);

  } catch (err) {
    console.error('[stock] cargarStock:', err);
    tbody.innerHTML = `<tr><td colspan="9" class="tabla-empty">
      Error al cargar. <button class="btn-link" onclick="cargarStock()">Reintentar</button>
    </td></tr>`;
  } finally {
    _cargando = false;
  }
}

// ── Paginación ─────────────────────────────────────────────────────────────
function actualizarPaginacion(total) {
  const pages = Math.ceil(total / PAGE_SIZE);
  const wrap  = document.getElementById('paginacion-wrap');
  if (!wrap) return;
  if (pages <= 1) { wrap.style.display = 'none'; return; }

  wrap.style.display = 'flex';
  document.getElementById('pag-info').textContent = `Página ${_page} de ${pages}`;
  document.getElementById('btn-pag-ant').disabled = _page <= 1;
  document.getElementById('btn-pag-sig').disabled = _page >= pages;
}

function actualizarContador(total) {
  // El contador de topbar se eliminó de la UI (ver limpieza de zócalo).
  // Se deja la función como no-op para no tocar los 3 call sites.
}

function irPagina(nueva) {
  const pages = Math.ceil(_total / PAGE_SIZE);
  if (nueva < 1 || nueva > pages || nueva === _page) return;
  _page = nueva;
  cargarStock();
  document.querySelector('.tabla-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Filtros ────────────────────────────────────────────────────────────────
function onBusqueda() {
  clearTimeout(_busqTimer);
  _busqTimer = setTimeout(() => { _page = 1; cargarStock(); }, 350);
}

function aplicarFiltros() {
  _page = 1;
  cargarStock();
  cargarOverviewKPIs().catch(err => console.error('[stock] overview KPIs:', err));
}

function selFiltroEstado(estado, btn) {
  document.querySelectorAll('.e-pill').forEach(b => b.classList.remove('activa'));
  btn.classList.add('activa');
  // "Todos" tiene que devolver la lista completa. Sin este reset, si se
  // llegó acá con el buscador precargado (ej. clic en un ítem de "Productos
  // modificados", que completa input-busqueda con el nombre del producto —
  // ver el listener de #modif-lista), tocar "Todos" solo sacaba el filtro
  // de estado y la tabla seguía acotada a ese único producto.
  if (estado === '') {
    document.getElementById('input-busqueda').value   = '';
    document.getElementById('filtro-deposito').value  = '';
    document.getElementById('filtro-categoria').value = '';
    cargarOverviewKPIs().catch(err => console.error('[stock] overview KPIs:', err));
  }
  _page = 1;
  cargarStock();
}

// FIX (v707): mismo patrón que pedidos.js — filtros-avanzados (depósito/
// categoría/Limpiar) oculto por defecto en mobile (ver stock.css @media
// 900px), se despliega solo al tocar el botón. Las acciones primarias
// (Depósitos, Transferir, Exportar, Escanear cámara, Vincular celular)
// quedan siempre visibles, fuera de este wrapper.
function toggleFiltrosAvanzados() {
  const btn = document.getElementById('btn-toggle-filtros-der');
  const wrap = document.getElementById('filtros-avanzados-stock');
  if (!wrap) return;
  const abierto = wrap.classList.toggle('abierto');
  if (btn) {
    btn.classList.toggle('abierto', abierto);
    btn.setAttribute('aria-expanded', String(abierto));
  }
}

function limpiarFiltros() {
  document.getElementById('input-busqueda').value    = '';
  document.getElementById('filtro-deposito').value   = '';
  document.getElementById('filtro-categoria').value  = '';
  document.querySelectorAll('.e-pill').forEach(b => b.classList.remove('activa'));
  document.querySelector('.e-pill[data-f=""]')?.classList.add('activa');
  _page = 1;
  cargarStock();
  cargarOverviewKPIs().catch(err => console.error('[stock] overview KPIs:', err));
}

// ── Alertas resumen ────────────────────────────────────────────────────────
function mostrarAlertasResumen(rows) {
  const box = document.getElementById('alertas-stock');
  const txt = document.getElementById('alerta-stock-txt');
  const criticos = rows.filter(s => disp(s) <= UMBRAL_CRITICO);
  const bajos    = rows.filter(s => disp(s) > UMBRAL_CRITICO && disp(s) <= UMBRAL_BAJO);
  const partes   = [];
  if (criticos.length) partes.push(`${criticos.length} sin stock`);
  if (bajos.length)    partes.push(`${bajos.length} con stock bajo`);
  if (!partes.length) { box.style.display = 'none'; return; }
  box.style.display = 'flex';
  txt.textContent = `En esta página: ${partes.join(' · ')}`;
}

// ── Helpers de presentación (avatar de producto) ────────────────────────────
const _AVATAR_COLORES = ['#00AE70', '#fd7e14', '#6f42c1', '#17a2b8', '#e83e8c', '#007bff', '#20c997', '#dc3545'];

function inicialesDe(nombre) {
  const partes = (nombre || '?').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '?';
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[1][0]).toUpperCase();
}

function colorDe(nombre) {
  const str = nombre || '';
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return _AVATAR_COLORES[hash % _AVATAR_COLORES.length];
}

// v461: si el producto tiene foto real (foto_url, agregado a
// fn_stock_lista_agrupada) la muestra en vez de las iniciales — mismo
// patrón que renderAvatarFoto en productos.js. Si falla la carga de la
// imagen (URL rota, bucket borrado), cae de nuevo a las iniciales via
// onerror. Click para hacer zoom a la imagen en grande, vía abrirZoomFoto().
function renderAvatarFoto(fotoUrl, nombre, avatarBg, iniciales) {
  if (!fotoUrl) {
    return `<span class="prod-avatar" style="background:${avatarBg}">${escHtml(iniciales)}</span>`;
  }
  const iniEsc = escHtml(iniciales);
  const urlEsc = escHtml(fotoUrl);
  return `
    <span class="prod-avatar-wrap">
      <img class="prod-avatar prod-avatar--foto" src="${urlEsc}" alt="Foto de ${escHtml(nombre)}"
           loading="lazy" tabindex="0" role="button"
           title="Ver imagen en grande"
           aria-label="Ver imagen en grande de ${escHtml(nombre)}"
           onclick="event.stopPropagation(); abrirZoomFoto('${urlEsc}')"
           onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();abrirZoomFoto('${urlEsc}');}"
           onerror="this.outerHTML='<span class=&quot;prod-avatar&quot; style=&quot;background:${avatarBg}&quot;>${iniEsc}</span>'">
    </span>`;
}

// v461: lightbox simple para ver en grande la foto de un producto — mismo
// componente que usa Productos.html (ver productos.js / productos.html).
function abrirZoomFoto(url) {
  if (!url) return;
  const backdrop = document.getElementById('foto-zoom-backdrop');
  const modal    = document.getElementById('foto-zoom-modal');
  const img      = document.getElementById('foto-zoom-img');
  if (!backdrop || !modal || !img) return;
  img.src = url;
  backdrop.classList.add('activo');
  modal.classList.add('activo');
  document.addEventListener('keydown', _escCerrarZoomFoto);
}

function cerrarZoomFoto() {
  const backdrop = document.getElementById('foto-zoom-backdrop');
  const modal    = document.getElementById('foto-zoom-modal');
  const img      = document.getElementById('foto-zoom-img');
  if (backdrop) backdrop.classList.remove('activo');
  if (modal) modal.classList.remove('activo');
  if (img) img.src = '';
  document.removeEventListener('keydown', _escCerrarZoomFoto);
}

function _escCerrarZoomFoto(ev) {
  if (ev.key === 'Escape') cerrarZoomFoto();
}

// stock.js es un módulo (type="module"): sus funciones no son globales por
// default, pero el HTML del modal usa onclick="cerrarZoomFoto()" y el
// onclick/onerror inline generado arriba usa abrirZoomFoto(...) — hay que
// colgarlas explícitamente de window para que esos atributos las encuentren.
window.abrirZoomFoto = abrirZoomFoto;
window.cerrarZoomFoto = cerrarZoomFoto;

// Devuelve un depósito de arranque razonable para el modal de ajuste cuando
// la fila es agrupada (varios depósitos) y no hay uno puntual ya resuelto:
// el principal si existe, si no el primero de la lista. El selector del modal
// igual permite cambiarlo antes de guardar.
function depositoPorDefecto() {
  const principal = depositos.find(d => d.es_principal);
  return (principal || depositos[0])?.id || '';
}

// ── Render ─────────────────────────────────────────────────────────────────
// Cada fila de `rows` viene de fn_stock_lista_agrupada: 1 fila por producto,
// con cantidades ya sumadas entre depósitos. n_depositos > 1 indica que el
// producto tiene stock repartido en más de un depósito — en ese caso se
// muestra un botón para expandir el detalle (fn_stock_depositos_producto) en
// vez de repetir una fila por depósito.
function renderTabla(rows) {
  const tbody = document.getElementById('tabla-body');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="tabla-empty">No se encontraron productos con esos filtros. Probá con otro nombre, código o depósito.</td></tr>';
    return;
  }

  const frag = document.createDocumentFragment();
  const tmp  = document.createElement('template');

  rows.forEach(s => {
    const disponible = disp(s);
    const est        = estadoStock(disponible);
    const esInactivo = s.activo === false;
    const nombre     = s.nombre || '—';
    const codigo     = s.codigo
      ? `<span class="cod-producto">${escHtml(s.codigo)}</span>` : '';
    const cat     = s.categoria_nombre || '—';
    const unidad  = s.unidad || 'u';
    const prodId  = s.producto_id;
    const nDep    = Number(s.n_depositos) || 0;
    const agrupada = nDep > 1;
    const depIdAccion = s.deposito_id || (agrupada ? depositoPorDefecto() : '');

    const iniciales = inicialesDe(nombre);
    const avatarBg  = colorDe(nombre);
    const avatarHtml = renderAvatarFoto(s.foto_url, nombre, avatarBg, iniciales);

    const celdaDeposito = agrupada
      ? `<button type="button" class="btn-expandir-dep" data-prod-id="${prodId}"
           data-nombre="${escHtml(nombre)}" data-unidad="${escHtml(unidad)}" aria-expanded="false">
           <svg class="icon-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
           ${nDep} depósitos
         </button>`
      : escHtml(s.deposito_nombre || '—');

    tmp.innerHTML = `
      <tr class="fila-stock" data-prod-id="${prodId}" data-dep-id="${s.deposito_id || ''}">
        <td class="td-producto" data-label="Producto">
          <div class="prod-row">
            ${avatarHtml}
            <div class="prod-info">
              <div class="prod-nombre">${escHtml(nombre)}${esInactivo ? ' <span class="tag-producto-inactivo" title="Producto desactivado con stock pendiente de reconciliar">Producto inactivo</span>' : ''}</div>${codigo}
            </div>
          </div>
        </td>
        <td class="td-text" data-label="Categoría">${escHtml(cat)}</td>
        <td class="td-text td-deposito" data-label="Depósito">${celdaDeposito}</td>
        <td class="td-num ${est.cls}" data-label="Disponible">${fmt(disponible)} <span class="unidad">${escHtml(unidad)}</span></td>
        <td class="td-num td-muted" data-label="Reservado">${fmt(s.cantidad_reservada)} <span class="unidad">${escHtml(unidad)}</span></td>
        <td class="td-num" data-label="Total">${fmt(s.cantidad)} <span class="unidad">${escHtml(unidad)}</span></td>
        <td class="td-num td-muted" data-label="Costo prom.">${window.formatARS(s.costo_promedio)}</td>
        <td data-label="Estado">
          ${esInactivo
            ? `<span class="badge-estado badge-inactivo" title="Producto inactivo — todavía tiene stock sin reconciliar">
                 <span class="badge-dot"></span>Inactivo · ${est.label}
               </span>`
            : `<span class="badge-estado badge-${est.key}">
                 <span class="badge-dot"></span>${est.label}
               </span>`}
        </td>
        <td class="td-acciones" data-label="Acciones">
          <button class="btn-ajustar btn-fila-accion"
            data-prod-id="${prodId}" data-dep-id="${depIdAccion}" data-disp="${disponible}"
            data-total="${Number(s.cantidad)||0}" data-reservado="${Number(s.cantidad_reservada)||0}"
            data-nombre="${escHtml(nombre)}" data-unidad="${escHtml(unidad)}" data-costo="${Number(s.costo_promedio||0)}"
            data-codigo="${escHtml(s.codigo || '')}">
            Ajustar stock
          </button>
        </td>
      </tr>${agrupada ? `
      <tr class="fila-stock-detalle" data-detalle-de="${prodId}" hidden>
        <td colspan="9" class="td-detalle-depositos"></td>
      </tr>` : ''}`.trim();
    frag.appendChild(tmp.content.cloneNode(true));
  });

  tbody.innerHTML = '';
  tbody.appendChild(frag);
}

// Cache en memoria del detalle por depósito de cada producto ya expandido en
// esta carga de página, para no repetir la RPC si el usuario colapsa y vuelve
// a abrir la misma fila.
const _cacheDetalleDep = new Map();

async function toggleDetalleDepositos(btn) {
  const prodId = btn.dataset.prodId;
  const fila = document.querySelector(`.fila-stock-detalle[data-detalle-de="${prodId}"]`);
  if (!fila) return;

  const abierta = !fila.hidden;
  if (abierta) {
    fila.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    btn.classList.remove('expandido');
    return;
  }

  fila.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('expandido');

  const celda = fila.querySelector('.td-detalle-depositos');

  if (_cacheDetalleDep.has(prodId)) {
    celda.innerHTML = _cacheDetalleDep.get(prodId);
    return;
  }

  celda.innerHTML = '<div class="detalle-depositos-loading"><span class="loading-spinner"></span> Cargando depósitos…</div>';

  try {
    const { data, error } = await window.conTimeoutRed(sb.rpc('fn_stock_depositos_producto', { p_producto_id: prodId }), 10000);
    if (error) throw error;
    const html = renderDetalleDepositos(prodId, btn.dataset.nombre, btn.dataset.unidad, data || []);
    _cacheDetalleDep.set(prodId, html);
    celda.innerHTML = html;
  } catch (err) {
    console.error('[stock] fn_stock_depositos_producto:', err);
    celda.innerHTML = '<div class="empty-row">No se pudo cargar el detalle por depósito. <button class="btn-link" data-reintentar-prod="' + prodId + '">Reintentar</button></div>';
  }
}

function renderDetalleDepositos(prodId, nombre, unidad, filas) {
  if (!filas.length) return '<div class="empty-row">Sin stock registrado en depósitos.</div>';

  const filasHtml = filas.map(d => {
    const disponible = Number(d.cantidad_disponible) || 0;
    const est = estadoStock(disponible);
    return `
      <div class="detalle-dep-fila">
        <span class="detalle-dep-nombre">${escHtml(d.deposito_nombre || '—')}${d.es_principal ? ' <span class="tag-principal">principal</span>' : ''}</span>
        <span class="td-num ${est.cls}" data-label="Disponible">${fmt(disponible)} <span class="unidad">${escHtml(unidad)}</span></span>
        <span class="td-num td-muted" data-label="Reservado">${fmt(d.cantidad_reservada)} <span class="unidad">${escHtml(unidad)}</span></span>
        <span class="td-num" data-label="Total">${fmt(d.cantidad)} <span class="unidad">${escHtml(unidad)}</span></span>
        <span class="td-num td-muted" data-label="Costo prom.">${window.formatARS(d.costo_promedio)}</span>
        <button type="button" class="btn-ajustar-mini btn-fila-accion"
          data-prod-id="${prodId}" data-dep-id="${d.deposito_id}" data-disp="${disponible}"
          data-total="${Number(d.cantidad)||0}" data-reservado="${Number(d.cantidad_reservada)||0}"
          data-nombre="${escHtml(nombre)}" data-unidad="${escHtml(unidad)}" data-costo="${Number(d.costo_promedio)||0}">
          Ajustar
        </button>
      </div>`;
  }).join('');

  return `<div class="detalle-depositos-grid">${filasHtml}</div>`;
}

// Delegación de eventos para las acciones de fila (evita construir onclick=""
// con texto libre de la base de datos interpolado en un atributo HTML, que
// era vulnerable a XSS almacenado si un nombre de producto contenía comillas).
// El botón "Ajustar" de una fila de detalle expandida (.btn-ajustar-mini)
// también tiene la clase .btn-fila-accion, así que reutiliza este mismo
// listener sin necesitar delegación aparte.
document.getElementById('tabla-body')?.addEventListener('click', (ev) => {
  const expandBtn = ev.target.closest('.btn-expandir-dep');
  if (expandBtn) { toggleDetalleDepositos(expandBtn); return; }

  const reintentar = ev.target.closest('[data-reintentar-prod]');
  if (reintentar) {
    const prodId = reintentar.dataset.reintentarProd;
    const expandido = document.querySelector(`.btn-expandir-dep[data-prod-id="${prodId}"]`);
    if (expandido) { expandido.setAttribute('aria-expanded', 'false'); toggleDetalleDepositos(expandido); }
    return;
  }

  const btn = ev.target.closest('.btn-fila-accion');
  if (!btn) return;
  abrirModal(
    btn.dataset.prodId,
    btn.dataset.depId,
    Number(btn.dataset.disp),
    btn.dataset.nombre,
    btn.dataset.unidad,
    Number(btn.dataset.costo),
    Number(btn.dataset.total),
    Number(btn.dataset.reservado)
  );
});

// ── Buscador de producto para transferencia (topbar → modal ajuste) ────────
let _mbtTimer      = null;
let _mbtAC         = null;
let _mbtResultados = [];

function abrirBuscadorTransferencia() {
  const box = document.getElementById('mbt-box');
  const bg  = document.getElementById('mbt-backdrop');
  const input = document.getElementById('mbt-input');
  const results = document.getElementById('mbt-resultados');

  input.value = '';
  results.innerHTML = '<div class="mbt-hint">Escribí para buscar un producto…</div>';

  bg.classList.add('open');
  box.classList.add('open');
  document.body.style.overflow = 'hidden';

  input.removeEventListener('input', _onMbtInput);
  input.addEventListener('input', _onMbtInput);

  setTimeout(() => input.focus(), 50);
}

function cerrarBuscadorTransferencia() {
  document.getElementById('mbt-backdrop').classList.remove('open');
  document.getElementById('mbt-box').classList.remove('open');
  document.body.style.overflow = '';
  if (_mbtAC) { _mbtAC.abort(); _mbtAC = null; }
  if (_mbtTimer) clearTimeout(_mbtTimer);
}

function _onMbtInput(e) {
  const q = e.target.value.trim();
  if (_mbtTimer) clearTimeout(_mbtTimer);
  if (!q) {
    document.getElementById('mbt-resultados').innerHTML = '<div class="mbt-hint">Escribí para buscar un producto…</div>';
    return;
  }
  _mbtTimer = setTimeout(() => buscarProductoTransferencia(q), 220);
}

async function buscarProductoTransferencia(q) {
  const results = document.getElementById('mbt-resultados');
  results.innerHTML = '<div class="mbt-loading"><span class="loading-spinner"></span> Buscando…</div>';

  if (_mbtAC) _mbtAC.abort();
  _mbtAC = createAC();

  try {
    const { data, error } = await window.conTimeoutRed(sb
      .from('stock')
      .select(`
        producto_id,
        deposito_id,
        cantidad,
        cantidad_reservada,
        cantidad_disponible,
        costo_promedio,
        productos!inner(id, codigo, nombre, unidad, activo),
        depositos(id, nombre, es_principal)
      `)
      .eq('productos.activo', true)
      .or(`nombre.ilike.%${q}%,codigo.ilike.%${q}%`, { foreignTable: 'productos' })
      .order('cantidad_disponible', { ascending: false })
      .limit(25)
      .abortSignal(_mbtAC.signal), 10000);

    if (error) throw error;

    if (!data || !data.length) {
      results.innerHTML = '<div class="mbt-empty">No se encontraron productos con stock para transferir.</div>';
      return;
    }

    _mbtResultados = data;

    results.innerHTML = data.map((row, idx) => {
      const p = row.productos;
      const d = row.depositos;
      const depNombre = (d?.nombre || 'Depósito') + (d?.es_principal ? ' (principal)' : '');
      return `
        <div class="mbt-item" data-idx="${idx}">
          <div>
            <div class="mbt-item-nombre">${escHtml(p.nombre)}</div>
            <div class="mbt-item-codigo">${escHtml(p.codigo || '')}</div>
          </div>
          <div class="mbt-item-stock">
            ${escHtml(depNombre)}<br>${fmt(row.cantidad_disponible)} ${escHtml(p.unidad || '')}
          </div>
        </div>`;
    }).join('');

    results.querySelectorAll('.mbt-item').forEach(el => {
      el.addEventListener('click', () => seleccionarProductoTransferencia(Number(el.dataset.idx)));
    });
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.error('Error buscando producto para transferencia:', err);
    results.innerHTML = '<div class="mbt-empty">No pudimos completar la búsqueda. Probá de nuevo.</div>';
  }
}

async function seleccionarProductoTransferencia(idx) {
  const row = _mbtResultados[idx];
  if (!row) return;
  const p = row.productos;
  cerrarBuscadorTransferencia();
  await abrirModal(row.producto_id, row.deposito_id, Number(row.cantidad_disponible) || 0, p.nombre, p.unidad || 'un', Number(row.costo_promedio) || 0, Number(row.cantidad) || 0, Number(row.cantidad_reservada) || 0);
  selTipo('transferencia', document.querySelector('.tipo-btn[data-tipo="transferencia"]'));
}
// ── Modal ajuste ───────────────────────────────────────────────────────────
async function abrirModal(productoId, depositoId, stockDisp, nombre, unidad, costoPromedio, stockTotal, stockReservado) {
  modalProductoId    = productoId;
  modalDepositoId    = depositoId;
  modalStockActual   = stockDisp;
  // Fallback por si algún call site viejo no pasa total/reservado todavía:
  // asumimos reservado 0 y total = disponible (peor caso: se comporta como antes).
  modalStockReservado = Number.isFinite(stockReservado) ? stockReservado : 0;
  modalStockTotal      = Number.isFinite(stockTotal) ? stockTotal : (stockDisp + modalStockReservado);
  modalNombre = nombre;
  modalUnidad = unidad;

  document.getElementById('modal-titulo').textContent    = 'Ajustar stock';
  document.getElementById('modal-subtitulo').textContent = nombre;
  document.getElementById('stock-actual-box').innerHTML  = `
    <div class="sa-item">
      <span class="sa-label">Disponible ahora</span>
      <span class="sa-val ${estadoStock(stockDisp).cls}">${fmt(stockDisp)} ${escHtml(unidad)}</span>
    </div>
    <div class="sa-item">
      <span class="sa-label">Reservado</span>
      <span class="sa-val sa-muted">${fmt(modalStockReservado)} ${escHtml(unidad)}</span>
    </div>
    <div class="sa-item">
      <span class="sa-label">Total físico</span>
      <span class="sa-val">${fmt(modalStockTotal)} ${escHtml(unidad)}</span>
    </div>
    ${costoPromedio > 0 ? `
    <div class="sa-item">
      <span class="sa-label">Costo promedio</span>
      <span class="sa-val sa-costo">${window.formatARS(costoPromedio)}</span>
    </div>` : ''}`;

  const selDep  = document.getElementById('select-deposito');
  const selDest = document.getElementById('select-deposito-destino');
  selDep.innerHTML = '';
  selDest.innerHTML = '';
  depositos.forEach(d => {
    [selDep, selDest].forEach(sel => {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.nombre + (d.es_principal ? ' (principal)' : '');
      if (d.id === depositoId) o.selected = true;
      sel.appendChild(o);
    });
  });

  selTipo('ingreso', document.querySelector('.tipo-btn[data-tipo="ingreso"]'));
  document.getElementById('input-cantidad').value  = '';
  document.getElementById('select-motivo').value   = '';
  document.getElementById('input-notas').value     = '';
  document.getElementById('preview-resultado').style.display = 'none';

  document.getElementById('modal-backdrop').style.display = 'block';
  document.getElementById('modal-ajuste').classList.add('open');
  document.body.style.overflow = 'hidden';

  if (_modalAC) _modalAC.abort();
  _modalAC = createAC();
  const sig = _modalAC.signal;
  document.getElementById('input-cantidad').addEventListener('input', actualizarPreview, { signal: sig });
  document.getElementById('input-stock-nuevo').addEventListener('input', actualizarPreview, { signal: sig });
  document.getElementById('select-motivo').addEventListener('change', actualizarAvisoMotivo, { signal: sig });
  actualizarAvisoMotivo();

  cargarHistorial(productoId);
}

function cerrarModal() {
  document.getElementById('modal-backdrop').style.display = 'none';
  document.getElementById('modal-ajuste').classList.remove('open');
  document.body.style.overflow = '';
  if (_modalAC) { _modalAC.abort(); _modalAC = null; }
}

// v343: el motivo tiene que ser coherente con el tipo de movimiento elegido
// (ej. no se puede registrar un "Ingreso" con motivo "Merma / vencimiento",
// que es un egreso) — antes el <select> mostraba las 4 categorías siempre,
// sin importar el tipo activo, y solo se validaba que hubiera ALGÚN motivo
// elegido. Este mapa es la única fuente de verdad para filtrar el <select>
// y para la validación defensiva en guardarAjuste().
const MOTIVOS_POR_TIPO = {
  ingreso:       ['compra', 'devolucion_cliente', 'produccion'],
  egreso:        ['venta_manual', 'merma', 'rotura', 'muestra'],
  ajuste:        ['inventario', 'conteo_fisico'],
  transferencia: ['entre_depositos'],
};

// Oculta del <select id="select-motivo"> las opciones que no correspondan
// al tipo de movimiento activo (y su <optgroup>, si queda sin opciones
// visibles), para que sea imposible elegir un motivo de otra categoría.
function filtrarMotivosPorTipo(tipo) {
  const permitidos = MOTIVOS_POR_TIPO[tipo] || [];
  document.querySelectorAll('#select-motivo option[data-tipo]').forEach(opt => {
    opt.hidden = !permitidos.includes(opt.value);
  });
  document.querySelectorAll('#select-motivo optgroup').forEach(og => {
    og.hidden = ![...og.children].some(opt => !opt.hidden);
  });
}

function selTipo(tipo, btn) {
  tipoActivo = tipo;
  document.querySelectorAll('.tipo-btn').forEach(b => b.classList.remove('activo'));
  btn.classList.add('activo');
  document.getElementById('deposito-destino-wrap').style.display = tipo === 'transferencia' ? 'block' : 'none';
  document.getElementById('stock-nuevo-wrap').style.display      = tipo === 'ajuste' ? 'block' : 'none';
  document.getElementById('deposito-origen-wrap').style.display  = tipo === 'ajuste' ? 'none' : 'flex';
  const labels = { ingreso:'Cantidad a ingresar', egreso:'Cantidad a egresar', transferencia:'Cantidad a transferir' };
  document.getElementById('label-cantidad').textContent = labels[tipo] || 'Cantidad';
  filtrarMotivosPorTipo(tipo);
  document.getElementById('select-motivo').value = '';
  actualizarAvisoMotivo();
  actualizarPreview();
}

// v341: "Compra a proveedor" y "Venta manual" ya tienen un flujo dedicado que
// resuelve costo/lote/proveedor (recepción de OC) o cliente/cobro (POS) —
// usar el ajuste manual para esos casos deja el circuito contable/operativo
// incompleto. "Compra a proveedor" se bloquea (no hay forma correcta de
// vincular lote/proveedor/costo desde este modal); "Venta manual" se deja
// disponible pero renombrado para el caso legítimo de egreso sin factura,
// con un aviso para redirigir al POS cuando hay cliente y cobro de por medio.
function actualizarAvisoMotivo() {
  const motivo = document.getElementById('select-motivo').value;
  const aviso  = document.getElementById('motivo-redirect-aviso');
  const btn    = document.getElementById('btn-guardar');

  const avisos = {
    compra: {
      clase: 'aviso--bloqueante',
      html: 'La compra a proveedor se registra <strong>recepcionando la Orden de Compra</strong> — así queda vinculada a lote, costo y proveedor. <a href="/admin/compras" target="_blank" rel="noopener">Ir a Compras →</a>',
      bloquea: true,
    },
    devolucion_cliente: {
      clase: 'aviso--bloqueante',
      html: 'La devolución de un cliente se registra desde <strong>Devoluciones</strong> — así queda vinculada al cliente/pedido, y desde ahí podés generar la nota de crédito y reponer el stock con trazabilidad. <a href="/admin/devoluciones" target="_blank" rel="noopener">Ir a Devoluciones →</a>',
      bloquea: true,
    },
    venta_manual: {
      clase: 'aviso--info',
      html: '¿Es una venta con cliente y cobro? Usá el <a href="/admin/pos" target="_blank" rel="noopener">POS →</a>. Este motivo es solo para salidas por venta ya cobrada que no se facturó en el momento.',
      bloquea: false,
    },
  };

  const cfg = avisos[motivo];
  if (!cfg) {
    aviso.style.display = 'none';
    aviso.className = 'motivo-redirect-aviso';
    aviso.innerHTML = ''; // evita que quede texto viejo visible si algún estilo fuerza el display
    btn.disabled = false;
    return;
  }
  aviso.style.display = 'flex';
  aviso.className = `motivo-redirect-aviso ${cfg.clase}`;
  aviso.innerHTML = cfg.html;
  btn.disabled = !!cfg.bloquea;
}

function actualizarPreview() {
  const prev = document.getElementById('preview-resultado');
  const body = document.getElementById('preview-body');
  const cant = parseInt(
    tipoActivo === 'ajuste'
      ? document.getElementById('input-stock-nuevo').value
      : document.getElementById('input-cantidad').value,
    10
  );
  if (isNaN(cant)) { prev.style.display = 'none'; return; }

  // Para ajuste directo comparamos total-contra-total (es un conteo físico),
  // no disponible-contra-total como antes. Para ingreso/egreso seguimos
  // comparando disponible-contra-disponible, que es correcto porque esos
  // deltas se aplican de forma aditiva.
  let antes = modalStockActual;
  let nuevo = modalStockActual;
  if (tipoActivo === 'ingreso')          nuevo = modalStockActual + cant;
  else if (tipoActivo === 'egreso')      nuevo = modalStockActual - cant;
  else if (tipoActivo === 'transferencia') nuevo = modalStockActual - cant;
  else if (tipoActivo === 'ajuste') {
    antes = modalStockTotal;
    nuevo = cant;
  }

  // El estado (badge de bajo/crítico) siempre se calcula sobre el disponible
  // resultante, sea cual sea el tipo, porque es lo que le importa a la
  // operación (cuánto queda para vender/despachar).
  const dispResultante = tipoActivo === 'ajuste'
    ? Math.max(0, cant - modalStockReservado)
    : nuevo;
  const est = estadoStock(dispResultante);

  prev.style.display = 'block';
  body.innerHTML = `
    <span class="prev-antes">${fmt(antes)}</span>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
    <span class="prev-despues ${est.cls}">${fmt(nuevo)}</span>
    <span class="prev-estado badge-${est.key}">${est.label}</span>`;
}

// Después de un ajuste, la lista se recarga con los mismos filtros/página.
// Si la fila sigue cumpliendo esos filtros, la resaltamos y hacemos scroll
// hacia ella para que el usuario vea el impacto sin tener que buscarla a
// mano. Devuelve true si la encontró.
function resaltarFilaActualizada(prodId, depId) {
  // Si la fila es agrupada (varios depósitos), data-dep-id queda vacío en el
  // DOM aunque el ajuste se haya hecho en un depósito puntual — en ese caso
  // alcanza con encontrar la fila del producto.
  const fila = document.querySelector(`.fila-stock[data-prod-id="${prodId}"][data-dep-id="${depId}"]`)
    || document.querySelector(`.fila-stock[data-prod-id="${prodId}"]`);
  if (!fila) return false;
  fila.classList.remove('fila-stock--actualizada');
  void fila.offsetWidth; // fuerza reflow para poder re-disparar la animación
  fila.classList.add('fila-stock--actualizada');
  fila.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}

function nombreDeposito(depId) {
  return depositos.find(d => d.id === depId)?.nombre || 'depósito';
}

async function guardarAjuste() {
  const motivo    = document.getElementById('select-motivo').value;
  const notas     = document.getElementById('input-notas').value.trim();
  const depOrigen = document.getElementById('select-deposito').value;
  const depDest   = document.getElementById('select-deposito-destino').value;

  if (!motivo) { toast('Seleccioná un motivo'); return; }
  if (motivo === 'compra') { toast('Para compra a proveedor, recepcioná la Orden de Compra desde Compras'); return; }
  if (motivo === 'devolucion_cliente') { toast('Para devolución de cliente, registrala desde Devoluciones'); return; }
  // Defensivo: el <select> ya filtra por tipoActivo (ver filtrarMotivosPorTipo),
  // pero se valida de nuevo acá para no depender únicamente de que el DOM
  // haya quedado sincronizado (ej. value seteado por código externo).
  if (!(MOTIVOS_POR_TIPO[tipoActivo] || []).includes(motivo)) {
    toast('Ese motivo no corresponde al tipo de movimiento elegido'); return;
  }

  let cantidad;
  if (tipoActivo === 'ajuste') {
    // Bug corregido: "Stock total resultante" es un conteo físico (total),
    // no el disponible. El delta debe calcularse contra modalStockTotal
    // (cantidad), no contra modalStockActual (cantidad_disponible) — de lo
    // contrario cada ajuste con reservas activas infla el total en el
    // excedente reservado (total_después = conteo + reservado_antes).
    const valorNuevo = document.getElementById('input-stock-nuevo').value;
    const nuevo = parseInt(valorNuevo, 10);
    if (isNaN(nuevo) || nuevo < 0 || Number(valorNuevo) !== nuevo) { toast('Ingresá un stock resultante entero'); return; }
    cantidad = nuevo - modalStockTotal;
  } else {
    const valorCant = document.getElementById('input-cantidad').value;
    cantidad = parseInt(valorCant, 10);
    if (isNaN(cantidad) || cantidad <= 0 || Number(valorCant) !== cantidad) { toast('Ingresá una cantidad entera válida'); return; }
    if ((tipoActivo === 'egreso' || tipoActivo === 'transferencia') && cantidad > modalStockActual) {
      toast(tipoActivo === 'egreso' ? 'No hay suficiente stock disponible' : 'No hay suficiente stock disponible para transferir'); return;
    }
  }

  const okAjuste = await window.confirmar(
    `¿Confirmás este movimiento de stock (${tipoActivo}, cantidad ${Math.abs(cantidad)})?`,
    { labelOk: 'Confirmar', labelCancel: 'Revisar' }
  );
  if (!okAjuste) return;

  const btn = document.getElementById('btn-guardar');
  btn.disabled = true;
  btn.textContent = 'Guardando...';

  let resultadoGuardado = null;

  try {
    // v201: la RPC ahora es la única que escribe en movimientos_stock (con el
    // delta REALMENTE aplicado) y rechaza (ok:false) si el resultado dejaría
    // el stock en negativo, en vez de clampear. El cliente ya no inserta
    // directo en la tabla.
    if (tipoActivo === 'transferencia') {
      if (depOrigen === depDest) { toast('El depósito de origen y destino no pueden ser el mismo'); return; }

      // v342: una única función SQL transaccional (débito + crédito en la
      // misma transacción de Postgres) reemplaza el patrón anterior de dos
      // llamadas RPC a ajustar_stock con reversión manual del lado cliente.
      // La atomicidad la garantiza la base — ya no existe una ventana donde
      // el stock pueda quedar débitado de origen sin acreditar en destino.
      const payloadRpcTransferencia = {
        p_producto_id: modalProductoId,
        p_deposito_origen: depOrigen,
        p_deposito_destino: depDest,
        p_cantidad: Math.abs(cantidad),
        p_motivo: motivo, p_notas: notas || null,
      };
      const { data, error } = await window.conTimeoutRed(sb.rpc('transferir_stock', payloadRpcTransferencia), 10000);
      if (error) {
        // Plan offline — Etapa 3, ítem 5: mismo criterio que ajuste/conteo —
        // encolar en vez de perder la transferencia si fue un corte de red,
        // no un error de negocio (stock insuficiente, etc.).
        if (esErrorDeRed(error) && window.StockOffline) {
          await window.StockOffline.encolarAccion('transferir_stock', payloadRpcTransferencia);
          cerrarModal();
          toast(`Sin conexión: guardamos la transferencia de ${modalNombre} en el dispositivo. Se va a enviar sola cuando vuelva internet.`, 'warning', 6000);
          return;
        }
        throw error;
      }
      if (!data?.ok) { toast(data?.error || 'No se pudo transferir'); return; }

      resultadoGuardado = {
        mensaje: `${modalNombre}: transferido ${fmt(Math.abs(cantidad))} ${modalUnidad}. ` +
          `${nombreDeposito(depOrigen)} → ${fmt(data.stock_origen_nuevo)} ${modalUnidad} · ` +
          `${nombreDeposito(depDest)} → ${fmt(data.stock_destino_nuevo)} ${modalUnidad}`,
        filas: [[modalProductoId, depOrigen], [modalProductoId, depDest]],
      };

    } else if (tipoActivo === 'ajuste') {
      // v344: el ajuste directo ("Corrección de inventario" / "Conteo
      // físico") ya no pasa por ajustar_stock con un delta calculado a
      // mano en el cliente — deja además un snapshot histórico
      // (sistema vs. contado) en conteos_stock, que es lo que permite
      // auditar recuentos periódicos más adelante.
      const nuevo = modalStockTotal + cantidad; // cantidad = nuevo - modalStockTotal, con signo
      const payloadRpcConteo = {
        p_producto_id: modalProductoId, p_deposito_id: depOrigen,
        p_cantidad_contada: nuevo,
        p_motivo: motivo, p_notas: notas || null,
        // Plan offline, Etapa 4: snapshot del stock que el usuario vio al
        // armar el conteo. Si esto se termina sincronizando desde el outbox
        // (quedó offline), el servidor lo compara contra el stock real en
        // ese momento — si alguien más lo movió mientras tanto, rechaza con
        // tipo:'conflicto_stock_cambio' en vez de pisar un conteo que ya no
        // tiene sentido. En el camino online normal (sin pasar por el
        // outbox) este chequeo es redundante pero inofensivo: se manda y se
        // vuelve a comparar contra el mismo stock que se acaba de leer.
        p_stock_sistema_esperado: modalStockTotal,
      };
      const { data, error } = await window.conTimeoutRed(sb.rpc('registrar_conteo_stock', payloadRpcConteo), 10000);
      if (error) {
        // Plan offline — Etapa 3, ítem 2: si la RPC no llegó a responder por
        // falta de red, encolamos el conteo en vez de perderlo — se envía
        // solo apenas vuelve la señal (idempotente por offline_local_id,
        // migración 443).
        if (esErrorDeRed(error) && window.StockOffline) {
          await window.StockOffline.encolarAccion('registrar_conteo_stock', payloadRpcConteo);
          cerrarModal();
          toast(`Sin conexión: guardamos el conteo de ${modalNombre} en el dispositivo. Se va a enviar solo cuando vuelva internet.`, 'warning', 6000);
          return;
        }
        throw error;
      }
      if (!data?.ok) { toast(data?.error || 'No se pudo registrar el conteo'); return; }

      resultadoGuardado = {
        mensaje: `${modalNombre} (${nombreDeposito(depOrigen)}): ${fmt(modalStockTotal)} → ${fmt(data.stock_nuevo)} ${modalUnidad}` +
          (data.diferencia != 0 ? ` (diferencia ${data.diferencia > 0 ? '+' : ''}${fmt(data.diferencia)})` : ''),
        filas: [[modalProductoId, depOrigen]],
      };

    } else if (tipoActivo === 'ingreso' && motivo === 'produccion') {
      // v343: "Producción propia" descuenta automáticamente los insumos de
      // la receta (BOM, tabla producto_insumos) en la misma transacción que
      // el ingreso del producto terminado. Si el producto no tiene receta
      // cargada, produce igual (no bloquea a quien todavía no cargó el BOM).
      const { data, error } = await window.conTimeoutRed(sb.rpc('producir_con_insumos', {
        p_producto_id: modalProductoId, p_deposito_id: depOrigen,
        p_cantidad: Math.abs(cantidad),
        p_motivo: motivo, p_notas: notas || null,
      }), 10000);
      if (error) throw error;
      if (!data?.ok) { toast(data?.error || 'No se pudo registrar la producción'); return; }

      const avisoReceta = data.tiene_receta
        ? ` · ${data.insumos_consumidos?.length || 0} insumo(s) descontado(s) según receta`
        : ' · sin receta cargada, no se descontó ningún insumo';
      resultadoGuardado = {
        mensaje: `${modalNombre} (${nombreDeposito(depOrigen)}): ${fmt(modalStockTotal)} → ${fmt(data.stock_nuevo)} ${modalUnidad}${avisoReceta}`,
        filas: [[modalProductoId, depOrigen]],
      };

    } else {
      const delta = tipoActivo === 'egreso' ? -Math.abs(cantidad) : Math.abs(cantidad);
      const payloadRpcAjuste = {
        p_producto_id: modalProductoId, p_deposito_id: depOrigen,
        p_delta: delta, p_tipo: tipoActivo,
        p_motivo: motivo, p_notas: notas || null,
      };
      const { data, error } = await window.conTimeoutRed(sb.rpc('ajustar_stock', payloadRpcAjuste), 10000);
      if (error) {
        // Plan offline — Etapa 3, ítem 2: mismo criterio que el conteo de
        // arriba — encolar en vez de perder el ingreso/egreso si fue un
        // corte de red, no un error de negocio.
        if (esErrorDeRed(error) && window.StockOffline) {
          await window.StockOffline.encolarAccion('ajustar_stock', payloadRpcAjuste);
          cerrarModal();
          toast(`Sin conexión: guardamos el movimiento de ${modalNombre} en el dispositivo. Se va a enviar solo cuando vuelva internet.`, 'warning', 6000);
          return;
        }
        throw error;
      }
      if (!data?.ok) { toast(data?.error || 'No se pudo registrar el movimiento'); return; }

      resultadoGuardado = {
        mensaje: `${modalNombre} (${nombreDeposito(depOrigen)}): ${fmt(modalStockTotal)} → ${fmt(data.stock_nuevo)} ${modalUnidad}`,
        filas: [[modalProductoId, depOrigen]],
      };
    }

    cerrarModal();
    await cargarStock(); // Refrescar página actual

    // El movimiento recién guardado debe reflejarse en el panel de
    // "Productos modificados" sin esperar a un reload manual — antes
    // ese panel solo se cargaba una vez en init() y quedaba desactualizado
    // tras cada ingreso/egreso/ajuste/transferencia.
    cargarProductosModificados(_periodoModificados).catch(err => console.error('[stock] modificados:', err));

    // Si la fila quedó visible con los filtros/página actuales, la resaltamos
    // y hacemos scroll hasta ella. Si no (p.ej. dejó de cumplir el filtro de
    // estado activo, o cambió de página), el toast ya deja explícito el
    // cambio real para no obligar a buscarla a mano.
    const encontrada = (resultadoGuardado?.filas || []).some(([p, d]) => resaltarFilaActualizada(p, d));
    toast(
      resultadoGuardado.mensaje + (encontrada ? '' : ' (ya no aparece en esta vista por el filtro o la página actual)'),
      'success',
      encontrada ? 3500 : 6000
    );

  } catch (err) {
    console.error(err);
    toast('No se pudo guardar el movimiento. Probá de nuevo en unos segundos; si persiste, avisá a soporte.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Registrar movimiento';
  }
}

// ── Historial ──────────────────────────────────────────────────────────────
async function cargarHistorial(productoId) {
  const lista = document.getElementById('historial-lista');
  lista.innerHTML = '<div class="loading-row">Cargando...</div>';

  const { data } = await window.conTimeoutRed(sb.from('movimientos_stock')
    .select('tipo, cantidad, referencia, notas, created_at, usuarios(nombre), depositos(nombre)')
    .eq('producto_id', productoId)
    .order('created_at', { ascending: false })
    .limit(20), 10000);

  if (!data?.length) {
    lista.innerHTML = '<div class="empty-row">Sin movimientos registrados</div>';
    return;
  }

  const tipoLabel = { ingreso:'Ingreso', egreso:'Egreso', ajuste:'Ajuste', transferencia:'Transferencia', reserva:'Reserva', liberacion:'Liberación' };
  lista.innerHTML = data.map(m => {
    const signo  = m.cantidad >= 0 ? '+' : '';
    const cls    = m.cantidad >= 0 ? 'mov-positivo' : 'mov-negativo';
    const fecha  = new Date(m.created_at).toLocaleString('es-AR', { dateStyle:'short', timeStyle:'short' });
    const esTransferencia = m.tipo === 'transferencia';
    return `
      <div class="mov-row${esTransferencia ? ' mov-row--transferencia' : ''}">
        <div class="mov-left">
          <div class="mov-tipo">
            ${esTransferencia
              ? `<span class="mov-tipo-badge mov-tipo-transferencia">⇄ Transferencia</span>`
              : escHtml(tipoLabel[m.tipo] || m.tipo)
            }
          </div>
          <div class="mov-meta">${fecha} · ${escHtml(m.usuarios?.nombre || '—')} · ${escHtml(m.depositos?.nombre || '—')}</div>
          ${m.referencia ? `<div class="mov-ref">${escHtml(m.referencia)}${m.notas ? ' — ' + escHtml(m.notas) : ''}</div>` : ''}
        </div>
        <div class="mov-cant ${esTransferencia ? 'mov-transferencia-cant' : cls}">${signo}${fmt(m.cantidad)}</div>
      </div>`;
  }).join('');
}

// ── Exportar Excel ─────────────────────────────────────────────────────────
async function exportarExcel() {
  const btn = document.getElementById('btn-exportar-excel-stock');
  const btnHtmlOriginal = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = 'Generando…'; }
  toast('Preparando exportación…');
  try {
    const busq     = document.getElementById('input-busqueda').value.trim();
    const depFiltro = document.getElementById('filtro-deposito').value;
    const catFiltro = document.getElementById('filtro-categoria').value;
    const estadoBtn = document.querySelector('.e-pill.activa')?.dataset?.f || '';

    let q = sb
      .from('stock')
      .select(`
        producto_id, deposito_id, cantidad, cantidad_reservada, costo_promedio, cantidad_disponible,
        productos!inner(id, codigo, nombre, unidad, activo, categorias(nombre)),
        depositos(nombre)
      `)
      .eq('productos.activo', true)
      .order('productos(nombre)')
      .range(0, 1999);

    if (depFiltro)               q = q.eq('deposito_id', depFiltro);
    if (catFiltro)               q = q.eq('productos.categoria_id', catFiltro);
    if (estadoBtn === 'critico') q = q.lte('cantidad_disponible', UMBRAL_CRITICO);
    else if (estadoBtn === 'bajo') q = q.gt('cantidad_disponible', UMBRAL_CRITICO).lte('cantidad_disponible', UMBRAL_BAJO);
    else if (estadoBtn === 'ok')   q = q.gt('cantidad_disponible', UMBRAL_BAJO);
    else if (estadoBtn === 'bajo_minimo') {
      const ids = await obtenerIdsBajoMinimo();
      if (!ids.length) { toast('Ningún producto está por debajo de su stock mínimo.'); return; }
      q = q.in('producto_id', ids);
    }

    if (busq) {
      const { data: matchIds } = await window.conTimeoutRed(sb.from('productos').select('id')
        .eq('empresa_id', empresaData.id).eq('activo', true)
        .or(`nombre.ilike.%${busq}%,codigo.ilike.%${busq}%`), 10000);
      const ids = (matchIds || []).map(p => p.id);
      if (ids.length) q = q.in('producto_id', ids);
    }

    const { data } = await window.conTimeoutRed(q, 10000);
    const rows = (data || []).map(s => {
      const d = disp(s);
      return {
        'Código':         s.productos?.codigo || '',
        'Producto':       s.productos?.nombre || '',
        'Categoría':      s.productos?.categorias?.nombre || '',
        'Depósito':       s.depositos?.nombre || '',
        'Unidad':         s.productos?.unidad || '',
        'Total':          Number(s.cantidad),
        'Reservado':      Number(s.cantidad_reservada),
        'Disponible':     d,
        'Costo promedio': Number(s.costo_promedio),
        'Estado':         estadoStock(d).label,
      };
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Stock');
    ws['!cols'] = [8,30,18,16,8,10,10,10,14,12].map(w => ({ wch: w }));
    XLSX.writeFile(wb, `stock_${new Date().toISOString().slice(0,10)}.xlsx`);
    toast('Archivo descargado');
  } catch (err) {
    console.error(err);
    toast('No se pudo exportar. Probá de nuevo.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = btnHtmlOriginal; }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
function disp(s) {
  return s.cantidad_disponible != null
    ? Number(s.cantidad_disponible)
    : Math.max(0, Number(s.cantidad) - Number(s.cantidad_reservada));
}

function estadoStock(d) {
  if (d <= UMBRAL_CRITICO) return { key:'critico', label:'Sin stock', cls:'num-rojo' };
  if (d <= UMBRAL_BAJO)    return { key:'bajo',    label:'Stock bajo', cls:'num-amarillo' };
  return                          { key:'ok',      label:'Normal',    cls:'num-verde' };
}

function fmt(n) {
  const num = Number(n || 0);
  return num % 1 === 0
    ? num.toLocaleString('es-AR')
    : num.toLocaleString('es-AR', { maximumFractionDigits: 3 });
}

function escHtml(s) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(s);
}

async function cerrarSesion() {
  await sb.auth.signOut();
  window.location.href = '/admin/login';
}

// ── Stock Autónomo ─────────────────────────────────────────────────────────
let _proyeccionData   = [];
let _alertasStockAuto = [];

async function cargarAlertasStockAuto() {
  try {
    const token = window.authCtx?.session?.access_token || '';
    const resp  = await fetch('/api/stock-auto?accion=alertas', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!resp.ok) return;
    const { alertas } = await resp.json();
    _alertasStockAuto = alertas || [];
    renderAlertasStockAuto();
  } catch (err) {
    console.error('[Stock-Auto] alertas:', err);
  }
}

const STOCKAUTO_TIPOS = {
  quiebre:       { label: 'Quiebre',     max: 3  },
  critico:       { label: 'Crítico',     max: 15 },
  stock_bajo:    { label: 'Stock bajo',  max: 30 },
  // Producto necesita reponerse pero no tiene proveedor_id_default: el
  // motor automático no puede generarle una OC (no sabe a quién enviarla).
  // Requiere acción manual: asignar proveedor por defecto en la ficha del
  // producto. Sin esta entrada, caía en el fallback genérico (label = 'sin_proveedor').
  sin_proveedor: { label: 'Sin proveedor asignado', max: 15 },
  // Fix 460: necesita reponerse pero sin historial de ventas ni stock
  // objetivo cargado — no hay base para sugerir una cantidad, así que no
  // se generó orden automática. Requiere acción manual: cargar stock
  // mínimo/objetivo en la ficha del producto, o revisar y pedir a mano.
  sin_historial: { label: 'Sin historial de ventas', max: 15 }
};
const STOCKAUTO_MOSTRAR_INICIAL = 6;
const STOCKAUTO_PAGINA = 30;
let _stockAutoVisibles = STOCKAUTO_MOSTRAR_INICIAL;

// Orden de prioridad para el desglose del header: lo más urgente primero.
const STOCKAUTO_ORDEN_DESGLOSE = ['quiebre', 'critico', 'stock_bajo', 'sin_proveedor', 'sin_historial'];

function desgloseStockAuto(alertas) {
  const conteos = {};
  for (const a of alertas) conteos[a.tipo] = (conteos[a.tipo] || 0) + 1;
  return STOCKAUTO_ORDEN_DESGLOSE
    .filter(tipo => conteos[tipo] > 0)
    .map(tipo => `${conteos[tipo]} ${(STOCKAUTO_TIPOS[tipo]?.label || tipo).toLowerCase()}`)
    .join(' · ');
}

function renderAlertasStockAuto() {
  const contenedor = document.getElementById('alertas-stock-auto');
  if (!contenedor) return;

  if (!_alertasStockAuto.length) {
    contenedor.innerHTML = `
      <div class="stockauto-panel">
        <div class="stockauto-empty"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Sin alertas de reposición activas.</div>
      </div>`;
    return;
  }

  const total    = _alertasStockAuto.length;
  const visibles = _alertasStockAuto.slice(0, _stockAutoVisibles);

  const filas = visibles.map(a => {
    const tipoInfo = STOCKAUTO_TIPOS[a.tipo] || { label: a.tipo, max: 30 };
    const dias     = a.dias_restantes != null ? Number(a.dias_restantes) : null;
    const pct      = dias != null ? Math.max(4, 100 - Math.min(100, (dias / tipoInfo.max) * 100)) : 4;

    return `
    <div class="stockauto-row stockauto-row--${a.tipo}" onclick="verProyeccionStock('${a.producto_id}')" title="Ver proyección de reposición">
      <span class="stockauto-row__bar"></span>
      <span class="stockauto-row__nombre">${escHtml(a.productos?.nombre || '?')}</span>
      <span class="stockauto-row__tipo">${escHtml(tipoInfo.label)}</span>
      <span class="stockauto-row__urgencia"><i style="width:${pct}%"></i></span>
      <span class="stockauto-row__dias">${dias != null ? `<strong>${dias.toFixed(1)}</strong> días` : '—'}</span>
      <button type="button" class="stockauto-row__ver" onclick="event.stopPropagation();verProyeccionStock('${a.producto_id}')">Ver proyección</button>
    </div>`;
  }).join('');

  const hayMas       = total > _stockAutoVisibles;
  const puedeColapsar = _stockAutoVisibles > STOCKAUTO_MOSTRAR_INICIAL;
  const restantes     = total - _stockAutoVisibles;
  const pie = (hayMas || puedeColapsar) ? `
    <div class="stockauto-foot">
      ${hayMas ? `
        <button type="button" class="stockauto-toggle" onclick="cargarMasStockAuto()">
          Cargar ${Math.min(STOCKAUTO_PAGINA, restantes)} más (quedan ${restantes})
        </button>` : ''}
      ${puedeColapsar ? `
        <button type="button" class="stockauto-toggle stockauto-toggle--ghost" onclick="colapsarStockAuto()">
          Ver menos
        </button>` : ''}
    </div>` : '';

  const desglose = desgloseStockAuto(_alertasStockAuto);

  contenedor.innerHTML = `
    <div class="stockauto-panel">
      <div class="stockauto-head">
        <div class="stockauto-head__left">
          <span class="stockauto-head__icon">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </span>
          <div>
            <h3>Reposición sugerida</h3>
            <div class="stockauto-head__sub">Productos que se van a quedar sin stock, ordenados por urgencia</div>
            ${desglose ? `<div class="stockauto-head__desglose">${desglose}</div>` : ''}
          </div>
        </div>
        <span class="stockauto-head__count">${total}</span>
      </div>
      <div class="stockauto-list">${filas}</div>
      ${pie}
    </div>`;
}

function cargarMasStockAuto() {
  _stockAutoVisibles = Math.min(_alertasStockAuto.length, _stockAutoVisibles + STOCKAUTO_PAGINA);
  renderAlertasStockAuto();
}
window.cargarMasStockAuto = cargarMasStockAuto;

function colapsarStockAuto() {
  _stockAutoVisibles = STOCKAUTO_MOSTRAR_INICIAL;
  renderAlertasStockAuto();
  document.getElementById('alertas-stock-auto')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
window.colapsarStockAuto = colapsarStockAuto;

async function verProyeccionStock(productoId) {
  const modal = document.getElementById('modal-proyeccion-stock');
  if (!modal) return;
  modal.style.display = 'flex';
  document.getElementById('proyeccion-body').innerHTML =
    '<div class="loading-row">Cargando proyección...</div>';

  try {
    const token = window.authCtx?.session?.access_token || '';
    const resp  = await fetch('/api/stock-auto?accion=vista-previa', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!resp.ok) throw new Error('Error al cargar');
    const { analisis } = await resp.json();
    _proyeccionData = analisis || [];

    const item = _proyeccionData.find(a => a.producto_id === productoId);
    if (!item) {
      document.getElementById('proyeccion-body').innerHTML =
        '<p class="empty-hint">No hay datos de proyección para este producto.</p>';
      return;
    }

    const diasR = Number(item.dias_restantes).toFixed(1);
    const cls   = item.dias_restantes < 3 ? 'num-rojo' : item.dias_restantes < 14 ? 'num-amarillo' : 'num-verde';

    // Frase resumen en criollo: la conclusión antes que las métricas sueltas.
    const fraseResumen = item.necesita_reponer
      ? `Al ritmo de venta actual, se agota en <strong>${diasR} días</strong> y el proveedor tarda <strong>${item.lead_time} días</strong> en traer más — conviene pedir ahora.`
      : `Al ritmo de venta actual, <strong>alcanza para ${diasR} días</strong>. El proveedor tarda ${item.lead_time} días en traer más, así que por ahora no hace falta pedir.`;

    const demandaFuturaRow = Number(item.demanda_futura_conocida || 0) > 0
      ? `<div class="proy-kpi"><span class="kpi-label">Pedidos futuros ya confirmados</span><strong>${Number(item.demanda_futura_conocida).toLocaleString('es-AR')}</strong></div>`
      : '';

    if (_miniGraficoChart && typeof destruirGraficoECharts === 'function') {
      destruirGraficoECharts(_miniGraficoChart, 'proy-mini-grafico');
      _miniGraficoChart = null;
    }
    document.getElementById('proyeccion-body').innerHTML = `
      <div class="proyeccion-card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
          <h3 style="margin:0;">${escHtml(item.nombre)}</h3>
          <button type="button" class="btn btn--sm btn--ghost" style="white-space:nowrap;flex-shrink:0;" onclick="abrirModalDesdeProductoId('${productoId}')">Abrir producto</button>
        </div>
        <p class="proy-resumen">${fraseResumen}</p>
        <div class="proyeccion-grid">
          <div class="proy-kpi"><span class="kpi-label">Stock actual</span><strong>${Number(item.stock_actual || 0).toLocaleString('es-AR')}</strong></div>
          <div class="proy-kpi"><span class="kpi-label">Venta diaria promedio</span><strong>${Number(item.velocidad_dia).toFixed(2)}</strong></div>
          <div class="proy-kpi"><span class="kpi-label">Te alcanza para (días)</span><strong class="${cls}">${diasR}</strong></div>
          <div class="proy-kpi"><span class="kpi-label">Demora del proveedor</span><strong>${item.lead_time} días</strong></div>
          <div class="proy-kpi"><span class="kpi-label">Ya vendido / reservado en pedidos</span><strong>${Number(item.demanda_comprometida || 0).toLocaleString('es-AR')}</strong></div>
          ${demandaFuturaRow}
        </div>
        ${item.necesita_reponer
          ? `<div class="proy-alerta">⚠ Requiere reposición: <strong>${Number(item.cantidad_sugerida).toLocaleString('es-AR')} unidades</strong>
             <button class="btn btn--sm btn--primario" onclick="generarOrdenAutoManual('${productoId}')">Generar orden</button></div>`
          : '<div class="proy-ok"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Stock suficiente para el período</div>'}
        ${renderMiniGrafico(item)}
      </div>`;
    renderMiniGraficoEcharts(item);
  } catch (err) {
    console.error('[stock] Error al calcular proyección:', err);
    document.getElementById('proyeccion-body').innerHTML =
      `<p class="empty-hint">No pudimos calcular la proyección. Probá de nuevo en un momento.</p>`;
  }
}

function renderMiniGrafico(item) {
  return `
    <div id="proy-mini-grafico" style="width:100%;height:80px;border-radius:6px;background:#111;margin-top:12px"></div>
    <p style="font-size:11px;color:#8E8C82;margin:4px 0 0">Próximos 30 días · verde = cuándo llegaría el próximo pedido · rojo = cuándo se acaba</p>`;
}

let _miniGraficoChart = null;
function renderMiniGraficoEcharts(item) {
  if (typeof echarts === 'undefined') return; // sin ECharts cargado, se queda solo el caption
  const dias = 30;
  const stockActual = item.stock_actual || 0;
  const velocidad = item.velocidad_dia || 0;
  const datos = Array.from({ length: dias + 1 }, (_, d) => [d, Math.max(0, stockActual - velocidad * d)]);
  const agotaEn = velocidad > 0 ? stockActual / velocidad : Infinity;

  _miniGraficoChart = crearGraficoECharts(_miniGraficoChart, 'proy-mini-grafico', {
    backgroundColor: '#111',
    grid: { top: 20, bottom: 8, left: 8, right: 8 },
    xAxis: { type: 'value', min: 0, max: dias, show: false },
    yAxis: { type: 'value', min: 0, show: false },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: '#444' } },
      formatter: (params) => `Día ${Math.round(params[0].value[0])}: ${Math.round(params[0].value[1]).toLocaleString('es-AR')} u.`,
    },
    series: [{
      type: 'line',
      data: datos,
      showSymbol: false,
      lineStyle: { color: '#6A9873', width: 1.5 },
      markLine: {
        symbol: 'none',
        silent: true,
        data: [
          ...(agotaEn < dias ? [{
            xAxis: agotaEn,
            lineStyle: { color: '#D1594A', type: 'dashed', width: 1 },
            label: { formatter: 'Se acaba', color: '#D1594A', fontSize: 9, position: 'insideEndTop' },
          }] : []),
          {
            xAxis: Math.min(item.lead_time, dias),
            lineStyle: { color: '#487050', type: 'dashed', width: 1 },
            label: { show: false },
          },
        ],
      },
    }],
  }, { notMerge: true });
}

window.cerrarModalProyeccion = () => {
  const m = document.getElementById('modal-proyeccion-stock');
  if (m) m.style.display = 'none';
  if (_miniGraficoChart && typeof destruirGraficoECharts === 'function') {
    destruirGraficoECharts(_miniGraficoChart, 'proy-mini-grafico');
    _miniGraficoChart = null;
  }
};

// Abre el modal de ajuste/edición de un producto a partir de su producto_id,
// resolviendo el depósito con más stock disponible como default. Se usa desde
// el modal de proyección para poder modificar el producto sin salir del flujo.
async function abrirModalDesdeProductoId(productoId) {
  try {
    const { data, error } = await window.conTimeoutRed(sb
      .from('stock')
      .select(`
        producto_id,
        deposito_id,
        cantidad,
        cantidad_reservada,
        cantidad_disponible,
        costo_promedio,
        productos!inner(id, nombre, unidad, activo)
      `)
      .eq('producto_id', productoId)
      .eq('productos.activo', true)
      .order('cantidad_disponible', { ascending: false })
      .limit(1), 10000);

    if (error) throw error;
    if (!data || !data.length) {
      toast('No se encontró el producto para editar.', 'error');
      return;
    }

    const row = data[0];
    const p   = row.productos;
    window.cerrarModalProyeccion();
    await abrirModal(
      row.producto_id,
      row.deposito_id,
      Number(row.cantidad_disponible) || 0,
      p.nombre,
      p.unidad || 'un',
      Number(row.costo_promedio) || 0,
      Number(row.cantidad) || 0,
      Number(row.cantidad_reservada) || 0
    );
  } catch (err) {
    console.error('[stock] Error al abrir producto desde proyección:', err);
    toast('No pudimos abrir el producto. Probá de nuevo.', 'error');
  }
}
window.abrirModalDesdeProductoId = abrirModalDesdeProductoId;

window.generarOrdenAutoManual = async (productoId) => {
  try {
    const item  = _proyeccionData.find(a => a.producto_id === productoId);
    const token = window.authCtx?.session?.access_token || '';
    await fetch('/api/stock-auto?accion=analizar', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ solo_producto_id: productoId })
    });
    window.cerrarModalProyeccion();
    toast(item?.proveedor_id ? 'Orden generada' : 'Orden generada — revisar en Compras');
    if (item?.proveedor_id) setTimeout(() => { window.location.href = `/admin/compras?proveedor=${item.proveedor_id}`; }, 700);
  } catch (err) {
    console.error('[stock] Error al generar orden:', err);
    toast('No se pudo generar la orden. Probá de nuevo.', 'error');
  }
};

async function aprobarOrdenAuto(ordenId) {
  try {
    const token = window.authCtx?.session?.access_token || '';
    const resp  = await fetch('/api/stock-auto?accion=aprobar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ orden_id: ordenId })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error');
    toast('Orden enviada al proveedor');
    await cargarAlertasStockAuto();
    return data;
  } catch (err) {
    console.error('[stock] Error al aprobar orden:', err);
    toast('No se pudo aprobar la orden. Probá de nuevo.', 'error');
    throw err;
  }
}

// ── Exposición global ──────────────────────────────────────────────────────
window.exportarExcel          = exportarExcel;
window.guardarAjuste          = guardarAjuste;
window.limpiarFiltros         = limpiarFiltros;
window.toggleFiltrosAvanzados = toggleFiltrosAvanzados;
window.selFiltroEstado        = selFiltroEstado;
window.selTipo                = selTipo;
window.cerrarModal            = cerrarModal;
window.abrirModal             = abrirModal;
window.aplicarFiltros         = aplicarFiltros;
window.onBusqueda             = onBusqueda;
window.irPagina               = irPagina;
window.verProyeccionStock     = verProyeccionStock;
window.aprobarOrdenAuto       = aprobarOrdenAuto;
window.cargarAlertasStockAuto = cargarAlertasStockAuto;
window.cerrarSesion           = cerrarSesion;
window.abrirBuscadorTransferencia       = abrirBuscadorTransferencia;
window.cerrarBuscadorTransferencia      = cerrarBuscadorTransferencia;
window.seleccionarProductoTransferencia = seleccionarProductoTransferencia;
window.selPeriodoModificados      = selPeriodoModificados;
window.toggleModificados          = toggleModificados;
window.cargarProductosModificados = cargarProductosModificados;

// Gestión de depósitos (ex /admin/depositos, ahora modal dentro de Stock)
window.abrirModalDepositos            = abrirModalDepositos;
window.cerrarModalDepositos           = cerrarModalDepositos;
window.cerrarModalDepositosSiFondo    = cerrarModalDepositosSiFondo;
window.cargarDepositosAdmin           = cargarDepositosAdmin;
window.abrirModalDepositoNuevo        = abrirModalDepositoNuevo;
window.abrirModalDepositoEditar       = abrirModalDepositoEditar;
window.cerrarModalDepositoForm        = cerrarModalDepositoForm;
window.cerrarModalDepositoFormSiFondo = cerrarModalDepositoFormSiFondo;
window.guardarDeposito                = guardarDeposito;
window.desactivarDeposito             = desactivarDeposito;
window.activarDeposito                = activarDeposito;

// Exponer _page para los botones del HTML
Object.defineProperty(window, '_page', { get: () => _page, configurable: true });

// FIX: cargarStock se llama desde onclick="cargarStock()" en el botón "Reintentar",
// pero al ser este archivo un módulo ES6 no queda accesible en window sin exponerla.
window.cargarStock = cargarStock;

// ── Arranque ───────────────────────────────────────────────────────────────
window.authReady.then(() => init()).catch(err => {
  console.error('[auth] authReady falló:', err?.message);
  if (!window.authCtx?.perfil) window.location.href = '/admin/login';
});
