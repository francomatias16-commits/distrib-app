// lib/wa-endpoint-http.js
//
// PLAN_ROBUSTEZ_ESCALABILIDAD_PROFESIONAL_2026.md — fix puntual encontrado
// al retomar el plan (sep 2026): 5 emisores de WhatsApp saliente
// (enviarNotifPedido en notif.js, enviarAvisoDeudaVencida, enviarRecuperacionFuga,
// ofrecerPlanDePago en score.js, el reset de password por WA en auth.js)
// comparten el mismo patrón `const WA_ENDPOINT = process.env.WA_ENDPOINT ||
// 'http://localhost:3000/...'` para pegarle a su propio /api/notif/whatsapp
// — pero, a diferencia de enviarAvisoChequesPorVencer (el único que ya
// hacía `if (process.env.WA_ENDPOINT)` antes de intentar el envío), los
// otros 5 siempre intentaban el fetch, incluso sin la env var configurada
// en Vercel (cayendo al fallback de localhost, que no existe en el runtime
// serverless). Además, si la respuesta no es JSON (HTML de error, redirect,
// etc.), `.json()` tira un SyntaxError genérico que no dice nada útil.
//
// Estas dos funciones son un helper de bajo nivel, no un wrapper que
// reemplaza las 5 llamadas — cada caller sigue armando su propio fetch
// (headers/body distintos entre ellos, ej. Authorization Bearer CRON_SECRET
// en score.js/auth.js) para no tocar ningún contrato de retorno existente.

// waEndpointConfigurado(): mismo criterio que ya usaba
// enviarAvisoChequesPorVencer — si WA_ENDPOINT no está seteada, no tiene
// sentido intentar pegarle al fallback de localhost en producción.
export function waEndpointConfigurado() {
  return !!process.env.WA_ENDPOINT;
}

// leerRespuestaWa(waResp): igual que waResp.json(), pero si el body no es
// JSON (content-type distinto, o JSON.parse revienta igual) devuelve
// { ok:false, motivo } con el status/content-type real en vez de dejar
// pasar el SyntaxError crudo hasta el catch del caller.
export async function leerRespuestaWa(waResp) {
  const contentType = waResp.headers?.get?.('content-type') || '';
  if (!contentType.includes('application/json')) {
    const textoCrudo = await waResp.text().catch(() => '');
    return {
      esJson: false,
      motivo: `respuesta no-JSON de WA_ENDPOINT (status ${waResp.status}, content-type "${contentType || 'desconocido'}"): ${textoCrudo.slice(0, 200)}`,
    };
  }
  try {
    return { esJson: true, data: await waResp.json() };
  } catch (err) {
    return { esJson: false, motivo: `respuesta no-JSON de WA_ENDPOINT (status ${waResp.status}): ${err.message}` };
  }
}
