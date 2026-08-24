# CHANGELOG v815 — Auditoría Integral 2026: SEC-01 y SEC-02 (los 2 hallazgos CRÍTICOS)

**Migración:** `supabase/migrations/20260818_auditoria_integral_2026_sec01_sec02_criticos.sql`
**Alcance:** solo los 2 hallazgos con severidad CRÍTICA de la Auditoría Integral 2026. Los 27 hallazgos ALTA/MEDIA restantes de esa auditoría (SEC-03/04/05/08/09/11/12/13, BUG-02 a BUG-11, SYNC-01 a 09) **siguen pendientes**.

## SEC-01 — `exportar_contable` invocable por `anon`

**Antes:** función `SECURITY DEFINER` con `EXECUTE` efectivo para `anon` (confirmado en `qa-secdef-anon-signatures.txt`). Recibía `p_empresa_id` y `p_usuario_id` como parámetros de payload sin validar sesión, rol ni pertenencia. Cualquiera con el UUID de una empresa podía pedir su exportación contable completa (ventas/compras/cobranzas) sin autenticarse.

**Ahora:**
- Deriva empresa (`public.get_empresa_id()`) y usuario (`public.auth_usuario_id()`) de la sesión real — los valores que lleguen por payload se sobreescriben, no tienen efecto.
- Exige rol dueño/admin (`public.es_admin()`); si no, `42501`.
- Fail-closed si no hay sesión válida.
- `REVOKE EXECUTE ... FROM PUBLIC, anon` + `GRANT ... TO authenticated, service_role`.

No hay caller en el código JS actual para esta RPC (es una función "fantasma" expuesta solo vía el endpoint REST autogenerado de Supabase) — el fix es enteramente a nivel de base de datos.

## SEC-02 — `transferir_stock_entre_depositos` sin validar tenant del destino ni del caller

**Antes:** función `SECURITY DEFINER` con `EXECUTE` para `authenticated`. El handler Node (`lib/handlers/pos.js:transferirStockHandler`) sí valida permisos y que ambos depósitos sean de la empresa del caller — pero como Supabase expone toda función con grant como endpoint REST propio, cualquier usuario autenticado podía invocar la RPC **directamente**, sin pasar por ese handler. La función solo miraba la empresa del depósito de *origen* y confiaba en el `p_usuario_id` del payload.

**Ahora:**
- Deriva la empresa del caller de la sesión (`public.get_empresa_id()`); fail-closed si no hay sesión.
- Fuerza `p_usuario_id := public.auth_usuario_id()` — se ignora lo que venga en el payload.
- Exige que **ambos** depósitos (origen y destino) pertenezcan a la empresa del caller antes de tocar una sola fila de `stock`/`lotes`/`movimientos_stock`.
- El resto del cuerpo (movimiento FIFO por lotes, `FOR UPDATE`, manejo de errores) queda idéntico — el fix es puramente de autorización, no cambia la lógica de negocio.
- Grants explícitos: `authenticated` y `service_role` sí, `anon`/`PUBLIC` no.

`lib/repos/pos.js` sigue mandando `usuario_id` en el payload de la RPC (`transferirStockEntreDepositosRpc`) — no requiere cambios, ese parámetro ahora simplemente se ignora en el lado de la base.

## Validación

- Balance de bloques `$function$`/`BEGIN`/`END;` verificado (2 funciones completas).
- No se tocaron políticas RLS, triggers ni otras funciones `SECURITY DEFINER`.
- **Pendiente:** aplicar la migración contra el Supabase de QA real y volver a correr el probe de grants (`qa-rpc-grants.tsv`/`qa-secdef-anon-signatures.txt`) para confirmar que ninguna de las dos funciones sigue apareciendo en la lista de ejecutables por `anon`. No se ejecutó DDL contra ningún entorno desde este merge.

## Qué sigue

Con esto el proyecto deja de tener hallazgos CRÍTICOS abiertos de esta auditoría, pero **no está listo para producción**: quedan 14 hallazgos ALTA sin remediar (incluye SEC-03, SEC-05 buckets públicos, SEC-08 notas de crédito, SYNC-05/06/08) y 15 MEDIA.
