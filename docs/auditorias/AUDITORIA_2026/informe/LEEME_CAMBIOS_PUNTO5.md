# Punto 5 — Corregir la deduplicación offline global

Auditoría pre-lanzamiento 2026. Estado: **RESUELTO — 19/08/2026**.
Migración `508_offline_dedup_tenant_scoped` **ya aplicada en Supabase**
(proyecto `jgiquzjwoedmzwqgzubr`) y verificada en vivo.

## Qué estaba mal

El dedup offline por `offline_local_id` (migraciones 443/444/446) tenía
índice único **global** en 6 tablas, y los lookups de fast-path (RPC y
repos JS) no filtraban por `empresa_id`:

| Tabla | Tenía `empresa_id` antes | Índice antes |
|---|---|---|
| `movimientos_stock` | No | único global |
| `entregas` | No | único global |
| `conteos_stock` | Sí | único global (no la usaba) |
| `devoluciones` | Sí | único global (no la usaba) |
| `cobros` | Sí | único global (no la usaba) |
| `facturas_proveedor` | Sí | único global (no la usaba) |
| `ventas_pos` | Sí (ya bien) | ya era `(empresa_id, offline_local_id)` — patrón de referencia |

**Riesgo:** una colisión de `offline_local_id` entre dos empresas (el id
lo genera el dispositivo con `crypto.randomUUID()` — astronómicamente
improbable, pero no imposible ante bug de cliente, RNG degradado o
dispositivo reusado entre tenants) hacía que el fast-path devolviera el
registro de **otra empresa** como `ya_existia: true`. Backfill de la
migración: **0 colisiones reales** encontradas — es defensa en
profundidad, no un incidente observado en producción.

## Fix aplicado

### Base de datos — `supabase/migrations/508_offline_dedup_tenant_scoped.sql`
- Agrega `empresa_id` + trigger `BEFORE INSERT` (auto-completa desde el
  padre: `depositos`/`pedidos`/`rutas`) a `movimientos_stock` y `entregas`.
- Backfill de `empresa_id` en filas existentes.
- Recrea los 6 índices únicos como `(empresa_id, offline_local_id)`.
- Reescribe `ajustar_stock`, `registrar_conteo_stock`, `transferir_stock`
  y `registrar_cobro_completo` para resolver `empresa_id` **antes** del
  fast-path (antes se resolvía después) y filtrar el lookup por él.

### Aplicación
- `lib/repos/pedidos.js` — `buscarEntregaPorOfflineLocalId` y
  `buscarDevolucionPorOfflineLocalId` ahora piden `empresa_id`.
- `lib/handlers/pedidos.js` — los 3 call sites (entregar, no-entregar,
  crearDevolucionCore) pasan `empresa_id` al lookup.
- `lib/repos/portal-proveedor.js` — `insertarFacturaProveedorPortal`
  acota el lookup por `campos.empresa_id`.

### Tests
- `tests/repos/offline-dedup-tenant-scope.test.js` — 5/5 en verde.
- Suite completa del proyecto: 977/981 pasan; las 4 fallas restantes son
  drift preexistente (`pos-offline`, `eventos-dispatcher`, `empresas`,
  `migracion`), confirmado sin relación con este cambio. **Cero
  regresiones.**

## Verificación en vivo post-migración (Supabase)

```
idx_entregas_offline_local_id            → UNIQUE (empresa_id, offline_local_id)
idx_facturas_proveedor_offline_local_id  → UNIQUE (empresa_id, offline_local_id)
movimientos_stock.empresa_id             → existe
entregas.empresa_id                      → existe
ajustar_stock                            → contiene el fix (resuelve empresa_id antes del fast-path)
```

## Pendiente relacionado (punto 6 del informe, no cerrado en esta entrega)

Como side-effect de este punto, `ajustar_stock`, `registrar_conteo_stock`
y `transferir_stock` ya resuelven `empresa_id` antes del fast-path. Sigue
pendiente el resto del punto 6: validar sesión/rol completos antes del
fast-path en `registrar_cobro_completo`, y tocar el portal de proveedores
y las entregas offline (no se modificaron en este punto).

## Contenido del paquete

```
INFORME_TRABAJO_CONJUNTO_PUNTOS_CRITICOS.docx   (actualizado: punto 5 resuelto, punto 6 con avance parcial)
LEEME_CAMBIOS.md
supabase/migrations/508_offline_dedup_tenant_scoped.sql
lib/repos/pedidos.js
lib/repos/portal-proveedor.js
lib/handlers/pedidos.js
tests/repos/offline-dedup-tenant-scope.test.js
```
