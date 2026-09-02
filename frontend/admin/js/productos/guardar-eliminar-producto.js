// frontend/admin/js/productos/guardar-eliminar-producto.js
// Parte del split de frontend/admin/js/productos.js (25/08/2026) — Guardar (alta/edición), eliminar producto, editar columnas, ver alertas, exportar CSV.
// Se carga como <script> clásico (no ES module) en productos.html, en el
// mismo orden que ocupaba en el archivo original, para preservar el scope
// global compartido entre secciones (variables de estado, funciones
// window.*). Repite 'use strict' porque el pragma es por-script (el
// original lo tenía una sola vez porque era un solo script). Ver
// docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

async function guardarProducto() {
  const nombre = document.getElementById('fp-nombre').value.trim();
  if (!nombre) { toast('El nombre es obligatorio', 'warning'); return; }

  const payload = {
    empresa_id:   empresaData?.id,
    codigo:       document.getElementById('fp-codigo').value.trim() || null,
    nombre,
    categoria_id: document.getElementById('fp-categoria_id').value || null,
    precio_base:  parseFloat(document.getElementById('fp-precio_base').value) || 0,
    costo:        parseFloat(document.getElementById('fp-costo').value) || 0,
    stock_minimo: parseInt(document.getElementById('fp-stock_minimo').value, 10) || 0,
    stock_objetivo: parseInt(document.getElementById('fp-stock_objetivo').value, 10) || 0,
    activo:       document.getElementById('fp-activo').value === 'true',
    destacado:    document.getElementById('fp-destacado').checked,
  };

  if (!payload.empresa_id) {
    toast('No se pudo determinar la empresa del usuario actual.', 'error');
    return;
  }

  const okConfirm = await window.confirmar(
    modalProductoId ? `¿Guardar los cambios de "${nombre}"?` : `¿Confirmás crear el producto "${nombre}"?`,
    { labelOk: modalProductoId ? 'Guardar' : 'Crear', labelCancel: 'Revisar' }
  );
  if (!okConfirm) return;

  try {
    // v353: si el usuario eligió un archivo nuevo, subirlo primero al
    // bucket 'productos-fotos' y usar la URL pública resultante.
    let fotoUrlNueva = null;
    try {
      fotoUrlNueva = await subirFotoProductoSiCorresponde();
    } catch (errFoto) {
      console.error('[productos] Error al subir la foto:', errFoto);
      toast('No se pudo subir la imagen. Se guardará el producto sin foto.', 'warning');
    }

    if (modalProductoId) {
      // Edición: sin cambios respecto a antes — el stock por depósito ya
      // existe y se gestiona desde la sección Stock, no acá.
      // v353: se agrega foto_url — nueva si se subió una, null si se pidió
      // "Quitar imagen", o la que ya tenía si no se tocó nada.
      if (fotoUrlNueva) {
        payload.foto_url = fotoUrlNueva;
      } else if (fotoProductoQuitar) {
        payload.foto_url = null;
      } else {
        payload.foto_url = fotoProductoUrlActual;
      }

      const { error } = await window.conTimeoutRed(sb.from('productos').update(payload).eq('id', modalProductoId), 10000);
      if (error) throw error;
      toast('Producto actualizado', 'success');
      aportarBancoCodigos(payload.codigo, payload.nombre, payload.foto_url);
    } else {
      // Alta (v351): ya no se inserta directo en `productos` (eso disparaba
      // el trigger que fanoteaba stock a TODOS los depósitos). Ahora se usa
      // fn_crear_producto(), que crea el producto + stock inicial en 0 SOLO
      // en los depósitos elegidos en el checklist.
      const depositoIds = Array.from(document.querySelectorAll('.fp-deposito-chk:checked')).map(el => el.value);
      if (!depositoIds.length) {
        const errEl = document.getElementById('fp-depositos-error');
        if (errEl) errEl.style.display = 'block';
        toast('Elegí al menos un depósito para el producto nuevo.', 'warning');
        return;
      }

      const { data: nuevoId, error } = await window.conTimeoutRed(sb.rpc('fn_crear_producto', {
        p_nombre:       payload.nombre,
        p_deposito_ids: depositoIds,
        p_codigo:       payload.codigo,
        p_categoria_id: payload.categoria_id,
        p_precio_base:  payload.precio_base,
        p_costo:        payload.costo,
        p_stock_minimo: payload.stock_minimo,
        p_activo:       payload.activo,
        p_destacado:    payload.destacado,
        p_foto_url:     fotoUrlNueva,
        p_stock_objetivo: payload.stock_objetivo,
      }), 10000);
      if (error) throw error;
      // fn_crear_producto devuelve el uuid del producto recién creado —
      // lo guardamos por si algo (etiquetas, notas) necesita el id real
      // antes de que se recargue la tabla.
      modalProductoId = nuevoId || null;
      toast('Producto creado', 'success');
      aportarBancoCodigos(payload.codigo, payload.nombre, fotoUrlNueva);
    }
    cerrarModalProducto();
    await cargarProductos();
  } catch (err) {
    console.error('[productos] Error al guardar:', err);
    // v494: trigger fn_guard_desactivar_producto_con_stock bloquea
    // desactivar un producto que todavía tiene stock físico != 0 en algún
    // depósito. El mensaje ya viene redactado para el usuario final.
    if (err?.code === 'P0001' && /desactivar/i.test(err?.message || '')) {
      toast(err.message, 'error');
    } else {
      toast('No se pudo guardar el producto. Probá de nuevo en un momento.', 'error');
    }
  }
}

/* ── Eliminar producto (borrado físico) ───────────────────────────────────
   Distinto de "dar de baja" (campo ESTADO → Inactivo), que es lo normal
   para dejar de vender algo sin perder su historial. Esto borra la fila
   de verdad. Si el producto ya tiene movimientos de stock, pedidos,
   facturas, etc. asociados, la base va a rechazar el DELETE por FK —
   en ese caso avisamos y sugerimos desactivarlo en su lugar. ──────────── */
async function eliminarProducto() {
  if (!modalProductoId) return;

  const p = productosPage.find(x => x.id === modalProductoId);
  const nombre = p?.nombre || 'este producto';

  const ok = await window.confirmar(
    `¿Eliminar "${nombre}" definitivamente? Esta acción no se puede deshacer.`,
    { labelOk: 'Eliminar', labelCancel: 'Cancelar', tipo: 'danger' }
  );
  if (!ok) return;

  try {
    const { error } = await window.conTimeoutRed(sb.from('productos').delete().eq('id', modalProductoId), 10000);
    if (error) throw error;
    toast('Producto eliminado', 'success');
    cerrarModalProducto();
    await cargarProductos();
  } catch (err) {
    console.error('[productos] Error al eliminar:', err);
    // 23503 = foreign_key_violation — el producto tiene historial asociado
    // (stock, pedidos, facturas, movimientos, etc.) y no se puede borrar
    // sin perder ese historial.
    if (err?.code === '23503') {
      // FIX v743: se renombró la opción del select de estado de "Archivado"
      // a "Inactivo" (ver productos.html, fp-activo) porque es la palabra
      // que el dueño esperaba encontrar — coincide con este mismo mensaje.
      toast('No se puede eliminar: este producto ya tiene stock, pedidos o movimientos asociados. Marcalo como inactivo en su lugar.', 'error');
    } else {
      toast('No se pudo eliminar el producto. Probá de nuevo en un momento.', 'error');
    }
  }
}

/* ── Editar columnas ── */
function editarColumnas() {
  alert('Personalización de columnas disponible próximamente.');
}

/* ── Alertas (desde la topbar) ── */
function verAlertas() {
  if (!contadores.total_sin_stock) { toast('No hay productos sin stock.', 'info'); return; }
  filtroEstado = 'sin_stock';
  const sel = document.getElementById('prod-filtro-estado');
  if (sel) sel.value = 'sin_stock';
  recargarConFiltro();
}

/* ── Exportar CSV ──────────────────────────────────────────────────────────
   Auditoría filtros v280: ya no existe un array completo en memoria
   (productosAll/productosFilt) — solo tenemos la página actual
   (productosPage), resuelta por fn_productos_lista con LIMIT/OFFSET.
   Exportamos lo que el usuario está viendo en pantalla (la página actual,
   ya filtrada/ordenada). Si se necesita exportar TODO el resultado
   filtrado (no solo la página visible), habría que pedirle a
   fn_productos_lista un p_limit alto y armar el CSV con esa respuesta. ── */
function exportarProductos() {
  const lista = productosPage;
  if (!lista.length) { toast('No hay productos para exportar.', 'warning'); return; }

  const cols = ['Nombre', 'Categoría', 'Estado', 'Última Actualización', 'Precio', 'Costo', 'Stock', 'Margen%', 'Goal%'];
  const filas = lista.map(p => [
    p.nombre, p.cat, p.estado, formatFecha(p.fechaAct),
    p.precio, p.costo, p.stock, p.margen, p.goal
  ]);
  const csv = [cols, ...filas]
    .map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href:     url,
    download: `productos_${new Date().toISOString().slice(0, 10)}.csv`,
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast(`${lista.length} productos exportados correctamente.`, 'success');
}
