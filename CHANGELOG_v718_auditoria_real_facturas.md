# v718 — Auditoría real de facturas: quién emitió/anuló cada comprobante

## Contexto

Investigación disparada por un pedido del usuario: agregar en `auditoria.html`
una distinción entre "lo hizo un click en el panel" vs. "lo hizo el
asistente por voz". Al auditar el código real se encontró que esa
distinción (`origen`) era la parte fácil — el problema real era más de
fondo: **la mayoría de los dominios de escritura no dejan NINGÚN rastro
de auditoría hoy**, ni desde el panel ni desde el asistente. No tiene
sentido agregar "quién lo hizo" a un log que no existe.

Se decidió encarar esto en tandas por dominio. Esta primera tanda cubre
**facturas** (emitir/anular), el dominio con el gap más claro y de mayor
impacto (hay plata y obligaciones fiscales de por medio).

## Hallazgo: stock y cobros NO necesitaban este trabajo

Antes de tocar código se verificó contra la base de producción
(`jgiquzjwoedmzwqgzubr`, vía MCP) el estado real de las RPCs de stock y
cobros:

- `ajustar_stock`, `registrar_conteo_stock` y `registrar_cobro_completo`
  ya guardan `usuario_id` (parámetro explícito, no `auth.uid()`) en
  `movimientos_stock` / `conteos_stock` / `cobros` — un registro de
  negocio ya completo con quién hizo qué, expuesto además por
  `listar_movimientos_stock`/`listar_conteos_stock`. No hacía falta
  ningún cambio ahí.
- Se confirmó además que los triggers viejos de `audit_log` sobre
  `stock`/`productos` (`trg_audit_stock`, `trg_audit_productos_precio`,
  `015_audit_log.sql`) están **muertos en la práctica**: dependen de
  `auth.uid()`/`get_empresa_id()`, que siempre son `NULL` porque el
  backend opera con `SERVICE_ROLE_KEY` (sin sesión Postgres). Alguien ya
  parcheó `registrar_auditoria()` en producción para que en ese caso
  simplemente no inserte nada (`IF v_empresa_id IS NULL THEN RETURN;`),
  en vez de romper la transacción de negocio — así que nunca escribieron
  una fila real desde que la app existe. No se tocaron (no rompen nada
  activo), quedan como deuda técnica documentada acá.

Con esto, **facturas era el único de los tres dominios elegidos con un
gap real**.

## Cambios

### `lib/facturas.js`
- `emitirFactura(origen, usuarioId = null)` y
  `anularFactura(factura, motivo, usuarioId = null)` aceptan ahora quién
  pidió la acción. Al terminar con éxito, llaman a
  `registrarAuditoriaSilenciosa()` (`lib/repos/audit.js`, ya existía,
  nunca lanza) contra `audit_log`, tabla `'facturas'`, con estado antes/
  después (incluye número, CAE, motivo de anulación, id de la NC).
- `usuarioId` es opcional y por defecto `null` a propósito: en los
  callers donde no hay un usuario humano pidiendo la factura (listener
  `pedido_creado`, auto-facturación de POS a cuenta corriente,
  confirmación automática de pedido, `cierre.js`) se deja sin tocar —
  `usuario_id = NULL` en `audit_log` representa correctamente "lo
  disparó el sistema", no un dato que falta.

### `lib/handlers/facturas.js`
- Los 3 endpoints con un usuario autenticado detrás (`POST /api/facturas`
  emitir, `?accion=anular`, `?accion=reintentar`) pasan `user.id`.

### `lib/handlers/pedidos.js`
- La cancelación manual de pedido desde el panel (que puede arrastrar la
  anulación de una factura vinculada) pasa `user.id`.

### `lib/asistente-tools.js`
- `anular_factura`, `emitir_factura` y la anulación de factura arrastrada
  por `cancelar_pedido_asistente` ahora reciben `usuarioId` en su
  `execute()` (ya venía en la firma del executor, solo faltaba
  destructurarlo) y lo pasan a `facturas.js`.

## Alcance de esta tanda

Cubre únicamente emitir/anular factura. Dominios que siguen sin
auditoría real (fuera de alcance de este changelog, quedan para una
próxima tanda si se decide seguir): clientes, reglas de precio/
automatización, liquidación. El propio `audit_log` sigue sin columna
`origen` — se agrega recién cuando haya cobertura real que valga la pena
distinguir por origen (ver hallazgo del changelog anterior sobre esto).

## Pendiente

- Prueba funcional contra datos reales (sin credenciales de Supabase en
  este entorno de trabajo, aunque sí se usó Supabase MCP de solo lectura
  para verificar el estado de las RPCs).
- Decidir si seguir con más dominios (clientes/reglas) o si con
  facturas alcanza por ahora.
