// frontend/admin/js/productos/precios-masivo.js
// Actualización masiva de precios — reutiliza la selección múltiple que ya
// existe para "Generar etiquetas" (seleccion-etiquetas.js: seleccionEtiquetas,
// incluye el atajo "seleccionar los N resultados" del filtro activo, que
// cubre el caso "por categoría"). La RPC fn_actualizar_precios_masivo
// (629) hace todo el cálculo y la escritura en un solo UPDATE atómico del
// lado del servidor — acá solo se arma el pedido, se muestra la vista
// previa (p_preview=true) y, si el usuario confirma, se repite la misma
// llamada con p_preview=false.
//
// Se carga como <script> clásico (no ES module) en productos.html, después
// de seleccion-etiquetas.js (usa seleccionEtiquetas, sb, window.toast,
// window.sanitize, cargarProductos). Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

let _pmzIds       = [];   // ids de producto de la tanda actual (snapshot al abrir)
let _pmzPreview   = null; // [{id, nombre, precio_anterior, precio_nuevo}] de la última preview
let _pmzFormUsado = null; // {tipo, valor, redondeo} con el que se generó _pmzPreview
let _pmzCargando  = false;

function _pmzFormatPeso(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return '$' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Entrada desde la barra flotante de selección (ver seleccion-etiquetas.js).
function abrirModalPreciosMasivo() {
  const ids = Array.from(seleccionEtiquetas);
  if (!ids.length) return;
  _pmzIds = ids;
  _pmzPreview = null;
  _pmzFormUsado = null;

  const modal = document.getElementById('modal-precios-masivo');
  const cuerpo = document.getElementById('precios-masivo-cuerpo');
  if (!modal || !cuerpo) return;

  document.getElementById('pmz-subtitulo').textContent =
    `${ids.length} producto${ids.length === 1 ? '' : 's'} seleccionado${ids.length === 1 ? '' : 's'}.`;

  modal.classList.add('open');
  document.getElementById('modal-backdrop-precios-masivo')?.style.setProperty('display', 'block');
  _pmzRenderFormulario();
}

// v978-style: entrada desde "Más funciones" — si ya hay algo tildado, va
// directo al modal; si no, lleva a la grilla a tildar (mismo patrón que
// iniciarGenerarEtiquetasDesdeMenu en seleccion-etiquetas.js).
function iniciarActualizarPreciosDesdeMenu() {
  if (seleccionEtiquetas.size) {
    abrirModalPreciosMasivo();
    return;
  }
  const tw = document.querySelector('.prod-tabla-wrap');
  if (tw) tw.scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.toast?.('Tildá los productos que querés actualizar y tocá "Actualizar precios" abajo.', 'default');
}

function _pmzRenderFormulario() {
  const cuerpo = document.getElementById('precios-masivo-cuerpo');
  if (!cuerpo) return;

  // Se preservan los valores ya tipeados si se vuelve al formulario desde
  // la vista previa (botón "Volver").
  const tipoPrevio     = document.getElementById('pmz-tipo')?.value || 'porcentaje';
  const valorPrevio    = document.getElementById('pmz-valor')?.value ?? '';
  const redondeoPrevio = document.getElementById('pmz-redondeo')?.value ?? '';

  cuerpo.innerHTML = `
    <div class="form-group">
      <label class="form-label" for="pmz-tipo">Tipo de ajuste</label>
      <select id="pmz-tipo" class="form-select">
        <option value="porcentaje" ${tipoPrevio === 'porcentaje' ? 'selected' : ''}>Porcentaje (%)</option>
        <option value="monto_fijo" ${tipoPrevio === 'monto_fijo' ? 'selected' : ''}>Monto fijo ($)</option>
        <option value="precio_fijo" ${tipoPrevio === 'precio_fijo' ? 'selected' : ''}>Precio fijo ($, reemplaza el actual)</option>
      </select>
    </div>
    <div class="form-row">
      <div class="form-group" style="flex:1">
        <label class="form-label" for="pmz-valor" id="pmz-valor-label">Valor</label>
        <input type="number" id="pmz-valor" class="form-input" step="0.01" value="${valorPrevio}"
               placeholder="Ej: 10 (sube 10%) o -10 (baja 10%)" />
      </div>
      <div class="form-group" style="flex:1">
        <label class="form-label" for="pmz-redondeo">Redondear a (opcional)</label>
        <input type="number" id="pmz-redondeo" class="form-input" step="1" min="1" value="${redondeoPrevio}"
               placeholder="Ej: 50, 100" />
      </div>
    </div>
    <p class="pmz-ayuda">
      El precio nunca queda negativo (se limita en 0). "Redondear a" ajusta el resultado
      al múltiplo más cercano (ej. 100 → $1.234 pasa a $1.200); dejalo vacío para redondear
      solo a 2 decimales.
    </p>
  `;

  document.getElementById('pmz-tipo').addEventListener('change', _pmzActualizarLabelValor);
  _pmzActualizarLabelValor();
  _pmzMostrarFooter('formulario');
}

function _pmzActualizarLabelValor() {
  const tipo = document.getElementById('pmz-tipo')?.value;
  const label = document.getElementById('pmz-valor-label');
  if (!label) return;
  label.textContent = tipo === 'precio_fijo' ? 'Precio nuevo ($)' : 'Valor';
}

function _pmzLeerFormulario() {
  const tipo = document.getElementById('pmz-tipo')?.value;
  const valorRaw = document.getElementById('pmz-valor')?.value;
  const redondeoRaw = document.getElementById('pmz-redondeo')?.value;

  const valor = valorRaw === '' ? NaN : Number(valorRaw);
  if (Number.isNaN(valor)) {
    window.toast?.('Ingresá un valor numérico para el ajuste.', 'warning');
    return null;
  }
  if (tipo === 'precio_fijo' && valor < 0) {
    window.toast?.('El precio fijo no puede ser negativo.', 'warning');
    return null;
  }

  const redondeo = redondeoRaw === '' ? null : Number(redondeoRaw);
  if (redondeo != null && (Number.isNaN(redondeo) || redondeo <= 0)) {
    window.toast?.('El redondeo debe ser un número positivo.', 'warning');
    return null;
  }

  return { tipo, valor, redondeo };
}

async function previsualizarPreciosMasivo() {
  if (_pmzCargando || !sb) return;
  const form = _pmzLeerFormulario();
  if (!form) return;

  _pmzCargando = true;
  const btn = document.getElementById('pmz-btn-previsualizar');
  if (btn) { btn.disabled = true; btn.textContent = 'Calculando…'; }

  try {
    const { data, error } = await window.conTimeoutRed(sb.rpc('fn_actualizar_precios_masivo', {
      p_producto_ids: _pmzIds,
      p_tipo_ajuste:  form.tipo,
      p_valor:        form.valor,
      p_redondeo:     form.redondeo,
      p_preview:      true,
    }), 10000);
    if (error) throw error;

    _pmzPreview = data || [];
    if (!_pmzPreview.length) {
      window.toast?.('Ninguno de los productos seleccionados pertenece a tu empresa, o ya no existen.', 'error');
      return;
    }
    _pmzFormUsado = form; // el formulario ya no va a estar en el DOM una vez renderizada la preview
    _pmzRenderPreview();
  } catch (err) {
    console.error('[precios-masivo] Error previsualizando:', err);
    window.toast?.(err.message || 'No se pudo calcular la actualización de precios.', 'error');
  } finally {
    _pmzCargando = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Previsualizar'; }
  }
}

function _pmzRenderPreview() {
  const cuerpo = document.getElementById('precios-masivo-cuerpo');
  if (!cuerpo || !_pmzPreview) return;
  const esc = (s) => (window.sanitize ? window.sanitize(s) : String(s ?? ''));

  cuerpo.innerHTML = `
    <p class="pmz-ayuda">Revisá los precios antes de aplicar — este paso todavía no modifica nada.</p>
    <div class="pmz-lista">
      <div class="pmz-fila pmz-fila-header">
        <span>Producto</span><span>Antes</span><span>Después</span>
      </div>
      ${_pmzPreview.map(p => {
        const sube = Number(p.precio_nuevo) > Number(p.precio_anterior);
        const baja = Number(p.precio_nuevo) < Number(p.precio_anterior);
        const clase = sube ? 'pmz-sube' : (baja ? 'pmz-baja' : '');
        return `
        <div class="pmz-fila">
          <span class="pmz-nombre" title="${esc(p.nombre)}">${esc(p.nombre)}</span>
          <span>${esc(_pmzFormatPeso(p.precio_anterior))}</span>
          <span class="${clase}">${esc(_pmzFormatPeso(p.precio_nuevo))}</span>
        </div>`;
      }).join('')}
    </div>
  `;
  _pmzMostrarFooter('preview');
}

function _pmzMostrarFooter(modo) {
  document.getElementById('pmz-footer-formulario')?.style.setProperty('display', modo === 'formulario' ? 'flex' : 'none');
  document.getElementById('pmz-footer-preview')?.style.setProperty('display', modo === 'preview' ? 'flex' : 'none');
}

function volverAlFormularioPreciosMasivo() {
  _pmzPreview = null;
  _pmzRenderFormulario();
}

async function confirmarPreciosMasivo() {
  if (_pmzCargando || !sb || !_pmzPreview) return;
  // No se relee el formulario acá: en este punto el modal está mostrando
  // la preview y los inputs (#pmz-valor, etc.) ya no están en el DOM.
  // Se reutiliza el mismo formulario con el que se calculó la preview.
  const form = _pmzFormUsado;
  if (!form) {
    window.toast?.('No se pudo aplicar: volvé a calcular la vista previa.', 'error');
    return;
  }

  _pmzCargando = true;
  const btn = document.getElementById('pmz-btn-confirmar');
  if (btn) { btn.disabled = true; btn.textContent = 'Aplicando…'; }

  try {
    const { data, error } = await window.conTimeoutRed(sb.rpc('fn_actualizar_precios_masivo', {
      p_producto_ids: _pmzIds,
      p_tipo_ajuste:  form.tipo,
      p_valor:        form.valor,
      p_redondeo:     form.redondeo,
      p_preview:      false,
    }), 10000);
    if (error) throw error;

    const n = (data || []).length;
    window.toast?.(`Precio actualizado en ${n} producto${n === 1 ? '' : 's'}.`, 'success');
    cerrarModalPreciosMasivo();
    cancelarSeleccionEtiquetas();
    cargarProductos();
  } catch (err) {
    console.error('[precios-masivo] Error aplicando:', err);
    window.toast?.(err.message || 'No se pudo aplicar la actualización de precios.', 'error');
  } finally {
    _pmzCargando = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Aplicar cambios'; }
  }
}

function cerrarModalPreciosMasivo() {
  document.getElementById('modal-precios-masivo')?.classList.remove('open');
  document.getElementById('modal-backdrop-precios-masivo')?.style.setProperty('display', 'none');
  _pmzIds = [];
  _pmzPreview = null;
  _pmzFormUsado = null;
}
