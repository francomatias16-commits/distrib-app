// frontend/admin/js/notas-internas.js
// REQ-14 — Módulo compartido de notas internas con historial
// Schema corregido por migración 062_fix_notas_internas_schema.sql
//
// Usado por: clientes.js (tab Historial), pedidos.js (sección Notas internas)
// Requiere: window.authCtx disponible (esperar window.authReady antes de usar)
//
// API pública:
//   NotasInternas.cargar(entidadTipo, entidadId)  → Promise<nota[]>
//   NotasInternas.agregar(entidadTipo, entidadId, contenido) → Promise<nota>
//   NotasInternas.archivar(notaId)  → Promise<void>
//   NotasInternas.renderLista(notas, containerId, { onArchivar?, editable? })
//   NotasInternas.renderForm(containerId, entidadTipo, entidadId, { onGuardada? })
//
// ─────────────────────────────────────────────────────────────────────────────

const NotasInternas = (() => {

  // ── Helpers internos ──────────────────────────────────────────────────────

  function sb() {
    return window.authCtx?.sb;
  }

  function perfil() {
    return window.authCtx?.perfil;
  }

  function empresaId() {
    return perfil()?.empresa_id;
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s || '');
    return d.innerHTML;
  }

  function formatTs(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const fecha = d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const hora  = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    return `${fecha} ${hora}`;
  }

  // Iniciales para avatar de usuario
  function iniciales(nombre) {
    return String(nombre || '?').split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
  }

  // Color de avatar determinístico por nombre
  const AVATAR_COLORS = ['#3B82F6','#8B5CF6','#EC4899','#10B981','#F59E0B','#EF4444','#06B6D4'];
  function avatarColor(nombre) {
    let hash = 0;
    for (const c of String(nombre || '')) hash = (hash * 31 + c.charCodeAt(0)) & 0xFFFF;
    return AVATAR_COLORS[hash % AVATAR_COLORS.length];
  }

  // ── API pública ───────────────────────────────────────────────────────────

  async function cargar(entidadTipo, entidadId) {
    const { data, error } = await sb()
      .from('notas_internas')
      .select('id, contenido, usuario_nombre, activa, created_at')
      .eq('empresa_id', empresaId())
      .eq('entidad_tipo', entidadTipo)
      .eq('entidad_id', entidadId)
      .eq('activa', true)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('[NotasInternas] Error cargando:', error.message);
      return [];
    }
    return data || [];
  }

  async function agregar(entidadTipo, entidadId, contenido) {
    const p = perfil();
    if (!p) throw new Error('Sin sesión');

    const payload = {
      empresa_id:    empresaId(),
      entidad_tipo:  entidadTipo,
      entidad_id:    entidadId,
      contenido:     contenido.trim(),
      usuario_id:    p.id,
      usuario_nombre: p.nombre || p.email || 'Sin nombre',
    };

    const { data, error } = await sb()
      .from('notas_internas')
      .insert(payload)
      .select('id, contenido, usuario_nombre, activa, created_at')
      .single();

    if (error) throw new Error(error.message);
    return data;
  }

  async function archivar(notaId) {
    const { error } = await sb()
      .from('notas_internas')
      .update({ activa: false })
      .eq('id', notaId)
      .eq('empresa_id', empresaId());

    if (error) throw new Error(error.message);
  }

  // ── Render: lista de notas ─────────────────────────────────────────────
  // options:
  //   editable {boolean}  — muestra botón archivar (solo roles admin/dueno/vendedor)
  //   onArchivar {fn}     — callback(notaId) al archivar

  // ── Paginación cliente ("Cargar más") ─────────────────────────────────
  // Por containerId, porque el módulo puede tener varias instancias
  // renderizadas a la vez (ej. clientes.js y pedidos.js en la misma sesión).
  const NI_MOSTRAR_INICIAL = 10;
  const NI_PAGINA          = 20;
  const _visibles = {};   // containerId -> cantidad visible
  const _listaActual = {}; // containerId -> última lista de notas renderizada
  const _opcionesActuales = {}; // containerId -> options usadas en el último renderLista

  function piePaginacionHTML(total, visibles, containerId) {
    const hayMas        = total > visibles;
    const puedeColapsar = visibles > NI_MOSTRAR_INICIAL;
    if (!hayMas && !puedeColapsar) return '';
    const restantes = total - visibles;
    return `<div class="paginar-foot">
      ${hayMas ? `<button type="button" class="paginar-btn" onclick="NotasInternas._cargarMas('${containerId}')">Cargar ${Math.min(NI_PAGINA, restantes)} más (quedan ${restantes})</button>` : ''}
      ${puedeColapsar ? `<button type="button" class="paginar-btn paginar-btn--ghost" onclick="NotasInternas._colapsar('${containerId}')">Ver menos</button>` : ''}
    </div>`;
  }

  function _cargarMas(containerId) {
    const total = (_listaActual[containerId] || []).length;
    _visibles[containerId] = Math.min(total, (_visibles[containerId] || NI_MOSTRAR_INICIAL) + NI_PAGINA);
    renderLista(_listaActual[containerId] || [], containerId, _opcionesActuales[containerId] || {});
  }
  function _colapsar(containerId) {
    _visibles[containerId] = NI_MOSTRAR_INICIAL;
    renderLista(_listaActual[containerId] || [], containerId, _opcionesActuales[containerId] || {});
  }
  // Público: llamar antes de mostrar notas de una entidad distinta en el
  // mismo containerId (ej. al abrir el tab de historial de OTRO cliente),
  // para no arrastrar el "Cargar más" ya expandido de la entidad anterior.
  function resetPaginacion(containerId) {
    _visibles[containerId] = NI_MOSTRAR_INICIAL;
  }

  function renderLista(notas, containerId, options = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const { editable = true, onArchivar } = options;
    _listaActual[containerId] = notas;
    _opcionesActuales[containerId] = options;
    if (_visibles[containerId] == null) _visibles[containerId] = NI_MOSTRAR_INICIAL;

    if (!notas.length) {
      container.innerHTML = `
        <div class="ni-empty">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
          <span>Sin notas internas todavía</span>
        </div>`;
      return;
    }

    const total    = notas.length;
    const visibles = notas.slice(0, _visibles[containerId]);

    const notasHtml = visibles.map(n => {
      const color = avatarColor(n.usuario_nombre);
      const ini   = iniciales(n.usuario_nombre);

      return `
        <div class="ni-nota" data-id="${n.id}">
          <div class="ni-avatar" style="background:${color}20;color:${color}">${ini}</div>
          <div class="ni-body">
            <div class="ni-meta">
              <span class="ni-autor">${escHtml(n.usuario_nombre || '—')}</span>
              <span class="ni-ts">${formatTs(n.created_at)}</span>
              ${editable ? `
                <button class="ni-archivar" title="Archivar nota" onclick="NotasInternas._onArchivar('${n.id}','${containerId}')">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                    <path d="M10 11v6m4-6v6"/>
                  </svg>
                </button>` : ''}
            </div>
            <div class="ni-contenido">${escHtml(n.contenido)}</div>
          </div>
        </div>`;
    }).join('');

    const pie = piePaginacionHTML(total, _visibles[containerId], containerId);
    container.innerHTML = notasHtml + pie;

    // Guardar callback para el onclick inline
    if (onArchivar) NotasInternas._callbacks[containerId] = onArchivar;
  }

  // Handler global invocado desde onclick inline
  // (necesario porque el onclick inline no tiene closure al callback)
  const _callbacks = {};
  async function _onArchivar(notaId, containerId) {
    if (!(await confirmar('¿Archivar esta nota? No se borrará permanentemente.', { labelOk: 'Archivar' }))) return;
    try {
      await archivar(notaId);
      const cb = _callbacks[containerId];
      if (cb) await cb(notaId);
    } catch(e) {
      window.toast('Error al archivar la nota: ' + e.message, 'danger');
    }
  }

  // ── Render: form de nueva nota ─────────────────────────────────────────
  // Inyecta un textarea + botón en el container indicado.
  // options:
  //   onGuardada {fn(nota)} — callback al guardar exitosamente
  //   placeholder {string}
  //   maxLen {number}       — default 1000

  function renderForm(containerId, entidadTipo, entidadId, options = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const { onGuardada, placeholder = 'Escribí una nota interna...', maxLen = 1000 } = options;
    const formId    = `ni-form-${containerId}`;
    const textaId   = `ni-ta-${containerId}`;
    const charId    = `ni-ch-${containerId}`;
    const btnId     = `ni-btn-${containerId}`;

    container.innerHTML = `
      <div class="ni-form" id="${formId}">
        <textarea
          id="${textaId}"
          class="ni-textarea"
          placeholder="${placeholder}"
          maxlength="${maxLen}"
          rows="3"
          oninput="NotasInternas._onInput('${textaId}','${charId}','${btnId}',${maxLen})"
        ></textarea>
        <div class="ni-form-footer">
          <span class="ni-charcount" id="${charId}">0 / ${maxLen}</span>
          <button class="btn btn-primary btn--primary ni-btn-guardar" id="${btnId}" disabled
            onclick="NotasInternas._onGuardar('${textaId}','${btnId}','${entidadTipo}','${entidadId}','${containerId}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Agregar nota
          </button>
        </div>
      </div>`;

    if (onGuardada) NotasInternas._guardarCallbacks[containerId] = onGuardada;
  }

  const _guardarCallbacks = {};

  function _onInput(textaId, charId, btnId, maxLen) {
    const ta  = document.getElementById(textaId);
    const ch  = document.getElementById(charId);
    const btn = document.getElementById(btnId);
    if (!ta) return;
    const len = ta.value.length;
    if (ch) ch.textContent = `${len} / ${maxLen}`;
    if (btn) btn.disabled = len < 1;
  }

  async function _onGuardar(textaId, btnId, entidadTipo, entidadId, containerId) {
    const ta  = document.getElementById(textaId);
    const btn = document.getElementById(btnId);
    if (!ta || !ta.value.trim()) return;

    const contenido = ta.value.trim();
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }

    try {
      const nota = await agregar(entidadTipo, entidadId, contenido);
      ta.value = '';
      _onInput(textaId, `ni-ch-${containerId}`, btnId, parseInt(ta.getAttribute('maxlength')) || 1000);

      const cb = _guardarCallbacks[containerId];
      if (cb) await cb(nota);

    } catch(e) {
      console.error('[NotasInternas] Error guardando:', e);
      window.toast('Error al guardar la nota: ' + e.message, 'danger');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Agregar nota'; }
    }
  }

  // ── CSS inyectado una sola vez ─────────────────────────────────────────
  function inyectarCSS() {
    if (document.getElementById('ni-styles')) return;
    const style = document.createElement('style');
    style.id = 'ni-styles';
    style.textContent = `
      /* ── Notas Internas — estilos compartidos ── */
      .ni-section-label {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: .06em;
        color: var(--color-text-muted, #5B6660);
        margin: 0 0 10px;
      }

      .ni-lista {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-bottom: 16px;
        max-height: 320px;
        overflow-y: auto;
      }

      .ni-nota {
        display: flex;
        gap: 10px;
        align-items: flex-start;
      }

      .ni-avatar {
        width: 30px;
        height: 30px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 700;
        flex-shrink: 0;
      }

      .ni-body {
        flex: 1;
        background: var(--color-bg, #F6F7F5);
        border: 1px solid var(--color-border, #DDE1DC);
        border-radius: 8px;
        padding: 9px 12px;
      }

      .ni-meta {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 5px;
      }

      .ni-autor {
        font-size: 12px;
        font-weight: 600;
        color: var(--color-text, #111A17);
      }

      .ni-ts {
        font-size: 11px;
        color: var(--color-text-muted, #5B6660);
        flex: 1;
      }

      .ni-archivar {
        background: none;
        border: none;
        cursor: pointer;
        color: var(--color-text-muted, #5B6660);
        padding: 2px 4px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        opacity: 0;
        transition: opacity .15s, color .12s;
      }

      .ni-nota:hover .ni-archivar {
        opacity: 1;
      }

      .ni-archivar:hover {
        color: var(--color-danger, #7A2820);
      }

      .ni-contenido {
        font-size: 13px;
        color: var(--color-text, #111A17);
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .ni-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        padding: 24px 0;
        color: var(--color-text-muted, #5B6660);
        font-size: 13px;
      }

      /* Form */
      .ni-form {
        margin-top: 4px;
      }

      .ni-textarea {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid var(--color-border, #DDE1DC);
        border-radius: 8px;
        padding: 10px 12px;
        font-size: 13px;
        font-family: inherit;
        color: var(--color-text, #111A17);
        background: var(--color-surface, #FFFFFF);
        resize: vertical;
        min-height: 72px;
        transition: border-color .15s;
        outline: none;
      }

      .ni-textarea:focus {
        border-color: var(--color-primary, #6A9873);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary, #6A9873) 12%, transparent);
      }

      .ni-form-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: 8px;
      }

      .ni-charcount {
        font-size: 11px;
        color: var(--color-text-muted, #5B6660);
      }

      .ni-btn-guardar {
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: 13px;
        padding: 7px 14px;
      }

      .ni-btn-guardar:disabled {
        opacity: .45;
        cursor: not-allowed;
      }

      /* Separador de sección */
      .ni-divider {
        border: none;
        border-top: 1px solid var(--color-border, #DDE1DC);
        margin: 16px 0;
      }
    `;
    document.head.appendChild(style);
  }

  // Auto-inyectar CSS al cargar el módulo
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inyectarCSS);
  } else {
    inyectarCSS();
  }

  // ── Exposición pública ─────────────────────────────────────────────────
  return {
    cargar,
    agregar,
    archivar,
    renderLista,
    renderForm,
    resetPaginacion,
    // Internos accesibles desde onclick inline
    _onArchivar,
    _onGuardar,
    _onInput,
    _callbacks,
    _guardarCallbacks,
    _cargarMas,
    _colapsar,
  };

})();

// Exponer globalmente
window.NotasInternas = NotasInternas;
