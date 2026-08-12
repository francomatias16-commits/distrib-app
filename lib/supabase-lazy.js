// lib/supabase-lazy.js
// Helper compartido para crear clients de Supabase de forma PEREZOSA a nivel
// de módulo.
//
// FIX (2026-07-14, incidente "dashboard no conecta con los datos" —
// recurrencia del patrón ya identificado en v336): ~28 handlers/módulos
// instanciaban su propio `createClient(process.env.SUPABASE_URL, ...)`
// directo a nivel de módulo (`const supabase = createClient(...)` fuera de
// cualquier función). api/index.js importa TODOS los handlers de una sola
// vez en una única Serverless Function (límite Vercel Hobby de 12
// funciones), así que si a CUALQUIERA de esos ~28 le faltaba
// SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY, el `createClient()` interno
// tiraba `Error: supabaseUrl is required.` en el import — y eso tumbaba el
// arranque de TODA la lambda: /api/admin/kpis, /api/pedidos, y cualquier
// otra ruta, aunque no tuvieran nada que ver con el módulo que disparó el
// error.
//
// crearClienteSupabaseLazy(getArgs) devuelve un Proxy que se comporta
// exactamente igual que el client real (`.from()`, `.rpc()`, `.auth`,
// `.storage`, etc.) pero recién ejecuta `createClient(...)` — y recién ahí
// puede fallar — en el primer uso real dentro de un handler, no en el
// import del módulo. Si faltan las env vars, solo ese handler puntual
// devuelve un error claro al llamarse; el resto del panel sigue
// funcionando.
import { createClient } from '@supabase/supabase-js';

export function crearClienteSupabaseLazy(getArgs) {
  let client = null;
  let initError = null;

  function obtenerClient() {
    if (client) return client;
    if (initError) throw initError;
    try {
      client = createClient(...getArgs());
    } catch (err) {
      initError = err;
      throw err;
    }
    return client;
  }

  return new Proxy({}, {
    get(_target, prop, _receiver) {
      const c = obtenerClient();
      const value = Reflect.get(c, prop, c);
      return typeof value === 'function' ? value.bind(c) : value;
    },
  });
}
