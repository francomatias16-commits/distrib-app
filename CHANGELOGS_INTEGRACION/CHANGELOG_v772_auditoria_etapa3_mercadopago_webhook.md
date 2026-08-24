# v772 — Auditoría funcional etapa 3: Mercado Pago (parte 1)

Sigue a `PLAN_AUDITORIA_FUNCIONAL_PRELANZAMIENTO_2026.md` (v768), etapa 3
("Pagos online + conciliación bancaria + gastos generales"). Esta entrega
cubre solo Mercado Pago; conciliación bancaria y gastos generales quedan
para la próxima.

## Hallazgo crítico — MERCADOPAGO-AUDIT-01: el webhook nunca confirmaba ningún pago

`transacciones_pago.referencia_externa` se completaba en `crearPreferencia`
con `preferenceData.id` — el ID de la **preferencia** (formato
`collector-uuid`). El webhook de MP notifica con `data.id` = **payment_id**,
un recurso numérico totalmente distinto. La resolución de empresa y el
update de la transacción buscaban ambos por
`referencia_externa = payment_id`, que nunca iba a matchear contra un valor
que en realidad guardaba el preference_id.

Efecto real: **todo pago por Checkout Pro caía siempre en la rama "empresa
no resuelta" del webhook, sin hacer nada.** El pedido nunca pasaba a
confirmado y el cobro nunca se acreditaba en `cta_cte` — el cliente quedaba
debiendo una factura que ya pagó, para siempre, sin que nadie se enterara
(no hay error visible: el webhook responde 200 igual, porque MP no debe
reintentar infinito). Confirmado contra la documentación oficial de MP:
`payment_id` y `preference_id` son identificadores de recursos distintos.
`transacciones_pago` tiene 0 filas en producción — nadie llegó a probar el
flujo contra una cuenta real todavía (ver v760), así que no hay pagos reales
perdidos, pero el bug estaba activo desde que existe el módulo.

### Fix
- El webhook ahora resuelve la empresa por `user_id` (top-level del body de
  la notificación de MP — la cuenta que recibió el cobro), no por nada
  guardado sobre el payment_id. Requiere `integraciones_pago.mp_user_id`.
- La transacción se busca/actualiza por `pedido_id` (columna propia,
  siempre confiable) en vez de por `referencia_externa`. De paso se corrige
  `referencia_externa` al payment_id real, para que quede disponible en
  próximos webhooks/polls.
- `guardarConfigMP` (conexión de Checkout Pro) ahora también persiste
  `mp_user_id` — antes solo lo guardaba `posQrSetupHandler` (config del QR
  del POS), así que una empresa que solo conectaba Checkout Pro (el caso
  normal) quedaba sin forma de resolverse desde el webhook aunque se
  aplicara el fix de arriba. Se usa el mismo `/users/me` que ya se llamaba
  para validar el token — sin request extra.
- `verificarPago` (polling desde el navegador tras el redirect) se deja
  como estaba: sigue buscando por `referencia_externa = payment_id`. Es un
  fallback de UX (evita esperar al webhook), no la fuente de verdad — si no
  matchea todavía, devuelve "pending" genérico y el webhook termina de
  confirmar. No corrompe nada, solo tarda un poco más en reflejarse.
- Repo (`lib/repos/pagos.js`): se agregan `obtenerIntegracionMPPorMpUserId`
  y `obtenerTransaccionPorPedido`; se eliminan `obtenerTransaccionEstadoPorReferencia`,
  `obtenerTransaccionEmpresaPorReferencia` y `actualizarTransaccionPorReferencia`
  (quedaron sin uso).

## Hallazgo secundario — migraciones 480 y 481 nunca se aplicaron en producción

Al ir a usar `mp_user_id` para el fix de arriba, la consulta directa contra
Supabase falló con `column "mp_user_id" does not exist`. El historial de
migraciones aplicadas salta de `479_gastos_generales` a
`482_fix_devolucion_pos_kardex...` — **480 y 481 (que agregan
mp_user_id/store_id/pos_id/qr_image/cuit_cuil a `integraciones_pago`) nunca
se corrieron**, aunque el código ya las asume (QR del POS, terminal Prisma,
y ahora el webhook). Eso significa que **el cobro QR presencial y la
terminal Prisma estaban rotos en producción** con error de columna
inexistente desde que se deployó ese código — no es algo que este fix haya
causado, ya estaba así.

Aplicadas ahora las dos, directo contra Supabase (`ALTER TABLE ... ADD
COLUMN IF NOT EXISTS`, idempotentes, sin impacto en datos —
`integraciones_pago` está vacía en producción). Registradas en
`schema_migrations_registry`.

## Conciliación bancaria — 2 hallazgos, ambos corregidos directo en Supabase

**CONCILIACION-AUDIT-01 (crítico, botón roto):** `descartarMovimiento()`
(`lib/repos/conciliacion-bancaria.js`) hace
`UPDATE ... SET estado = 'descartado'`, pero el CHECK constraint de
`conciliacion_bancaria_movimientos` solo permitía
`('pendiente','conciliado','sin_match','conciliado_manual')` — `'descartado'`
no estaba. Todo intento real de descartar un movimiento del extracto
fallaba con violación de constraint (probado en vivo contra la fila real
que había en producción). Fix (migración `489`): se agrega `'descartado'`
a los valores permitidos. `'sin_match'` y `'conciliado_manual'` quedan sin
tocar — ningún código los usa hoy, pero no correspondía borrarlos a ciegas
sin confirmar si eran de un flujo pensado y no terminado.

**CONCILIACION-AUDIT-02 (datos, silencioso):**
`conciliacion_buscar_candidatos()` matcheaba por fecha/monto contra
`cobros` (que son siempre ingresos) sin filtrar nunca por
`movimientos.tipo`. Un movimiento **débito** del extracto (comisión
bancaria, transferencia saliente) podía ofrecerse como "candidato" si el
monto/fecha coincidían por casualidad con un cobro real de un cliente —
y si el usuario lo confirmaba, ese cobro quedaba marcado
`conciliado_bancario=true` contra el movimiento equivocado, sin poder
matchear después contra su verdadero movimiento de crédito. Caso real ya
en producción: movimiento "COMISION MANTENIMIENTO CUENTA" ($1500,
débito) sin filtro. Fix (migración `490`): la función ahora solo busca
candidatos cuando `tipo = 'credito'`; un débito devuelve 0 candidatos
hasta que exista un módulo de conciliación contra egresos/gastos (fuera
de alcance de esta auditoría).

El resto del motor (`confirmar_match`, `deshacer_match`,
`auto_matchear_lote`) está sólido: usa `FOR UPDATE` para que un
doble-click no infle el contador del lote, es atómico, y el auto-match
solo confirma cuando hay un único candidato exacto dentro de tolerancia.

## Gastos generales — sin hallazgos

CRUD (`gastos-generales.js` + repo) correcto: validación de categorías,
soft-delete, auditoría silenciosa en INSERT/UPDATE, `CATEGORIAS_GASTO` en
JS coincide exacto con el CHECK constraint de la tabla. Se verificó en
vivo que **sí** está conectado a Ganancia Neta (no es una pieza huérfana
como parecía a primera vista por no aparecer en ningún handler de
"reportes"): `frontend/admin/js/reportes-financieros.js` lo consulta
directo vía Supabase client (RLS, mismo criterio que el resto de esa
pantalla) y calcula `Ganancia Neta = Margen Bruto - Gastos Generales del
período`. La policy RLS (`gastos_generales_empresa`, `ALL`, escopeada por
`empresa_id` vía subquery a `usuarios`) está bien armada.

## Etapa 3 — cierre
Con esto se cubrieron los tres módulos de la etapa 3 del plan (Mercado
Pago, conciliación bancaria, gastos generales). Pendiente para más
adelante (no bloqueante, ya documentado en el plan original):
- Probar el flujo de Checkout Pro end-to-end contra una cuenta MP real
  (nunca se hizo — coincide con el pase manual pendiente de la etapa 5).
- Decidir si conciliación bancaria contra egresos (gastos_generales /
  cc_proveedores) es un módulo a construir a futuro — hoy los movimientos
  débito del extracto quedan sin ninguna forma de conciliarse.
