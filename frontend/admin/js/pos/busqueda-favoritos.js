// frontend/admin/js/pos/busqueda-favoritos.js
// Parte del split de frontend/admin/js/pos.js (25/08/2026) — Buscador de productos y favoritos.
// Se carga como <script> clásico (no ES module) en pos.html, en el mismo
// orden que ocupaba en el archivo original, para preservar el scope global
// compartido entre secciones (variables de estado, funciones window.*).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

// ── "Sacar" el cursor del buscador cuando queda ocioso y vacío ─────────────
// El buscador se auto-enfoca (autofocus + refocus tras cada producto
// agregado) para que un lector de código de barras físico pueda escanear
// sin que el cajero tenga que clickear antes — eso hay que mantenerlo, si
// no un escaneo con el foco en otro lado se pierde. El problema es que
// mientras ese foco está puesto, los atajos de dígito (1-0, el respaldo de
// F1-F10 en notebooks donde la fila F no llega al navegador — ver v752)
// quedan bloqueados, porque un dígito ahí tiene que poder escribirse como
// parte de un código, no disparar una acción.
// Solución: si el campo queda vacío (nada escaneado ni tipeado) durante
// más de este tiempo, se le saca el foco solo. Un escaneo real llena el
// campo casi al instante y dispara 'input' en cada tecla, así que
// reinicia el timer constantemente mientras está en curso — nunca llega a
// dispararse en medio de un escaneo. Con el campo vacío y quieto (recién
// terminó de vender, o todavía no arrancó) el cursor sale solo y los
// dígitos quedan libres para actuar como atajo. Si el campo tiene texto
// (el cajero está buscando por nombre y se detuvo a pensar/leer
// resultados) no se toca — solo aplica con el campo vacío.
const _POS_BLUR_BUSCADOR_OCIOSO_MS = 1500;
let _blurBuscadorTimer = null;
function _programarBlurBuscadorSiOcioso() {
  clearTimeout(_blurBuscadorTimer);
  if (inputProducto.value.trim()) return; // hay texto: no se toca el foco
  _blurBuscadorTimer = setTimeout(() => {
    if (document.activeElement === inputProducto && !inputProducto.value.trim()) {
      inputProducto.blur();
    }
  }, _POS_BLUR_BUSCADOR_OCIOSO_MS);
}
inputProducto?.addEventListener('focus', _programarBlurBuscadorSiOcioso);
inputProducto?.addEventListener('input', _programarBlurBuscadorSiOcioso);
inputProducto?.addEventListener('blur', () => clearTimeout(_blurBuscadorTimer));

// Red de seguridad final: si por lo que sea (lector físico levantando el QR
// de la pantalla, pegado manual, etc.) llega acá el propio link de
// "Vincular celular" en vez de un código de producto, se corta antes de
// pegarle a la API — nunca va a existir un producto con ese "código".
const RE_LINK_VINCULAR_CELULAR = /\/scan-pos(?:[/?]|$)/i;

async function buscarProductos(q, porEnter) {
  if (RE_LINK_VINCULAR_CELULAR.test(q)) {
    if (porEnter) {
      inputProducto.value = '';
      renderResultados([]);
      window.mostrarToast?.('Ese es el link de "Vincular celular", no un código de producto.', 'default', 3500);
    }
    return;
  }

  // ── Offline: usar caché local si no hay red ───────────────────────────────
  if (window.PosOffline && !window.PosOffline.estaOnline()) {
    try {
      const resultados = await window.PosOffline.buscarProductosLocal(q);
      if (porEnter && resultados.length === 1) {
        agregarAlCarrito(resultados[0]);
        inputProducto.value = '';
        renderResultados([]);
        return;
      }
      if (porEnter && resultados.length === 0) {
        pitarError();
        window.mostrarToast(`No se encontró "${q}" en el catálogo local`, 'error', 4000);
      } else if (porEnter && resultados.length > 1) {
        window.mostrarToast('Hay varias coincidencias — elegí una de la lista', 'default');
      }
      renderResultados(resultados);
    } catch (e) {
      pitarError();
      window.mostrarToast('Error al buscar en caché local', 'error');
    }
    return;
  }

  // ── Online: búsqueda normal en la API ────────────────────────────────────
  try {
    const params = new URLSearchParams({ q });
    if (cajaActual?.id) params.set('caja_id', cajaActual.id);
    if (clienteSel?.lista_precio_id) params.set('lista_precio_id', clienteSel.lista_precio_id);

    const resultados = await apiGet(`/api/pos/productos?${params.toString()}`);

    // Aprovechar la búsqueda para refrescar el caché local con los resultados
    if (window.PosOffline && resultados.length > 0) {
      window.PosOffline.cachearProductos(resultados).catch(() => {});
    }

    if (porEnter && resultados.length === 1) {
      agregarAlCarrito(resultados[0]);
      inputProducto.value = '';
      renderResultados([]);
      return;
    }
    if (porEnter && resultados.length === 0) {
      pitarError();
      window.mostrarToast(`No se encontró ningún producto con el código "${q}"`, 'error', 4000);
    } else if (porEnter && resultados.length > 1) {
      window.mostrarToast('Hay varias coincidencias — elegí una de la lista', 'default');
    }

    renderResultados(resultados);
  } catch (e) {
    // Si hay error de red, intentar con caché local como fallback
    if (window.PosOffline) {
      try {
        const resultados = await window.PosOffline.buscarProductosLocal(q);
        if (resultados.length > 0) {
          window.mostrarToast('Usando catálogo local (sin conexión)', 'warning', 3000);
          renderResultados(resultados);
          return;
        }
      } catch (_) {}
    }
    pitarError();
    console.error(e);
    window.mostrarToast('Error al buscar productos', 'error');
  }
}

function renderResultados(items) {
  const cont = document.getElementById('pos-resultados');
  if (!items.length) {
    cont.innerHTML = '<p class="pos-resultados-vacio">Escaneá un código de barras o escribí para buscar productos.</p>';
    return;
  }
  cont.innerHTML = items.map(p => {
    const stock = p.stock_disponible;
    let badge = '';
    if (stock !== null && stock !== undefined) {
      const cls = stock <= 0 ? 'sin' : (stock < 5 ? 'bajo' : 'ok');
      badge = `<span class="pos-producto-stock ${cls}">${stock <= 0 ? 'Sin stock' : `Stock: ${stock}`}</span>`;
    }
    const sinStock = stock !== null && stock !== undefined && stock <= 0;
    return `
      <div class="pos-producto-card ${sinStock ? 'sin-stock' : ''}" data-id="${p.id}">
        <div class="pos-producto-info">
          <span class="pos-producto-nombre">${escapeHtml(p.nombre)}</span>
          <span class="pos-producto-meta">${escapeHtml(p.codigo || '')} · ${escapeHtml(p.unidad || 'un')}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          ${badge}
          <span class="pos-producto-precio">${fmt(p.precio)}</span>
        </div>
      </div>`;
  }).join('');

  cont.querySelectorAll('.pos-producto-card').forEach(el => {
    el.addEventListener('click', () => {
      const item = items.find(p => p.id === el.dataset.id);
      if (item) agregarAlCarrito(item);
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
// Fase 2 — ítem 13: Grilla de favoritos
// ══════════════════════════════════════════════════════════════════════════
async function cargarFavoritos() {
  try {
    const qs = cajaActual?.id ? `?caja_id=${cajaActual.id}` : '';
    const favs = await apiGet(`/api/pos/favoritos${qs}`);
    renderGrillaFavoritos(favs);
    favoritosCargados = true;
  } catch (_e) {
    // favoritos es opcional — si falla no interrumpe el flujo
  }
}

function renderGrillaFavoritos(favs) {
  const cont = document.getElementById('pos-grilla-favoritos');
  if (!cont) return;

  if (!favs || !favs.length) {
    cont.innerHTML = '<p class="pos-fav-vacio">Sin favoritos configurados. Podés agregar productos frecuentes desde Administrar → Favoritos.</p>';
    return;
  }

  cont.innerHTML = favs.map(f => {
    const color = f.color || 'var(--nav-ventas, #487050)';
    const etiqueta = f.etiqueta || f.nombre || 'Producto';
    return `
      <button class="pos-fav-btn" data-id="${f.producto_id}" data-fav='${JSON.stringify(f)}'
              style="--fav-color:${escapeHtml(color)}" title="${escapeHtml(etiqueta)}">
        <span class="pos-fav-nombre">${escapeHtml(etiqueta)}</span>
        <span class="pos-fav-precio">${fmt(f.precio)}</span>
      </button>`;
  }).join('');

  cont.querySelectorAll('.pos-fav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const f = JSON.parse(btn.dataset.fav);
      agregarAlCarrito({
        id: f.producto_id,
        nombre: f.etiqueta || f.nombre,
        codigo: f.codigo || '',
        precio: f.precio,
        iva: f.iva ?? 21,
        unidad: f.unidad || 'un',
        stock_disponible: f.stock_disponible ?? 9999, // favorito: si no hay dato, se permite (avisa RPC)
      });
    });
  });
}

// Gestión de favoritos — panel Admin → pestaña Favoritos
async function cargarFavoritosAdmin() {
  const cont = document.getElementById('pos-fav-admin-lista');
  if (!cont) return;
  cont.innerHTML = '<p class="pos-resultados-vacio">Cargando...</p>';
  try {
    const favs = await apiGet('/api/pos/favoritos');
    renderFavoritosAdmin(favs);
  } catch (e) {
    cont.innerHTML = `<p class="pos-resultados-vacio">${escapeHtml(e.message || 'Error al cargar')}</p>`;
  }
}

function renderFavoritosAdmin(favs) {
  const cont = document.getElementById('pos-fav-admin-lista');
  if (!favs.length) {
    cont.innerHTML = '<p class="pos-resultados-vacio">Todavía no hay favoritos. Buscá un producto abajo para agregar.</p>';
    return;
  }
  cont.innerHTML = favs.map((f, idx) => `
    <div class="pos-fav-admin-fila" data-id="${f.id}" data-producto-id="${f.producto_id}">
      <span class="pos-fav-admin-pos">${idx + 1}</span>
      <span class="pos-fav-admin-nombre">${escapeHtml(f.nombre)}</span>
      <input type="text" class="input-base pos-fav-admin-etiqueta" value="${escapeHtml(f.etiqueta || '')}" placeholder="Nombre corto (opcional)" maxlength="30" />
      <input type="color" class="pos-fav-admin-color" value="${f.color || '#487050'}" title="Color del botón" />
      <button class="btn btn--sm" onclick="guardarFavorito('${f.id}', '${f.producto_id}', this)" title="Guardar cambios"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg></button>
      <button class="pos-venta-btn-anular" onclick="quitarFavorito('${f.id}')">Quitar</button>
    </div>
  `).join('');
}

window.guardarFavorito = async function (favId, productoId, btn) {
  const fila = btn.closest('[data-id]');
  const etiqueta = fila.querySelector('.pos-fav-admin-etiqueta')?.value?.trim() || null;
  const color    = fila.querySelector('.pos-fav-admin-color')?.value || '#487050';
  try {
    btn.disabled = true;
    await apiPost('/api/pos/favoritos', { producto_id: productoId, etiqueta: etiqueta || null, color });
    window.toast('Favorito actualizado', 'exito');
    await cargarFavoritos(); // refrescar grilla principal
  } catch (e) {
    console.error(e);
    window.toast('No se pudo guardar', 'error');
  } finally {
    btn.disabled = false;
  }
};

// Búsqueda para agregar favorito
let favBuscarTimer = null;
document.getElementById('pos-fav-buscar')?.addEventListener('input', (e) => {
  clearTimeout(favBuscarTimer);
  const q = e.target.value.trim();
  const cont = document.getElementById('pos-fav-buscar-resultados');
  if (!q) { cont.innerHTML = ''; return; }
  favBuscarTimer = setTimeout(async () => {
    try {
      const res = await apiGet(`/api/pos/productos?q=${encodeURIComponent(q)}`);
      cont.innerHTML = (res || []).slice(0, 8).map(p => `
        <div class="pos-cliente-resultado" data-id="${p.id}" data-fav='${JSON.stringify(p)}'>
          ${escapeHtml(p.nombre)} <span style="color:var(--color-text-light)">${escapeHtml(p.codigo || '')}</span>
        </div>
      `).join('') || '<div class="pos-cliente-resultado" style="color:var(--color-text-light)">Sin resultados</div>';
      cont.querySelectorAll('[data-id]').forEach(el => {
        el.addEventListener('click', () => agregarFavorito(JSON.parse(el.dataset.fav)));
      });
    } catch (_e) {}
  }, 220);
});

async function agregarFavorito(producto) {
  try {
    await apiPost('/api/pos/favoritos', { producto_id: producto.id });
    window.toast('Favorito agregado', 'exito');
    document.getElementById('pos-fav-buscar').value = '';
    document.getElementById('pos-fav-buscar-resultados').innerHTML = '';
    const favs = await apiGet('/api/pos/favoritos');
    renderFavoritosAdmin(favs);
  } catch (e) {
    console.error(e);
    window.toast('No se pudo agregar el favorito', 'error');
  }
}

window.quitarFavorito = async function (favId) {
  try {
    await apiPost('/api/pos/favoritos-quitar', { id: favId });
    window.toast('Favorito eliminado', 'default');
    const favs = await apiGet('/api/pos/favoritos');
    renderFavoritosAdmin(favs);
  } catch (e) {
    console.error(e);
    window.toast('No se pudo quitar el favorito', 'error');
  }
};

