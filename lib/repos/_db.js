// lib/repos/_db.js
// Cliente Supabase singleton compartido por todos los repos.
//
// USO: importar `db` desde cualquier repo, no instanciar createClient() de nuevo.
//   import { db } from './_db.js';
//
// Antes de este módulo cada handler creaba su propio createClient() (24 instancias
// duplicadas). Un único cliente con SERVICE_ROLE_KEY es suficiente en serverless
// porque cada invocación es stateless.

import { createClient } from '@supabase/supabase-js';

// FIX (2026-07-14, incidente "dashboard no conecta con los datos" — recurrencia
// del patrón de v336): esto antes creaba el client (y validaba las env vars)
// a nivel de módulo, con un `throw` si faltaba SUPABASE_URL o
// SUPABASE_SERVICE_ROLE_KEY. Como api/index.js importa TODOS los handlers de
// una sola vez en una única Serverless Function, y ~18 repos/handlers
// importan `db` desde acá, ese throw en el import tumbaba el arranque de
// TODA la lambda — cualquier ruta /api/*, no solo las que usan `db`.
//
// Ahora la creación del client es perezosa: recién se ejecuta (y recién ahí
// puede fallar) en el primer uso real, dentro del handler que la invoque. Si
// faltan las env vars, ese handler puntual devuelve un error claro — el
// resto del panel sigue funcionando.
let _client = null;
let _initError = null;

function getClient() {
  if (_client) return _client;
  if (_initError) throw _initError;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    _initError = new Error('[repos/_db] SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no definidos');
    throw _initError;
  }
  _client = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { persistSession: false },   // serverless: no persistir sesión en memoria
    }
  );
  return _client;
}

// Proxy: mantiene la misma API que antes (`db.from(...)`, `db.rpc(...)`, etc.)
// para no tener que tocar los ~18 repos/handlers que ya hacen
// `import { db } from './_db.js'` y lo usan como objeto directo. La única
// diferencia es que el createClient() real (y su posible falla) se dispara
// recién cuando se accede a una propiedad, no en el import.
export const db = new Proxy({}, {
  get(_target, prop, receiver) {
    const client = getClient();
    const value = Reflect.get(client, prop, client);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
