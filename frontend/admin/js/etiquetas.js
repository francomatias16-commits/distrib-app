// frontend/admin/js/etiquetas.js
// Módulo compartido de etiquetas (tags), genérico y reusable para cualquier
// entidad (mismo patrón polimórfico que notas-internas.js: entidad_tipo +
// entidad_id). Schema: migración 473_etiquetas_genericas.sql
//
// Usado por: productos.js (chips en el modal + filtro en la tabla)
// Requiere: window.authCtx disponible (esperar window.authReady antes de usar)
//
// API pública:
//   Etiquetas.listarEmpresa()                                   → Promise<etiqueta[]>
//   Etiquetas.crear(nombre, color?)                              → Promise<etiqueta>
//   Etiquetas.actualizar(etiquetaId, { nombre?, color? })        → Promise<etiqueta>
//   Etiquetas.eliminarEtiqueta(etiquetaId)                       → Promise<void>
//   Etiquetas.deEntidad(entidadTipo, entidadId)                  → Promise<etiqueta[]>
//   Etiquetas.asignar(entidadTipo, entidadId, etiquetaId)        → Promise<void>
//   Etiquetas.quitar(entidadTipo, entidadId, etiquetaId)         → Promise<void>
//   Etiquetas.renderChips(containerId, entidadTipo, entidadId, { onCambio? })
//   Etiquetas.renderFiltroSelect(selectId, { onCambio? })
//   Etiquetas.renderGestion(containerId, { onCambio? })          — CRUD del catálogo
//     (crear/renombrar/recolorear/eliminar etiquetas de la empresa; usado
//     desde el popover "Gestionar etiquetas" del panel de filtros de
//     Productos. onCambio se dispara después de cualquier alta/edición/baja
//     para que quien lo use pueda refrescar el <select> de filtro y la lista.)
//
// ─────────────────────────────────────────────────────────────────────────────

const Etiquetas = (() => {

  // ── Helpers internos ──────────────────────────────────────────────────────

  function sb() {
    return window.authCtx?.sb;
  }

  function empresaId() {
    return window.authCtx?.perfil?.empresa_id;
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s || '');
    return d.innerHTML;
  }

  // Paleta acotada — evita que cada usuario tipee un color hex a mano.
  const PALETA = ['#6A9873', '#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B', '#EF4444', '#06B6D4', '#78716C'];
  function colorSugerido(nombre) {
    let hash = 0;
    for (const c of String(nombre || '')) hash = (hash * 31 + c.charCodeAt(0)) & 0xFFFF;
    return PALETA[hash % PALETA.length];
  }

  // ── API pública: datos ───────────────────────────────────────────────────

  async function listarEmpresa() {
    const { data, error } = await sb()
      .from('etiquetas')
      .select('id, nombre, color')
      .eq('empresa_id', empresaId())
      .order('nombre', { ascending: true });
    if (error) {
      console.error('[Etiquetas] Error listando:', error.message);
      return [];
    }
    return data || [];
  }

  async function crear(nombre, color) {
    const payload = {
      empresa_id: empresaId(),
      nombre: nombre.trim(),
      color: color || colorSugerido(nombre),
    };
    const { data, error } = await sb()
      .from('etiquetas')
      .insert(payload)
      .select('id, nombre, color')
      .single();
    if (error) {
      // 23505 = unique_violation → ya existe una etiqueta con ese nombre
      if (error.code === '23505') {
        const existentes = await listarEmpresa();
        const encontrada = existentes.find(e => e.nombre.toLowerCase() === nombre.trim().toLowerCase());
        if (encontrada) return encontrada;
      }
      throw new Error(error.message);
    }
    return data;
  }

  async function actualizar(etiquetaId, cambios = {}) {
    const payload = {};
    if (cambios.nombre != null) payload.nombre = cambios.nombre.trim();
    if (cambios.color  != null) payload.color  = cambios.color;
    if (!Object.keys(payload).length) throw new Error('Nada para actualizar');

    const { data, error } = await sb()
      .from('etiquetas')
      .update(payload)
      .eq('id', etiquetaId)
      .eq('empresa_id', empresaId())
      .select('id, nombre, color')
      .single();

    if (error) {
      // 23505 = unique_violation → ya existe otra etiqueta con ese nombre
      if (error.code === '23505') throw new Error('Ya existe una etiqueta con ese nombre.');
      throw new Error(error.message);
    }
    return data;
  }

  // Elimina la etiqueta del catálogo de la empresa (no solo la desasigna).
  // `entidad_etiquetas.etiqueta_id` tiene ON DELETE CASCADE (473), así que
  // esto también saca la etiqueta de todo lo que la tuviera asignada.
  async function eliminarEtiqueta(etiquetaId) {
    const { error } = await sb()
      .from('etiquetas')
      .delete()
      .eq('id', etiquetaId)
      .eq('empresa_id', empresaId());
    if (error) throw new Error(error.message);
  }

  async function deEntidad(entidadTipo, entidadId) {
    const { data, error } = await sb()
      .from('entidad_etiquetas')
      .select('etiqueta_id, etiquetas(id, nombre, color)')
      .eq('empresa_id', empresaId())
      .eq('entidad_tipo', entidadTipo)
      .eq('entidad_id', entidadId);
    if (error) {
      console.error('[Etiquetas] Error cargando de entidad:', error.message);
      return [];
    }
    return (data || []).map(r => r.etiquetas).filter(Boolean);
  }

  async function asignar(entidadTipo, entidadId, etiquetaId) {
    const payload = {
      empresa_id: empresaId(),
      entidad_tipo: entidadTipo,
      entidad_id: entidadId,
      etiqueta_id: etiquetaId,
    };
    const { error } = await sb().from('entidad_etiquetas').insert(payload);
    // 23505 = ya estaba asignada — no es un error real para el usuario
    if (error && error.code !== '23505') throw new Error(error.message);
  }

  async function quitar(entidadTipo, entidadId, etiquetaId) {
    const { error } = await sb()
      .from('entidad_etiquetas')
      .delete()
      .eq('empresa_id', empresaId())
      .eq('entidad_tipo', entidadTipo)
      .eq('entidad_id', entidadId)
      .eq('etiqueta_id', etiquetaId);
    if (error) throw new Error(error.message);
  }

  // ── Render: chips (agregar/quitar) para el modal de una entidad ─────────

  const _estado = {}; // containerId -> { entidadTipo, entidadId, asignadas: [], onCambio }

  async function renderChips(containerId, entidadTipo, entidadId, options = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const asignadas = entidadId ? await deEntidad(entidadTipo, entidadId) : [];
    _estado[containerId] = { entidadTipo, entidadId, asignadas, onCambio: options.onCambio };
    _pintarChips(containerId);
  }

  function _pintarChips(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const st = _estado[containerId];
    if (!st) return;

    const chips = st.asignadas.map(e => `
      <span class="et-chip" style="background:${e.color}20;color:${e.color};border-color:${e.color}55">
        ${escHtml(e.nombre)}
        <button type="button" class="et-chip-quitar" title="Quitar etiqueta" onclick="Etiquetas._onQuitar('${containerId}','${e.id}')">×</button>
      </span>`).join('');

    container.innerHTML = `
      <div class="et-chips-lista">${chips || '<span class="et-vacio">Sin etiquetas todavía</span>'}</div>
      <div class="et-agregar-row">
        <input type="text" class="et-input" id="${containerId}-input" placeholder="Agregar etiqueta..." list="${containerId}-datalist" maxlength="40" />
        <datalist id="${containerId}-datalist"></datalist>
        <button type="button" class="btn-secundario et-btn-agregar" onclick="Etiquetas._onAgregar('${containerId}')">Agregar</button>
      </div>`;

    const input = document.getElementById(`${containerId}-input`);
    if (input) {
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); _onAgregar(containerId); }
      });
      _poblarDatalist(containerId);
    }
  }

  async function _poblarDatalist(containerId) {
    const dl = document.getElementById(`${containerId}-datalist`);
    if (!dl) return;
    const todas = await listarEmpresa();
    dl.innerHTML = todas.map(e => `<option value="${escHtml(e.nombre)}"></option>`).join('');
  }

  async function _onAgregar(containerId) {
    const st = _estado[containerId];
    const input = document.getElementById(`${containerId}-input`);
    if (!st || !input || !input.value.trim()) return;
    const nombre = input.value.trim();

    if (!st.entidadId) {
      window.toast?.('Guardá primero el registro para poder agregar etiquetas.', 'warning');
      return;
    }

    try {
      const todas = await listarEmpresa();
      let etq = todas.find(e => e.nombre.toLowerCase() === nombre.toLowerCase());
      if (!etq) etq = await crear(nombre);

      if (st.asignadas.some(e => e.id === etq.id)) {
        input.value = '';
        return;
      }

      await asignar(st.entidadTipo, st.entidadId, etq.id);
      st.asignadas.push(etq);
      input.value = '';
      _pintarChips(containerId);
      if (st.onCambio) await st.onCambio(st.asignadas);
    } catch (e) {
      console.error('[Etiquetas] Error agregando:', e);
      window.toast?.('No se pudo agregar la etiqueta: ' + e.message, 'error');
    }
  }

  async function _onQuitar(containerId, etiquetaId) {
    const st = _estado[containerId];
    if (!st) return;
    try {
      await quitar(st.entidadTipo, st.entidadId, etiquetaId);
      st.asignadas = st.asignadas.filter(e => e.id !== etiquetaId);
      _pintarChips(containerId);
      if (st.onCambio) await st.onCambio(st.asignadas);
    } catch (e) {
      console.error('[Etiquetas] Error quitando:', e);
      window.toast?.('No se pudo quitar la etiqueta: ' + e.message, 'error');
    }
  }

  // ── Render: popover de gestión del catálogo (crear/renombrar/recolorear/
  //    eliminar) — usado desde el botón "Gestionar etiquetas" del panel de
  //    filtros de Productos. No asigna/desasigna de ninguna entidad, solo
  //    administra las filas de `etiquetas`. ─────────────────────────────

  const _gestion = {}; // containerId -> { onCambio, editandoId }

  async function renderGestion(containerId, options = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;
    _gestion[containerId] = { onCambio: options.onCambio, editandoId: _gestion[containerId]?.editandoId || null };
    await _pintarGestion(containerId);
  }

  async function _pintarGestion(containerId) {
    const container = document.getElementById(containerId);
    const st = _gestion[containerId];
    if (!container || !st) return;

    const todas = await listarEmpresa();

    const filas = todas.map(e => {
      const enEdicion = st.editandoId === e.id;
      if (enEdicion) {
        const swatches = PALETA.map(c => `
          <button type="button" class="et-swatch${c === e.color ? ' et-swatch--activo' : ''}"
                  style="background:${c}" title="${c}"
                  onclick="Etiquetas._onCambiarColor('${containerId}','${e.id}','${c}')"></button>
        `).join('');
        return `
          <div class="et-gestion-fila et-gestion-fila--edicion" data-id="${e.id}">
            <input type="text" class="et-input et-input--sm" id="${containerId}-edit-${e.id}"
                   value="${escHtml(e.nombre)}" maxlength="40"
                   onkeydown="if(event.key==='Enter'){Etiquetas._onGuardarNombre('${containerId}','${e.id}')}
                              if(event.key==='Escape'){Etiquetas._onCancelarEdicion('${containerId}')}" />
            <div class="et-swatches">${swatches}</div>
            <button type="button" class="et-icon-btn" title="Guardar" onclick="Etiquetas._onGuardarNombre('${containerId}','${e.id}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            </button>
            <button type="button" class="et-icon-btn" title="Cancelar" onclick="Etiquetas._onCancelarEdicion('${containerId}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>`;
      }
      return `
        <div class="et-gestion-fila" data-id="${e.id}">
          <span class="et-gestion-color" style="background:${e.color}"></span>
          <span class="et-gestion-nombre">${escHtml(e.nombre)}</span>
          <button type="button" class="et-icon-btn" title="Renombrar / cambiar color" onclick="Etiquetas._onEditar('${containerId}','${e.id}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
          </button>
          <button type="button" class="et-icon-btn et-icon-btn--danger" title="Eliminar etiqueta" onclick="Etiquetas._onEliminar('${containerId}','${e.id}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        </div>`;
    }).join('');

    container.innerHTML = `
      <div class="et-gestion-lista">${filas || '<span class="et-vacio">Todavía no hay etiquetas creadas</span>'}</div>
      <div class="et-agregar-row et-agregar-row--gestion">
        <input type="text" class="et-input" id="${containerId}-nueva" placeholder="Nueva etiqueta..." maxlength="40" />
        <button type="button" class="btn-secundario et-btn-agregar" onclick="Etiquetas._onCrearDesdeGestion('${containerId}')">Crear</button>
      </div>`;

    const nuevoInput = document.getElementById(`${containerId}-nueva`);
    if (nuevoInput) {
      nuevoInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); _onCrearDesdeGestion(containerId); }
      });
    }
  }

  async function _onCrearDesdeGestion(containerId) {
    const input = document.getElementById(`${containerId}-nueva`);
    if (!input) return;
    if (!input.value.trim()) {
      // FIX v742: antes esto hacía `return` en silencio — sin toast, sin
      // resaltar el campo, nada. El botón "Crear" quedaba pareciendo roto
      // cuando en realidad estaba rechazando un nombre vacío sin avisar.
      // Reportado como "no funciona el botón de Crear etiqueta".
      window.toast?.('Escribí un nombre para la etiqueta.', 'error');
      input.focus();
      return;
    }
    const nombre = input.value.trim();
    try {
      await crear(nombre);
      input.value = '';
      await _pintarGestion(containerId);
      const cb = _gestion[containerId]?.onCambio;
      if (cb) await cb();
    } catch (e) {
      console.error('[Etiquetas] Error creando desde gestión:', e);
      window.toast?.('No se pudo crear la etiqueta: ' + e.message, 'error');
    }
  }

  function _onEditar(containerId, etiquetaId) {
    _gestion[containerId].editandoId = etiquetaId;
    _pintarGestion(containerId);
  }

  function _onCancelarEdicion(containerId) {
    _gestion[containerId].editandoId = null;
    _pintarGestion(containerId);
  }

  async function _onCambiarColor(containerId, etiquetaId, color) {
    try {
      await actualizar(etiquetaId, { color });
      await _pintarGestion(containerId);
      const cb = _gestion[containerId]?.onCambio;
      if (cb) await cb();
    } catch (e) {
      console.error('[Etiquetas] Error cambiando color:', e);
      window.toast?.('No se pudo cambiar el color: ' + e.message, 'error');
    }
  }

  async function _onGuardarNombre(containerId, etiquetaId) {
    const input = document.getElementById(`${containerId}-edit-${etiquetaId}`);
    if (!input || !input.value.trim()) return;
    try {
      await actualizar(etiquetaId, { nombre: input.value.trim() });
      _gestion[containerId].editandoId = null;
      await _pintarGestion(containerId);
      const cb = _gestion[containerId]?.onCambio;
      if (cb) await cb();
    } catch (e) {
      console.error('[Etiquetas] Error renombrando:', e);
      window.toast?.('No se pudo renombrar: ' + e.message, 'error');
    }
  }

  async function _onEliminar(containerId, etiquetaId) {
    if (!(await window.confirmar('¿Eliminar esta etiqueta? Se va a quitar de todos los productos que la tengan asignada.', { labelOk: 'Eliminar', tipo: 'danger' }))) return;
    try {
      await eliminarEtiqueta(etiquetaId);
      await _pintarGestion(containerId);
      const cb = _gestion[containerId]?.onCambio;
      if (cb) await cb();
    } catch (e) {
      console.error('[Etiquetas] Error eliminando:', e);
      window.toast?.('No se pudo eliminar la etiqueta: ' + e.message, 'error');
    }
  }

  // ── Render: <select> de filtro por etiqueta (para listados/tablas) ──────

  async function renderFiltroSelect(selectId, options = {}) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    const todas = await listarEmpresa();
    const valorActual = sel.value;
    sel.innerHTML = '<option value="">Todas las etiquetas</option>' +
      todas.map(e => `<option value="${e.id}">${escHtml(e.nombre)}</option>`).join('');
    if (valorActual) sel.value = valorActual;
    if (options.onCambio) sel.onchange = () => options.onCambio(sel.value);
  }

  // ── CSS inyectado una sola vez ─────────────────────────────────────────
  function inyectarCSS() {
    if (document.getElementById('et-styles')) return;
    const style = document.createElement('style');
    style.id = 'et-styles';
    style.textContent = `
      .et-chips-lista { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; min-height: 26px; }
      .et-chip {
        display: inline-flex; align-items: center; gap: 5px;
        font-size: 12px; font-weight: 600; padding: 3px 8px 3px 10px;
        border-radius: 999px; border: 1px solid; line-height: 1.6;
      }
      .et-chip-quitar {
        background: none; border: none; cursor: pointer; color: inherit;
        font-size: 15px; line-height: 1; padding: 0 0 0 2px; opacity: .6;
      }
      .et-chip-quitar:hover { opacity: 1; }
      .et-vacio { font-size: 12px; color: var(--color-text-muted, #5B6660); }
      .et-agregar-row { display: flex; gap: 8px; }
      .et-input {
        flex: 1; box-sizing: border-box; border: 1px solid var(--color-border, #DDE1DC);
        border-radius: 8px; padding: 7px 10px; font-size: 13px; font-family: inherit;
        color: var(--color-text, #111A17); background: var(--color-surface, #FFFFFF);
        outline: none;
      }
      .et-input:focus {
        border-color: var(--color-primary, #6A9873);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary, #6A9873) 12%, transparent);
      }
      .et-btn-agregar { font-size: 12px; padding: 7px 12px; white-space: nowrap; }

      /* Popover de gestión (crear/renombrar/recolorear/eliminar) */
      .et-gestion-lista {
        display: flex; flex-direction: column; gap: 4px;
        max-height: 260px; overflow-y: auto; margin-bottom: 10px;
      }
      .et-gestion-fila {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 4px; border-radius: 6px;
      }
      .et-gestion-fila:hover { background: var(--color-bg, #F6F7F5); }
      .et-gestion-color {
        width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0;
      }
      .et-gestion-nombre {
        flex: 1; font-size: 13px; color: var(--color-text, #111A17);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .et-icon-btn {
        background: none; border: none; cursor: pointer; padding: 4px;
        border-radius: 5px; display: flex; align-items: center;
        color: var(--color-text-muted, #5B6660); flex-shrink: 0;
      }
      .et-icon-btn:hover { background: var(--color-border, #DDE1DC); color: var(--color-text, #111A17); }
      .et-icon-btn--danger:hover { background: color-mix(in srgb, var(--color-danger, #7A2820) 15%, transparent); color: var(--color-danger, #7A2820); }
      .et-gestion-fila--edicion { flex-wrap: wrap; background: var(--color-bg, #F6F7F5); }
      .et-input--sm { flex: 1 1 140px; padding: 5px 8px; font-size: 12px; }
      .et-swatches { display: flex; gap: 4px; }
      .et-swatch {
        width: 16px; height: 16px; border-radius: 50%; border: 2px solid transparent;
        cursor: pointer; padding: 0;
      }
      .et-swatch--activo { border-color: var(--color-text, #111A17); }
      .et-agregar-row--gestion { border-top: 1px solid var(--color-border, #DDE1DC); padding-top: 10px; }

      /* Popover contenedor (anclado al botón "Gestionar etiquetas") */
      .et-gestion-popover {
        position: absolute; z-index: 60; width: 300px;
        background: var(--color-surface, #FFFFFF);
        border: 1px solid var(--color-border, #DDE1DC);
        border-radius: 10px; box-shadow: 0 8px 24px rgba(22,24,29,.12);
        padding: 14px; margin-top: 6px;
      }
      .et-gestion-popover-titulo {
        font-size: 12px; font-weight: 700; text-transform: uppercase;
        letter-spacing: .04em; color: var(--color-text-muted, #5B6660);
        margin: 0 0 10px;
      }
    `;
    document.head.appendChild(style);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inyectarCSS);
  } else {
    inyectarCSS();
  }

  return {
    listarEmpresa,
    crear,
    actualizar,
    eliminarEtiqueta,
    deEntidad,
    asignar,
    quitar,
    renderChips,
    renderFiltroSelect,
    renderGestion,
    _onAgregar,
    _onQuitar,
    _onCrearDesdeGestion,
    _onEditar,
    _onCancelarEdicion,
    _onCambiarColor,
    _onGuardarNombre,
    _onEliminar,
  };
})();

window.Etiquetas = Etiquetas;
