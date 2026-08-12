// lib/ws-polyfill.js
//
// FIX (2026-07-14, incidente "dashboard no conecta con los datos" v339):
// @supabase/supabase-js 2.110.5 (vía @supabase/realtime-js) instancia un
// RealtimeClient dentro de createClient(...) y ese constructor referencia
// el global `WebSocket` en el momento de la llamada — aunque la app nunca
// use canales realtime, solo REST/RPC. Node 20.x (el runtime configurado
// en engines/Vercel) no expone `WebSocket` como global nativo (recién
// Node 22+ lo hace), así que CUALQUIER primer createClient() de la lambda
// tira: "Node.js detected but native WebSocket not found" y ese handler
// puntual queda ok:false en /api/health y sin datos en el dashboard.
//
// Este archivo debe importarse ANTES que cualquier módulo que llame a
// createClient() (ver primera línea de api/index.js). Usa el paquete
// `ws` (ya requerido transitivamente por @supabase/realtime-js) como
// implementación de WebSocket para Node.
import WebSocketImpl from 'ws';

if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = WebSocketImpl;
}
