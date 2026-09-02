/* admin/js/comparador-precios.js — Etapa 2, ítem 3/3: Comparador de precios entre proveedores
   Lee /api/proveedores?_svc=comparador-precios → ranking_ahorro_proveedores() / comparar_precios_proveedores()
   (migración 244). Solo considera OCs con estado='recibida' (precio confirmado). */

const ROLES_COMPARADOR = ['dueno', 'admin', 'depositero', 'contador'];

let mesesActuales = 12;
let buscarTimeout = null;

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await window.authReady;

  const hoy = new Date();
  const elFechaTopbar = document.getElementById('topbar-fecha');
  if (elFechaTopbar) {
    elFechaTopbar.textContent =
      hoy.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  const user = window.authCtx?.perfil;
  if (!user) return;
  (document.getElementById('topbar-usuario') || {}).textContent = user.nombre || user.email;

  if (!ROLES_COMPARADOR.includes(user.rol)) {
    document.getElementById('contenido-comparador').classList.add('hidden');
    document.getElementById('sin-permiso').classList.remove('hidden');
    return;
  }

  document.getElementById('input-buscar-producto').addEventListener('input', onBuscarProducto);
  document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.buscador-wrap');
    if (wrap && !wrap.contains(e.target)) {
      document.getElementById('buscador-resultados').classList.add('hidden');
    }
  });

  await cargarRanking();
});

// ── Buscador de producto (autocomplete vía /api/busqueda) ──────────────────
// XSS: helper para escapar de forma segura texto libre (nombre de producto)
// dentro de un argumento de atributo onclick="funcion('...')". El patrón
// anterior (.replace(/'/g, "\\'")) solo escapaba comillas simples, no dobles
// ni el atributo HTML en sí. JSON.stringify escapa comillas/backslashes
// correctamente para el string JS, y el resto escapa lo necesario para el
// atributo HTML que lo contiene.
function escOnclickArg(valor) {
  return JSON.stringify(String(valor ?? ''))
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function onBuscarProducto(e) {
  clearTimeout(buscarTimeout);
  const q = e.target.value.trim();
  const cont = document.getElementById('buscador-resultados');

  if (q.length < 2) { cont.classList.add('hidden'); return; }

  buscarTimeout = setTimeout(async () => {
    try {
      const token = await getToken();
      const r = await fetch(`/api/busqueda?q=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json();
      const productos = (data.productos || []).slice(0, 8);

      if (!productos.length) {
        cont.innerHTML = '<div class="item" style="color:var(--color-text-muted);cursor:default;">Sin resultados</div>';
        cont.classList.remove('hidden');
        return;
      }

      cont.innerHTML = productos.map(p => `
        <div class="item" data-id="${esc(p.id)}" data-nombre="${esc(p.nombre)}">
          <span>${esc(p.nombre)}</span>
          <span class="cod">${esc(p.codigo || '')}</span>
        </div>
      `).join('');
      cont.classList.remove('hidden');

      cont.querySelectorAll('.item[data-id]').forEach(el => {
        el.addEventListener('click', () => {
          document.getElementById('input-buscar-producto').value = el.dataset.nombre;
          cont.classList.add('hidden');
          cargarDetalle(el.dataset.id, el.dataset.nombre);
        });
      });
    } catch (e) {
      console.error('[comparador-precios] error buscando producto:', e);
    }
  }, 300);
}

function onCambioMeses() {
  mesesActuales = parseInt(document.getElementById('filtro-meses').value, 10) || 12;
  const detalleVisible = !document.getElementById('vista-detalle').classList.contains('hidden');
  if (detalleVisible && window._productoActualId) {
    cargarDetalle(window._productoActualId, window._productoActualNombre);
  } else {
    cargarRanking();
  }
}

// ── Ranking de oportunidades ────────────────────────────────────────────────
async function cargarRanking() {
  mostrarVista('ranking');
  const tbody = document.getElementById('tbody-ranking');
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--color-text-light);">Cargando…</td></tr>';
  document.getElementById('ranking-vacio').classList.add('hidden');

  try {
    const token = await getToken();
    const r = await fetch(`/api/proveedores?_svc=comparador-precios&meses=${mesesActuales}&limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al cargar el ranking');

    const filas = data.ranking || [];
    renderKpis(filas);

    if (!filas.length) {
      tbody.innerHTML = '';
      document.getElementById('ranking-vacio').classList.remove('hidden');
      return;
    }

    tbody.innerHTML = filas.map(f => `
      <tr class="clickable" onclick="cargarDetalle('${esc(f.producto_id)}', ${escOnclickArg(f.producto_nombre)})">
        <td data-label="Producto"><strong>${esc(f.producto_nombre)}</strong><br><span style="font-size:11px;color:var(--color-text-muted);">${esc(f.producto_codigo || '')}</span></td>
        <td data-label="Proveedores">${f.cantidad_proveedores}</td>
        <td data-label="Precio promedio pagado">${fmtPeso(f.precio_promedio_pagado)}</td>
        <td class="monto-verde" data-label="Precio más bajo disponible">${fmtPeso(f.precio_minimo_disponible)}</td>
        <td data-label="Diferencia">${f.spread_pct != null ? `<span class="spread-badge ${f.spread_pct < 5 ? 'bajo' : ''}">${fmtNum(f.spread_pct)}%</span>` : '—'}</td>
        <td data-label="Proveedor más barato">${esc(f.proveedor_mas_barato || '—')}</td>
        <td data-label="Le compraste más a">${esc(f.proveedor_mas_usado || '—')}</td>
        <td class="monto-verde" data-label="Ahorro potencial">${fmtPeso(f.ahorro_potencial)}</td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('[comparador-precios] error cargando ranking:', e);
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--color-danger);">No se pudo cargar el ranking. Probá de nuevo en un momento.</td></tr>`;
  }
}

function renderKpis(filas) {
  const cont = document.getElementById('kpis-grid');
  const totalAhorro = filas.reduce((acc, f) => acc + (Number(f.ahorro_potencial) || 0), 0);
  const productosConOportunidad = filas.filter(f => Number(f.ahorro_potencial) > 0).length;

  cont.className = 'franja-resumen-sololectura';
  cont.innerHTML = `
    <div class="dato-sello" data-tono="verde" title="Últimos ${mesesActuales} meses, si siempre se hubiera comprado al proveedor más barato"><div class="dato-sello-valor">${fmtPeso(totalAhorro)}</div><div class="dato-sello-etiqueta">Ahorro potencial total</div></div>
    <div class="dato-sello" data-tono="ambar" title="De ${filas.length} productos comprados a más de un proveedor"><div class="dato-sello-valor">${productosConOportunidad}</div><div class="dato-sello-etiqueta">Productos con oportunidad</div></div>
  `;
}

// ── Detalle por producto ────────────────────────────────────────────────────
async function cargarDetalle(producto_id, producto_nombre) {
  window._productoActualId = producto_id;
  window._productoActualNombre = producto_nombre;

  mostrarVista('detalle');
  document.getElementById('detalle-titulo').textContent = `Detalle por proveedor — ${producto_nombre}`;
  const tbody = document.getElementById('tbody-detalle');
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--color-text-light);">Cargando…</td></tr>';
  document.getElementById('detalle-vacio').classList.add('hidden');

  try {
    const token = await getToken();
    const r = await fetch(`/api/proveedores?_svc=comparador-precios&producto_id=${producto_id}&meses=${mesesActuales}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al cargar el detalle');

    const filas = data.detalle || [];
    if (!filas.length) {
      tbody.innerHTML = '';
      document.getElementById('detalle-vacio').classList.remove('hidden');
      return;
    }

    const precioMinimo = Math.min(...filas.map(f => Number(f.precio_ultimo)));

    tbody.innerHTML = filas.map(f => {
      const esMejor = Number(f.precio_ultimo) === precioMinimo;
      return `
        <tr class="${esMejor ? 'fila-mejor' : ''}">
          <td data-label="Proveedor">${esc(f.proveedor_nombre)}${esMejor ? '<span class="badge-mejor">Más barato</span>' : ''}</td>
          <td data-label="Último precio">${fmtPeso(f.precio_ultimo)}</td>
          <td data-label="Última compra">${fmtFecha(f.fecha_ultima_compra)}</td>
          <td data-label="Precio mínimo">${fmtPeso(f.precio_minimo)}</td>
          <td data-label="Precio máximo">${fmtPeso(f.precio_maximo)}</td>
          <td data-label="Precio promedio">${fmtPeso(f.precio_promedio)}</td>
          <td data-label="Compras">${f.compras_count}</td>
          <td data-label="Cantidad total">${fmtNum(f.cantidad_total)}</td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    console.error('[comparador-precios] error cargando detalle:', e);
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--color-danger);">No se pudo cargar el detalle. Probá de nuevo en un momento.</td></tr>`;
  }
}

function volverARanking() {
  window._productoActualId = null;
  window._productoActualNombre = null;
  document.getElementById('input-buscar-producto').value = '';
  cargarRanking();
}

function mostrarVista(vista) {
  document.getElementById('vista-ranking').classList.toggle('hidden', vista !== 'ranking');
  document.getElementById('vista-detalle').classList.toggle('hidden', vista !== 'detalle');
}

// ── Helpers ───────────────────────────────────────────────────────────────
async function getToken() {
  const { data: { session } } = await window.authCtx.sb.auth.getSession();
  return session?.access_token || '';
}
function fmtPeso(n) {
  return '$' + Math.round(+n || 0).toLocaleString('es-AR');
}
function fmtNum(n) {
  return Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 1 });
}
function fmtFecha(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('es-AR');
}
function esc(s) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(s);
}

// Exponer para onclick inline
window.onCambioMeses  = onCambioMeses;
window.cargarDetalle  = cargarDetalle;
window.volverARanking = volverARanking;
