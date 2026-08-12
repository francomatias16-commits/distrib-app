// gps-tracker.js — Etapa 1 (Logística) del plan por etapas.
//
// Manda la posición GPS del chofer cada ~25s a POST /api/rutas-live?accion=posicion
// mientras tiene una ruta activa hoy con al menos un pedido "despachado"
// (en camino). Esa posición es la que ya consumía el mapa de seguimiento del
// admin (frontend/admin/js/rutas.js) y el endpoint de seguimiento del
// cliente (accion=seguimiento) — hasta ahora nadie la mandaba desde acá.
//
// Se auto-inicia solo (no depende de variables de otros <script> de la
// página) y es 100% best-effort: cualquier error se ignora en silencio para
// no interrumpir el uso normal de la app del chofer. Si el navegador o el
// usuario no dan permiso de geolocalización, la app sigue funcionando
// exactamente igual que antes, solo que sin tracking en vivo.
(function () {
  const INTERVALO_MS = 25000; // no floodear el backend en cada evento de watchPosition
  const REVISAR_RUTA_MS = 5 * 60 * 1000; // re-chequear si ya hay ruta asignada, cada 5 min

  let watchId = null;
  let ultimoEnvio = 0;
  let rutaIdActual = null;
  let sbGps = null;

  async function obtenerSesion() {
    if (!sbGps) return null;
    const { data } = await sbGps.auth.getSession();
    return data?.session || null;
  }

  async function detectarRutaActiva() {
    const session = await obtenerSesion();
    if (!session) return null;
    try {
      const r = await fetch('/api/chofer/remitos', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!r.ok) return null;
      const data = await r.json();
      const remitos = data.remitos || [];
      const hayEnCamino = remitos.some(rem => rem.estado === 'despachado');
      if (!data.ruta_id || !hayEnCamino) return null;
      return data.ruta_id;
    } catch (e) {
      return null;
    }
  }

  function iniciarWatch() {
    if (watchId !== null) return; // ya está corriendo
    if (!navigator.geolocation) return;

    watchId = navigator.geolocation.watchPosition(
      (pos) => enviarPosicion(pos.coords.latitude, pos.coords.longitude),
      (err) => console.warn('[gps-tracker] geolocalización no disponible:', err.message),
      { enableHighAccuracy: true, maximumAge: 20000, timeout: 30000 }
    );
  }

  function detenerWatch() {
    if (watchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  }

  async function enviarPosicion(lat, lng) {
    const ahora = Date.now();
    if (ahora - ultimoEnvio < INTERVALO_MS) return; // throttle
    ultimoEnvio = ahora;
    if (!rutaIdActual) return;

    const session = await obtenerSesion();
    if (!session) return;

    try {
      await fetch('/api/rutas-live?accion=posicion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ ruta_id: rutaIdActual, lat, lng }),
      });
    } catch (e) {
      // silencioso a propósito: un ping de GPS perdido no debe interrumpir al chofer
    }
  }

  async function tick() {
    const rutaId = await detectarRutaActiva();
    if (rutaId) {
      rutaIdActual = rutaId;
      iniciarWatch();
    } else {
      rutaIdActual = null;
      detenerWatch();
    }
  }

  async function iniciarTrackingGPS() {
    if (!window.ENV?.SUPABASE_URL || !window.supabase) return;
    sbGps = window.supabase.createClient(window.ENV.SUPABASE_URL, window.ENV.SUPABASE_ANON_KEY, { auth: { storageKey: 'sb-chofer-auth' } });

    const session = await obtenerSesion();
    if (!session) return; // login.html no carga este script, pero por las dudas

    await tick();
    setInterval(tick, REVISAR_RUTA_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciarTrackingGPS);
  } else {
    iniciarTrackingGPS();
  }
})();
