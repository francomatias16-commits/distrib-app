/**
 * adminlte-widgets.js — 5 Widgets avanzados para distribuidora
 * Pace Bar · Ribbon · Profile Card · Todo List · Kanban Board
 */

'use strict';

/* ══════════════════════════════════════════════════════════════════════
   FUNCIÓN 1 — PACE BAR
   Barra de progreso delgada en el top durante cargas fetch.
   Auto-integrado con window.fetch.
   Uso manual: PaceBar.start() / PaceBar.done()
   ══════════════════════════════════════════════════════════════════════ */
const PaceBar = window.PaceBar = (() => {
  let _bar, _fill, _spin, _t, _pct = 0;

  function _ensure() {
    if (_bar) return;
    _bar = document.createElement('div');
    _bar.className = 'pace-bar';
    _fill = document.createElement('div');
    _fill.className = 'pace-bar-fill';
    _bar.appendChild(_fill);
    _spin = document.createElement('div');
    _spin.className = 'pace-bar-spinner';
    document.body.prepend(_spin);
    document.body.prepend(_bar);
  }

  function set(pct) {
    _ensure();
    _pct = Math.min(99, pct);
    _fill.style.width = _pct + '%';
  }

  function start() {
    _ensure();
    set(0);
    _bar.classList.add('visible');
    _spin.classList.add('visible');
    clearInterval(_t);
    _t = setInterval(() => {
      const step = _pct < 30 ? 8 : _pct < 60 ? 4 : _pct < 80 ? 2 : 0.5;
      set(_pct + step);
      if (_pct >= 90) clearInterval(_t);
    }, 200);
  }

  function done() {
    clearInterval(_t);
    set(100);
    setTimeout(() => {
      if (_bar) _bar.classList.remove('visible');
      if (_spin) _spin.classList.remove('visible');
      setTimeout(() => { set(0); }, 300);
    }, 250);
  }

  // Auto-integrar con fetch global (sólo si no está ya wrapeado)
  if (typeof window !== 'undefined' && window.fetch && !window._paceWrapped) {
    window._paceWrapped = true;
    const _orig = window.fetch;
    let _pending = 0;
    window.fetch = function(...args) {
      if (_pending === 0) start();
      _pending++;
      return _orig.apply(this, args).finally(() => {
        _pending--;
        if (_pending === 0) done();
      });
    };
  }

  return { start, done, set };
})();


/* ══════════════════════════════════════════════════════════════════════
   FUNCIÓN 2 — RIBBON BADGE
   Bandera de esquina sobre una card.
   Uso: ribbonCard(cardEl, 'Sin stock', 'bg-danger')
        quitarRibbon(cardEl)
   ══════════════════════════════════════════════════════════════════════ */
function ribbonCard(cardEl, texto, colorClass = 'bg-danger', size = '') {
  cardEl.querySelectorAll('.ribbon-wrapper').forEach(e => e.remove());
  cardEl.classList.add('card-ribboned');
  const wrap = document.createElement('div');
  wrap.className = `ribbon-wrapper ${size}`.trim();
  wrap.innerHTML = `<div class="ribbon ${colorClass}">${texto}</div>`;
  cardEl.appendChild(wrap);
}
window.ribbonCard = ribbonCard;

function quitarRibbon(cardEl) {
  cardEl.querySelectorAll('.ribbon-wrapper').forEach(e => e.remove());
}
window.quitarRibbon = quitarRibbon;


/* ══════════════════════════════════════════════════════════════════════
   FUNCIÓN 3 — PROFILE CARD
   Card de perfil para clientes y proveedores.
   Uso: ProfileCard.render(containerEl, datos)
   ══════════════════════════════════════════════════════════════════════ */
const ProfileCard = window.ProfileCard = {
  /**
   * datos = {
   *   nombre, rol, score ('A'|'B'|'C'|'D'), bannerColor,
   *   stats: [{label, value}, ...],
   *   lista: [{label, value}, ...],
   *   acciones: [{label, icon, onclick, variant}, ...]
   * }
   */
  render(container, datos = {}) {
    const {
      nombre = '—', rol = '', score = null,
      bannerColor = '', stats = [], lista = [], acciones = []
    } = datos;

    // XSS: nombre/rol/stats/lista vienen de datos de cliente/proveedor
    // (razón social, zona, vendedor, etc.) — nunca confiar en ellos sin
    // escapar antes de insertarlos en innerHTML (mismo patrón que el
    // resto del proyecto, ver window.sanitize en ui-utils.js).
    const _esc = (str) => {
      if (str === null || str === undefined) return '';
      const d = document.createElement('div');
      d.textContent = String(str);
      return d.innerHTML;
    };

    const iniciales = nombre.trim().split(/\s+/).slice(0, 2)
      .map(w => w[0]).join('').toUpperCase() || '?';

    const scoreHtml = score
      ? `<span class="score-badge score-${_esc(score.toLowerCase())}">${_esc(score)}</span>`
      : '';

    const statsHtml = stats.length ? `
      <div class="profile-stats">
        ${stats.map(s => `
          <div class="profile-stat">
            <span class="profile-stat-value">${_esc(s.value)}</span>
            <span class="profile-stat-label">${_esc(s.label)}</span>
          </div>`).join('')}
      </div>` : '';

    const listaHtml = lista.length ? `
      <ul class="profile-list">
        ${lista.map(li => `
          <li class="profile-list-item">
            <span class="profile-list-label">${_esc(li.label)}</span>
            <span class="profile-list-value">${_esc(li.value)}</span>
          </li>`).join('')}
      </ul>` : '';

    const accionesHtml = acciones.length ? `
      <div class="profile-card-actions">
        ${acciones.map(a => `
          <button class="btn btn--${_esc(a.variant || 'outline-primary')} btn--sm"
            onclick="${a.onclick || ''}">
            ${a.icon || ''} ${_esc(a.label)}
          </button>`).join('')}
      </div>` : '';

    container.innerHTML = `
      <div class="profile-card">
        <div class="profile-card-banner ${_esc(bannerColor)}">
          <div class="profile-card-avatar">${_esc(iniciales)}</div>
        </div>
        <div class="profile-card-body">
          <div class="profile-card-name">${_esc(nombre)}</div>
          <div class="profile-card-role">${_esc(rol)} ${scoreHtml}</div>
          ${statsHtml}
          ${listaHtml}
        </div>
        ${accionesHtml}
      </div>`;
  }
};


/* ══════════════════════════════════════════════════════════════════════
   FUNCIÓN 4 — TODO LIST
   Lista de tareas interactiva con checkboxes y agregar/eliminar.
   Uso: const todo = new TodoList(containerEl, items, onCambio)
   items = [{texto, hecho, color, meta}, ...]
   ══════════════════════════════════════════════════════════════════════ */
class TodoList {
  #container; #items; #onCambio;

  constructor(container, items = [], onCambio = null) {
    this.#container = container;
    this.#items = items.map((it, i) => ({ id: Date.now() + i, ...it }));
    this.#onCambio = onCambio;
    this.#render();
  }

  #render() {
    const ul = document.createElement('ul');
    ul.className = 'todo-list';

    this.#items.forEach(item => {
      const li = document.createElement('li');
      li.className = `todo-item todo-${item.color || 'primary'}${item.hecho ? ' completado' : ''}`;
      li.dataset.id = item.id;
      li.innerHTML = `
        <span class="todo-drag-handle" title="Reordenar">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
            <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
          </svg>
        </span>
        <input type="checkbox" class="todo-checkbox" ${item.hecho ? 'checked' : ''}>
        <span class="todo-text">${this.#esc(item.texto)}</span>
        ${item.meta ? `<span class="todo-meta">${this.#esc(item.meta)}</span>` : ''}
        <button class="btn-tool" data-del="${item.id}" title="Eliminar"
          style="margin-left:auto;flex-shrink:0;background:none;border:none;cursor:pointer;color:var(--color-text-light);padding:2px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      `;

      li.querySelector('.todo-checkbox').addEventListener('change', (e) => {
        item.hecho = e.target.checked;
        li.classList.toggle('completado', item.hecho);
        this.#onCambio?.(this.#items);
      });

      li.querySelector('[data-del]').addEventListener('click', () => {
        this.#items = this.#items.filter(i => i.id !== item.id);
        li.remove();
        this.#onCambio?.(this.#items);
      });

      ul.appendChild(li);
    });

    // Fila para agregar nueva tarea
    const addRow = document.createElement('div');
    addRow.className = 'todo-add-row';
    addRow.innerHTML = `
      <input type="text" class="todo-add-input" placeholder="Agregar tarea…">
      <button class="btn btn--primary btn--sm" style="flex-shrink:0;">+</button>
    `;
    const input = addRow.querySelector('input');
    const agregar = () => {
      const texto = input.value.trim();
      if (!texto) return;
      const nuevo = { id: Date.now(), texto, hecho: false, color: 'primary' };
      this.#items.push(nuevo);
      input.value = '';
      this.#container.innerHTML = '';
      this.#render();
      this.#onCambio?.(this.#items);
    };
    addRow.querySelector('button').addEventListener('click', agregar);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') agregar(); });

    this.#container.innerHTML = '';
    this.#container.appendChild(ul);
    this.#container.appendChild(addRow);
  }

  #esc(str) {
    return String(str).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  getItems() { return this.#items; }
  getPendientes() { return this.#items.filter(i => !i.hecho).length; }
}


/* ══════════════════════════════════════════════════════════════════════
   FUNCIÓN 5 — KANBAN BOARD
   Tablero de estados de pedidos con drag & drop nativo.
   Uso: const board = new KanbanBoard(containerEl, columnas, onMover)
   columnas = [{id, label, icono, items:[{id, titulo, monto, hora, tags}]}]
   onMover(itemId, colOrigen, colDestino)
   ══════════════════════════════════════════════════════════════════════ */
class KanbanBoard {
  #container; #columnas; #onMover; #dragging = null;

  constructor(container, columnas = [], onMover = null) {
    this.#container = container;
    this.#columnas = columnas;
    this.#onMover = onMover;
    this.#render();
  }

  #render() {
    const board = document.createElement('div');
    board.className = 'kanban-board';

    this.#columnas.forEach(col => {
      const colEl = document.createElement('div');
      colEl.className = `kanban-col col-${col.id}`;
      colEl.innerHTML = `
        <div class="kanban-col-header">
          <span class="kanban-col-title">${col.icono || ''} ${col.label}</span>
          <span class="kanban-col-count">${col.items?.length || 0}</span>
        </div>
        <div class="kanban-col-body" data-col="${col.id}"></div>
      `;

      const body = colEl.querySelector('.kanban-col-body');
      (col.items || []).forEach(item => body.appendChild(this.#crearCard(item, col.id)));

      body.addEventListener('dragover', e => {
        e.preventDefault();
        body.classList.add('drag-over');
      });
      body.addEventListener('dragleave', () => body.classList.remove('drag-over'));
      body.addEventListener('drop', e => {
        e.preventDefault();
        body.classList.remove('drag-over');
        if (!this.#dragging) return;
        const { cardEl, origenCol, itemId } = this.#dragging;
        const destCol = body.dataset.col;
        if (origenCol === destCol) { this.#dragging = null; return; }
        body.appendChild(cardEl);
        cardEl.classList.remove('dragging');
        this.#actualizarContadores(board);
        this.#onMover?.(itemId, origenCol, destCol);
        this.#dragging = null;
      });

      board.appendChild(colEl);
    });

    this.#container.innerHTML = '';
    this.#container.appendChild(board);
  }

  #crearCard(item, colId) {
    const card = document.createElement('div');
    card.className = 'kanban-card';
    card.draggable = true;
    card.dataset.id = item.id;

    const tagsHtml = item.tags?.length
      ? `<div class="kanban-card-tags">${item.tags.map(t =>
          `<span class="kanban-tag">${t}</span>`).join('')}</div>`
      : '';

    card.innerHTML = `
      <div class="kanban-card-title">${item.titulo || item.cliente || '—'}</div>
      <div class="kanban-card-meta">
        <span>${item.hora || item.fecha || ''}</span>
        <span class="kanban-card-amount">${item.monto || ''}</span>
      </div>
      ${tagsHtml}
    `;

    card.addEventListener('dragstart', () => {
      card.classList.add('dragging');
      this.#dragging = { cardEl: card, origenCol: colId, itemId: item.id };
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));

    return card;
  }

  #actualizarContadores(board) {
    board.querySelectorAll('.kanban-col').forEach(col => {
      const count = col.querySelector('.kanban-col-count');
      if (count) count.textContent = col.querySelectorAll('.kanban-card').length;
    });
  }

  actualizar(columnas) {
    this.#columnas = columnas;
    this.#render();
  }
}
window.KanbanBoard = KanbanBoard;
// XSS: helper para armar de forma segura argumentos de string dentro de
// atributos onclick="funcion('...')" cuando el valor viene de datos de
// usuario (teléfono, nombre, etc.). JSON.stringify escapa correctamente
// comillas/backslashes para el string JS, y el resto escapa lo necesario
// para el atributo HTML que lo contiene (", &, <, >). Ver uso en
// ProfileCard (botón WhatsApp) — no confiar nunca en '${valor}' a mano
// dentro de un onclick.
function onclickArg(valor) {
  return JSON.stringify(String(valor ?? ''))
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
window.onclickArg = onclickArg;

export { PaceBar, ribbonCard, quitarRibbon, ProfileCard, TodoList, KanbanBoard, onclickArg };
