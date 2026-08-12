# v554 — Auditoría de negocio centralizada (Fase 5, plan ERP)

Última fase del plan de sincronización ERP arrancado en v540+. Con
`pedido_creado`, `cliente_en_mora` y `cheques_por_vencer` ya pasando por
`eventos_negocio` (Fases 1/3/4) y `pedido_facturado`/`factura_anulada`
emitiéndose desde v552, esta entrega expone esa tabla como reporte —
tanto para cada empresa (dueño/admin) como para el superadmin del SaaS
(cross-empresa).

## Modelo de datos (Supabase, proyecto `jgiquzjwoedmzwqgzubr`)

- **Migración `fase5_eventos_negocio_rls_dueno_admin`**: la policy SELECT
  de `eventos_negocio` dejaba ver los eventos de la empresa a
  **cualquier rol** (chofer, vendedor, cliente, etc.) — quedó así de
  cuando la tabla era solo un mecanismo interno (outbox pattern) sin UI
  encima. Se restringe a `dueno`/`admin`, mismo criterio que ya usa
  `audit_log_select_unificada`.
  - No afecta al despachador ni a los listeners: siguen leyendo/escribiendo
    con el cliente `service_role`, que bypassea RLS por completo.

## Backend

- **`lib/handlers/saas.js`**: nueva ruta `GET /api/saas/eventos-negocio`
  — vista cross-empresa (todos los tenants) para el superadmin. Usa
  `supabaseAdmin` (service_role) detrás del mismo gate de superadmin que
  ya protege el resto de `/api/saas/*`; RLS no aplica acá porque el
  service_role la bypassea, así que el gate de rol es el único control de
  acceso. Filtros opcionales por querystring (`empresaId`, `tipoEvento`,
  `estado`) y paginación (`limite` ≤ 200, `offset`). Devuelve
  `{ data, total, limite, offset }`, con `empresas(nombre)` embebido vía
  join para no resolver nombres del lado del cliente.

## Frontend — por empresa (`/admin/auditoria`, dueño/admin/contador)

- **`auditoria.html`**: agregada una segunda pestaña "Eventos de
  negocio" junto a "Registro de cambios" (tabs, no dos páginas separadas
  — mismo layout que ya usaba la página). Tabla con filtros por tipo de
  evento y estado, paginación propia, y modal de detalle que muestra el
  payload completo del evento.
- **`auditoria.js`**: `cambiarTab()` carga los eventos on-demand (recién
  la primera vez que se abre esa pestaña, para no pagar la consulta si
  nadie la mira). Lee `eventos_negocio` directo con el cliente Supabase
  del usuario — RLS ya restringe a dueño/admin, no hace falta pasar por
  un endpoint de backend acá (a diferencia de la vista superadmin, que sí
  necesita cross-empresa).
- **`auditoria-gentelella.css`**: estilos de las tabs (no existían).

## Frontend — superadmin (`/admin/saas-billing`, cross-empresa)

- **`saas-billing.html`**: nueva sección "Eventos de negocio (todos los
  tenants)" en la vista superadmin, junto a la de Migraciones. Filtros
  por tipo de evento y estado, paginación, y llamada a
  `/api/saas/eventos-negocio` con el mismo patrón de fetch + bearer token
  que ya usan `cargar()`/`cargarDashboardKpis()` (no es una RPC
  `SECURITY DEFINER` como `migracion_superadmin_resumen` porque acá el
  filtrado por empresa es dinámico vía querystring, no fijo en la
  función).

## Verificación

- `node --check` sobre los 5 archivos JS tocados/nuevos (`saas.js`,
  `eventos-dispatcher.js`, `cheques_por_vencer.js`, `facturas.js`,
  `notif.js`, `auditoria.js`) + el `<script>` inline de `saas-billing.html`.
- Balance de tags `<div>`/`</div>` verificado en `auditoria.html` (37/37)
  y `saas-billing.html` (95/95) — la sesión anterior había dejado
  `auditoria.html` con el HTML de las tabs a medio cerrar; se reescribió
  la sección completa.
- RLS verificada por consulta directa a `pg_policies` en Supabase (la
  migración ya estaba aplicada de la sesión anterior).
- **Suite completa: 53/53** (sin tests nuevos — el endpoint nuevo y las
  vistas de auditoría no tienen cobertura hoy, mismo estado que el resto
  de `saas.js`).

## Qué NO se hizo en esta entrega

- No se agregó exportación (CSV/Excel) de los eventos — no estaba en el
  alcance acordado.
- No se tocó el flujo de reprocesamiento (`eventos-reprocesar-cron`) ni
  los listeners existentes — esta entrega es puramente de lectura/reporte
  sobre datos que ya se estaban generando.
- La vista superadmin no tiene selector de empresa todavía (columna
  "Empresa" en la tabla, pero sin filtro dedicado en el UI) — se puede
  sumar como follow-up si hace falta filtrar por tenant específico desde
  ahí; el backend ya soporta `empresaId` en la query string.

## Follow-up (mismo día): selector de empresa en la vista superadmin

Cerrado el pendiente que quedaba anotado en "Qué NO se hizo": se agregó
un `<select>` de empresa al filtro de "Eventos de negocio (todos los
tenants)" en `saas-billing.html`, poblado con la misma lista que ya trae
`cargar()` (`GET /api/saas?_svc=empresas`) — sin consulta extra. El
backend ya soportaba `empresaId` en la query string desde el diseño
original del endpoint, así que este cambio fue puramente de frontend.

Verificación: `node --check` del script inline, balance de tags, suite
53/53.

## Follow-up (mismo día): exportación a CSV

Reutiliza `frontend/admin/js/export-utils.js` (ya existía en el repo,
usado en otros reportes) — sin librería nueva ni endpoint nuevo.

- **Por empresa** (`auditoria.html`/`auditoria.js`): botón "Exportar CSV"
  en la pestaña "Eventos de negocio". `exportarEventosCSV()` consulta
  `eventos_negocio` directo (mismo cliente RLS de la página) respetando
  los filtros de tipo/estado activos, con tope de 5000 filas — no exporta
  solo la página visible, exporta todo lo que matchea el filtro.
- **Superadmin** (`saas-billing.html`): botón "Exportar CSV" en la
  sección cross-empresa. `exportarEventosNegocioCSV()` pagina
  `/api/saas/eventos-negocio` (tope de 200 por request) hasta un total de
  2000 filas, respetando filtros de empresa/tipo/estado, e incluye la
  columna Empresa que la vista por-empresa no necesita.

Verificación: `node --check` de ambos scripts inline/externos, balance de
tags HTML (excluyendo el contenido de `<script>`, que puede tener texto
tipo `<select>` en comentarios), suite 53/53.
