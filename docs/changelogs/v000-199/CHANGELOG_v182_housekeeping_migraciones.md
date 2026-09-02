# v182 — Housekeeping post "prueba de volumen": migraciones 160-165

Aplica los pendientes del machete actualizado (30/06) después de la prueba
de volumen contra el tenant de prueba en producción.

## 1. Bug crítico de pedidos abiertos — repo sincronizado con el hotfix

`migracion_confirmar_pedidos_lote` armaba `v_estado` como `TEXT` y lo
insertaba directo en `pedidos.estado` (enum `estado_pedido`), lo que hacía
fallar **toda** confirmación de pedidos abiertos en la primera fila. El fix
(cast `::estado_pedido`) ya se había aplicado en caliente en producción
durante la prueba de volumen, pero el archivo del repo
(`159_migracion_pedidos_abiertos.sql`) seguía con la versión rota.

- Verificado contra producción (`jgiquzjwoedmzwqgzubr`) con
  `pg_get_functiondef`: la versión viva ya tenía el cast.
- Actualizado `159_migracion_pedidos_abiertos.sql` para que el repo refleje
  exactamente lo que corre hoy. No se volvió a aplicar contra la base
  (no hacía falta, ya estaba), solo se sincronizó el archivo.

## 2. Migraciones 160-165 reconstruidas (housekeeping, no aplicación nueva)

El handler (`lib/handlers/migracion.js`, `frontend/admin/js/migracion.js`)
tiene comentarios que referencian "migración 160" a "165" para cta_cte,
deshacer, precios_clientes, proveedores y un fix de decimales — todo eso
ya corría en producción, pero los `.sql` no estaban en
`supabase/migrations/` del repo.

Verifiqué objeto por objeto contra la base viva (`pg_proc`, `pg_constraint`,
`information_schema.columns`) y reconstruí 4 archivos con el contenido
exacto de lo que está corriendo (no aproximado — `pg_get_functiondef`
literal):

| Archivo | Contenido |
|---|---|
| `160_migracion_cta_cte.sql` | entidad `cta_cte` + `migracion_confirmar_cta_cte_lote` |
| `161_migracion_deshacer_sesion.sql` | columnas `deshecho_en`/`deshecho_error` + `migracion_deshacer_sesion` |
| `162_migracion_precios_clientes.sql` | entidad `precios_clientes` + `migracion_confirmar_precios_cliente_lote` |
| `164_migracion_proveedores.sql` | entidad `proveedores` + `migracion_confirmar_proveedores_lote` |

Las 4 ya quedaron además re-aplicadas contra producción (operación
no-op, mismo contenido que ya estaba vivo — solo para que también figuren
en el historial de migraciones de Supabase) y registradas en
`schema_migrations_registry`.

### Sobre los números 163 y 165 (no se inventó contenido)

- **163**: no encontré ningún objeto vivo en la base (función, columna,
  constraint, policy) que correspondiera a este número y no apareciera ya
  cubierto por 160/161/162/164. Es posible que ese número se haya usado en
  una sesión de desarrollo sin que terminara en un cambio de schema
  independiente, o que haya quedado pisado por un `CREATE OR REPLACE`
  posterior del que no queda rastro (Postgres no guarda historial de
  versiones de una función). Si en algún momento te acordás qué era,
  decime y lo agrego — pero no quise fabricar un archivo con contenido
  inventado solo para "completar la serie".
- **165** (fix de decimales: coma vs. punto, parseo Latin1/UTF-8 de
  `aNumero`, dedupe intra-archivo en `precios_clientes`): es un fix
  **100% del lado JS** (`lib/handlers/migracion.js`,
  `frontend/admin/js/migracion.js`), no toca el schema. No le corresponde
  ni le faltaba un `.sql` — el machete lo agrupaba junto con los demás
  porque comparten numeración de comentarios en el código, pero no porque
  hiciera falta una migración de base.

**Importante:** ninguna de estas 4 reconstrucciones es una migración nueva
ni cambia el comportamiento de producción — `cta_cte`, `precios_clientes` y
`proveedores` ya eran entidades válidas del wizard, `deshacer` ya
funcionaba. Esto es exclusivamente para que el repo pueda reconstruir la
base desde cero si hace falta algún día, que era el riesgo señalado en el
machete.

## 3. Lo que quedó pendiente (no se tocó, son decisiones o pruebas manuales)

No se generó ningún cambio para estos puntos del machete porque no son
correcciones de código — son decisiones de producto o pruebas que solo se
pueden hacer por la interfaz real:

- Gap crítico 1: comprobantes fiscales históricos (decisión de producto).
- Gap crítico 2: órdenes de compra / pagos a proveedores históricos
  (decisión de producto).
- Gap crítico 3: revisar si categorías/depósitos/listas/zonas "stub"
  necesitan atributos extra.
- Gap 4: prueba end-to-end real por la interfaz — ahora más urgente,
  porque es la única forma de confirmar que el fix de pedidos también
  funciona desde el parseo de archivo en el browser.
- Gap 6 (resto): encoding Latin1/Windows-1252 con un Excel viejo real —
  es específico del parseo client-side, no se puede simular desde acá.

## 4. Verificación

`node scripts/check-migraciones-registro.js` → 0 colisiones, 142 archivos
en `supabase/migrations/`, todo consistente.
