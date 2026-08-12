# v281 — Cuenta Corriente server-side + fix de grants (continuación AUDITORIA_FILTROS_v280)

## Contexto
Continuación directa de la sesión anterior sobre la pantalla "Saldos por
cliente" (`/admin/cobranzas?vista=saldos`, `cta-cte.js`). Ese trabajo había
quedado en: migración 266 aplicada en vivo contra la base real
(`jgiquzjwoedmzwqgzubr`) agregando `fn_cta_cte_kpis()` y `fn_cta_cte_lista()`,
con un smoke test de `fn_cta_cte_kpis()` ya verificado. El código quedó sin
integrar al zip de trabajo y `cta-cte.js` sin actualizar. Este paquete cierra
ambas cosas.

## 266_rpc_cta_cte_kpis_y_lista_server_side.sql (incluida, ya aplicada)
Confirmado en la sesión anterior: no había bug de aislamiento multi-tenant
en `resumen_cta_cte()` (la sospecha inicial se basaba en una migración
`007_finanzas_fix.sql` que no existe en el historial real del proyecto —
el zip auditado tenía la carpeta `supabase/migrations/` desincronizada de
la base real para el rango 001-109). `resumen_cta_cte()` queda intacta.
Se agregan dos funciones de performance sobre el esquema real
(`facturas`+`clientes`+`cobros`, verificado por `information_schema.columns`):
- `fn_cta_cte_kpis()` — los 4 totales de las tarjetas agregados en SQL.
- `fn_cta_cte_lista()` — página filtrada (búsqueda + estado) con
  `LIMIT`/`OFFSET` real y `total_count` vía `COUNT(*) OVER()`, incluye
  `ultimo_pago` desde `cobros`.

## 267_fix_grants_fn_cta_cte_kpis_y_lista.sql (nueva)
Al verificar `pg_proc.proacl` de las dos funciones creadas por la 266
(paso de rutina, no algo que se haya pedido) se encontró el mismo patrón
ya corregido en la 258 para `fn_productos_lista`/`fn_productos_contadores`:
`CREATE FUNCTION` deja `EXECUTE` otorgado a `PUBLIC` por defecto, y la 266
solo agregó `GRANT` a `authenticated`/`service_role` sin revocar antes —
o sea `anon` también podía ejecutarlas. Se revoca de `PUBLIC` y `anon`,
queda el `EXECUTE` solo para `authenticated` y `service_role`. Verificado
con `pg_proc.proacl` directo (no `has_function_privilege`) antes y después:
antes `{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}`,
después `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}`.
Aplicada en vivo contra `jgiquzjwoedmzwqgzubr`.

## frontend/admin/js/cta-cte.js
`cargarCtaCte()` reescrita para llamar `fn_cta_cte_kpis()` +
`fn_cta_cte_lista()` en paralelo en lugar de `resumen_cta_cte()` sin
paginar + agregación de los 4 KPIs en JS sobre el array completo.
- Los KPIs ahora vienen de una sola fila agregada en SQL
  (`actualizarKPIsSaldos`); se mantiene `actualizarKPIsSaldosFallback`
  con la lógica vieja por si las RPC nuevas no están disponibles en algún
  tenant (fallback automático a `resumen_cta_cte()` / consulta directa a
  `facturas` si `fn_cta_cte_kpis`/`fn_cta_cte_lista` devuelven error).
- `filtrarClientes()` ya no filtra en JS sobre un array en memoria: resetea
  a página 1 y recarga contra la RPC (búsqueda + estado viajan como
  parámetros `p_busqueda`/`p_estado`).
- Búsqueda con debounce (`onBusquedaClienteInput`, 250ms), mismo patrón que
  `notas-credito.js` (migración 264).
- Paginación real agregada: `paginaActualCC`, `ITEMS_POR_PAGINA_CC` (50),
  `totalCCFiltrados`, controles inyectados dinámicamente
  (`inyectarControlesPaginacionCC` / `cambiarPaginaCC`), mismo componente
  visual que notas de crédito (`.paginacion-container` / `.btn-pag` de
  `shared/pagination.css`).

## frontend/admin/cobranzas.html
- Agregado `<link rel="stylesheet" href="/shared/pagination.css?v=1" />`
  (no estaba incluido; los controles de paginación nuevos lo necesitan).
- `buscar-cliente` pasa de `oninput="filtrarClientes()"` a
  `oninput="onBusquedaClienteInput()"` para el debounce.
- Cache-buster de `cta-cte.js` actualizado a `?v266`.

## Pendiente / para revisar juntos
La sesión anterior dejó abierta la pregunta de si otras pantallas tienen
el mismo problema de fondo (carpeta `supabase/migrations/` del zip
desincronizada de la base real para rangos viejos). No se tocó nada más
todavía — queda para decidir cómo lo encaramos.

---

# Continuación — AUDITORIA_FILTROS_v280, sección 5 (mediano plazo)

Reconciliado el documento de auditoría completo (versión "(3)", con la
ampliación de portales + repaso admin) contra el código real y contra
`list_migrations` de Supabase. Ya cerrados antes de esta tanda: §1 (bug
Clientes), §6.1 (catálogo cliente, migración 255 confirmada aplicada en
vivo), §6.2 (POS, sin cambios), corto plazo completo (Productos 256,
Pedidos 257, Cheques 259, Riesgo cheques 261, Facturación 262), y del
mediano plazo: Notas (263), Notas de crédito (264), Cta-cte (266/267).

## 268_rpc_cobranzas_kpis_y_facturas_server_side.sql (nueva)
Módulo: `cobranzas.js`, pestaña "¿A quién llamo hoy?" (no confundir con
"Saldos por cliente" = cta-cte, ya resuelta). No tiene buscador de texto
(son 3 tabs por fecha + "Priorizada", que sigue con `/api/score` sin
tocar), pero sí el mismo patrón de fondo: `cargarDatos()` traía TODAS las
facturas `estado IN ('emitida','parcial')` con `.limit(500)` "tope de
seguridad" y las repartía en 3 baldes (hoy/semana/vencidas) con
`Array.filter()` en JS — si un tenant supera las 500 facturas abiertas,
"Vence hoy" y "Total vencido" empiezan a subcontar (mismo tipo de bug que
el `.limit(200)` ya corregido en Pedidos).

Se agregan:
- `fn_cobranzas_kpis()` — deuda + conteo de los 3 baldes agregados en SQL,
  sin tope arbitrario.
- `fn_cobranzas_facturas(p_bucket, p_limit, p_offset)` — página de un
  balde puntual con `LIMIT`/`OFFSET` real y `total_count` vía
  `COUNT(*) OVER()`.

Grants sin `PUBLIC`/`anon` desde el `CREATE FUNCTION` (lección de la 267:
esta vez el `REVOKE` va en la misma migración, no como parche aparte).
Verificado con `pg_proc.proacl` tras aplicar:
`{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}`.
Aplicada y probada en vivo contra `jgiquzjwoedmzwqgzubr`.

## frontend/admin/js/cobranzas.js
- `cargarDatos()` ya no trae el listado completo de facturas: llama
  `fn_cobranzas_kpis()` para los 4 KPIs (cobrado hoy sigue igual, viene de
  `cta_cte` acotado por fecha).
- `renderFacturas(tab)` para hoy/semana/vencidas pide su propia página a
  `fn_cobranzas_facturas()` en vez de filtrar arrays en memoria.
  "Priorizada" no se tocó.
- Paginación real agregada por tab (`paginaActualCob`,
  `ITEMS_POR_PAGINA_COB` = 50, `totalCobFiltradas`), controles inyectados
  dinámicamente (`inyectarControlesPaginacionCob` / `cambiarPaginaCob`),
  ocultos en la pestaña "Priorizada" (`ocultarPaginacionCob`), mismo
  componente visual que Cta-cte / Notas de crédito. Reset a página 1 al
  cambiar de tab.
- `enviarRecordatorioMasivo()` usaba `facturasVencidas.length +
  facturasHoy.length` sobre los arrays completos viejos; ahora usa los
  conteos de la última respuesta de `fn_cobranzas_kpis()`
  (`ultimosKpisCob`).
- Cache-buster de `cobranzas.js` actualizado a `?v268`.

## Estado del plan de la auditoría tras esta tanda
Quedan del listado de §5 (mediano plazo): **Devoluciones, Proveedores,
Reglas de precio, Rutas, Puntos, Conciliación bancaria, Cc-proveedores**.
De §6.3: **Puntos sigue sin debounce** en su buscador (confirmado,
pendiente junto con su paginación). Rutas — la propia auditoría (§6.4)
aclara que no es urgente (filtra sobre un subconjunto ya chico), así que
puede ir al final de la cola.

