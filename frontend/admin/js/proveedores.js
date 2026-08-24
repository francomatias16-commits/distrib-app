// frontend/admin/js/proveedores.js
// Módulo de proveedores — REQ-01

let sb = null, usuario = null, empresaData = null;
let proveedoresData = [], filtrados = [];
let modalProveedorId = null;

let paginaActualProveedores = 1;
const ITEMS_POR_PAGINA_PROVEEDORES = 200;
let totalProveedoresFiltrados = 0;

// ── Init ──────────────────────────────────────────────────────────────
async function init() {
  sb          = window.authCtx.sb;
  usuario     = window.authCtx.perfil;
  empresaData = window.authCtx.perfil?.empresas || { id: window.authCtx.perfil?.empresa_id, nombre: '', config: {} };

  try { inyectarControlesPaginacionProveedores(); } catch(e) { console.warn('[proveedores] paginacion init:', e.message); }

  // Buscador con debounce (250ms, mismo criterio que clientes.js): la
  // búsqueda ahora pega contra /api/proveedores en vez de filtrar en
  // memoria sobre el recorte fijo de 500.
  const inputBusqueda = document.getElementById('busqueda');
  if (inputBusqueda) {
    let debounceBusquedaProveedores = null;
    inputBusqueda.addEventListener('input', () => {
      clearTimeout(debounceBusquedaProveedores);
      debounceBusquedaProveedores = setTimeout(() => filtrar(), 250);
    });
  }

  await cargarProveedores();
  cargarLinksActivos();
}

// ── Carga ─────────────────────────────────────────────────────────────
// Antes: .limit(500) fijo en el backend + Array.filter() en el navegador
// sobre ese recorte (función filtrar(), más abajo). Ahora: búsqueda,
// filtro de activo y paginación se resuelven server-side (busqueda,
// page, limit → lib/handlers/proveedores.js).
async function cargarProveedores() {
  try {
    const token  = (await sb.auth.getSession()).data.session?.access_token;
    const activo = document.getElementById('filtro-activo')?.value ?? 'true';
    const busq   = document.getElementById('busqueda')?.value.trim() || '';

    const params = new URLSearchParams();
    if (activo !== '') params.set('activo', activo);
    if (busq) params.set('busqueda', busq);
    params.set('page', String(paginaActualProveedores));
    params.set('limit', String(ITEMS_POR_PAGINA_PROVEEDORES));

    const res  = await fetch(`/api/proveedores?${params}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('No se pudo cargar la lista de proveedores.');
    const data = await res.json();
    proveedoresData = data.proveedores || [];
    filtrados = proveedoresData; // ya viene filtrado/paginado del servidor
    totalProveedoresFiltrados = data.total || 0;

    renderTabla();
    actualizarControlesPaginacionProveedores();
  } catch (err) {
    window.toast?.(err.message || 'No se pudo cargar la lista de proveedores.', 'error');
  }
}

// Antes filtraba `proveedoresData` en memoria con Array.filter(). Ahora
// dispara una nueva carga server-side, reseteando a la página 1.
function filtrar() {
  paginaActualProveedores = 1;
  cargarProveedores();
}

// ── Paginación ──────────────────────────────────────────────────────────
function inyectarControlesPaginacionProveedores() {
  if (document.getElementById('paginacion-proveedores')) return; // ya existe
  const contenedor = document.querySelector('.tabla-wrap') || document.body;
  const div = document.createElement('div');
  div.id = 'paginacion-proveedores';
  div.className = 'paginacion-container';
  div.innerHTML = `
      <button id="btn-prev-proveedores" class="btn-pag" onclick="cambiarPaginaProveedores(-1)">Anterior</button>
      <span id="info-pag-proveedores">Página 1</span>
      <button id="btn-next-proveedores" class="btn-pag" onclick="cambiarPaginaProveedores(1)">Siguiente</button>
  `;
  contenedor.appendChild(div);
}

function actualizarControlesPaginacionProveedores() {
  const totalPaginas = Math.max(1, Math.ceil(totalProveedoresFiltrados / ITEMS_POR_PAGINA_PROVEEDORES));
  const info = document.getElementById('info-pag-proveedores');
  if (info) info.textContent = `Página ${paginaActualProveedores} de ${totalPaginas} (${totalProveedoresFiltrados} proveedores)`;
  const btnPrev = document.getElementById('btn-prev-proveedores');
  const btnNext = document.getElementById('btn-next-proveedores');
  if (btnPrev) btnPrev.disabled = paginaActualProveedores <= 1;
  if (btnNext) btnNext.disabled = paginaActualProveedores >= totalPaginas;
}

function cambiarPaginaProveedores(delta) {
  const totalPaginas = Math.max(1, Math.ceil(totalProveedoresFiltrados / ITEMS_POR_PAGINA_PROVEEDORES));
  const nueva = paginaActualProveedores + delta;
  if (nueva < 1 || nueva > totalPaginas) return;
  paginaActualProveedores = nueva;
  cargarProveedores();
}
window.cambiarPaginaProveedores = cambiarPaginaProveedores;

// ── Render tabla ──────────────────────────────────────────────────────
function renderTabla() {
  const tbody = document.getElementById('tbody-proveedores');
  if (!tbody) return;

  if (!filtrados.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="vacio">No se encontraron proveedores. Probá otra búsqueda o cargá el primero con «Nuevo proveedor».</td></tr>';
    return;
  }

  tbody.innerHTML = filtrados.map(p => `
    <tr data-testid="proveedores-fila" data-id="${p.id}" class="fila-clickeable" onclick="if (event.target.closest('[onclick],a,select,input,textarea,button') === this) abrirModalEditar('${p.id}')">
      <td data-label="Proveedor">
        <div style="font-weight:600;color:var(--color-text)">${sanitize(p.razon_social)}</div>
        ${p.nombre_fantasia ? `<div style="font-size:11px;color:var(--color-text-muted)">${sanitize(p.nombre_fantasia)}</div>` : ''}
      </td>
      <td class="col-fit" style="font-size:12px;color:var(--color-text-muted)" data-label="CUIT">${p.cuit || '—'}</td>
      <td class="col-fit" style="font-size:12px" data-label="Contacto">${sanitize(p.contacto || '—')}</td>
      <td class="col-fit" style="font-size:12px" data-label="Teléfono">${sanitize(p.telefono || '—')}</td>
      <td class="col-fit" style="text-align:center;font-size:12px" data-label="Pago">${p.dias_pago > 0 ? p.dias_pago + ' días' : 'Contado'}</td>
      <td class="col-fit" data-label="Estado">${ComponentesAdmin.renderBadgeEstado(p.activo ? 'Activo' : 'Inactivo', p.activo ? 'ok' : 'inactivo')}</td>
      <td class="col-sticky-end col-fit" data-label="Acciones">
        <span class="fila-acciones">
          <button type="button" class="btn-tabla" onclick="abrirModalEditar('${p.id}')">Editar</button>
          ${p.activo
            ? `<button type="button" class="btn-tabla peligro" onclick="desactivar('${p.id}')">Dar de baja</button>`
            : `<button type="button" class="btn-tabla primario" onclick="activar('${p.id}')">Activar</button>`
          }
          <button type="button" class="btn-kebab btn-kebab-proveedor" data-proveedor-id="${p.id}" title="Más acciones" aria-label="Más acciones" aria-haspopup="menu" aria-expanded="false"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg></button>
        </span>
      </td>
    </tr>
  `).join('');
}

// ── Menú "⋮" de acciones secundarias por fila (Compras / Portal) ──────────
// Mismo patrón de menú flotante compartido que Cheques/Notas de crédito
// (ver PLAN_UNIFICACION_UX_ADMIN.md §2/§5, cierre del Hallazgo #6 acá).
(function iniciarMenuAccionesProveedor() {
  const menu = document.getElementById('menu-acciones-proveedor');
  if (!menu) return;

  const cerrar = () => {
    menu.hidden = true;
    document.querySelectorAll('.btn-kebab-proveedor[aria-expanded="true"]')
      .forEach(b => b.setAttribute('aria-expanded', 'false'));
  };

  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.btn-kebab-proveedor');
    if (!btn) { if (!ev.target.closest('#menu-acciones-proveedor')) cerrar(); return; }
    ev.stopPropagation();

    const yaAbiertoParaEsteBtn = !menu.hidden && menu.dataset.proveedorId === btn.dataset.proveedorId;
    cerrar();
    if (yaAbiertoParaEsteBtn) return;

    const proveedorId = btn.dataset.proveedorId;
    menu.innerHTML = `
      <button type="button" class="dropdown-item" role="menuitem" onclick="verCompras('${proveedorId}')">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/></svg>
        Compras
      </button>
      <button type="button" class="dropdown-item" role="menuitem" onclick="abrirPortal('${proveedorId}')">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        Portal
      </button>`;
    menu.dataset.proveedorId = proveedorId;

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
  document.getElementById('tbody-proveedores')?.addEventListener('scroll', cerrar);
})();

// ── Modal nuevo/editar ────────────────────────────────────────────────
function abrirModalNuevo() {
  modalProveedorId = null;
  limpiarForm();
  document.getElementById('modal-titulo').textContent = 'Nuevo proveedor';
  document.getElementById('btn-guardar').textContent  = 'Guardar proveedor';
  document.getElementById('modal-proveedor').style.display = 'flex';
  const _badgeCont = document.getElementById('badge-origen-migracion');
  if (_badgeCont) _badgeCont.innerHTML = '';
}

async function abrirModalEditar(id) {
  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const res   = await fetch(`/api/proveedores?id=${id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('No se pudo cargar el proveedor');
    const p = await res.json();
    if (!p?.id) { window.toast('No se pudo cargar el proveedor', 'error'); return; }

    modalProveedorId = id;
  document.getElementById('f-razon_social').value     = p.razon_social || '';
  document.getElementById('f-nombre_fantasia').value  = p.nombre_fantasia || '';
  document.getElementById('f-cuit').value             = p.cuit || '';
  document.getElementById('f-condicion_iva').value    = p.condicion_iva || 'responsable_inscripto';
  document.getElementById('f-contacto').value         = p.contacto || '';
  document.getElementById('f-telefono').value         = p.telefono || '';
  document.getElementById('f-email').value            = p.email || '';
  document.getElementById('f-dias_pago').value        = p.dias_pago || 0;
  document.getElementById('f-domicilio').value        = p.domicilio || '';
  document.getElementById('f-localidad').value        = p.localidad || '';
  document.getElementById('f-notas').value            = p.notas || '';

  document.getElementById('modal-titulo').textContent = 'Editar proveedor';
  document.getElementById('btn-guardar').textContent  = 'Guardar cambios';
  document.getElementById('modal-proveedor').style.display = 'flex';
  if (typeof renderBadgeOrigenMigracion === 'function') renderBadgeOrigenMigracion('proveedores', p.id, 'badge-origen-migracion');
  } catch (err) {
    window.toast(err.message || 'No se pudo cargar el proveedor', 'error');
  }
}

function limpiarForm() {
  ['razon_social','nombre_fantasia','cuit','contacto','telefono','email','domicilio','localidad','notas']
    .forEach(id => { const el = document.getElementById('f-' + id); if (el) el.value = ''; });
  const dp = document.getElementById('f-dias_pago');
  if (dp) dp.value = '0';
  const ci = document.getElementById('f-condicion_iva');
  if (ci) ci.value = 'responsable_inscripto';
}

function cerrarModal() {
  document.getElementById('modal-proveedor').style.display = 'none';
  modalProveedorId = null;
}

function cerrarModalSiFondo(event) {
  if (event.target.id === 'modal-proveedor') cerrarModal();
}

async function guardarProveedor() {
  const btn = document.getElementById('btn-guardar');
  btn.disabled = true; btn.textContent = 'Guardando...';

  const body = {
    razon_social:    document.getElementById('f-razon_social').value.trim(),
    nombre_fantasia: document.getElementById('f-nombre_fantasia').value.trim(),
    cuit:            document.getElementById('f-cuit').value.trim(),
    condicion_iva:   document.getElementById('f-condicion_iva').value,
    contacto:        document.getElementById('f-contacto').value.trim(),
    telefono:        document.getElementById('f-telefono').value.trim(),
    email:           document.getElementById('f-email').value.trim(),
    dias_pago:       parseInt(document.getElementById('f-dias_pago').value) || 0,
    domicilio:       document.getElementById('f-domicilio').value.trim(),
    localidad:       document.getElementById('f-localidad').value.trim(),
    notas:           document.getElementById('f-notas').value.trim()
  };

  if (!body.razon_social) {
    window.toast('Razón social es requerida', 'error');
    btn.disabled = false; btn.textContent = modalProveedorId ? 'Guardar cambios' : 'Guardar proveedor';
    return;
  }

  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const method = modalProveedorId ? 'PATCH' : 'POST';
    if (modalProveedorId) body.id = modalProveedorId;

    const res = await fetch('/api/proveedores', {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    btn.disabled = false;

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      window.toast(err.error || 'No se pudo guardar el proveedor', 'error');
      btn.textContent = modalProveedorId ? 'Guardar cambios' : 'Guardar proveedor';
      return;
    }

    window.toast(modalProveedorId ? 'Proveedor actualizado' : 'Proveedor creado', 'exito');
    cerrarModal();
    await cargarProveedores();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = modalProveedorId ? 'Guardar cambios' : 'Guardar proveedor';
    window.toast(err.message || 'No se pudo guardar el proveedor', 'error');
  }
}

async function desactivar(id) {
  if (!(await confirmar('¿Dar de baja este proveedor?', { labelOk: 'Dar de baja', tipo: 'danger' }))) return;
  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const res = await fetch(`/api/proveedores?id=${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      window.toast(err.error || 'No se pudo dar de baja el proveedor', 'error');
      return;
    }
    window.toast('Proveedor dado de baja', 'exito');
    await cargarProveedores();
  } catch (err) {
    window.toast(err.message || 'No se pudo dar de baja el proveedor', 'error');
  }
}

async function activar(id) {
  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const res = await fetch('/api/proveedores', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, activo: true })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      window.toast(err.error || 'No se pudo activar el proveedor', 'error');
      return;
    }
    window.toast('Proveedor activado', 'exito');
    await cargarProveedores();
  } catch (err) {
    window.toast(err.message || 'No se pudo activar el proveedor', 'error');
  }
}

function verCompras(proveedorId) {
  window.location.href = `/admin/compras?proveedor=${proveedorId}`;
}

// ── Portal de autogestión del proveedor (#10 — Vidriera Inversa) ───────
let portalProveedorTel = '';

async function abrirPortal(proveedorId) {
  const prov = proveedoresData.find(p => p.id === proveedorId);
  portalProveedorTel = prov?.telefono || '';

  document.getElementById('portal-titulo').textContent = `Portal de ${prov?.razon_social || ''}`;
  document.getElementById('portal-body').innerHTML = '<p class="portal-cargando">Generando link...</p>';
  document.getElementById('modal-portal').style.display = 'flex';

  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const res = await fetch('/api/proveedores?_svc=portal-admin&accion=generar-link', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proveedor_id: proveedorId })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      document.getElementById('portal-body').innerHTML =
        `<p class="portal-error">${err.error || 'No se pudo generar el link'}</p>`;
      return;
    }

    const data = await res.json();
    const expira = new Date(data.expira_at).toLocaleDateString('es-AR');

    document.getElementById('portal-body').innerHTML = `
      <p style="font-size:13px;color:var(--color-text-muted);margin-bottom:10px">
        Este link le permite a <strong>${sanitize(prov?.razon_social || '')}</strong> ver sus órdenes de compra sin necesidad
        de iniciar sesión. Es válido hasta el <strong>${expira}</strong> (${data.dias_validez} días).
      </p>
      <div class="portal-link-box">
        <input type="text" id="portal-link-input" class="form-input" value="${data.url}" readonly onclick="this.select()" />
      </div>
      <div class="portal-acciones">
        <button class="btn-tabla primario" onclick="window.open('${data.url.replace(/'/g, "\\'")}', '_blank')" title="Ingresar ahora al portal de este proveedor, en una pestaña nueva">Abrir portal ahora</button>
        <button class="btn-tabla" onclick="copiarLinkPortal()">Copiar link</button>
        ${portalProveedorTel
          ? `<button class="btn-tabla" onclick="enviarPortalWhatsapp('${data.url.replace(/'/g, "\\'")}')">Enviar por WhatsApp</button>`
          : ''}
      </div>
    `;
  } catch (err) {
    document.getElementById('portal-body').innerHTML =
      `<p class="portal-error">${err.message || 'No se pudo generar el link'}</p>`;
  }
}

function copiarLinkPortal() {
  const input = document.getElementById('portal-link-input');
  if (!input) return;
  input.select();
  navigator.clipboard?.writeText(input.value).then(
    () => window.toast('Link copiado', 'exito'),
    () => window.toast('No se pudo copiar, seleccioná y copiá manualmente', 'error')
  );
}

function enviarPortalWhatsapp(url) {
  const tel = (portalProveedorTel || '').replace(/\D/g, '');
  const msg = encodeURIComponent(`Hola, te paso el link para que puedas ver tus órdenes de compra: ${url}`);
  const wa = tel ? `https://wa.me/${tel}?text=${msg}` : `https://wa.me/?text=${msg}`;
  window.open(wa, '_blank');
}

function cerrarModalPortal() {
  document.getElementById('modal-portal').style.display = 'none';
}

function cerrarModalPortalSiFondo(event) {
  if (event.target.id === 'modal-portal') cerrarModalPortal();
}

// ── Toast ─────────────────────────────────────────────────────────────

// ── Arranque ──────────────────────────────────────────────────────────
window.authReady.then(() => {
  if (!window.authCtx?.perfil) { window.location.href = '/admin/login'; return; }
  init();
}).catch(err => {
  console.error('[proveedores.js] authReady falló:', err?.message);
  window.location.href = '/admin/login';
});


// Exponer funciones al scope global (requerido por los onclick del HTML)
window.abrirModalNuevo = abrirModalNuevo;
window.cerrarModal = cerrarModal;
window.cerrarModalSiFondo = cerrarModalSiFondo;
window.guardarProveedor = guardarProveedor;
window.abrirPortal = abrirPortal;
window.copiarLinkPortal = copiarLinkPortal;
window.enviarPortalWhatsapp = enviarPortalWhatsapp;
window.cerrarModalPortal = cerrarModalPortal;
window.cerrarModalPortalSiFondo = cerrarModalPortalSiFondo;

// ── Links activos del portal de proveedores ────────────────────────────────────

// Mapa proveedorId → razonSocial para el panel de links
let _proveedorNombreMap = {};

// Independiente de la paginación de la tabla principal: antes usaba
// `proveedoresData` (que con el .limit(500) original contenía prácticamente
// todos los proveedores). Ahora que la tabla pagina de a
// ITEMS_POR_PAGINA_PROVEEDORES, ese array solo trae la página visible —
// si se dejaba así, los links de proveedores de otras páginas
// desaparecían del panel silenciosamente. Este fetch es liviano (una sola
// vez, no en cada tecla) y no reintroduce el patrón que se está arreglando:
// sirve solo para resolver id→nombre en este panel secundario.
async function cargarLinksActivos() {
  const tbody = document.getElementById('tbody-links-activos');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="8" class="vacio">Cargando…</td></tr>';

  const token = (await sb.auth.getSession()).data.session?.access_token;

  const resNombres = await fetch(`/api/proveedores?activo=&limit=2000`, {
    headers: { Authorization: `Bearer ${token}` }
  }).then(r => r.ok ? r.json() : { proveedores: [] }).catch(() => ({ proveedores: [] }));
  const todosProveedores = resNombres.proveedores || [];

  _proveedorNombreMap = {};
  for (const p of todosProveedores) {
    _proveedorNombreMap[p.id] = p.razon_social || p.nombre_fantasia || p.id;
  }

  // Pedimos links de todos los proveedores del tenant (sin filtrar por proveedor)
  // La API acepta GET ?accion=links&proveedor_id= — hacemos una petición por cada
  // proveedor con links conocidos; pero mejor: llamamos a Supabase directo
  // desde el frontend usando la vista/tabla via anon (RLS deny-all) — no funciona.
  // Alternativa: iterar sobre los proveedores con links conocidos o hacer una
  // llamada a la API con proveedor_id vacío (el handler lo rechaza).
  // Solución pragmática: llamamos la API por cada proveedor en paralelo, solo
  // si hay proveedores; mostramos todos los activos en conjunto.

  const ids = todosProveedores.map(p => p.id);
  if (!ids.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="vacio">Sin proveedores.</td></tr>';
    return;
  }

  try {
    const resultados = await Promise.all(
      ids.map(id =>
        fetch(`/api/proveedores?_svc=portal-admin&accion=links&proveedor_id=${id}`, {
          headers: { Authorization: `Bearer ${token}` }
        })
          .then(r => r.ok ? r.json() : { links: [] })
          .then(d => (d.links || []).map(l => ({ ...l, _proveedor_id: id })))
          .catch(() => [])
      )
    );

    const todos = resultados.flat().sort((a, b) =>
      new Date(b.creado_at) - new Date(a.creado_at)
    );
    const activos = todos.filter(l => l.estado === 'activo');

    if (!activos.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="vacio">No hay links activos en este momento.</td></tr>';
      return;
    }

    tbody.innerHTML = activos.map(l => {
      const nombre     = window.sanitize(_proveedorNombreMap[l._proveedor_id] || '—');
      const creadoPor  = window.sanitize(l.usuarios?.nombre || '—');
      const creadoEl   = new Date(l.creado_at).toLocaleDateString('es-AR');
      const expiraEl   = new Date(l.expira_at).toLocaleDateString('es-AR');
      const ultimoUso  = l.ultimo_uso_at
        ? new Date(l.ultimo_uso_at).toLocaleDateString('es-AR')
        : '—';
      return `
        <tr id="link-row-${l.id}">
          <td>${nombre}</td>
          <td class="col-fit" style="font-size:12px;color:var(--color-text-muted,#5B6660);">${creadoPor}</td>
          <td class="col-fit" style="font-size:12px;">${creadoEl}</td>
          <td class="col-fit" style="font-size:12px;">${expiraEl}</td>
          <td class="col-fit" style="text-align:center;font-weight:600;">${l.usos || 0}</td>
          <td class="col-fit" style="font-size:12px;">${ultimoUso}</td>
          <td class="col-fit"><span style="color:var(--color-success,#487050);font-weight:600;font-size:12px;">● Activo</span></td>
          <td class="col-sticky-end col-fit">
            <button class="btn-tabla" style="color:var(--color-danger,#7A2820);"
              onclick="revocarLinkPortal('${l.id}','${l._proveedor_id}')">Revocar</button>
          </td>
        </tr>`;
    }).join('');
  } catch (e) {
    console.error('[proveedores] Error al cargar links de portal:', e);
    tbody.innerHTML = `<tr><td colspan="8" class="vacio" style="color:var(--color-danger)">No se pudieron cargar los links. Probá de nuevo en un momento.</td></tr>`;
  }
}

window.revocarLinkPortal = async function (tokenId, proveedorId) {
  const nombre = window.sanitize(_proveedorNombreMap[proveedorId] || 'este proveedor');
  const ok = await window.confirmar(
    `¿Revocar el link de acceso de ${nombre}? El proveedor ya no podrá usarlo.`,
    { tipo: 'danger', labelOk: 'Revocar link' }
  );
  if (!ok) return;

  const token = (await sb.auth.getSession()).data.session?.access_token;
  const res = await fetch('/api/proveedores?_svc=portal-admin&accion=revocar', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token_id: tokenId })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    window.toast(err.error || 'No se pudo revocar el link. Probá de nuevo.', 'error');
    return;
  }

  // Quitar fila de la tabla
  document.getElementById(`link-row-${tokenId}`)?.remove();
  const tbody = document.getElementById('tbody-links-activos');
  if (tbody && !tbody.querySelector('tr:not(.oculto)')) {
    tbody.innerHTML = '<tr><td colspan="8" class="vacio">No hay links activos en este momento.</td></tr>';
  }
  window.toast('Link revocado correctamente', 'exito');
};
