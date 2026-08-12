// supabase/functions/saas-email-sender/index.ts
// Edge Function que se llama periódicamente (o vía webhook de DB)
// para procesar los emails pendientes en saas_email_log.
//
// Deploy: supabase functions deploy saas-email-sender
// Trigger: puede invocarse desde pg_cron via net.http_post(), o desde
//          un cron job de Supabase Dashboard → Edge Functions → Schedule.
//
// Variables de entorno requeridas (Dashboard → Settings → Edge Functions):
//   SUPABASE_URL              (automática)
//   SUPABASE_SERVICE_ROLE_KEY (automática)
//   RESEND_API_KEY            (agregar manualmente)
//   SAAS_FROM_EMAIL           ej: "distrib <no-reply@distrib.app>"
//   SAAS_ADMIN_EMAIL          email del superadmin para copia

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const RESEND_KEY  = Deno.env.get("RESEND_API_KEY")!;
const FROM_EMAIL  = Deno.env.get("SAAS_FROM_EMAIL") ?? "distrib <no-reply@distrib.app>";
const ADMIN_EMAIL = Deno.env.get("SAAS_ADMIN_EMAIL") ?? "";

// ─── Helpers ────────────────────────────────────────────────────────────────

async function sendEmail(to: string, subject: string, html: string, attachments?: object[]) {
  const body: Record<string, unknown> = { from: FROM_EMAIL, to, subject, html };
  if (attachments?.length) body.attachments = attachments;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err}`);
  }
  return res.json();
}

/** Genera HTML simple de la factura (sin PDF externo) */
function buildFacturaHtml(empresa: Record<string, unknown>, factura: Record<string, unknown>, cfg: Record<string, unknown>): string {
  return `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
  .header { background: #1e40af; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
  .body   { border: 1px solid #e5e7eb; border-top: none; padding: 20px; }
  table   { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th, td  { padding: 8px 12px; border: 1px solid #e5e7eb; text-align: left; }
  th      { background: #f3f4f6; }
  .total  { font-size: 1.3em; font-weight: bold; color: #1e40af; }
  .cbu    { background: #f0fdf4; border: 1px solid #86efac; padding: 12px; border-radius: 6px; margin: 16px 0; }
  .footer { color: #6b7280; font-size: 0.85em; margin-top: 24px; }
</style></head>
<body>
  <div class="header">
    <h2 style="margin:0">distrib SaaS — Factura de Suscripción</h2>
    <p style="margin:4px 0 0">N° ${factura.numero}</p>
  </div>
  <div class="body">
    <p>Hola, <strong>${empresa.nombre}</strong>.</p>
    <p>Te adjuntamos la factura correspondiente al período <strong>${factura.periodo}</strong>.</p>

    <table>
      <tr><th>N° Factura</th>      <td>${factura.numero}</td></tr>
      <tr><th>Período</th>         <td>${factura.periodo}</td></tr>
      <tr><th>Concepto</th>        <td>${factura.concepto}</td></tr>
      <tr><th>Fecha de emisión</th> <td>${factura.fecha_emision}</td></tr>
      <tr><th>Fecha de vencimiento</th><td><strong>${factura.fecha_vencimiento}</strong></td></tr>
      <tr><th>Monto</th>           <td class="total">$ ${Number(factura.monto).toLocaleString("es-AR", { minimumFractionDigits: 2 })}</td></tr>
    </table>

    <div class="cbu">
      <strong>Datos para la transferencia:</strong><br>
      CBU: <code>${cfg.cbu}</code><br>
      Alias: <code>${cfg.alias}</code><br>
      Titular: ${cfg.titular}<br>
      Banco: ${cfg.banco}<br><br>
      <em>Por favor indicar N° de factura <strong>${factura.numero}</strong> en el concepto de la transferencia.</em>
    </div>

    <p>
      Una vez realizada la transferencia, tu cuenta será reactivada manualmente
      dentro del próximo día hábil. Ante cualquier duda respondé este email.
    </p>

    <div class="footer">
      <p>distrib SaaS — Sistema de gestión para distribuidoras</p>
    </div>
  </div>
</body>
</html>`;
}

function buildTrialAvisoHtml(empresa: Record<string, unknown>, factura: Record<string, unknown>, cfg: Record<string, unknown>, diasRestantes: number): string {
  return `
<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
  .header { background: #d97706; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
  .body   { border: 1px solid #e5e7eb; border-top: none; padding: 20px; }
  .cbu    { background: #f0fdf4; border: 1px solid #86efac; padding: 12px; border-radius: 6px; margin: 16px 0; }
</style></head>
<body>
  <div class="header">
    <h2 style="margin:0">⚠️ Tu prueba gratuita vence en ${diasRestantes} día${diasRestantes !== 1 ? "s" : ""}</h2>
  </div>
  <div class="body">
    <p>Hola, <strong>${empresa.nombre}</strong>.</p>
    <p>Tu período de prueba gratuita de <strong>distrib SaaS</strong> vence el
       <strong>${(empresa as Record<string, unknown>).saas_trial_fin}</strong>.</p>
    <p>Para continuar usando la plataforma sin interrupciones, realizá la transferencia
       antes del vencimiento:</p>

    <div class="cbu">
      <strong>Datos para la transferencia:</strong><br>
      CBU: <code>${cfg.cbu}</code><br>
      Alias: <code>${cfg.alias}</code><br>
      Titular: ${cfg.titular}<br>
      Monto: <strong>$ ${Number(factura.monto).toLocaleString("es-AR", { minimumFractionDigits: 2 })}</strong> / mes<br><br>
      <em>Indicar N° <strong>${factura.numero}</strong> en el concepto de la transferencia.</em>
    </div>

    <p>Si ya realizaste la transferencia ignorá este mensaje. Tu cuenta será activada
       dentro del próximo día hábil.</p>
  </div>
</body>
</html>`;
}

function buildSuspensionHtml(empresa: Record<string, unknown>): string {
  return `
<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
  .header { background: #dc2626; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
  .body   { border: 1px solid #e5e7eb; border-top: none; padding: 20px; }
</style></head>
<body>
  <div class="header"><h2 style="margin:0">Cuenta suspendida</h2></div>
  <div class="body">
    <p>Hola, <strong>${empresa.nombre}</strong>.</p>
    <p>Tu cuenta de <strong>distrib SaaS</strong> fue suspendida por falta de pago.</p>
    <p>Para reactivarla, realizá la transferencia pendiente y respondé este email con
       el comprobante. Reactivaremos tu cuenta dentro del próximo día hábil.</p>
    <p>Tus datos se conservan intactos y estarán disponibles en cuanto se confirme el pago.</p>
  </div>
</body>
</html>`;
}

function buildReactivacionHtml(empresa: Record<string, unknown>): string {
  return `
<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
  .header { background: #16a34a; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
  .body   { border: 1px solid #e5e7eb; border-top: none; padding: 20px; }
</style></head>
<body>
  <div class="header"><h2 style="margin:0">✅ Cuenta reactivada</h2></div>
  <div class="body">
    <p>Hola, <strong>${empresa.nombre}</strong>.</p>
    <p>¡Tu pago fue confirmado! Tu cuenta de <strong>distrib SaaS</strong> está activa nuevamente.</p>
    <p>Podés ingresar desde <a href="https://distrib.app">distrib.app</a>.</p>
    <p>Gracias por tu confianza.</p>
  </div>
</body>
</html>`;
}

/** v186: nudge de activación — trial con 3 días sin cargar catálogo/movimientos */
function buildOnboardingNudgeHtml(empresa: Record<string, unknown>): string {
  return `
<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
  .header { background: #0ea5e9; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
  .body   { border: 1px solid #e5e7eb; border-top: none; padding: 20px; }
  .paso   { display: flex; gap: 10px; align-items: flex-start; margin: 12px 0; }
  .num    { background: #0ea5e9; color: white; border-radius: 50%; width: 22px; height: 22px;
            display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0; }
</style></head>
<body>
  <div class="header"><h2 style="margin:0">👋 ¿Necesitás una mano para arrancar?</h2></div>
  <div class="body">
    <p>Hola, <strong>${empresa.nombre}</strong>.</p>
    <p>Vimos que todavía no cargaste tu catálogo ni registraste tu primer movimiento
       en <strong>distrib</strong>. Son 2 pasos y ya tenés todo el sistema funcionando:</p>

    <div class="paso"><div class="num">1</div><div>Importá tu catálogo de productos
      (Excel, CSV, PDF o incluso una foto de tu lista de precios) desde
      <strong>Productos → Importar</strong>.</div></div>
    <div class="paso"><div class="num">2</div><div>Cargá tu primer pedido o hacé una
      venta de prueba en el punto de venta — así vas a ver los reportes tomar forma
      solos.</div></div>

    <p>Si te trabaste en algún paso o preferís que te ayudemos a migrar tus datos
       desde tu sistema actual, respondé este email y coordinamos.</p>

    <p>Ingresá desde <a href="https://distrib.app">distrib.app</a>.</p>
  </div>
</body>
</html>`;
}

// ─── Procesador principal ────────────────────────────────────────────────────

async function procesarEmailsPendientes() {
  // Leer config global
  const { data: cfg } = await supabase
    .from("saas_config")
    .select("*")
    .eq("id", 1)
    .single();

  if (!cfg) throw new Error("saas_config no encontrada");

  // Leer emails no enviados aún (ok = false indica pendiente de envío real)
  // Usamos la convención: ok = true significa "ya procesado por este edge function"
  // Nota: al insertar desde SQL ponemos ok=true para simplicidad del log;
  // acá buscamos registros de los últimos 60 min que tengan factura_id o tipo suspension/reactivacion
  // que aún no tienen el campo "detalle" seteado (= pendientes de envío real).
  //
  // Alternativa más simple: buscar registros de las últimas 2 horas sin detalle.
  const { data: pendientes, error } = await supabase
    .from("saas_email_log")
    .select(`
      id, empresa_id, factura_id, tipo, destinatario, ok, detalle,
      empresas:empresa_id ( nombre, email, saas_trial_fin ),
      saas_facturas:factura_id ( numero, periodo, concepto, monto, fecha_emision, fecha_vencimiento )
    `)
    .is("detalle", null)
    .gte("enviado_at", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
    .limit(50);

  if (error) throw new Error(`Error leyendo email_log: ${error.message}`);
  if (!pendientes?.length) return { procesados: 0 };

  let procesados = 0;

  for (const item of pendientes) {
    const empresa  = item.empresas as Record<string, unknown>;
    const factura  = item.saas_facturas as Record<string, unknown>;
    const to       = item.destinatario;
    let subject    = "";
    let html       = "";

    try {
      switch (item.tipo) {
        case "factura":
          subject = `[distrib] Factura ${factura?.numero} — vence ${factura?.fecha_vencimiento}`;
          html    = buildFacturaHtml(empresa, factura, cfg);
          await sendEmail(to, subject, html);
          // Copia al admin
          if (ADMIN_EMAIL) await sendEmail(ADMIN_EMAIL, `[COPIA] ${subject}`, html);
          break;

        case "trial_aviso": {
          const trialFin = new Date(empresa.saas_trial_fin as string);
          const hoy      = new Date();
          const dias     = Math.ceil((trialFin.getTime() - hoy.getTime()) / 86400000);
          subject = `[distrib] Tu prueba gratuita vence en ${dias} día${dias !== 1 ? "s" : ""}`;
          html    = buildTrialAvisoHtml(empresa, factura, cfg, dias);
          await sendEmail(to, subject, html);
          break;
        }

        case "suspension":
          subject = "[distrib] Cuenta suspendida por falta de pago";
          html    = buildSuspensionHtml(empresa);
          await sendEmail(to, subject, html);
          if (ADMIN_EMAIL) await sendEmail(ADMIN_EMAIL, `[ALERTA] Empresa suspendida: ${empresa.nombre}`, html);
          break;

        case "reactivacion":
          subject = "[distrib] ✅ Tu cuenta fue reactivada";
          html    = buildReactivacionHtml(empresa);
          await sendEmail(to, subject, html);
          break;

        case "onboarding_nudge":
          subject = `[distrib] ¿Necesitás una mano para arrancar, ${empresa.nombre}?`;
          html    = buildOnboardingNudgeHtml(empresa);
          await sendEmail(to, subject, html);
          break;

        default:
          console.warn("Tipo de email desconocido:", item.tipo);
          continue;
      }

      // Marcar como enviado
      await supabase
        .from("saas_email_log")
        .update({ detalle: "enviado", ok: true })
        .eq("id", item.id);

      procesados++;
    } catch (err) {
      console.error(`Error enviando email ${item.id}:`, err);
      await supabase
        .from("saas_email_log")
        .update({ detalle: `error: ${(err as Error).message}`, ok: false })
        .eq("id", item.id);
    }
  }

  return { procesados };
}

// ─── Handler HTTP ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type",
      },
    });
  }

  try {
    const result = await procesarEmailsPendientes();
    return new Response(JSON.stringify({ ok: true, ...result }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
