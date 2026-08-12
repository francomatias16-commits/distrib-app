// frontend/admin/js/migracion-badge.js
// Punto 2 del machete de auditoría de migración: "trazabilidad de origen" +
// "datos extra sin destino" (REQ-MIG-EXTRAS v194).
//
// Problema original (trazabilidad): una vez que un registro (cliente,
// producto, proveedor, etc.) se crea vía el módulo de migración, no queda
// NINGÚN rastro visible en su ficha de que vino de una importación masiva.
//
// Segundo problema (REQ-MIG-EXTRAS): si el CSV del cliente tenía columnas
// que no se mapearon a ningún campo del sistema, esos datos se descartan
// silenciosamente. Ahora se muestran como "datos extra" en la ficha del
// registro migrado (solo lectura; el backend los persiste en datos_extras).
//
// Este archivo es intencionalmente independiente de migracion.js (que sólo
// se carga en migracion.html): cualquier pantalla del admin que tenga una
// "ficha" de detalle puede incluir este script y llamar a
// `renderBadgeOrigenMigracion(...)` sin duplicar lógica de fetch/estilo.
//
// Requiere que la página ya tenga inicializado un cliente `sb` (supabase-js)
// global, igual que el resto de los módulos admin.

(function () {
  let _estiloInyectado = false;

  function _inyectarEstilo() {
    if (_estiloInyectado) return;
    _estiloInyectado = true;
    const style = document.createElement('style');
    style.textContent = `
      .mig-badge-origen {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        font-weight: 600;
        padding: 3px 10px;
        border-radius: 999px;
        background: rgba(var(--violeta-rgb,91,74,143), 0.15);
        color: var(--violeta-mid,#5B4A8F);
        border: 1px solid rgba(var(--violeta-rgb,91,74,143), 0.35);
        cursor: pointer;
        text-decoration: none;
        white-space: nowrap;
        margin-top: 4px;
      }
      .mig-badge-origen:hover {
        background: rgba(var(--violeta-rgb,91,74,143), 0.28);
      }
      .mig-badge-origen svg { width: 13px; height: 13px; flex: none; }

      /* ── Sección de datos extra sin destino (REQ-MIG-EXTRAS) ── */
      .mig-extras-wrap {
        margin-top: 10px;
        border: 1px solid rgba(var(--violeta-rgb,91,74,143), 0.25);
        border-radius: 10px;
        overflow: hidden;
        font-size: 13px;
      }
      .mig-extras-toggle {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: rgba(var(--violeta-rgb,91,74,143), 0.07);
        border: none;
        cursor: pointer;
        font-size: 12px;
        font-weight: 700;
        color: var(--violeta-light,#7A639F);
        text-align: left;
        transition: background .15s;
      }
      .mig-extras-toggle:hover { background: rgba(var(--violeta-rgb,91,74,143), 0.13); }
      .mig-extras-toggle svg { width: 13px; height: 13px; flex: none; transition: transform .2s; }
      .mig-extras-toggle.abierto svg { transform: rotate(90deg); }
      .mig-extras-body {
        display: none;
        padding: 10px 12px;
        background: rgba(var(--violeta-rgb,91,74,143), 0.04);
      }
      .mig-extras-body.abierto { display: block; }
      .mig-extras-tabla {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      .mig-extras-tabla th {
        text-align: left;
        padding: 4px 8px;
        font-weight: 600;
        color: var(--violeta-dark,#453A70);
        border-bottom: 1px solid rgba(var(--violeta-rgb,91,74,143), 0.18);
        white-space: nowrap;
      }
      .mig-extras-tabla td {
        padding: 4px 8px;
        border-bottom: 1px solid rgba(var(--violeta-rgb,91,74,143), 0.08);
        word-break: break-word;
        max-width: 280px;
      }
      .mig-extras-tabla tr:last-child td { border-bottom: none; }
      .mig-extras-nota {
        margin-top: 8px;
        font-size: 11px;
        color: var(--violeta-light,#7A639F);
        opacity: .8;
      }
    `;
    document.head.appendChild(style);
  }

  async function _obtenerToken() {
    try {
      if (typeof getFreshToken === 'function') return await getFreshToken();
      if (typeof sb !== 'undefined' && sb?.auth) {
        const { data: { session } } = await sb.auth.getSession();
        return session?.access_token || '';
      }
    } catch (_e) { /* noop */ }
    return '';
  }

  function _escHtml(s) {
    // Consolidado: delega a la única fuente de verdad (ui-utils.js).
    return window.sanitize(s);
  }

  // Muestra los datos extras en un panel colapsable debajo del badge.
  // datosExtras: objeto plano { columna: valor, ... }
  function _renderExtras(cont, datosExtras) {
    if (!datosExtras || !Object.keys(datosExtras).length) return;
    _inyectarEstilo();

    const wrap = document.createElement('div');
    wrap.className = 'mig-extras-wrap';

    const entradas = Object.entries(datosExtras);
    const toggleId = `mig-extras-body-${Math.random().toString(36).slice(2)}`;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'mig-extras-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', toggleId);
    toggle.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
      ${entradas.length} dato${entradas.length === 1 ? '' : 's'} extra sin campo de destino
    `;

    const body = document.createElement('div');
    body.className = 'mig-extras-body';
    body.id = toggleId;
    body.innerHTML = `
      <table class="mig-extras-tabla">
        <thead><tr><th>Campo original</th><th>Valor</th></tr></thead>
        <tbody>
          ${entradas.map(([col, val]) => `
            <tr>
              <td><strong>${_escHtml(col)}</strong></td>
              <td>${_escHtml(String(val ?? '—'))}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <p class="mig-extras-nota">
        Estos campos existían en el archivo original pero no se mapearon a
        ningún campo del sistema. Se conservan aquí solo como referencia
        (no son operativos).
      </p>
    `;

    toggle.addEventListener('click', () => {
      const abierto = body.classList.toggle('abierto');
      toggle.classList.toggle('abierto', abierto);
      toggle.setAttribute('aria-expanded', abierto);
    });

    wrap.appendChild(toggle);
    wrap.appendChild(body);
    cont.appendChild(wrap);
  }

  // ── API pública ─────────────────────────────────────────────────────────────
  //
  // entidad: string igual al usado por el módulo de migración (ej: 'clientes',
  //          'productos', 'proveedores', 'cta_cte', ...).
  // id: UUID del registro final (cliente.id, producto.id, etc.)
  // contenedorId: id del elemento del DOM donde se debe insertar el badge
  //               (se limpia y se reemplaza en cada llamada).
  //
  // El backend (accion=origen) puede devolver opcionalmente:
  //   datos_extras: { col: val, ... }  — campos del CSV sin campo de destino
  // Si el campo no existe en la respuesta, el panel de extras no se muestra.
  async function renderBadgeOrigenMigracion(entidad, id, contenedorId) {
    const cont = document.getElementById(contenedorId);
    if (!cont) return;
    cont.innerHTML = '';
    if (!entidad || !id) return;

    try {
      const token = await _obtenerToken();
      if (!token) return;
      const resp = await fetch(
        `/api/migracion?accion=origen&entidad=${encodeURIComponent(entidad)}&id=${encodeURIComponent(id)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data?.migrado) return;

      _inyectarEstilo();
      const fecha = data.fecha ? new Date(data.fecha).toLocaleDateString('es-AR') : '';
      const a = document.createElement('a');
      a.className = 'mig-badge-origen';
      a.href = `/admin/migracion.html?sesion_id=${encodeURIComponent(data.sesion_id)}`;
      a.title = `Este registro fue creado por una migración de datos${
        data.nombre_archivo_original ? ` (archivo: ${data.nombre_archivo_original})` : ''
      }${fecha ? ` — ${fecha}` : ''}. Click para ver la sesión de origen.`;
      a.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>
        </svg>
        Importado por migración${fecha ? ` · ${fecha}` : ''}
      `;
      cont.appendChild(a);

      // REQ-MIG-EXTRAS: Si el backend devuelve datos_extras, mostrarlos.
      // El backend debe incluir datos_extras en la respuesta de accion=origen.
      // Ver: lib/handlers/migracion.js → case 'origen' (instrucciones de
      // implementación en CHANGELOG_v194_migracion_extras.md)
      if (data.datos_extras && typeof data.datos_extras === 'object' &&
          Object.keys(data.datos_extras).length > 0) {
        _renderExtras(cont, data.datos_extras);
      }

    } catch (_e) {
      // Silencioso: la falta de badge no debe romper la ficha del registro.
    }
  }

  window.renderBadgeOrigenMigracion = renderBadgeOrigenMigracion;
})();
