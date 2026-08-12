// frontend/admin/js/producto-picker.js
// REQ-06: Buscador visual de productos para modales de Pedido y Presupuesto.
// Expone window.ProductoPicker — se monta en cualquier contenedor dado.
//
// Uso:
//   const picker = new ProductoPicker(container, { onAgregar(item){} });
//   await picker.init(sb, empresa_id);
//   picker.reset();

(function () {

class ProductoPicker {
  /**
   * @param {HTMLElement} container
   * @param {{ onAgregar: function({producto_id,descripcion,cantidad,precio_unitario,descuento,unidad}) }} opts
   */
  constructor(container, opts = {}) {
    this.container   = container;
    this.onAgregar   = opts.onAgregar || (() => {});
    this._sb         = null;
    this._empresaId  = null;
    this._productos  = [];
    this._categorias = [];
    this._catActiva  = '';
    this._q          = '';
    this._debounce   = null;
    this._frecuentes = [];   // ids de producto ordenados por frecuencia (del cliente activo)
    this._vista      = 'grid'; // 'grid' (tarjetas, una por una) | 'lista' (planilla, carga varias y agrega todas juntas)
  }

  // ── init: cargar datos y pintar ─────────────────────────────────────────
  async init(sb, empresa_id) {
    this._sb        = sb;
    this._empresaId = empresa_id;
    this._renderShell();
    await Promise.all([this._cargarCategorias(), this._cargarProductos()]);
  }

  // REQ-AGIL: productos frecuentes de un cliente puntual (calculados por el
  // caller a partir del historial de pedidos). Si hay al menos uno, se
  // activa automáticamente el chip "⭐ Frecuentes" — así, apenas se elige
  // el cliente, el grid ya muestra lo que ese cliente suele pedir, sin
  // tener que escribir nada en el buscador.
  setFrecuentes(ids) {
    this._frecuentes = Array.isArray(ids) ? ids.filter(Boolean) : [];
    this._pintarChips();
    if (this._frecuentes.length) {
      this._catActiva = '__frec__';
      this._q = '';
      const inp = this.container.querySelector('.pp-input');
      if (inp) inp.value = '';
    } else if (this._catActiva === '__frec__') {
      this._catActiva = '';
    }
    this._activarChip(this._catActiva);
    this._pintarGrid();
  }

  reset() {
    this._q         = '';
    this._catActiva = '';
    this._frecuentes = [];
    const inp = this.container.querySelector('.pp-input');
    if (inp) inp.value = '';
    this._activarChip('');
    this._pintarChips();
    this._pintarGrid();
    this._focusInput();
  }

  // REQ-AGIL: foco automático en el buscador — el flujo típico es
  // "escribir código/nombre → Enter" sin tocar el mouse. Público porque
  // init()/reset() corren mientras el modal contenedor sigue con
  // display:none (se destapa recién después, en el caller) — un .focus()
  // sobre un input oculto no hace nada, así que el caller debe invocar
  // picker.focus() una vez que el modal ya es visible.
  focus() {
    const inp = this.container.querySelector('.pp-input');
    if (inp) requestAnimationFrame(() => inp.focus());
  }
  _focusInput() { this.focus(); }

  // ── Shell HTML ───────────────────────────────────────────────────────────
  _renderShell() {
    this.container.innerHTML = `
      <div class="pp-wrap">
        <div class="pp-search-row">
          <div class="pp-search-box">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input class="pp-input" type="text" placeholder="Buscar por nombre o código…" autocomplete="off"/>
          </div>
          <div class="pp-view-toggle" role="group" aria-label="Vista">
            <button type="button" class="pp-view-btn pp-view-btn--activa" data-vista="grid" title="Tarjetas: agregar de a un producto">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
            </button>
            <button type="button" class="pp-view-btn" data-vista="lista" title="Lista rápida: cargar varias cantidades y agregar todo junto">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
            </button>
          </div>
        </div>
        <div class="pp-chips" id="pp-chips-${this._uid()}"></div>
        <div class="pp-grid"  id="pp-grid-${this._uid()}">
          <div class="pp-loading">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="pp-spin"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
            Cargando productos…
          </div>
        </div>
        <div class="pp-lista-footer" id="pp-lista-footer-${this._uid()}" style="display:none">
          <span class="pp-lista-footer-hint">Cargá cantidades y confirmá — se agregan todas juntas</span>
          <button type="button" class="pp-btn-agregar-varios" disabled>Agregar seleccionados</button>
        </div>
      </div>`;

    // guardar refs a los nodos con IDs únicos
    this._chipsEl  = this.container.querySelector('[id^="pp-chips-"]');
    this._gridEl   = this.container.querySelector('[id^="pp-grid-"]');
    this._footerEl = this.container.querySelector('[id^="pp-lista-footer-"]');

    this.container.querySelectorAll('.pp-view-btn').forEach(btn =>
      btn.addEventListener('click', () => this._setVista(btn.dataset.vista))
    );

    this._footerEl.querySelector('.pp-btn-agregar-varios').addEventListener('click', () => this._agregarVarios());

    const inp = this.container.querySelector('.pp-input');
    inp.addEventListener('input', e => {
      clearTimeout(this._debounce);
      this._debounce = setTimeout(() => {
        this._q = e.target.value.trim().toLowerCase();
        this._pintarGrid();
      }, 180);
    });

    // REQ-AGIL: Enter = agregar sin soltar el teclado. Si la búsqueda actual
    // (aplicando ya el valor recién tipeado, sin esperar el debounce) deja
    // un único producto, se agrega con cantidad 1 y se limpia el buscador
    // para seguir cargando el próximo ítem. Si hay más de un resultado no
    // se adivina cuál quiso decir el usuario: no hace nada (evita agregar
    // el producto equivocado).
    inp.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      clearTimeout(this._debounce);
      this._q = inp.value.trim().toLowerCase();
      const lista = this._filtrar();
      if (lista.length === 1) {
        this._agregar(lista[0], 1);
        this._q = '';
        inp.value = '';
        this._pintarGrid();
        this._flashInput();
      } else {
        this._pintarGrid();
      }
    });

    this._focusInput();
  }

  _flashInput() {
    const box = this.container.querySelector('.pp-search-box');
    if (!box) return;
    box.classList.add('pp-search-box--ok');
    setTimeout(() => box.classList.remove('pp-search-box--ok'), 400);
  }

  _uid() {
    if (!this.__uid) this.__uid = Math.random().toString(36).slice(2, 7);
    return this.__uid;
  }

  // ── Cargar datos ─────────────────────────────────────────────────────────
  async _cargarCategorias() {
    try {
      const { data, error } = await this._sb.from('categorias')
        .select('id, nombre')
        .eq('empresa_id', this._empresaId)
        .eq('activa', true)
        .order('orden');
      if (error) { console.warn('[ProductoPicker] categorias:', error.message); return; }
      this._categorias = data || [];
      this._pintarChips();
    } catch (e) { console.warn('[ProductoPicker] categorias:', e.message); /* sin categorías: el picker igual funciona */ }
  }

  // FIX: antes solo se desestructuraba `data` — si la query fallaba (RLS,
  // columna inexistente, sesión sin empresa_id válido, etc.) supabase-js
  // NO tira excepción, devuelve {data:null, error:{...}} — así que el catch
  // nunca se disparaba y `data || []` dejaba el grid vacío silenciosamente,
  // indistinguible de "no tenés productos". Ahora se muestra el motivo real
  // y un botón para reintentar.
  async _cargarProductos() {
    if (this._gridEl) {
      this._gridEl.innerHTML = `
        <div class="pp-loading">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="pp-spin"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
          Cargando productos…
        </div>`;
    }
    try {
      const { data, error } = await this._sb.from('productos')
        .select('id, codigo, nombre, unidad, precio_base, categoria_id, foto_url, activo')
        .eq('empresa_id', this._empresaId)
        .eq('activo', true)
        .order('nombre');
      if (error) throw error;
      this._productos = data || [];
      this._pintarGrid();
    } catch (e) {
      console.error('[ProductoPicker] No se pudieron cargar los productos:', e);
      if (this._gridEl) this._gridEl.innerHTML = `
        <div class="pp-empty">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:.4;margin-bottom:4px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span>No se pudieron cargar los productos${e?.message ? `: ${_esc(e.message)}` : '.'}</span>
          <button type="button" class="pp-btn-retry">Reintentar</button>
        </div>`;
      this._gridEl?.querySelector('.pp-btn-retry')?.addEventListener('click', () => this._cargarProductos());
    }
  }

  // ── Cache pública para diagnóstico rápido desde la consola ──────────────
  // (window.__ppUltimoError queda seteado si algo falló — evita tener que
  // reproducir el bug con el inspector abierto para ver el motivo real).

  // ── Chips ────────────────────────────────────────────────────────────────
  _pintarChips() {
    if (!this._chipsEl) return;
    if (!this._categorias.length && !this._frecuentes.length) { this._chipsEl.innerHTML = ''; return; }
    const chipFrec = this._frecuentes.length
      ? `<button class="pp-chip pp-chip--frec" data-id="__frec__">⭐ Frecuentes de este cliente</button>`
      : '';
    this._chipsEl.innerHTML = chipFrec +
      `<button class="pp-chip" data-id="">Todos</button>` +
      this._categorias.map(c =>
        `<button class="pp-chip" data-id="${c.id}">${_esc(c.nombre)}</button>`
      ).join('');
    this._chipsEl.querySelectorAll('.pp-chip').forEach(btn =>
      btn.addEventListener('click', () => {
        this._catActiva = btn.dataset.id;
        this._activarChip(btn.dataset.id);
        this._pintarGrid();
      })
    );
    this._activarChip(this._catActiva);
  }

  _activarChip(id) {
    this._chipsEl?.querySelectorAll('.pp-chip').forEach(b =>
      b.classList.toggle('pp-chip--activa', b.dataset.id === id)
    );
  }

  // ── Grid ─────────────────────────────────────────────────────────────────
  _filtrar() {
    let lista;
    if (this._catActiva === '__frec__' && this._frecuentes.length) {
      const porId = new Map(this._productos.map(p => [p.id, p]));
      lista = this._frecuentes.map(id => porId.get(id)).filter(Boolean);
    } else {
      lista = this._productos;
      if (this._catActiva) lista = lista.filter(p => String(p.categoria_id) === String(this._catActiva));
    }
    if (this._q) {
      const q = this._q;
      lista = lista.filter(p =>
        (p.nombre || '').toLowerCase().includes(q) ||
        (p.codigo || '').toLowerCase().includes(q)
      );
    }
    return lista;
  }

  // ── Vista tarjetas / lista ───────────────────────────────────────────────
  _setVista(v) {
    if (this._vista === v) return;
    this._vista = v;
    this.container.querySelectorAll('.pp-view-btn').forEach(b =>
      b.classList.toggle('pp-view-btn--activa', b.dataset.vista === v)
    );
    this._pintarGrid();
  }

  // ── Agregar (compartido por click en la card y por el atajo Enter) ──────
  _agregar(p, cant) {
    this.onAgregar({
      producto_id:     p.id,
      descripcion:     p.nombre,
      cantidad:        cant,
      precio_unitario: Number(p.precio_base || 0),
      descuento:       0,
      unidad:          p.unidad || 'unidad',
    });
  }

  // REQ-AGIL: núcleo del modo "Lista" — carga muchas cantidades de un
  // tirón (tabulando entre filas) y las agrega todas juntas con un solo
  // click, en vez de tener que buscar-cargar-confirmar producto por
  // producto. Pensado para armar un pedido grande desde cero.
  _pintarLista(lista) {
    const frag = document.createDocumentFragment();
    lista.forEach(p => {
      const precio = Number(p.precio_base || 0);
      const row = document.createElement('div');
      row.className = 'pp-list-row';
      row.innerHTML = `
        <div class="pp-list-info">
          <div class="pp-list-nombre">${_esc(p.nombre)}</div>
          <div class="pp-list-meta">${p.codigo ? _esc(p.codigo) + ' · ' : ''}${_esc(p.unidad || 'unidad')} · $${_fmt(precio)}</div>
        </div>
        <input class="pp-list-cant" type="number" min="0" step="1" inputmode="numeric" placeholder="0" aria-label="Cantidad de ${_esc(p.nombre)}"/>
      `;
      const cantInp = row.querySelector('.pp-list-cant');
      cantInp.dataset.productoId = p.id;
      // FIX: solo números enteros — antes se podían cargar decimales
      // (tipeados a mano, o con el step de a .001 en otro campo) y quedaban
      // cantidades como "1,006" en el pedido. _soloEnteros descarta
      // cualquier caracter que no sea dígito apenas se tipea.
      cantInp.addEventListener('input', () => { _soloEnteros(cantInp); this._actualizarFooterLista(); });
      // Enter salta a la fila siguiente (carga tipo planilla); en la última fila, agrega todo.
      cantInp.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const filas = Array.from(this._gridEl.querySelectorAll('.pp-list-cant'));
        const i = filas.indexOf(cantInp);
        if (i >= 0 && i < filas.length - 1) filas[i + 1].focus();
        else this._agregarVarios();
      });
      // FIX: antes había que acordarse de tocar "Agregar seleccionados" para
      // que la cantidad tipeada realmente entrara al pedido — si el usuario
      // pasaba directo a "Crear pedido" sin ese paso, quedaba todo sin
      // agregar y sin ninguna pista visible. Ahora, al salir del campo
      // (tab, click afuera, etc.) con una cantidad cargada, se agrega solo,
      // igual que ya pasaba al tipear Enter en la vista Tarjetas.
      cantInp.addEventListener('blur', () => {
        const cant = parseInt(cantInp.value, 10);
        if (!(cant > 0)) return;
        this._agregar(p, cant);
        cantInp.value = '';
        row.classList.add('pp-list-row--agregada');
        setTimeout(() => row.classList.remove('pp-list-row--agregada'), 700);
        this._actualizarFooterLista();
      });
      frag.appendChild(row);
    });
    this._gridEl.innerHTML = '';
    this._gridEl.appendChild(frag);
    this._actualizarFooterLista();
  }

  _actualizarFooterLista() {
    if (!this._footerEl) return;
    const filas = Array.from(this._gridEl.querySelectorAll('.pp-list-cant'));
    const n = filas.filter(i => parseInt(i.value, 10) > 0).length;
    const btn = this._footerEl.querySelector('.pp-btn-agregar-varios');
    if (!btn) return;
    btn.disabled = n === 0;
    btn.classList.remove('pp-btn-add--ok');
    btn.textContent = n > 0 ? `Agregar ${n} producto${n === 1 ? '' : 's'}` : 'Agregar seleccionados';
  }

  _agregarVarios() {
    if (!this._gridEl) return;
    const filas = Array.from(this._gridEl.querySelectorAll('.pp-list-cant'));
    const porId = new Map(this._productos.map(p => [p.id, p]));
    let n = 0;
    filas.forEach(inp => {
      const cant = parseInt(inp.value, 10);
      if (cant > 0) {
        const p = porId.get(inp.dataset.productoId);
        if (p) { this._agregar(p, cant); n++; }
        inp.value = '';
      }
    });
    const btn = this._footerEl?.querySelector('.pp-btn-agregar-varios');
    if (n && btn) {
      btn.textContent = `✓ Se agregaron ${n}`;
      btn.classList.add('pp-btn-add--ok');
      setTimeout(() => this._actualizarFooterLista(), 900);
    } else {
      this._actualizarFooterLista();
    }
  }

  _pintarGrid() {
    if (!this._gridEl) return;
    const esLista = this._vista === 'lista';
    this._gridEl.classList.toggle('pp-grid--lista', esLista);
    const lista = this._filtrar();

    if (!lista.length) {
      this._gridEl.innerHTML = `
        <div class="pp-empty">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:.3;margin-bottom:6px">
            <rect x="3" y="7" width="18" height="13" rx="2"/><path d="M3 7l2-4h14l2 4"/><path d="M9 11v3M15 11v3"/>
          </svg>
          <span>Sin productos para ese criterio.</span>
        </div>`;
      if (this._footerEl) this._footerEl.style.display = 'none';
      return;
    }

    if (esLista) {
      if (this._footerEl) this._footerEl.style.display = 'flex';
      this._pintarLista(lista);
      return;
    }
    if (this._footerEl) this._footerEl.style.display = 'none';

    const frag = document.createDocumentFragment();
    lista.forEach(p => {
      const card  = document.createElement('div');
      card.className = 'pp-card';
      const precio = Number(p.precio_base || 0);
      card.innerHTML = `
        <div class="pp-card-img">
          ${p.foto_url
            ? `<img src="${_esc(p.foto_url)}" alt="" loading="lazy">`
            : `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:.25"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M3 7l2-4h14l2 4"/></svg>`}
        </div>
        <div class="pp-card-body">
          <div class="pp-card-nombre">${_esc(p.nombre)}</div>
          ${p.codigo ? `<div class="pp-card-codigo">${_esc(p.codigo)}</div>` : ''}
          <div class="pp-card-meta">${_esc(p.unidad || 'unidad')}</div>
          <div class="pp-card-precio">$${_fmt(precio)}</div>
        </div>
        <div class="pp-card-add">
          <input class="pp-cant" type="number" min="1" step="1" inputmode="numeric" value="1" aria-label="Cantidad"/>
          <button class="pp-btn-add">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Agregar
          </button>
        </div>`;

      const cantInp = card.querySelector('.pp-cant');
      cantInp.addEventListener('input', () => _soloEnteros(cantInp));
      const doAgregar = () => {
        const cant = parseInt(cantInp.value, 10) || 1;
        this._agregar(p, cant);
        // feedback
        const btn = card.querySelector('.pp-btn-add');
        btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Agregado';
        btn.classList.add('pp-btn-add--ok');
        setTimeout(() => {
          btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Agregar';
          btn.classList.remove('pp-btn-add--ok');
        }, 1000);
      };

      card.querySelector('.pp-btn-add').addEventListener('click', doAgregar);
      // REQ-AGIL: Enter en el campo de cantidad agrega sin ir a buscar el botón con el mouse
      cantInp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); doAgregar(); }
      });

      frag.appendChild(card);
    });
    this._gridEl.innerHTML = '';
    this._gridEl.appendChild(frag);
  }
}

function _esc(s) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(s);
}
function _fmt(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// FIX: cantidades solo enteras — descarta cualquier caracter que no sea
// dígito a medida que se tipea (bloquea '.', ',', '-', 'e', etc., que un
// <input type="number"> igual deja pasar en varios navegadores).
function _soloEnteros(inp) {
  const limpio = inp.value.replace(/[^\d]/g, '');
  if (limpio !== inp.value) inp.value = limpio;
}

window.ProductoPicker = ProductoPicker;

})();
