// lib/supabase-fetch-timeout.js
// Helper compartido: un `fetch` con timeout para inyectar como `global.fetch`
// en createClient() de Supabase.
//
// FIX v862 (504 recurrente en /api/admin/*, generalización del incidente
// 2026-07-12): ese incidente detectó que `supabase.auth.getUser()` podía
// colgarse SIN tirar error, comiéndose los 60s completos del límite de
// Vercel. Se lo parchó puntualmente con un `Promise.race` + timeout de 8s
// alrededor de esa única llamada (ver `getUserConTimeout` en
// lib/handlers/admin.js).
//
// Pero ese parche solo cubre esa llamada puntual. `auth.getUser()` (GoTrue)
// y `.from()/.rpc()` (PostgREST) comparten el mismo `fetch` interno del
// client — si el fetch en sí puede colgarse sin timeout, TODAS las llamadas
// de red del client pueden hacerlo, no solo Auth: el perfil del usuario
// (`obtenerPerfilAdmin`), el rate limiter (`rl_check_and_increment`), y los
// RPCs de KPIs (`obtener_kpis_dashboard_v3/v2/v1`, ventas-por-canal,
// resumen-compras, gastos-generales) son todos llamadas por el mismo
// mecanismo sin protección. Confirmado en producción (Vercel runtime logs):
// /api/admin/kpis siguió devolviendo 504 a los 60s exactos incluso en
// deploys que ya tenían el parche de auth.getUser.
//
// En vez de seguir parchando llamada por llamada, se le pone timeout al
// fetch del client UNA sola vez acá, y se inyecta en los dos lugares que
// instancian createClient() (lib/repos/_db.js y lib/supabase-lazy.js). Todo
// el código que ya hace `if (error) ...` sobre el resultado de `.from()` o
// `.rpc()` sigue funcionando sin cambios: postgrest-js atrapa el AbortError
// del fetch y lo devuelve como `{ data: null, error }` en vez de tirarlo sin
// atrapar, así que un timeout acá se comporta como cualquier otro error de
// red ya contemplado en el resto del proyecto.
//
// El timeout individual (10s) queda por debajo del límite de la función
// (60s) para que, incluso si una request encadena 2-3 llamadas secuenciales
// que timeoutean todas, el handler siga teniendo margen para responder un
// error controlado en vez de que Vercel mate la función en seco.

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Crea una función `fetch` compatible con la opción `global.fetch` de
 * `createClient()`, que aborta la request si no hay respuesta dentro de
 * `timeoutMs`.
 */
export function crearFetchConTimeout(timeoutMs = DEFAULT_TIMEOUT_MS) {
  return function fetchConTimeout(url, options = {}) {
    const controller = new AbortController();

    // Si el caller ya mandó un signal propio, lo encadenamos: cualquiera de
    // los dos (el nuestro por timeout, o el suyo) puede abortar la request.
    const signalExterno = options.signal;
    if (signalExterno) {
      if (signalExterno.aborted) controller.abort();
      else signalExterno.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const timer = setTimeout(() => controller.abort(), timeoutMs);

    return fetch(url, { ...options, signal: controller.signal })
      .finally(() => clearTimeout(timer));
  };
}
