// supabase/functions/security-audit-alert/index.ts
//
// Etapa 0 — cierre del gap "cambios aplicados directo por SQL Editor sin
// pasar por CI ni por el dueño del proyecto" (el mismo patrón que dejó
// secnew_02 / audit_security_grants_v2 / v3 vivas en la base sin archivo
// en el repo). Como el proyecto se deploya directo con Vercel CLI sin
// GitHub (no hay GitHub Actions posible), el chequeo diario vive adentro
// de Supabase con pg_cron — mismo patrón que ya usa saas_email_sender_hourly.
//
// Este función NO corre la auditoría: solo recibe el resultado que ya
// calculó `ejecutar_auditoria_seguridad_diaria()` (ver migración
// 20260828041000_etapa0_cron_security_audit_diario.sql) vía
// net.http_post(), y si hay al menos un hallazgo de riesgo, avisa por
// email. Si no hay hallazgos, no manda nada (para no generar fatiga de
// alertas con un mail "todo bien" todos los días).
//
// Deploy: supabase functions deploy security-audit-alert --no-verify-jwt
//   (mismo motivo que saas-email-sender: la llama pg_cron via net.http_post
//   sin Authorization header, no hace falta vault ni JWT).
//
// Variables de entorno requeridas (ya configuradas para saas-email-sender,
// se reutilizan tal cual — Dashboard → Settings → Edge Functions):
//   SUPABASE_URL              (automática)
//   SUPABASE_SERVICE_ROLE_KEY (automática, no se usa acá pero queda reservada)
//   RESEND_API_KEY            (ya configurada)
//   SAAS_FROM_EMAIL           (ya configurada)
//   SAAS_ADMIN_EMAIL          (ya configurada) — destinatario de la alerta

const RESEND_KEY  = Deno.env.get("RESEND_API_KEY")!;
const FROM_EMAIL  = Deno.env.get("SAAS_FROM_EMAIL") ?? "distrib <no-reply@distrib.app>";
const ADMIN_EMAIL = Deno.env.get("SAAS_ADMIN_EMAIL") ?? "";

interface HallazgoFuncion {
  funcion: string;
  argumentos: string;
  anon_puede_ejecutar: boolean;
  authenticated_puede_ejecutar: boolean;
  muta_datos: boolean;
  parece_filtrar_por_tenant: boolean;
  parece_verificar_rol: boolean;
}

interface HallazgoVista {
  vista: string;
  anon_puede_leer: boolean;
  authenticated_puede_leer: boolean;
}

interface PayloadAuditoria {
  ejecutado_en: string;
  funciones_riesgo: HallazgoFuncion[];
  vistas_riesgo: HallazgoVista[];
}

async function sendEmail(to: string, subject: string, html: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err}`);
  }
  return res.json();
}

function filaFuncion(f: HallazgoFuncion): string {
  return `
    <tr>
      <td><code>${f.funcion}(${f.argumentos ?? ""})</code></td>
      <td>${f.anon_puede_ejecutar ? "anon" : ""}${f.anon_puede_ejecutar && f.authenticated_puede_ejecutar ? " + " : ""}${f.authenticated_puede_ejecutar ? "authenticated" : ""}</td>
      <td>${f.muta_datos ? "sí" : "no"}</td>
      <td>${f.parece_filtrar_por_tenant ? "sí" : "no"}</td>
      <td>${f.parece_verificar_rol ? "sí" : "no"}</td>
    </tr>`;
}

function filaVista(v: HallazgoVista): string {
  return `
    <tr>
      <td><code>${v.vista}</code></td>
      <td>${v.anon_puede_leer ? "anon" : ""}${v.anon_puede_leer && v.authenticated_puede_leer ? " + " : ""}${v.authenticated_puede_leer ? "authenticated" : ""}</td>
    </tr>`;
}

function buildHtml(payload: PayloadAuditoria): string {
  const total = payload.funciones_riesgo.length + payload.vistas_riesgo.length;

  const tablaFunciones = payload.funciones_riesgo.length
    ? `
      <h3>Funciones SECURITY DEFINER (${payload.funciones_riesgo.length})</h3>
      <table>
        <tr><th>Función</th><th>Ejecutable por</th><th>Muta datos</th><th>Filtra tenant</th><th>Verifica rol</th></tr>
        ${payload.funciones_riesgo.map(filaFuncion).join("")}
      </table>`
    : "";

  const tablaVistas = payload.vistas_riesgo.length
    ? `
      <h3>Vistas sin security_invoker (${payload.vistas_riesgo.length})</h3>
      <table>
        <tr><th>Vista</th><th>Legible por</th></tr>
        ${payload.vistas_riesgo.map(filaVista).join("")}
      </table>`
    : "";

  return `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; color: #333; max-width: 640px; margin: 0 auto; padding: 20px; }
  .header { background: #b91c1c; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
  .body   { border: 1px solid #e5e7eb; border-top: none; padding: 20px; }
  table   { width: 100%; border-collapse: collapse; margin: 12px 0 20px; font-size: 0.85em; }
  th, td  { padding: 6px 10px; border: 1px solid #e5e7eb; text-align: left; }
  th      { background: #f3f4f6; }
  code    { background: #f3f4f6; padding: 1px 4px; border-radius: 3px; }
  .footer { color: #6b7280; font-size: 0.85em; margin-top: 24px; }
</style></head>
<body>
  <div class="header">
    <h2 style="margin:0">⚠️ Auditoría de seguridad diaria — ${total} hallazgo${total === 1 ? "" : "s"}</h2>
    <p style="margin:4px 0 0">${payload.ejecutado_en}</p>
  </div>
  <div class="body">
    <p>La corrida diaria de <code>audit_security_definer_grants()</code> /
       <code>audit_views_security_invoker()</code> encontró
       ${total} objeto${total === 1 ? "" : "s"} con <code>riesgo_potencial = true</code>
       contra la base real.</p>
    ${tablaFunciones}
    ${tablaVistas}
    <p>Revisar con <code>npm run audit:security</code> /
       <code>npm run audit:security:json</code> y, si el hallazgo es legítimo,
       agregarlo a <code>en_allowlist_revisado</code> con su justificación
       dejada en el commit/migración correspondiente — no editar la función
       a mano desde el SQL Editor sin versionarlo.</p>
    <div class="footer">Fluxo — chequeo automático diario (pg_cron).</div>
  </div>
</body>
</html>`;
}

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
    const payload = (await req.json()) as PayloadAuditoria;
    const total = (payload.funciones_riesgo?.length ?? 0) + (payload.vistas_riesgo?.length ?? 0);

    if (total === 0) {
      return new Response(JSON.stringify({ ok: true, enviado: false, motivo: "sin_hallazgos" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!ADMIN_EMAIL) {
      throw new Error("SAAS_ADMIN_EMAIL no está configurado — no hay destinatario para la alerta");
    }

    await sendEmail(
      ADMIN_EMAIL,
      `⚠️ Auditoría de seguridad: ${total} hallazgo${total === 1 ? "" : "s"} en distrib`,
      buildHtml(payload),
    );

    return new Response(JSON.stringify({ ok: true, enviado: true, total }), {
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
