// frontend/admin/js/remito.js
// REQ-02 — Generación de remito imprimible
// Se carga junto a pedidos.js (admin) y desde la app del chofer.
// No tiene dependencias externas: abre una ventana con HTML/CSS listo para imprimir.

// ── Número de remito ──────────────────────────────────────────────────────────
// Obtiene o incrementa el número correlativo de remito para el pedido.
// Si el pedido ya tiene remito_nro lo reutiliza; si no, reserva el siguiente.
async function obtenerNroRemito(pedidoId) {
  if (!window.authCtx) return null;
  const sb    = window.authCtx.sb;
  const token = (await sb.auth.getSession()).data.session?.access_token;

  // 1. Ver si el pedido ya tiene remito_nro
  const { data: ped } = await window.conTimeoutRed(sb.from('pedidos')
    .select('remito_nro')
    .eq('id', pedidoId)
    .single(), 10000);

  if (ped?.remito_nro) return ped.remito_nro;

  // 2. Reservar el siguiente número vía RPC (evita race conditions)
  //    Si la RPC no existe aún, fallback a max(remito_nro)+1
  try {
    const res = await fetch('/api/remito-nro', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pedido_id: pedidoId })
    });
    if (res.ok) {
      const d = await res.json();
      return d.remito_nro;
    }
  } catch (_) { /* fallback */ }

  // Fallback local (sin persistencia)
  const { data: maxRow } = await window.conTimeoutRed(sb.from('pedidos')
    .select('remito_nro')
    .not('remito_nro', 'is', null)
    .order('remito_nro', { ascending: false })
    .limit(1)
    .single(), 10000);

  const siguiente = (maxRow?.remito_nro || 0) + 1;

  await window.conTimeoutRed(sb.from('pedidos')
    .update({ remito_nro: siguiente })
    .eq('id', pedidoId), 10000);

  return siguiente;
}

// ── Función principal ─────────────────────────────────────────────────────────
async function imprimirRemito(pedidoId, itemsPrecargados) {
  if (!window.authCtx) { window.toast('Sin sesión', 'danger'); return; }

  // FIX v812: abrir la ventana ANTES de cualquier await. Los navegadores solo
  // permiten window.open() sin bloqueo si ocurre de forma síncrona dentro del
  // gesto de click; después de varios await (fetch a pedidos/items/nro_remito)
  // el popup blocker lo descarta en silencio, sin disparar ni el aviso propio
  // del navegador ni nuestro toast de "Bloqueador de popups activo" — por eso
  // no pasaba nada visible al hacer click. Reservamos la ventana ya y recién
  // al final le escribimos el HTML del remito.
  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) {
    if (window.mostrarToast) window.toast('Bloqueador de popups activo — permití ventanas emergentes', 'error');
    return;
  }
  win.document.write('<p style="font-family:sans-serif;padding:20px;color:#666">Generando remito…</p>');

  // FIX v813: try/catch envolviendo todo lo que sigue. Antes, cualquier error
  // no controlado (como el ReferenceError de formatPesoRemito) cortaba la
  // función a mitad de camino y dejaba la ventana ya abierta trabada en el
  // placeholder de arriba para siempre, sin ningún mensaje. Ahora, pase lo
  // que pase, la ventana termina mostrando el remito o un error legible.
  try {

  const sb          = window.authCtx.sb;
  const empresaData = window.authCtx.perfil?.empresas || { id: window.authCtx.perfil?.empresa_id, nombre: '', config: {} };

  // Toast de espera si está disponible
  if (window.mostrarToast) window.toast('Generando remito...', '');

  // Cargar pedido completo con datos de cliente
  const { data: p, error } = await window.conTimeoutRed(sb.from('pedidos')
    .select(`
      id, estado, subtotal, descuento, iva_total, total,
      notas_cliente, fecha_pedido, fecha_entrega, created_at, remito_nro,
      clientes(razon_social, nombre_fantasia, cuit, telefono, domicilio, localidad,
               condicion_iva, zonas(nombre)),
      usuarios!vendedor_id(nombre)
    `)
    .eq('id', pedidoId)
    .single(), 10000);

  if (error || !p) {
    if (window.mostrarToast) window.toast('Error al cargar el pedido', 'error');
    win.document.write('<p style="font-family:sans-serif;padding:20px;color:#c00">Error al cargar el pedido. Podés cerrar esta ventana.</p>');
    win.document.close();
    return;
  }

  // Cargar items si no vienen precargados
  let items = itemsPrecargados;
  if (!items) {
    const { data } = await window.conTimeoutRed(sb.from('pedido_items')
      .select('cantidad, precio_unitario, descuento_pct, subtotal, productos(nombre, unidad, codigo)')
      .eq('pedido_id', pedidoId), 10000);
    items = data || [];
  }

  // Obtener / reservar número de remito
  const nroRemito = await obtenerNroRemito(pedidoId);
  const nroStr    = String(nroRemito || 0).padStart(6, '0');

  // Datos de empresa
  const empresa = {
    nombre:   empresaData?.nombre   || 'Distribuidora',
    cuit:     empresaData?.cuit     || '',
    logo_url: empresaData?.logo_url || '',
  };

  // Datos de cliente
  const c = p.clientes || {};
  const cliente = {
    nombre:      c.razon_social || c.nombre_fantasia || '—',
    fantasia:    c.nombre_fantasia || '',
    cuit:        c.cuit || '',
    condicion:   labelCondicionIVA(c.condicion_iva),
    domicilio:   c.domicilio || '',
    localidad:   c.localidad || c.zonas?.nombre || '',
    telefono:    c.telefono || '',
  };

  const fechaEmision = new Date().toLocaleDateString('es-AR');
  const fechaEntrega = p.fecha_entrega
    ? new Date(p.fecha_entrega + 'T12:00:00').toLocaleDateString('es-AR')
    : '—';
  const shortId = p.id.slice(-6).toUpperCase();

  // ── Generar HTML del remito ───────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <title>Remito ${nroStr}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Arial, Helvetica, sans-serif;
      font-size: 12px;
      color: #1a1a1a;
      background: #fff;
      padding: 24px 28px;
    }

    /* ── Encabezado ── */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #1a1a1a;
      padding-bottom: 14px;
      margin-bottom: 16px;
    }
    .header-empresa { flex: 1; }
    .header-empresa .logo {
      max-height: 52px;
      max-width: 180px;
      margin-bottom: 6px;
      object-fit: contain;
    }
    .header-empresa .nombre-empresa {
      font-size: 18px;
      font-weight: 700;
      color: #111;
    }
    .header-empresa .cuit-empresa {
      font-size: 11px;
      color: #555;
      margin-top: 2px;
    }
    .header-doc {
      text-align: right;
      min-width: 180px;
    }
    .doc-tipo {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.5px;
      line-height: 1;
    }
    .doc-nro {
      font-size: 18px;
      font-weight: 700;
      color: #333;
      margin-top: 4px;
      font-family: 'Courier New', monospace;
    }
    .doc-meta {
      font-size: 11px;
      color: #555;
      margin-top: 6px;
      line-height: 1.6;
    }

    /* ── Datos cliente / entrega ── */
    .datos-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0;
      border: 1px solid #ccc;
      border-radius: 4px;
      margin-bottom: 18px;
      overflow: hidden;
    }
    .datos-box {
      padding: 10px 14px;
    }
    .datos-box:first-child {
      border-right: 1px solid #ccc;
    }
    .datos-box-title {
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #888;
      margin-bottom: 6px;
    }
    .datos-box .linea {
      font-size: 12px;
      line-height: 1.7;
    }
    .datos-box .linea strong {
      font-size: 13px;
    }

    /* ── Tabla de items ── */
    .tabla-items {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
      font-size: 12px;
    }
    .tabla-items thead tr {
      background: #1a1a1a;
      color: #fff;
    }
    .tabla-items th {
      padding: 7px 10px;
      text-align: left;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .tabla-items th.num { text-align: left; }
    .tabla-items td {
      padding: 8px 10px;
      border-bottom: 1px solid #e5e5e5;
      vertical-align: top;
    }
    .tabla-items td.num { text-align: left; }
    .tabla-items tbody tr:last-child td { border-bottom: none; }
    .tabla-items tbody tr:nth-child(even) { background: #fafafa; }
    .cod { font-size: 10px; color: #888; }
    .unidad { font-size: 10px; color: #666; }

    /* ── Totales ── */
    .totales-wrap {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 24px;
    }
    .totales-tabla {
      border: 1px solid #ccc;
      border-radius: 4px;
      overflow: hidden;
      min-width: 260px;
    }
    .totales-tabla .t-row {
      display: flex;
      justify-content: space-between;
      padding: 6px 14px;
      border-bottom: 1px solid #e5e5e5;
      font-size: 12px;
    }
    .totales-tabla .t-row:last-child {
      border-bottom: none;
      background: #1a1a1a;
      color: #fff;
      font-size: 14px;
      font-weight: 700;
    }
    .totales-tabla .t-row span:last-child { font-weight: 600; }

    /* ── Notas ── */
    .notas-box {
      border: 1px solid #e0e0e0;
      border-radius: 4px;
      padding: 10px 14px;
      margin-bottom: 24px;
      font-size: 11px;
      color: #555;
      white-space: pre-line;
    }
    .notas-box strong { display: block; margin-bottom: 4px; color: #333; font-size: 11px; }

    /* ── Sección firma / chofer ── */
    .firmas {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 20px;
      margin-top: 8px;
    }
    .firma-box {
      border-top: 1px solid #999;
      padding-top: 6px;
      text-align: center;
    }
    .firma-espacio {
      height: 56px;
    }
    .firma-label {
      font-size: 10px;
      color: #555;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .firma-nombre {
      font-size: 11px;
      font-weight: 600;
      margin-top: 2px;
    }

    /* ── Footer ── */
    .footer-remito {
      margin-top: 20px;
      border-top: 1px solid #ddd;
      padding-top: 8px;
      font-size: 10px;
      color: #aaa;
      text-align: center;
    }

    @media print {
      body { padding: 12px 16px; }
      @page { margin: 10mm; size: A4; }
    }
  </style>
</head>
<body>

  <!-- ── Encabezado ── -->
  <div class="header">
    <div class="header-empresa">
      ${empresa.logo_url
        ? `<img class="logo" src="${empresa.logo_url}" alt="${sanitize(empresa.nombre)}" />`
        : `<div class="nombre-empresa">${sanitize(empresa.nombre)}</div>`
      }
      ${empresa.logo_url ? `<div class="nombre-empresa" style="margin-top:4px">${sanitize(empresa.nombre)}</div>` : ''}
      ${empresa.cuit ? `<div class="cuit-empresa">CUIT: ${sanitize(empresa.cuit)}</div>` : ''}
    </div>
    <div class="header-doc">
      <div class="doc-tipo">REMITO</div>
      <div class="doc-nro">N° ${nroStr}</div>
      <div class="doc-meta">
        Pedido: #${shortId}<br>
        Emisión: ${fechaEmision}<br>
        Entrega: ${fechaEntrega}
      </div>
    </div>
  </div>

  <!-- ── Datos cliente y entrega ── -->
  <div class="datos-grid">
    <div class="datos-box">
      <div class="datos-box-title">Destinatario</div>
      <div class="linea"><strong>${sanitize(cliente.nombre)}</strong></div>
      ${cliente.fantasia && cliente.fantasia !== cliente.nombre ? `<div class="linea">${sanitize(cliente.fantasia)}</div>` : ''}
      ${cliente.cuit ? `<div class="linea">CUIT: ${sanitize(cliente.cuit)}</div>` : ''}
      ${cliente.condicion ? `<div class="linea">Cond. IVA: ${cliente.condicion}</div>` : ''}
      ${cliente.domicilio ? `<div class="linea">${sanitize(cliente.domicilio)}${cliente.localidad ? ', ' + cliente.localidad : ''}</div>` : ''}
      ${cliente.telefono ? `<div class="linea">Tel: ${sanitize(cliente.telefono)}</div>` : ''}
    </div>
    <div class="datos-box">
      <div class="datos-box-title">Datos de entrega</div>
      <div class="linea"><strong>Fecha de entrega:</strong> ${fechaEntrega}</div>
      ${c.zonas?.nombre ? `<div class="linea"><strong>Zona:</strong> ${sanitize(c.zonas.nombre)}</div>` : ''}
      ${p.usuarios?.nombre ? `<div class="linea"><strong>Vendedor:</strong> ${sanitize(p.usuarios.nombre)}</div>` : ''}
    </div>
  </div>

  <!-- ── Items ── -->
  <table class="tabla-items">
    <thead>
      <tr>
        <th style="width:40px">#</th>
        <th>Producto</th>
        <th class="num" style="width:80px">Cant.</th>
        <th style="width:60px">Unidad</th>
        <th class="num" style="width:90px">Precio</th>
        <th class="num" style="width:90px">Subtotal</th>
      </tr>
    </thead>
    <tbody>
      ${items.map((it, i) => {
        const nombre  = sanitize(it.productos?.nombre || '—');
        const codigo  = it.productos?.codigo ? `<div class="cod">${sanitize(it.productos.codigo)}</div>` : '';
        const unidad  = sanitize(it.productos?.unidad || 'u');
        const desc    = it.descuento_pct > 0 ? `<span style="font-size:10px;color:#d97706"> −${it.descuento_pct}%</span>` : '';
        return `
        <tr>
          <td style="color:#888">${i + 1}</td>
          <td>${nombre}${codigo}</td>
          <td class="num">${Number(it.cantidad).toLocaleString('es-AR', { maximumFractionDigits: 2 })}</td>
          <td><span class="unidad">${unidad}</span></td>
          <td class="num">${formatPesoRemito(it.precio_unitario)}${desc}</td>
          <td class="num">${formatPesoRemito(it.subtotal)}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>

  <!-- ── Totales ── -->
  <div class="totales-wrap">
    <div class="totales-tabla">
      <div class="t-row"><span>Subtotal</span><span>${formatPesoRemito(p.subtotal)}</span></div>
      ${p.descuento > 0 ? `<div class="t-row"><span>Descuento</span><span>−${formatPesoRemito(p.descuento)}</span></div>` : ''}
      <div class="t-row"><span>IVA</span><span>${formatPesoRemito(p.iva_total)}</span></div>
      <div class="t-row"><span>TOTAL</span><span>${formatPesoRemito(p.total)}</span></div>
    </div>
  </div>

  <!-- ── Notas del cliente ── -->
  ${p.notas_cliente ? `
  <div class="notas-box">
    <strong>Observaciones:</strong>
    ${sanitize(p.notas_cliente)}
  </div>` : ''}

  <!-- ── Firmas ── -->
  <div class="firmas">
    <div class="firma-box">
      <div class="firma-espacio"></div>
      <div class="firma-label">Nombre y firma del chofer</div>
      <div class="firma-nombre" style="margin-top:4px">&nbsp;</div>
    </div>
    <div class="firma-box">
      <div class="firma-espacio"></div>
      <div class="firma-label">Aclaración</div>
      <div class="firma-nombre">&nbsp;</div>
    </div>
    <div class="firma-box">
      <div class="firma-espacio"></div>
      <div class="firma-label">Conformidad del receptor</div>
      <div class="firma-nombre">&nbsp;</div>
    </div>
  </div>

  <!-- ── Footer ── -->
  <div class="footer-remito">
    Remito ${nroStr} · ${sanitize(empresa.nombre)}${empresa.cuit ? ' · CUIT ' + sanitize(empresa.cuit) : ''} · Emisión: ${fechaEmision}
  </div>

  <script>
    window.onload = function() { window.print(); };
  </script>
</body>
</html>`;

  // Escribir el remito en la ventana que ya habíamos abierto al principio
  win.document.open();
  win.document.write(html);
  win.document.close();

  } catch (err) {
    // FIX v813: si algo falla en cualquier punto de arriba (query, referencia
    // indefinida, etc.), la ventana ya está abierta con el placeholder — sin
    // este catch se queda trabada ahí para siempre. Mostramos el error acá
    // adentro en vez de dejarla colgada en silencio.
    console.error('[remito] Error al generar remito:', err);
    win.document.open();
    win.document.write(`<p style="font-family:sans-serif;padding:20px;color:#b91c1c">
      No se pudo generar el remito.<br>${err?.message || 'Error desconocido'}
    </p>`);
    win.document.close();
    if (window.mostrarToast) window.toast('Error al generar el remito', 'error');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function labelCondicionIVA(cond) {
  const map = {
    responsable_inscripto: 'Responsable Inscripto',
    monotributo:           'Monotributista',
    exento:                'Exento',
    consumidor_final:      'Consumidor Final',
  };
  return map[cond] || cond || '';
}

// FIX v813: esta función se usaba en 6 lugares del HTML del remito pero
// nunca estuvo definida en ningún archivo del proyecto — era un
// ReferenceError puro que cortaba imprimirRemito() al armar el HTML,
// dejando la ventana ya abierta trabada para siempre en el placeholder
// "Generando remito…" sin ningún aviso de error. Sigue el mismo patrón
// que el resto de los formatPeso/fmtPeso del proyecto (ver productos.js).
function formatPesoRemito(n) {
  if (n == null) return '—';
  return '$' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 0 });
}
