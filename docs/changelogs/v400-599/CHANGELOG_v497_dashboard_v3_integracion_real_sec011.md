# v497 — Dashboard v3: integración con datos reales + SEC-011

Integración a producción del boceto `dashboard-v3.html` (bento, paleta "Hoja
de Ruta"), verificado campo por campo contra el esquema real de Supabase y
los handlers existentes antes de tocar nada. Se publica como preview aislado
en `/admin/dashboard-v3` — **no reemplaza** `/admin/dashboard` todavía.

## Archivo nuevo

- `frontend/admin/dashboard-v3.html` — mismo patrón de auth que el resto del
  panel (`auth-ready.js` → `authCtx.sb`/`authCtx.perfil`), mismo
  `api-client.js`. 100% datos reales: `/api/admin/kpis`
  (`obtener_kpis_dashboard_v3`), `/api/admin/reportes/ventas-diarias`,
  `/api/admin/stock/bajo`, `/api/score?accion=cobranza-priorizada`,
  `/api/pos/cajas-admin` + `/api/pos/resumen-turno`, `/api/rutas-live`, y
  lectura directa por RLS de `cobros`, `cheques`, `clientes`, `productos`,
  `categorias`, `empresas`, `facturas`, `whatsapp_conversaciones` /
  `whatsapp_mensajes` / `v_whatsapp_conversaciones_activas`.

## Ruta nueva

- `vercel.json`: `/admin/dashboard-v3` → `frontend/admin/dashboard-v3.html`.
  No está en `nav-data.js` a propósito (preview, no descubrible por el resto
  de los usuarios hasta que se decida promoverlo).

## Bugs encontrados y corregidos durante la verificación contra Supabase

El boceto asumía columnas/vistas que no coinciden con el esquema real:

1. **Catálogo público**: `empresas` no tiene `slug` ni
   `catalogo_publico_activo` — el flag real es
   `config->>'catalogo_publico_habilitado'` (jsonb, SEC-008/migración 292).
   URL corregida a `/cliente/catalogo?empresa_id=` (no hay slug en este
   proyecto).
2. **Precio de producto**: la columna es `precio_base`, no `precio` —
   mostraba $0 en la lista de "últimos productos".
3. **Cheques "en cartera"**: el criterio real es `estado === 'en_cartera'`
   (igual que `cheques.js`/`riesgo-cheques.js`). El check constraint de
   `cheques.estado` no incluye `'vencido'`; el filtro original
   (`!== 'cobrado' && !== 'rechazado' && !== 'vencido'`) inflaba el conteo
   incluyendo pendiente/depositado/entregado_proveedor/anulado.
4. **WhatsApp**: `v_whatsapp_conversaciones_activas` (esquema real,
   verificado con `pg_get_viewdef`) no expone `pedido_borrador` ni
   `pedido_creado_id` — el comentario de cabecera de
   `whatsapp-conversaciones.js` está desactualizado en ese punto. Se agregó
   un query aparte a la tabla base (misma RLS por `empresa_id`) para
   mergear esos dos campos.
5. **Ranking → rentabilidad por zona**: la vista no tiene columnas
   `margen_pct`/`rentabilidad_pct`; el % se calcula ahora en el cliente
   desde `margen_neto_estimado / facturado_total` agregado por
   `zona_nombre`.

## SEC-011 (hallazgo durante esta integración, ya corregido en Supabase)

`v_rentabilidad_zona_ruta` (migración 069) está documentada como
"sin `security_invoker` ni RLS propia, consumir solo desde handler backend
con `SERVICE_ROLE_KEY`, nunca exponer directo por PostgREST al browser" —
pero conservaba los grants por defecto de una vista nueva de Postgres:
`anon` y `authenticated` con SELECT/INSERT/UPDATE/DELETE/TRUNCATE. En la
práctica, cualquiera (incluso sin login) podía leer margen, facturación y km
recorridos por ruta de **todas** las empresas vía PostgREST directo, sin
pasar por el filtro `empresa_id` de `/api/rutas-live`.

No hay evidencia de explotación — solo el gap de grants. Único consumidor
real confirmado: `lib/handlers/rutas-live.js` con `SERVICE_ROLE_KEY` (sin
usos directos desde `frontend/`).

**Fix aplicado en Supabase** (migración
`sec011_revoke_default_grants_v_rentabilidad_zona_ruta`, no incluida como
archivo `.sql` en este repo todavía — pendiente sumarla a
`supabase/migrations/` en la próxima corrida de `list_migrations`):

```sql
REVOKE ALL ON public.v_rentabilidad_zona_ruta FROM anon, authenticated, public;
GRANT SELECT ON public.v_rentabilidad_zona_ruta TO service_role;
```

Verificado: `rutas-live.js` sigue funcionando (usa `SERVICE_ROLE_KEY`, no
afectado por el revoke). El punto 5 de arriba (ranking del dashboard) se
corrigió en simultáneo para pedir por `/api/rutas-live?accion=rentabilidad-zona`
en vez de leer la vista directo — así el dashboard nuevo nunca dependió del
grant inseguro.

## Follow-up pendiente (no tocado en esta sesión)

`v_cc_proveedor` y `v_productos_sin_proveedor_default` tienen el mismo
patrón de grant a `authenticated` sin uso encontrado en `frontend/` —
mismo tipo de hallazgo que SEC-011, candidatas a revisar con el mismo
criterio en la próxima sesión de auditoría.
