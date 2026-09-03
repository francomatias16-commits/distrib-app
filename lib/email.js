// lib/email.js
// Módulo de emails transaccionales via Resend.
// Importar desde cualquier serverless function de Vercel:
//   import { enviarEmailConfirmacionPedido, enviarEmailDespacho } from '../../lib/email.js';
//
// ── Variables de entorno requeridas ───────────────────────────────────────
//   RESEND_API_KEY  = re_...          (Resend → API Keys)
//   EMAIL_FROM      = notificaciones@tu-dominio.com
//
// ── Emails implementados ──────────────────────────────────────────────────
//   enviarEmailConfirmacionPedido(pedido, cliente, empresa)
//   enviarEmailDespacho(pedido, cliente, empresa)
//   enviarEmailRecuperacionPassword(email, linkRecuperacion, empresa)
//
// ─────────────────────────────────────────────────────────────────────────

const RESEND_API_URL = 'https://api.resend.com/emails';

// ── Helper principal ───────────────────────────────────────────────────────
import { esEmpresaDemo } from './demo-mode.js';

export async function enviarEmail({ to, subject, html, replyTo, empresa_id }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from   = process.env.EMAIL_FROM;

  if (!apiKey || !from) {
    console.warn('[EMAIL] RESEND_API_KEY o EMAIL_FROM no configurados — email omitido');
    return { ok: false, razon: 'no_configurado' };
  }

  // ── Corte de modo demo — Fase 3 del proceso demo/comercial ────────────
  // Ninguna empresa demo dispara un email real a una casilla real.
  if (await esEmpresaDemo(empresa_id)) {
    console.log(`[EMAIL] (demo) omitido a ${to} | asunto: ${subject}`);
    return { ok: true, id: 'demo.' + Date.now(), demo: true };
  }

  try {
    const resp = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to:      Array.isArray(to) ? to : [to],
        subject,
        html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error('[EMAIL] Error Resend:', data);
      return { ok: false, razon: 'error_resend', detalle: data };
    }

    console.log(`[EMAIL] Enviado a ${to} | id: ${data.id} | asunto: ${subject}`);
    return { ok: true, id: data.id };

  } catch (err) {
    console.error('[EMAIL] Error de red:', err.message);
    return { ok: false, razon: 'error_red', detalle: err.message };
  }
}

// ── Helpers de formato ─────────────────────────────────────────────────────
// HALLAZGO (auditoría "templates de email sin escapar", continuación del
// fix de saas-alertas.js v1056): igual que empresa.nombre en ese handler,
// acá el mismo campo (y otros de texto libre — notas de pedido del cliente,
// descripción de movimientos, nombres de producto) se interpolaban directo
// en el HTML de emails que le llegan a un actor DISTINTO de quien cargó el
// dato — el cliente o proveedor de la empresa, no la propia empresa. Un
// distribuidor que se autoregistra con un nombre malicioso (o un cliente
// que carga notas de pedido con HTML activo) podía inyectar HTML/enlaces de
// phishing en emails transaccionales reales que llegan a terceros. Se
// centraliza acá el mismo escapeHtml() ya usado en saas-alertas.js y se
// aplica en las 5 funciones de este archivo — tal como quedó documentado
// como pendiente en ese changelog.
function escapeHtml(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatPeso(n) {
  return '$\u202F' + Math.round(n || 0).toLocaleString('es-AR');
}

function formatFecha(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-AR', {
    day: '2-digit', month: 'long', year: 'numeric',
  });
}

// ── Estilos base compartidos ───────────────────────────────────────────────
const CSS_BASE = `
  body { margin:0; padding:0; background:#F1EFE8; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  .wrap { max-width:560px; margin:32px auto; background:#ffffff; border-radius:12px; overflow:hidden; border:1px solid #D3D1C7; }
  .header { background:#185FA5; padding:28px 32px; }
  .header h1 { margin:0; color:#ffffff; font-size:20px; font-weight:700; }
  .header p  { margin:6px 0 0; color:#c7dcf5; font-size:14px; }
  .body { padding:28px 32px; }
  .kpi-row { display:flex; gap:16px; margin:20px 0; }
  .kpi { flex:1; background:#F1EFE8; border-radius:8px; padding:14px 16px; }
  .kpi-label { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:#5F5E5A; margin-bottom:4px; }
  .kpi-value { font-size:22px; font-weight:700; color:#2C2C2A; }
  .items-table { width:100%; border-collapse:collapse; margin:20px 0; font-size:14px; }
  .items-table th { text-align:left; padding:8px 10px; background:#F1EFE8; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:#5F5E5A; }
  .items-table td { padding:9px 10px; border-bottom:1px solid #EFEFED; color:#2C2C2A; }
  .items-table tr:last-child td { border-bottom:none; }
  .td-num { text-align:right; }
  .total-row td { font-weight:700; background:#E6F1FB; color:#185FA5; }
  .btn { display:inline-block; padding:12px 24px; background:#185FA5; color:#ffffff; text-decoration:none; border-radius:8px; font-size:14px; font-weight:600; margin:16px 0; }
  .info-box { background:#F1EFE8; border-radius:8px; padding:14px 16px; font-size:14px; color:#5F5E5A; margin:16px 0; line-height:1.6; }
  .footer { padding:20px 32px; border-top:1px solid #EFEFED; font-size:12px; color:#888780; text-align:center; }
`;

// ── 1. Confirmación de pedido ──────────────────────────────────────────────
// Llamar desde api/pedidos/index.js luego de crear el pedido exitosamente.
//
// pedido  : { id, numero?, total, subtotal, iva_total, fecha_entrega, notas_cliente }
// cliente : { email, razon_social }
// empresa : { nombre, email? }
// items   : [{ nombre, cantidad, precio_unitario, descuento_pct? }]  (opcional)
//
export async function enviarEmailConfirmacionPedido(pedido, cliente, empresa, items = []) {
  if (!cliente?.email) {
    console.log('[EMAIL] Cliente sin email — confirmación omitida');
    return { ok: false, razon: 'sin_email' };
  }

  const numeroLabel = pedido.numero || pedido.id?.substring(0, 8).toUpperCase() || '—';
  const primerNombre = escapeHtml((cliente.razon_social || '').split(/[\s,]+/)[0]);
  const nombreEmpresa = escapeHtml(empresa?.nombre) || 'Distribuidora';

  const itemsHtml = items.length > 0 ? `
    <table class="items-table">
      <thead><tr>
        <th>Producto</th><th class="td-num">Cant.</th><th class="td-num">Precio</th><th class="td-num">Subtotal</th>
      </tr></thead>
      <tbody>
        ${items.map(i => {
          const sub = i.precio_unitario * i.cantidad * (1 - (i.descuento_pct || 0) / 100);
          return `<tr>
            <td>${escapeHtml(i.nombre) || '—'}${i.descuento_pct > 0 ? ` <small style="color:#185FA5">(−${i.descuento_pct}%)</small>` : ''}</td>
            <td class="td-num">${i.cantidad}</td>
            <td class="td-num">${formatPeso(i.precio_unitario)}</td>
            <td class="td-num">${formatPeso(sub)}</td>
          </tr>`;
        }).join('')}
        <tr class="total-row">
          <td colspan="3">Total</td>
          <td class="td-num">${formatPeso(pedido.total)}</td>
        </tr>
      </tbody>
    </table>` : `
    <div class="kpi-row">
      <div class="kpi"><div class="kpi-label">Total</div><div class="kpi-value">${formatPeso(pedido.total)}</div></div>
      ${pedido.fecha_entrega ? `<div class="kpi"><div class="kpi-label">Entrega estimada</div><div class="kpi-value" style="font-size:16px">${formatFecha(pedido.fecha_entrega)}</div></div>` : ''}
    </div>`;

  const notasHtml = pedido.notas_cliente
    ? `<div class="info-box"><strong>Notas del pedido:</strong> ${escapeHtml(pedido.notas_cliente)}</div>`
    : '';

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${CSS_BASE}</style></head><body>
  <div class="wrap">
    <div class="header">
      <h1>Pedido confirmado</h1>
      <p>${nombreEmpresa} · Pedido #${numeroLabel}</p>
    </div>
    <div class="body">
      <p style="font-size:16px;color:#2C2C2A;margin:0 0 16px">Hola <strong>${primerNombre}</strong>, recibimos tu pedido y ya comenzamos a prepararlo.</p>
      ${itemsHtml}
      ${notasHtml}
      ${pedido.fecha_entrega ? `<div class="info-box"><strong>Fecha de entrega estimada:</strong> ${formatFecha(pedido.fecha_entrega)}</div>` : ''}
      <p style="font-size:14px;color:#5F5E5A;margin:20px 0 0">Te avisaremos por este medio cuando tu pedido esté en camino.</p>
    </div>
    <div class="footer">${nombreEmpresa} · Este es un email automático, no respondas directamente.</div>
  </div>
</body></html>`;

  return enviarEmail({
    to:      cliente.email,
    subject: `Pedido #${numeroLabel} confirmado — ${(empresa?.nombre || 'Distribuidora').replace(/[\r\n]/g, ' ')}`,
    html,
    replyTo: empresa?.email,
    empresa_id: empresa?.id,
  });
}

// ── 2. Aviso de despacho ───────────────────────────────────────────────────
// Llamar desde api/pedidos/index.js cuando el admin cambia el estado a 'despachado'.
//
// pedido  : { id, numero?, total, fecha_entrega }
// cliente : { email, razon_social }
// empresa : { nombre, email? }
//
export async function enviarEmailDespacho(pedido, cliente, empresa) {
  if (!cliente?.email) {
    console.log('[EMAIL] Cliente sin email — aviso despacho omitido');
    return { ok: false, razon: 'sin_email' };
  }

  const numeroLabel  = pedido.numero || pedido.id?.substring(0, 8).toUpperCase() || '—';
  const primerNombre = escapeHtml((cliente.razon_social || '').split(/[\s,]+/)[0]);
  const nombreEmpresa = escapeHtml(empresa?.nombre) || 'Distribuidora';

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${CSS_BASE}</style></head><body>
  <div class="wrap">
    <div class="header" style="background:#3B6D11">
      <h1>Tu pedido está en camino</h1>
      <p>${nombreEmpresa} · Pedido #${numeroLabel}</p>
    </div>
    <div class="body">
      <p style="font-size:16px;color:#2C2C2A;margin:0 0 16px">Hola <strong>${primerNombre}</strong>, tu pedido <strong>#${numeroLabel}</strong> ya fue despachado y está en camino a tu domicilio.</p>
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-label">Pedido</div><div class="kpi-value" style="font-size:18px">#${numeroLabel}</div></div>
        <div class="kpi"><div class="kpi-label">Total</div><div class="kpi-value">${formatPeso(pedido.total)}</div></div>
        ${pedido.fecha_entrega ? `<div class="kpi"><div class="kpi-label">Entrega estimada</div><div class="kpi-value" style="font-size:16px">${formatFecha(pedido.fecha_entrega)}</div></div>` : ''}
      </div>
      <p style="font-size:14px;color:#5F5E5A;margin:20px 0 0">El repartidor pasará por tu domicilio en el horario acordado. Si tenés alguna consulta, contactanos directamente.</p>
    </div>
    <div class="footer">${nombreEmpresa} · Este es un email automático, no respondas directamente.</div>
  </div>
</body></html>`;

  return enviarEmail({
    to:      cliente.email,
    subject: `Tu pedido #${numeroLabel} está en camino — ${(empresa?.nombre || 'Distribuidora').replace(/[\r\n]/g, ' ')}`,
    html,
    replyTo: empresa?.email,
    empresa_id: empresa?.id,
  });
}

// ── 3. Recuperación de contraseña ──────────────────────────────────────────
// Llamar desde api/auth/reset-password.js (endpoint nuevo).
// Supabase genera el link y nosotros lo enviamos con el diseño de la empresa.
//
// email            : destinatario
// linkRecuperacion : URL de reset generada por supabase.auth.admin.generateLink()
// empresa          : { nombre, email? }
//
export async function enviarEmailRecuperacionPassword(email, linkRecuperacion, empresa) {
  if (!email) return { ok: false, razon: 'sin_email' };

  const nombreEmpresa = escapeHtml(empresa?.nombre) || 'Distribuidora';
  const linkSeguro = escapeHtml(linkRecuperacion);

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${CSS_BASE}</style></head><body>
  <div class="wrap">
    <div class="header" style="background:#5B3DA8">
      <h1>Restablecer contraseña</h1>
      <p>${nombreEmpresa}</p>
    </div>
    <div class="body">
      <p style="font-size:16px;color:#2C2C2A;margin:0 0 16px">Recibimos una solicitud para restablecer la contraseña de tu cuenta.</p>
      <p style="font-size:14px;color:#5F5E5A;margin:0 0 24px">Hacé clic en el siguiente botón para crear una nueva contraseña. El enlace es válido por <strong>60 minutos</strong>.</p>
      <a href="${linkSeguro}" class="btn">Restablecer mi contraseña</a>
      <div class="info-box" style="margin-top:20px">
        Si no solicitaste restablecer tu contraseña, ignorá este email. Tu cuenta sigue segura.
      </div>
      <p style="font-size:12px;color:#888780;margin:16px 0 0">Si el botón no funciona, copiá y pegá este enlace en tu navegador:<br>
        <a href="${linkSeguro}" style="color:#185FA5;word-break:break-all">${linkSeguro}</a>
      </p>
    </div>
    <div class="footer">${nombreEmpresa} · Este es un email automático, no respondas directamente.</div>
  </div>
</body></html>`;

  return enviarEmail({
    to:      email,
    subject: `Restablecé tu contraseña — ${(empresa?.nombre || 'Distribuidora').replace(/[\r\n]/g, ' ')}`,
    html,
    replyTo: empresa?.email,
    empresa_id: empresa?.id,
  });
}
// ── REQ-10: Agregar al final de lib/email.js ──────────────────────────────
//
// 4. Estado de cuenta (envío manual desde admin → cta-cte)
//
// cliente  : { razon_social, nombre_fantasia, email, cuit, localidad }
// saldos   : { total, vencida, porVencer }
// facturas : [{ numero, total, total_cobrado, vencimiento, estado }]
// movs     : [{ fecha, monto, tipo }]
// empresa  : { nombre, email? }
// enviadoPor: { nombre } — el admin que lo envía manualmente
//
export async function enviarEmailEstadoCuenta(
  cliente,
  saldos,
  facturas = [],
  movimientos = [],
  empresa,
  enviadoPor = null,
) {
  if (!cliente?.email) return { ok: false, razon: 'sin_email' };

  const nombreEmpresa  = escapeHtml(empresa?.nombre) || 'Distribuidora';
  const nombreCliente  = escapeHtml(cliente.nombre_fantasia || cliente.razon_social);
  const primerNombre   = nombreCliente.split(/[\s,]+/)[0];
  const hoy            = new Date();
  const fechaEmision   = hoy.toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' });

  // ── Semáforo de estado ──────────────────────────────────────────────────
  const tieneVencida   = saldos.vencida > 0;
  const tienePorVencer = saldos.porVencer > 0;
  const colorEstado    = tieneVencida ? '#DC2626' : tienePorVencer ? '#D97706' : '#16A34A';
  const labelEstado    = tieneVencida ? '⚠ Deuda vencida' : tienePorVencer ? '⏰ Próximo vencimiento' : 'Al día';

  // ── Tabla de facturas pendientes ────────────────────────────────────────
  let facturasHtml = '';
  const facturasPendientes = facturas.filter(f => {
    const pend = (f.total || 0) - (f.total_cobrado || 0);
    return pend > 0;
  });

  if (facturasPendientes.length > 0) {
    const filas = facturasPendientes.map(f => {
      const pendiente = (f.total || 0) - (f.total_cobrado || 0);
      const vto       = f.vencimiento ? new Date(f.vencimiento) : null;
      const vtoLabel  = vto ? vto.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
      const estaVencida = vto && vto < hoy;
      const colorVto  = estaVencida ? '#DC2626' : '#2C2C2A';
      const numero    = escapeHtml(f.numero) || f.id?.substring(0, 8).toUpperCase() || '—';
      return `
        <tr>
          <td style="padding:9px 10px;border-bottom:1px solid #EFEFED;color:#2C2C2A">
            Factura #${numero}
          </td>
          <td style="padding:9px 10px;border-bottom:1px solid #EFEFED;color:${colorVto};font-weight:${estaVencida ? '600' : '400'}">
            ${vtoLabel}${estaVencida ? ' <span style="font-size:10px;background:#FEE2E2;color:#DC2626;padding:1px 5px;border-radius:3px">VENCIDA</span>' : ''}
          </td>
          <td style="padding:9px 10px;border-bottom:1px solid #EFEFED;text-align:right;color:#2C2C2A;font-weight:600">
            ${formatPeso(f.total || 0)}
          </td>
          <td style="padding:9px 10px;border-bottom:1px solid #EFEFED;text-align:right;color:#16A34A">
            ${formatPeso(f.total_cobrado || 0)}
          </td>
          <td style="padding:9px 10px;border-bottom:1px solid #EFEFED;text-align:right;font-weight:700;color:${estaVencida ? '#DC2626' : '#185FA5'}">
            ${formatPeso(pendiente)}
          </td>
        </tr>`;
    }).join('');

    facturasHtml = `
      <div style="margin:24px 0 8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#5F5E5A">
        Facturas con saldo pendiente
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#F1EFE8">
            <th style="text-align:left;padding:8px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#5F5E5A">Comprobante</th>
            <th style="text-align:left;padding:8px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#5F5E5A">Vencimiento</th>
            <th style="text-align:right;padding:8px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#5F5E5A">Total</th>
            <th style="text-align:right;padding:8px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#5F5E5A">Cobrado</th>
            <th style="text-align:right;padding:8px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#5F5E5A">Pendiente</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>`;
  }

  // ── Últimos movimientos ─────────────────────────────────────────────────
  let movsHtml = '';
  if (movimientos.length > 0) {
    const filasMov = movimientos.slice(0, 8).map(m => {
      const esCobro = m.tipo === 'cobro' || m.monto > 0;
      const abs     = Math.abs(m.monto || 0);
      const signo   = esCobro ? '+' : '−';
      const color   = esCobro ? '#16A34A' : '#DC2626';
      const fecha   = m.fecha
        ? new Date(m.fecha).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })
        : '—';
      return `
        <tr>
          <td style="padding:7px 10px;border-bottom:1px solid #EFEFED;color:#5F5E5A;font-size:12px">${fecha}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #EFEFED;color:#2C2C2A;font-size:13px">${escapeHtml(m.descripcion) || (esCobro ? 'Cobro recibido' : 'Factura emitida')}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #EFEFED;text-align:right;font-weight:700;color:${color};font-size:13px">
            ${signo} ${formatPeso(abs)}
          </td>
        </tr>`;
    }).join('');

    movsHtml = `
      <div style="margin:24px 0 8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#5F5E5A">
        Últimos movimientos
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:#F1EFE8">
            <th style="text-align:left;padding:8px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#5F5E5A">Fecha</th>
            <th style="text-align:left;padding:8px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#5F5E5A">Concepto</th>
            <th style="text-align:right;padding:8px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#5F5E5A">Importe</th>
          </tr>
        </thead>
        <tbody>${filasMov}</tbody>
      </table>`;
  }

  // ── Alerta si hay deuda vencida ─────────────────────────────────────────
  const alertaHtml = tieneVencida ? `
    <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:14px 16px;margin:20px 0;font-size:13px;color:#DC2626">
      <strong>⚠ Deuda vencida:</strong> Tenés ${formatPeso(saldos.vencida)} con vencimiento superado.
      Te pedimos que regularices tu situación a la brevedad para mantener tu crédito activo.
    </div>` : '';

  // ── Footer de quién envía ───────────────────────────────────────────────
  const enviadoPorHtml = enviadoPor?.nombre
    ? `<p style="margin:8px 0 0;font-size:11px;color:#AEADA8">Enviado por ${escapeHtml(enviadoPor.nombre)} · ${fechaEmision}</p>`
    : `<p style="margin:8px 0 0;font-size:11px;color:#AEADA8">${fechaEmision}</p>`;

  // ── HTML del email ──────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Estado de Cuenta</title>
</head>
<body style="margin:0;padding:0;background:#F1EFE8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:580px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #D3D1C7">

    <!-- Header -->
    <div style="background:#185FA5;padding:28px 32px">
      <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:700">Estado de Cuenta</h1>
      <p style="margin:6px 0 0;color:#c7dcf5;font-size:14px">${nombreEmpresa} · ${fechaEmision}</p>
    </div>

    <!-- Body -->
    <div style="padding:28px 32px">

      <p style="font-size:16px;color:#2C2C2A;margin:0 0 20px">
        Hola <strong>${primerNombre}</strong>, a continuación te enviamos tu estado de cuenta actualizado.
      </p>

      <!-- KPIs de saldo -->
      <div style="display:flex;gap:14px;margin:20px 0;flex-wrap:wrap">
        <div style="flex:1;min-width:120px;background:#F1EFE8;border-radius:8px;padding:14px 16px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#5F5E5A;margin-bottom:4px">Total adeudado</div>
          <div style="font-size:22px;font-weight:700;color:${saldos.total > 0 ? '#DC2626' : '#16A34A'}">${formatPeso(saldos.total)}</div>
        </div>
        <div style="flex:1;min-width:120px;background:#F1EFE8;border-radius:8px;padding:14px 16px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#5F5E5A;margin-bottom:4px">Vencido</div>
          <div style="font-size:22px;font-weight:700;color:${tieneVencida ? '#DC2626' : '#16A34A'}">${formatPeso(saldos.vencida)}</div>
        </div>
        <div style="flex:1;min-width:120px;background:#F1EFE8;border-radius:8px;padding:14px 16px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#5F5E5A;margin-bottom:4px">Estado</div>
          <div style="font-size:15px;font-weight:700;color:${colorEstado}">${labelEstado}</div>
        </div>
      </div>

      ${alertaHtml}
      ${facturasHtml}
      ${movsHtml}

      <!-- Info de contacto -->
      <div style="background:#F1EFE8;border-radius:8px;padding:14px 16px;font-size:13px;color:#5F5E5A;margin:24px 0 0;line-height:1.6">
        Ante cualquier consulta o si ya realizaste el pago, contactanos directamente para actualizar tu cuenta.
        ${empresa?.email ? `<br><a href="mailto:${escapeHtml(empresa.email)}" style="color:#185FA5">${escapeHtml(empresa.email)}</a>` : ''}
      </div>

    </div><!-- /body -->

    <!-- Footer -->
    <div style="padding:20px 32px;border-top:1px solid #EFEFED;text-align:center">
      <p style="margin:0;font-size:12px;color:#888780">${nombreEmpresa}</p>
      ${enviadoPorHtml}
    </div>

  </div>
</body>
</html>`;

  return enviarEmail({
    to:      cliente.email,
    subject: `Estado de cuenta — ${(empresa?.nombre || 'Distribuidora').replace(/[\r\n]/g, ' ')}`,
    html,
    replyTo: empresa?.email,
    empresa_id: empresa?.id,
  });
}

// ── 8.4: Notificación de recepción al proveedor ────────────────────────────
//
// proveedor    : { razon_social, email, contacto? }
// orden        : { id, numero? }
// recepcion    : { id, created_at, confirmada_at?, foto_url? }
// items        : [{nombre, cant_pedida, cant_ocr, precio_pedido, precio_ocr,
//                  diff_cant_pct, diff_precio_pct, alerta}]  — de conciliar_recepcion
// discrepancias: [{nombre, cant_pedida, cant_ocr, diff_cant_pct, diff_precio_pct}]
// empresa      : { nombre, email? }
//
export async function enviarEmailRecepcionProveedor(
  proveedor,
  orden,
  recepcion,
  items = [],
  discrepancias = [],
  empresa,
) {
  if (!proveedor?.email) {
    console.log('[EMAIL] Proveedor sin email — notificación recepción omitida');
    return { ok: false, razon: 'sin_email' };
  }

  const nombreEmpresa  = escapeHtml(empresa?.nombre) || 'Distribuidora';
  const nombreProv     = escapeHtml(proveedor.razon_social || proveedor.contacto) || 'Proveedor';
  const primerNombre   = nombreProv.split(/[\s,]+/)[0];
  const ordenLabel     = escapeHtml(orden?.numero) || orden?.id?.substring(0, 8).toUpperCase() || '—';
  const fechaRecepcion = formatFecha(recepcion?.confirmada_at || recepcion?.created_at);
  const hayDiscr       = discrepancias.length > 0;

  // ── Tabla de items recibidos ─────────────────────────────────────────────
  const itemsHtml = items.length > 0 ? `
    <table class="items-table">
      <thead>
        <tr>
          <th>Producto</th>
          <th class="td-num">Pedido</th>
          <th class="td-num">Recibido</th>
          <th class="td-num">Δ Cant.</th>
          <th class="td-num">Precio OC</th>
          <th class="td-num">Precio Remito</th>
          <th class="td-num">Δ Precio</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(it => {
          const alertaColor = it.alerta ? '#DC2626' : '#16A34A';
          const diffCantStr   = it.diff_cant_pct   != null ? it.diff_cant_pct   + '%' : '—';
          const diffPrecioStr = it.diff_precio_pct != null ? it.diff_precio_pct + '%' : '—';
          const rowBg = it.alerta ? 'background:#FEF2F2' : '';
          return `<tr style="${rowBg}">
            <td>${escapeHtml(it.nombre) || '—'}${it.alerta ? ' <span style="font-size:10px;background:#FEE2E2;color:#DC2626;padding:1px 5px;border-radius:3px">⚠</span>' : ''}</td>
            <td class="td-num">${it.cant_pedida ?? '—'}</td>
            <td class="td-num" style="font-weight:600">${it.cant_ocr ?? '—'}</td>
            <td class="td-num" style="color:${alertaColor};font-weight:600">${diffCantStr}</td>
            <td class="td-num">${it.precio_pedido != null ? formatPeso(it.precio_pedido) : '—'}</td>
            <td class="td-num">${it.precio_ocr    != null ? formatPeso(it.precio_ocr)    : '—'}</td>
            <td class="td-num" style="color:${alertaColor};font-weight:600">${diffPrecioStr}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>` : '<p style="color:#5F5E5A;font-size:14px">Sin detalle de items disponible.</p>';

  // ── Bloque de alerta si hay discrepancias ────────────────────────────────
  const alertaHtml = hayDiscr ? `
    <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:14px 16px;margin:20px 0;font-size:13px;color:#DC2626;line-height:1.6">
      <strong>⚠ Se detectaron ${discrepancias.length} discrepancia(s)</strong> entre la orden de compra y el remito escaneado.<br>
      Por favor revisá los items marcados y contactanos si hay algún error en la facturación.
    </div>` : `
    <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;padding:14px 16px;margin:20px 0;font-size:13px;color:#16A34A">
      La recepción fue procesada sin discrepancias. ¡Gracias!
    </div>`;

  // ── Link a la foto del remito ────────────────────────────────────────────
  const fotoHtml = recepcion?.foto_url ? `
    <div class="info-box" style="margin-top:16px">
      <strong>Remito escaneado:</strong>
      <a href="${escapeHtml(recepcion.foto_url)}" style="color:#185FA5;margin-left:6px">Ver imagen del remito</a>
    </div>` : '';

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${CSS_BASE}</style>
</head>
<body>
  <div class="wrap">
    <div class="header" style="background:#185FA5">
      <h1>Confirmación de recepción</h1>
      <p>${nombreEmpresa} · Orden de compra #${ordenLabel}</p>
    </div>
    <div class="body">
      <p style="font-size:16px;color:#2C2C2A;margin:0 0 16px">
        Hola <strong>${primerNombre}</strong>, confirmamos la recepción de la mercadería
        correspondiente a la orden <strong>#${ordenLabel}</strong> del día <strong>${fechaRecepcion}</strong>.
      </p>

      <div class="kpi-row">
        <div class="kpi">
          <div class="kpi-label">Orden de compra</div>
          <div class="kpi-value" style="font-size:18px">#${ordenLabel}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Fecha de recepción</div>
          <div class="kpi-value" style="font-size:15px">${fechaRecepcion}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Discrepancias</div>
          <div class="kpi-value" style="font-size:18px;color:${hayDiscr ? '#DC2626' : '#16A34A'}">${hayDiscr ? discrepancias.length : '0'}</div>
        </div>
      </div>

      ${alertaHtml}

      <div style="margin:20px 0 8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#5F5E5A">
        Detalle de la recepción
      </div>
      ${itemsHtml}
      ${fotoHtml}

      <p style="font-size:13px;color:#5F5E5A;margin:24px 0 0;line-height:1.6">
        Si encontrás diferencias en este resumen o necesitás emitir una nota de crédito,
        respondé este email o contactanos directamente.
      </p>
    </div>
    <div class="footer">
      ${nombreEmpresa}${empresa?.email ? ` · <a href="mailto:${escapeHtml(empresa.email)}" style="color:#185FA5">${escapeHtml(empresa.email)}</a>` : ''}
      · Este es un email automático generado por el sistema de recepciones.
    </div>
  </div>
</body>
</html>`;

  // Subject: texto plano, no HTML — se usan los valores crudos (solo se
  // recortan saltos de línea) en vez de las variables ya escapadas para HTML.
  const nombreEmpresaAsunto = (empresa?.nombre || 'Distribuidora').replace(/[\r\n]/g, ' ');
  const ordenLabelAsunto = (orden?.numero || orden?.id?.substring(0, 8).toUpperCase() || '—').toString().replace(/[\r\n]/g, ' ');

  const asunto = hayDiscr
    ? `⚠ Recepción OC #${ordenLabelAsunto} — ${discrepancias.length} discrepancia(s) — ${nombreEmpresaAsunto}`
    : `Recepción OC #${ordenLabelAsunto} confirmada — ${nombreEmpresaAsunto}`;

  return enviarEmail({ to: proveedor.email, subject: asunto, html, replyTo: empresa?.email, empresa_id: empresa?.id });
}
