/* admin/js/export-contable.js — Etapa 6: Export contable (Tango/Bejerman/Contabilium)
   Lee/guarda /api/export-contable/config, lista /api/export-contable/historial,
   y genera archivos vía GET /api/export-contable?tipo=&desde=&hasta=&proveedor=

   Solo 'generico_csv' devuelve un archivo real hoy — tango/bejerman/contabilium
   responden 501 (ver lib/export-contable/formato-*.js), así que quedan
   marcados como "Próximamente" en la UI pero se pueden igual seleccionar
   como preferencia para el día que se completen. */

const ROLES_VER    = ['dueno', 'admin', 'contador'];
const ROLES_CONFIG = ['dueno', 'admin'];

const PROVEEDORES = [
  { id: 'generico_csv',  nombre: 'CSV genérico',  desc: 'Listado plano, cualquier sistema. Andá con esto hoy.', listo: true },
  { id: 'tango',         nombre: 'Tango',          desc: 'Importación de asientos. En desarrollo.',              listo: false },
  { id: 'bejerman',      nombre: 'Bejerman',       desc: 'Importación de asientos. En desarrollo.',              listo: false },
  { id: 'contabilium',   nombre: 'Contabilium',    desc: 'Integración por API. En desarrollo.',                  listo: false },
];

let esConfigurador = false;
let proveedorSeleccionado = 'generico_csv';

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
  document.getElementById('topbar-usuario').textContent = user.nombre || user.email;

  if (!ROLES_VER.includes(user.rol)) {
    document.getElementById('contenido').classList.add('hidden');
    document.getElementById('sin-permiso').classList.remove('hidden');
    return;
  }

  esConfigurador = ROLES_CONFIG.includes(user.rol);

  // Rango por defecto: 1ro del mes actual → hoy
  const primerDiaMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  document.getElementById('gen_desde').value = toISODate(primerDiaMes);
  document.getElementById('gen_hasta').value = toISODate(hoy);

  renderProveedorOpciones();

  document.getElementById('btn-guardar-config').addEventListener('click', guardarConfig);
  document.getElementById('btn-generar').addEventListener('click', generarExport);

  if (!esConfigurador) {
    document.querySelectorAll('#plan-cuentas-wrap input, #separador_decimal, #formato_fecha')
      .forEach(el => el.disabled = true);
    document.getElementById('btn-guardar-config').disabled = true;
    document.getElementById('btn-guardar-config').title = 'Solo dueño/admin puede modificar la configuración';
  }

  await Promise.all([cargarConfig(), cargarHistorial()]);
});

// ── Proveedores (cards seleccionables) ──────────────────────────────────
function renderProveedorOpciones() {
  const cont = document.getElementById('proveedor-opciones');
  cont.innerHTML = PROVEEDORES.map(p => `
    <div class="proveedor-card ${p.id === proveedorSeleccionado ? 'selected' : ''} ${!esConfigurador ? 'disabled' : ''}"
         data-id="${p.id}">
      <span class="${p.listo ? 'badge-listo' : 'badge-proximamente'}">${p.listo ? 'Listo' : 'Próximamente'}</span>
      <h3>${esc(p.nombre)}</h3>
      <p>${esc(p.desc)}</p>
    </div>
  `).join('');

  if (esConfigurador) {
    cont.querySelectorAll('.proveedor-card').forEach(el => {
      el.addEventListener('click', () => {
        proveedorSeleccionado = el.dataset.id;
        renderProveedorOpciones();
      });
    });
  }
}

// ── Config ────────────────────────────────────────────────────────────
async function cargarConfig() {
  try {
    const token = await getToken();
    const r = await fetch('/api/export-contable/config', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error('No se pudo leer la configuración');
    const d = await r.json();

    if (d && d.proveedor) {
      proveedorSeleccionado = d.proveedor;
      renderProveedorOpciones();
    }

    const pc = d?.plan_cuentas || {};
    document.getElementById('pc_ventas_neto').value        = pc.ventas_neto || '';
    document.getElementById('pc_iva_debito_fiscal').value   = pc.iva_debito_fiscal || '';
    document.getElementById('pc_deudores_por_venta').value  = pc.deudores_por_venta || '';
    document.getElementById('pc_compras_neto').value        = pc.compras_neto || '';
    document.getElementById('pc_iva_credito_fiscal').value  = pc.iva_credito_fiscal || '';
    document.getElementById('pc_proveedores').value         = pc.proveedores || '';

    document.getElementById('separador_decimal').value = d?.separador_decimal || ',';
    document.getElementById('formato_fecha').value      = d?.formato_fecha || 'DD/MM/YYYY';
  } catch (e) {
    console.error('[export-contable] error cargando config:', e);
    mostrarAlerta('No se pudo cargar la configuración guardada. Podés seguir usando el export CSV genérico igual.', 'inf');
  }
}

async function guardarConfig() {
  const ok = await window.confirmar('¿Guardar esta configuración de exportación contable?', { labelOk: 'Guardar', labelCancel: 'Revisar' });
  if (!ok) return;

  const btn = document.getElementById('btn-guardar-config');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Guardando…';

  try {
    const plan_cuentas = {
      ventas_neto:        document.getElementById('pc_ventas_neto').value.trim(),
      iva_debito_fiscal:  document.getElementById('pc_iva_debito_fiscal').value.trim(),
      deudores_por_venta: document.getElementById('pc_deudores_por_venta').value.trim(),
      compras_neto:       document.getElementById('pc_compras_neto').value.trim(),
      iva_credito_fiscal: document.getElementById('pc_iva_credito_fiscal').value.trim(),
      proveedores:        document.getElementById('pc_proveedores').value.trim(),
    };
    // No guardar claves vacías — así get_export_contable_config() refleja
    // fielmente qué está realmente configurado.
    Object.keys(plan_cuentas).forEach(k => { if (!plan_cuentas[k]) delete plan_cuentas[k]; });

    const body = {
      proveedor: proveedorSeleccionado,
      plan_cuentas,
      separador_decimal: document.getElementById('separador_decimal').value,
      formato_fecha: document.getElementById('formato_fecha').value,
      activo: true,
    };

    const token = await getToken();
    const r = await fetch('/api/export-contable/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const d = await r.json();

    if (!r.ok) throw new Error(d.error || 'Error guardando la configuración');

    mostrarAlerta('Configuración guardada.', 'ok');
    if (window.toast) window.toast('Configuración guardada', 'success');
  } catch (e) {
    console.error('[export-contable] error guardando config:', e);
    mostrarAlerta('No se pudo guardar la configuración. Probá de nuevo.', 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ── Historial ─────────────────────────────────────────────────────────
async function cargarHistorial() {
  const tbody = document.getElementById('tbody-historial');
  try {
    const token = await getToken();
    const r = await fetch('/api/export-contable/historial', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error('No se pudo leer el historial');
    const d = await r.json();
    const historial = d.historial || [];

    document.getElementById('historial-vacio').classList.toggle('hidden', historial.length > 0);

    tbody.innerHTML = historial.map(h => `
      <tr>
        <td data-label="Fecha">${formatFechaHora(h.created_at)}</td>
        <td data-label="Proveedor">${nombreProveedor(h.proveedor)}</td>
        <td data-label="Tipo">${nombreTipo(h.tipo)}</td>
        <td data-label="Rango">${esc(h.fecha_desde)} → ${esc(h.fecha_hasta)}</td>
        <td data-label="Registros">${h.cantidad_registros ?? 0}</td>
        <td data-label="Archivo">${esc(h.archivo_nombre || '—')}</td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('[export-contable] error cargando historial:', e);
    tbody.innerHTML = '';
    document.getElementById('historial-vacio').classList.remove('hidden');
  }
}

// ── Generar export ────────────────────────────────────────────────────
async function generarExport() {
  const btn = document.getElementById('btn-generar');
  const tipo  = document.getElementById('gen_tipo').value;
  const desde = document.getElementById('gen_desde').value;
  const hasta = document.getElementById('gen_hasta').value;

  if (!desde || !hasta) {
    mostrarAlerta('Elegí el rango de fechas.', 'err');
    return;
  }
  if (desde > hasta) {
    mostrarAlerta('"Desde" no puede ser posterior a "Hasta".', 'err');
    return;
  }

  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Generando…';

  try {
    const token = await getToken();
    const params = new URLSearchParams({ tipo, desde, hasta, proveedor: proveedorSeleccionado });
    const r = await fetch(`/api/export-contable?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!r.ok) {
      // Los formatos no implementados (Tango/Bejerman/Contabilium) responden
      // 501 con {error}. El resto de los errores (validación, plan de
      // cuentas incompleto) llegan como 400/500 con la misma forma.
      let mensaje = 'Error generando el export';
      try { const d = await r.json(); if (d.error) mensaje = d.error; } catch (_) {}
      throw new Error(mensaje);
    }

    const blob = await r.blob();
    const nombreArchivo = extraerNombreArchivo(r.headers.get('Content-Disposition'))
      || `export_${tipo}_${desde}_${hasta}.csv`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nombreArchivo;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    if (window.toast) window.toast('Export generado', 'success');
    mostrarAlerta(`Export de ${nombreTipo(tipo).toLowerCase()} generado y descargado.`, 'ok');
    await cargarHistorial();
  } catch (e) {
    console.error('[export-contable] error generando export:', e);
    mostrarAlerta('No se pudo generar el export. Probá de nuevo.', 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────
async function getToken() {
  const { data: { session } } = await window.authCtx.sb.auth.getSession();
  return session?.access_token || '';
}

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

function formatFechaHora(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function nombreProveedor(id) {
  return esc(PROVEEDORES.find(p => p.id === id)?.nombre || id || '—');
}

function nombreTipo(tipo) {
  return { ventas: 'Ventas', compras: 'Compras', cobranzas: 'Cobranzas' }[tipo] || tipo;
}

function extraerNombreArchivo(contentDisposition) {
  if (!contentDisposition) return null;
  const m = contentDisposition.match(/filename="([^"]+)"/);
  return m ? m[1] : null;
}

function mostrarAlerta(mensaje, tipo) {
  const el = document.getElementById('alerta');
  el.textContent = mensaje;
  el.className = `alerta alerta-${tipo}`;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 6000);
}

function esc(s) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(s);
}
