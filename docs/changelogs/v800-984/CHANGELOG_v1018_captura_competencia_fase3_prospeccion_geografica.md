# v1018 — Captura de competencia, Fase 3 (Capa 1 — prospección geográfica) (2026-08-30)

## Por qué

Fase 1 (v1012-v1013) resolvió la captura y conversión de una factura de
competencia en el mostrador; Fase 2 (v1017) cerró el loop de retención con
el ahorro acumulado. Lo que faltaba era el otro extremo del embudo: hoy el
vendedor solo puede capturar un comercio de competencia si ya está parado
adentro. Fase 3, Capa 1 le da un lugar donde ir anotando los comercios
no-clientes que va conociendo en su recorrido (nombre, rubro, ubicación) y,
más adelante, ver cuáles quedan cerca de una ruta ya armada — para no tener
que acordarse de memoria a quién visitar ni desviarse a ciegas.

Sin PostGIS instalado en el proyecto (verificado antes de diseñar la
migración), así que no hay `geography`/`ST_DWithin`: `lat`/`lng` quedan
como `numeric` simples —igual que `clientes.lat/lng`— y la distancia
(Haversine) se calcula en la capa de aplicación, no en SQL.

## Supabase — migración `557_prospectos_competencia.sql`

- Tabla nueva `prospectos_competencia` (comercios no-cliente cargados a
  mano: nombre, rubro, dirección descriptiva, lat/lng, notas, estado).
- `estado` con el mismo espíritu de máquina de estados simple que el resto
  del proyecto: `pendiente → visita_planificada → visitado`, más
  `convertido` (cuando la visita termina en cliente real) y `descartado`.
  `captura_id` (nullable) vincula el prospecto con la captura de
  competencia (Fase 1) que terminó generando, cuando corresponde.
- RLS de solo lectura por `empresa_id` vía `public.get_empresa_id()`,
  igual que `captura_competencia` (551) — el INSERT/UPDATE lo hace siempre
  el handler con `SERVICE_ROLE_KEY`.
- Índice sobre `(lat, lng)` como filtro grueso previo al cálculo exacto en
  la aplicación (mismo espíritu que un bounding-box antes de un cálculo
  más caro, aunque hoy el repo todavía no lo aprovecha explícitamente —
  queda para cuando el volumen de prospectos lo justifique).

## Backend

- `lib/repos/prospectos-competencia.js`: `crearProspecto`,
  `listarProspectos` (scope condicional por `vendedor_id`, mismo criterio
  que `listarCapturasPendientes`), `marcarEstadoProspecto`,
  `listarProspectosActivosParaRanking`, `obtenerParadasConCoordsDeRuta`
  (recorre `entregas → pedidos → clientes` porque `entregas` no tiene
  lat/lng propio) y `distanciaHaversineMetros` (la pieza que reemplaza a
  PostGIS).
- `lib/handlers/prospectos-competencia.js`: 5 acciones —
  `crear` / `listar` / `marcar_estado` / `ranking_ruta` / `metricas`.
  Comparte el mismo
  gate de feature flag que `captura-competencia.js`
  (`empresas.config->>'captura_competencia_habilitada'`, mismo código de
  error `CAPTURA_COMPETENCIA_DESHABILITADA`) — es la misma iniciativa y
  alimenta la misma pantalla de captura, así que no tiene sentido un flag
  independiente.
  - `ranking_ruta`: para cada prospecto activo (`pendiente` o
    `visita_planificada`), calcula la distancia MÍNIMA contra cualquiera
    de las paradas del día de la ruta pedida, descarta lo que queda a más
    del radio configurado de todas las paradas, ordena ascendente y
    devuelve como máximo el tope configurado de resultados. Radio (default
    500m) y tope (default 20) son configurables por empresa vía
    `empresas.config->>'captura_competencia_radio_ranking_metros'` /
    `'...max_ranking_resultados'` — mismo criterio que
    `captura_competencia_margen_minimo_pct` en `captura-competencia.js`
    (default si no está cargado), con un clamp adicional (radio 50–5000m,
    tope 1–100) para que un valor mal cargado no convierta un cálculo
    pensado para decenas de filas en algo caro sobre miles.
  - `marcar_estado`: el vendedor solo puede tocar sus propios prospectos;
    dueño/admin, cualquiera de la empresa — mismo scope que `listar`.
  - `metricas` (plan 3.5 — entregable de Fase 3): "% de comercios
    sugeridos que efectivamente reciben una visita y una captura". Como
    `ranking_ruta` se calcula on-demand y no queda un log histórico de qué
    prospecto apareció en qué ranking, el universo de "sugeridos" se toma
    como el total de prospectos cargados (candidatos disponibles en
    cualquier momento). Devuelve `tasa_visita_pct` (estado `visitado` o
    `convertido`) y `tasa_captura_pct` (`captura_id` no nulo) por
    separado, mismo criterio que `accion=metricas` de
    `captura-competencia.js` (Fase 1, plan 1.7).
- `lib/permisos-service.js`: recurso nuevo `prospectos_competencia`
  (`crear` / `leer` / `confirmar`), mismos roles que `captura_competencia`.
- `api/index.js`: loader nuevo para el módulo `prospectos-competencia`.

## Frontend

- `frontend/admin/prospectos-competencia.html` +
  `js/prospectos-competencia.js`: pantalla con dos vistas —
  - **Bandeja**: alta manual (con botón de geolocalización del navegador o
    carga de coordenadas a mano) y acciones de estado (planificar visita /
    marcar visitado / iniciar captura / descartar).
  - **Sobre una ruta**: elegís una ruta del día (mismo query a Supabase
    que ya usa `rutas.js` para el selector) y ves los prospectos
    priorizados por cercanía, con la distancia en metros.
  - Franja de KPIs (`#pc-kpis`, plan 3.5): prospectos cargados, % que
    reciben visita y % que terminan en captura — mismo componente
    `.dato-sello` que `captura-competencia.js` (Fase 1, plan 1.7).
  - "Iniciar captura" hace un deep-link a `/admin/captura-competencia`
    (Fase 1) con el nombre y el `prospecto_id` en la URL.
- `frontend/admin/js/captura-competencia.js`: al llegar por ese deep-link
  (`?proveedor=X&prospecto_id=Y`), abre directamente el modal de "Nueva
  captura" con el proveedor precargado, y guarda el `prospecto_id` colgado
  de la captura que se termine creando (no como estado global, para no
  vincular por error una captura distinta si el vendedor cancela y arranca
  otra en la misma sesión). Al convertir esa captura en cliente + pedido,
  dispara automáticamente un `accion=marcar_estado` sobre
  `prospectos-competencia` (`estado: 'convertido'`, `captura_id` de la
  captura recién creada) — cierra el loop prospección→captura que en la
  entrega anterior quedaba pendiente de completarse a mano.
- `frontend/admin/js/nav-data.js`: entrada nueva "Prospección de
  competencia", mismo flag y mismos roles que "Captura de competencia".
- `vercel.json`: rewrites nuevos (`/api/prospectos-competencia`,
  `/admin/prospectos-competencia`).

## Tests

- `tests/repos/prospectos-competencia.test.js`: `distanciaHaversineMetros`
  (simetría, distancia real entre dos puntos de Santa Fe, caso
  mismo-punto), el scoping condicional por `vendedor_id` en
  `listarProspectos`/`marcarEstadoProspecto`, y `obtenerMetricasProspectos`.
- `tests/handlers/prospectos-competencia.test.js`: gate del feature flag,
  validaciones de `accion=crear` (nombre, coordenadas numéricas y en
  rango), scoping vendedor-vs-dueño/admin en `listar`/`marcar_estado`,
  `ranking_ruta` (lista vacía sin paradas, orden por distancia mínima,
  corte en el radio/tope configurados, y clamp de valores fuera de rango)
  y `accion=metricas` (tasas de visita/captura, sin división por cero).
- `tests/frontend/captura-competencia-prospecto-origen.test.js` (nuevo):
  el deep-link prellena el proveedor en el modal; una captura creada con
  prospecto de origen dispara el `marcar_estado` de vínculo al convertir
  (`estado: 'convertido'`, `captura_id` correcto); una captura sin
  prospecto de origen NO dispara ese POST extra.
- Suite completa verificada: 87 archivos / 1339 tests, sin regresiones.

## Pendiente

Sin pendientes abiertos de Fase 3 al momento de este corte. El radio y el
tope de `ranking_ruta` quedaron configurables por empresa (ver sección
Backend) pero sin UI de edición — hoy se cargan a mano en
`empresas.config`, mismo criterio que el resto de las claves de esa
columna (`captura_competencia_habilitada`,
`captura_competencia_margen_minimo_pct`), que tampoco tienen pantalla de
edición propia.
