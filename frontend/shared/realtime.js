// frontend/shared/realtime.js
// Fase 2 del plan de sincronización ERP: helper compartido para
// suscripciones a Supabase Realtime. Un solo punto de entrada
// (window.DistribRealtime.suscribir) para que cada pantalla no
// reimplemente su propio manejo de canales, reconexión y limpieza.
(function () {
  const canales = new Map();

  function suscribir({ sb, nombreCanal, tabla, filtro, onCambio, evento = '*', schema = 'public' }) {
    if (!sb) {
      console.error(`[DistribRealtime] falta el client "sb" para el canal "${nombreCanal}"`);
      return null;
    }
    if (!nombreCanal || !tabla || typeof onCambio !== 'function') {
      console.error('[DistribRealtime] suscribir() requiere nombreCanal, tabla y onCambio');
      return null;
    }

    // Si ya existe un canal con este nombre (ej. la pantalla se
    // reinicializa sin recarga completa), se remueve antes de crear el
    // nuevo para no terminar con dos suscripciones activas al mismo evento.
    const previo = canales.get(nombreCanal);
    if (previo) {
      sb.removeChannel(previo);
      canales.delete(nombreCanal);
    }

    const config = { event: evento, schema, table: tabla };
    if (filtro) config.filter = filtro;

    const canal = sb
      .channel(nombreCanal)
      .on('postgres_changes', config, (payload) => {
        try {
          onCambio(payload);
        } catch (err) {
          console.error(`[DistribRealtime] error en el handler del canal "${nombreCanal}":`, err);
        }
      })
      .subscribe((estado) => {
        if (estado === 'CHANNEL_ERROR' || estado === 'TIMED_OUT') {
          console.error(`[DistribRealtime] canal "${nombreCanal}" en estado ${estado}`);
        }
      });

    canales.set(nombreCanal, canal);
    return canal;
  }

  function desuscribir(nombreCanal) {
    const canal = canales.get(nombreCanal);
    if (!canal) return;
    canal.unsubscribe?.();
    canales.delete(nombreCanal);
  }

  window.DistribRealtime = { suscribir, desuscribir };
})();
