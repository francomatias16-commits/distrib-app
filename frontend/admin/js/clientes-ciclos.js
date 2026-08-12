// frontend/admin/js/clientes-ciclos.js
// REQ-07 — Pedido Habitual (Piloto Automático) en la ficha de cliente.
//
// INSTRUCCIÓN DE INTEGRACIÓN EN clientes.js:
// 1. Agregar <script src="/frontend/admin/js/clientes-ciclos.js?v..."></script>
//    al final de clientes.html (antes del cierre </body>), junto a api-client.js.
// 2. En la función que abre el panel de detalle de cliente (ej. `cli_abrirDetalle`
//    o `cli_renderDetalle`), al final agregar:
//       cli_ciclos_cargar(cliente.id);
// 3. En el HTML del panel de detalle (clientes.html), agregar dentro del panel
//    lateral, después de la sección de "Ofrecer plan de pago":
//       <div id="ciclos-section"></div>
//
// Usa fetch directo con Authorization: Bearer (window.authCtx.session.access_token),
// igual que el resto de las llamadas en clientes.js (ver /api/score). La empresa_id
// se resuelve en el backend desde el JWT, nunca desde un header enviado por el cliente.
//
// Este archivo es autocontenido: no pisa ninguna función existente de clientes.js.

// ── Helpers ──────────────────────────────────────────────────────────────────

function cli_ciclos_diasDesde(fechaStr) {
  if (!fechaStr) return null;
  const d = Math.floor((Date.now() - new Date(fechaStr).getTime()) / 86400000);
  return d;
}

function cli_ciclos_formatFecha(fechaStr) {
  if (!fechaStr) return '—';
  return new Date(fechaStr).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function cli_ciclos_confianzaLabel(c) {
  if (!c) return '';
  if (c >= 0.85) return '<span class="ciclo-conf alta">Alta</span>';
  if (c >= 0.55) return '<span class="ciclo-conf media">Media</span>';
  return '<span class="ciclo-conf baja">Baja</span>';
}

// ── Cargar y renderizar sección ───────────────────────────────────────────────

async function cli_ciclos_cargar(clienteId) {
  const sec = document.getElementById('ciclos-section');
  if (!sec) return;

  sec.innerHTML = `
    <div class="ficha-seccion">
      <h4 class="ficha-seccion-titulo">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
        Piloto Automático
      </h4>
      <p class="ciclo-cargando">Cargando…</p>
    </div>`;

  try {
    const r = await fetch(`/api/ciclos?cliente_id=${clienteId}`, {
      headers: { 'Authorization': `Bearer ${window.authCtx?.session?.access_token || ''}` }
    });
    if (r.status === 401 || r.status === 403) { window.location.href = '/admin/login'; return; }
    const data = await r.json();
    cli_ciclos_render(sec, clienteId, data);
  } catch (e) {
    sec.querySelector('.ciclo-cargando').textContent = 'Error al cargar ciclos.';
  }
}

function cli_ciclos_render(sec, clienteId, { ciclos, sugerido, ultima_notif }) {
  const diasUltimaNotif = cli_ciclos_diasDesde(ultima_notif);
  const notifLabel = diasUltimaNotif === null
    ? 'Nunca enviado'
    : diasUltimaNotif === 0
      ? 'Enviado hoy'
      : `Último envío: hace ${diasUltimaNotif} día${diasUltimaNotif !== 1 ? 's' : ''}`;

  // ── Tabla de ciclos ──
  let ciclosHtml = '';
  if (!ciclos.length) {
    ciclosHtml = `<p class="ciclo-vacio">Sin ciclos de compra registrados. Se calculan automáticamente con el historial de pedidos.</p>`;
  } else {
    ciclosHtml = `
      <div class="ciclo-tabla-wrap">
      <table class="ciclo-tabla">
        <thead><tr>
          <th>Producto</th><th>Cada</th><th>Próximo</th><th>Confianza</th>
        </tr></thead>
        <tbody>
          ${ciclos.map(c => `
            <tr>
              <td>${window.sanitize(c.productos?.nombre ?? c.producto_id)}</td>
              <td>${c.intervalo_dias}d</td>
              <td class="${c.proximo_pedido && new Date(c.proximo_pedido) <= new Date() ? 'ciclo-vencido' : ''}">
                ${cli_ciclos_formatFecha(c.proximo_pedido)}
              </td>
              <td>${cli_ciclos_confianzaLabel(c.confianza)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      </div>`;
  }

  // ── Panel del pedido sugerido ──
  let sugeridoHtml = '';
  if (sugerido) {
    const itemsStr = (sugerido.pedido_items || [])
      .map(it => `${window.sanitize(it.productos?.nombre ?? 'Producto')} × ${it.cantidad}`)
      .join(', ');
    const conf = sugerido.confianza_sugerencia
      ? `${Math.round(sugerido.confianza_sugerencia * 100)}% confianza`
      : '';

    sugeridoHtml = `
      <div class="ciclo-sugerido-card">
        <div class="ciclo-sugerido-header">
          <span class="ciclo-badge-sugerido"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13V22"/></svg>Pedido habitual listo</span>
          ${conf ? `<span class="ciclo-conf-pct">${conf}</span>` : ''}
        </div>
        <p class="ciclo-sugerido-items">${itemsStr || '—'}</p>
        <p class="ciclo-sugerido-total">Total estimado: $${Number(sugerido.total).toLocaleString('es-AR')}</p>
        <div class="ciclo-sugerido-acciones">
          <button class="btn-wa-sugerencia" onclick="cli_ciclos_enviar('${clienteId}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>
            Enviar por WhatsApp
          </button>
          <button class="btn-descartar-sugerencia" onclick="cli_ciclos_descartar('${sugerido.id}', '${clienteId}')">
            Descartar
          </button>
        </div>
      </div>`;
  } else if (ciclos.length) {
    sugeridoHtml = `<p class="ciclo-vacio ciclo-sin-sugerido">Sin pedido habitual pendiente hoy. El piloto lo genera automáticamente cuando se acerca el próximo vencimiento.</p>`;
  }

  sec.innerHTML = `
    <div class="ficha-seccion">
      <h4 class="ficha-seccion-titulo">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
        Piloto Automático
        <span class="ciclo-notif-label">${notifLabel}</span>
      </h4>
      ${ciclosHtml}
      ${sugeridoHtml}
    </div>`;
}

// ── Acciones ──────────────────────────────────────────────────────────────────

async function cli_ciclos_enviar(clienteId) {
  const btn = document.querySelector('.btn-wa-sugerencia');
  if (btn) { btn.disabled = true; btn.textContent = 'Abriendo WhatsApp…'; }

  try {
    const r = await fetch('/api/ciclos?accion=enviar-sugerencia', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${window.authCtx?.session?.access_token || ''}`
      },
      body: JSON.stringify({ cliente_id: clienteId })
    });
    if (r.status === 401 || r.status === 403) { window.location.href = '/admin/login'; return; }
    const data = await r.json();

    if (!r.ok || !data?.wa_url) {
      alert(data?.error || 'No se pudo generar el mensaje de WhatsApp.');
      if (btn) { btn.disabled = false; btn.innerHTML = '↩ Reintentar'; }
      return;
    }

    // Abrir WhatsApp en nueva pestaña
    window.open(data.wa_url, '_blank');

    // Refrescar la sección para mostrar "Enviado hoy"
    setTimeout(() => cli_ciclos_cargar(clienteId), 800);

  } catch (e) {
    alert('Error de conexión al enviar.');
    if (btn) { btn.disabled = false; }
  }
}

async function cli_ciclos_descartar(pedidoId, clienteId) {
  if (!confirm('¿Descartar este pedido habitual sugerido?')) return;

  const btn = document.querySelector('.btn-descartar-sugerencia');
  if (btn) btn.disabled = true;

  try {
    await fetch('/api/ciclos?accion=descartar-sugerencia', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${window.authCtx?.session?.access_token || ''}`
      },
      body: JSON.stringify({ pedido_id: pedidoId })
    });
    cli_ciclos_cargar(clienteId);
  } catch (e) {
    alert('Error al descartar.');
    if (btn) btn.disabled = false;
  }
}
