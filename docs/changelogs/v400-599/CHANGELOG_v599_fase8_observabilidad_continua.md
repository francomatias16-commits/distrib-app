# v599 — Fase 8, observabilidad continua (PLAN_ERP_SINCRONIZACION_2026.md)

## Qué pedía
Arrancar la Fase 8 del plan ERP, que hasta ahora no había arrancado
(confirmado en la sesión anterior: sin panel de salud del despachador de
eventos, sin alertas por eventos en error prolongado, sin métricas de
negocio derivadas de `eventos_negocio`).

## Qué se hizo
No se agregó tabla nueva — Fase 8 es lectura/agregación sobre lo que las
Fases 1-4 ya generan en `eventos_negocio`.

- **`supabase/migrations/435_fase8_indices_observabilidad_eventos.sql`** —
  dos índices de soporte: `idx_eventos_negocio_empresa_creado` (resumen por
  empresa/ventana de tiempo) e `idx_eventos_negocio_empresa_error` parcial
  sobre `estado='error'` (listado de errores prolongados por empresa) — los
  índices de la migración 431 no cubrían bien ninguno de los dos patrones
  nuevos.
- **`lib/repos/observabilidad.js`** (nuevo) — 3 queries: resumen por
  ventana, eventos en error hace más de 2 h, y eventos
  `pedido_creado`/`pedido_facturado` para las métricas de negocio. La
  agregación (conteos, tiempo promedio) se hace en JS sobre un recorte
  acotado (`LIMITE_FILAS_AGREGACION = 5000`), no con una función SQL —
  documentado en el propio archivo como el primer lugar a revisar si el
  volumen de eventos crece mucho.
- **`lib/handlers/admin.js`** — dos endpoints nuevos:
  - `GET /api/admin/salud-eventos?horas=` — conteos por estado
    (pendiente/procesado/error), desglose por `tipo_evento` con tiempo
    promedio de procesamiento, y lista de eventos en error hace más de 2 h
    (`MINUTOS_ERROR_PROLONGADO`).
  - `GET /api/admin/metricas-negocio?horas=` — pedidos por hora y tiempo
    promedio pedido→facturación, matcheando `pedido_creado`/
    `pedido_facturado` por `payload.pedido_id` (los dos eventos ya traían
    ese campo desde las Fases 1 y 4, no hizo falta tocar los emisores).
    Ojo: solo ve el flujo instrumentado — un pedido facturado como
    `venta_pos_id` en vez de `pedido_id` no entra en el promedio, queda
    documentado en el propio handler.
- **`handleAlertas`** (misma función, categoría 9 nueva) — eventos en
  error hace más de 2 h ahora aparecen en la campanita y en
  `/admin/avisos` (`tipo: evento_error_prolongado`), sin botón "marcar
  como revisado" (se resuelve solo cuando el evento pasa a `procesado`,
  mismo criterio que `cheque_vencido`).
- **`frontend/admin/observabilidad.html` + `js/observabilidad.js`**
  (nuevos) — pantalla "Salud del sistema": cards de resumen, tabla por
  tipo de evento, tabla de errores prolongados, barras de pedidos por hora
  y card de tiempo promedio pedido→factura. Mismo reskin que
  `avisos.html`/`anomalias.html` (`anomalias-gentelella.css`).
- **`frontend/admin/js/nav-data.js`** — nuevo ítem "Salud del sistema" en
  el grupo "Alertas automáticas".
- **`vercel.json`** — rutas `/api/admin/salud-eventos`,
  `/api/admin/metricas-negocio` y `/admin/observabilidad`.
- **`tests/repos/observabilidad.test.js`** (nuevo, 4 tests) — foco en que
  cada query filtra por `empresa_id` (mismo tipo de bug que ya auditó
  AUDITORIA_2026) y usa la columna correcta (`creado_en` para el resumen,
  `procesado_en` para "en error prolongado" — no son intercambiables).

## Verificación
- `npx vitest run` completo: 817 tests OK. La única falla
  (`tests/handlers/admin-permisos.test.js`, 6 casos) es preexistente y no
  la causaron estos cambios — ese archivo nunca mockeó
  `lib/repos/_db.js`, así que cualquiera de las 9 rutas ya existentes de
  `/api/admin/*` (no solo las 2 nuevas) falla igual en este sandbox por
  falta de `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` reales. Verificado
  poniendo variables falsas: el test pasa el punto de la falla original y
  después cuelga tratando de conectar a un Supabase real (timeout), lo que
  confirma que el gap es de mockeo del archivo de test, no del código de
  producción.

## Pendiente / decisiones a revisar
- El panel es por-tenant (cada dueño/admin ve solo la salud de su propia
  empresa), no una vista global cross-tenant — coherente con el resto de
  `admin.js` y con que no existe hoy un panel de operaciones interno
  separado del panel de cada cliente.
- `MINUTOS_ERROR_PROLONGADO = 120` (2 h) — arrancó en 30 min y se subió en
  la misma sesión: además del cron diario de reproceso, cada pedido nuevo
  de la empresa dispara un reintento inmediato
  (`despacharPendientes({ empresaId })` en `crearPedidoParaCliente`), así
  que el reintento real depende de la actividad del negocio, no de un
  reloj fijo. Con 30 min, una empresa con poca actividad (de noche, por
  ejemplo) mostraría "error prolongado" solo por falta de pedidos nuevos
  que disparen el reintento, no por una falla real. Si en producción 2h
  genera ruido o al revés tarda en avisar, es el primer parámetro a
  ajustar con datos reales.
- Las métricas de negocio (pedidos por hora, tiempo pedido→facturación)
  dependen de que el flujo piloto de Fase 1/4 esté activo para la empresa;
  no agregan retroactivamente eventos que nunca se emitieron.
