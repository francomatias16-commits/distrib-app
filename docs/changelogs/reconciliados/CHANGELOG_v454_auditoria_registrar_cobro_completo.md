# v454 — Auditoría real (usuario_id): cobro manual (Cobranzas / cta-cte)

Cierra la deuda técnica documentada en v722: *"Cobranzas/cobro manual (mismo
RPC `registrar_cobro_completo` desde `cc_clientes`/admin) sigue sin auditoría
propia — sería el siguiente módulo lógico si se decide extender la cobertura
de `cta_cte`."*

## Hallazgo previo al fix

El cobro manual desde el panel admin **no pasa por ningún handler de Node**:
el frontend llama al RPC `registrar_cobro_completo` directo vía Supabase JS
desde dos lugares —

- `frontend/admin/js/cta-cte.js`
- `frontend/admin/js/rutas-resumen.js`

Por eso el patrón usado en pedidos/pos/pagos/chofer_invitacion
(`registrarAuditoriaSilenciosa` a nivel handler) no aplica acá: no hay capa
de JS que interceptar. La única auditoría posible vive **dentro de la
función SQL misma**.

## `registrar_cobro_completo` (`supabase/migrations/454_...sql`)

`CREATE OR REPLACE` de la función (misma firma que la versión de la
migración 444, sin cambios de parámetros) agregando un único write point:

- **INSERT sobre `audit_log`**, tabla `cobros`, `accion: INSERT`,
  `usuario_id = COALESCE(p_usuario_id, auth.uid())` — misma resolución que
  ya usa el INSERT real en `cobros` unas líneas antes, así que cubre tanto
  el cobro manual desde el panel (usuario logueado vía `auth.uid()`) como el
  cobro en reparto del chofer (`pedidos.js` le pasa `p_usuario_id`
  explícito).
- Va en un bloque `BEGIN/EXCEPTION WHEN OTHERS THEN NULL` anidado, **después**
  de todos los INSERT/UPDATE reales (cobro, cta_cte, facturas aplicadas,
  desbloqueo de cliente) y antes del `RETURN ok:true` — si el insert a
  `audit_log` falla, el cobro (dinero real ya movido) igual devuelve éxito.
  Equivalente en PL/pgSQL a lo que `registrarAuditoriaSilenciosa` hace en JS.
- **No se audita en el fast path de idempotencia** (`p_offline_local_id` ya
  existente, `ya_existia: true`) — mismo criterio que "Registrar venta" en
  `pos.js` (v721): no duplicar el rastro de un mismo hecho de negocio ya
  registrado (y ya auditado) en el intento original.

Como la función corre con `SECURITY DEFINER`, el `INSERT` a `audit_log`
tiene los permisos necesarios sin tocar grants adicionales.

Con esto, los 5 módulos de la lista de prioridad original quedan cerrados:
pedidos → pos → pagos → chofer_invitacion → **cobro manual (cta_cte)**.

Deuda técnica que sigue documentada y fuera de esta pasada: `cc_proveedores.js`
(pagos a proveedores, mencionado en v722 como "ya con auditoría parcial" pero
sin una revisión dedicada como esta serie), la creación de la preferencia de
pago en `pagos.js` (`_generarPreferenciaPago`, intento abierto, no hecho
consumado), y los ABMs de configuración de POS (favoritos, hardware, PIN de
supervisor, promociones, umbral de descuento, movimientos de caja manuales,
transferencias de stock).
