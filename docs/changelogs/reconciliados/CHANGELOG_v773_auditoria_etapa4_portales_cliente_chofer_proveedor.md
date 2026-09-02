# v773 — Auditoría funcional etapa 4: portal cliente / chofer / proveedor

Sigue a `PLAN_AUDITORIA_FUNCIONAL_PRELANZAMIENTO_2026.md` (v768), etapa 4.

## Portal proveedor — auditado, sin hallazgos
Token de acceso hasheado con SHA-256 (nunca se guarda en texto plano),
`validar_token_portal_proveedor` chequea revocado/expirado correctamente,
y las tres acciones públicas (`ver`, `confirmar-entrega`, `subir-factura`)
filtran explícitamente por `proveedor_id`/`empresa_id` resueltos del
token — nunca del body/query. Despacho en `proveedores.js` correcto:
`_svc=portal` se resuelve antes de exigir sesión de usuario interno.
Módulo sólido, no requirió cambios.

## Portal chofer — hallazgo crítico corregido: PORTAL-CHOFER-AUDIT-01

El flujo "marcar pedido como no entregado" tiene toda la lógica de
backend completa y bien guardada en `lib/handlers/pedidos.js`
(`ruta === 'no-entregar'`): valida que el pedido pertenezca al chofer
autenticado, es idempotente para reintentos offline (usa
`p_offline_local_id`), actualiza el estado de la ruta y dispara la
notificación por WhatsApp correspondiente.

Pero **nunca se llegaba a ejecutar**: `vercel.json` tiene una regla de
rewrite específica para `/api/chofer/remitos/(.*)/entregar` pero no para
`/api/chofer/remitos/(.*)/no-entregar` — el patrón de "entregar" no
matchea "no-entregar" (el segmento final del path es distinto). La
request caía en el catch-all genérico `/api/chofer/(.*)`, que no setea
`_ruta`, así que el handler tomaba el default `_ruta = 'remitos'` (listado)
en vez de `'no-entregar'`. El botón real en `frontend/chofer/remito.html`
(línea 682) apuntaba a una URL que nunca llegaba a la lógica que se
había escrito para ella.

**Fix**: se agregó la regla de rewrite faltante en `vercel.json`, en el
mismo bloque y con el mismo patrón que la de "entregar":
```json
{
  "source": "/api/chofer/remitos/(.*)/no-entregar",
  "destination": "/api/index?_mod=pedidos&_svc=chofer&_ruta=no-entregar"
}
```
Se verificó que el `id` del pedido no depende de esta regla (el handler
lo toma de `req.body.id`, que el frontend ya envía), así que el fix es
puramente de ruteo — no requirió tocar `pedidos.js`.

## Portal cliente — hallazgo crítico de seguridad corregido: PORTAL-CLIENTE-AUDIT-01

Las políticas RLS `pedidos_update` y `pedidos_insert` solo verificaban
`empresa_id = auth_empresa_id()` — sin el mismo scoping por `cliente_id`
que sí tiene `pedidos_select_unificada` (que restringe correctamente al
rol `cliente` a ver solo sus propios pedidos).

**Efecto real**: cualquier usuario autenticado con rol `cliente` podía,
llamando directo al SDK de Supabase desde la consola del navegador (con
su propio JWT + la anon key, ambos ya cargados en cualquier página del
portal cliente), hacer `UPDATE` o `INSERT` sobre filas de `pedidos` de
**otro cliente de la misma empresa** — cambiar estado, total, cliente_id,
lo que sea. El flujo normal de la app no lo explota (el checkout real
pasa por `/api/pedidos` con service_role, que bypassea RLS), pero es una
vulnerabilidad real y directamente explotable vía consola, no defensa en
profundidad teórica.

**Fix** (migración `491`): se reescribieron ambas políticas replicando
el criterio de `pedidos_select_unificada` — rol `cliente` acotado a su
propio `cliente_id`; roles de staff
(dueno/admin/vendedor/depositero/chofer/contador) mantienen acceso a
nivel empresa, igual que antes; `service_role` sin cambios.

Como efecto colateral verificado (no requirió migración aparte):
`pedido_items` queda automáticamente protegido por esta misma corrección.
Sus políticas de escritura subconsultan `pedidos` (`pedido_id IN (SELECT
id FROM pedidos WHERE ...)`), y Postgres aplica la política **SELECT** de
`pedidos` de forma transparente dentro de esa subconsulta — así que ahora
que `pedidos_select_unificada` restringe a un cliente a sus propios
pedidos, esa misma restricción se propaga sola a qué `pedido_items` puede
tocar.

## Nota de producto (no bug, no requiere fix de código): direcciones de entrega del cliente

`cuenta.html` (portal cliente) promete en su subtítulo *"Tus datos,
direcciones de entrega y estado de cuenta"*, pero no existe ningún form,
fetch ni tabla detrás de esa frase. `cliente_direcciones` es una tabla
100% administrada por el staff interno (`lib/handlers/clientes.js`,
`/api/clientes/direcciones`, protegido por `verificarToken` + permisos
internos) — no hay ningún endpoint ni política RLS que le dé acceso al
propio cliente sobre sus direcciones. No es un bug de permisos (las
políticas RLS de esa tabla son consistentes con que solo el staff la
toca); es una feature que nunca se construyó para el rol cliente. Queda
como decisión de producto para Matías: construir el CRUD del lado
cliente, o sacar la frase del copy mientras tanto.

## Etapa 4 — cierre
Cubiertos los tres portales externos del plan. 2 fixes de código (uno de
ruteo, uno de seguridad) ya aplicados en Supabase (migración 491) y en
`vercel.json` (pendiente de deploy en Vercel — el archivo local ya tiene
el cambio, falta el push/deploy real). 1 nota de producto sin acción de
código.
