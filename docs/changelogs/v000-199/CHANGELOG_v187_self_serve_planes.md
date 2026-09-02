# CHANGELOG v187 — Self-serve upgrade/downgrade de plan

Ítem 3 de la sección "Próximos pasos de sofisticación comercial" del
PLAN_COMERCIALIZACION_DISTRIB.md.

## Backend — migración 187 (`saas_tenant_cambiar_plan`)

RPC `SECURITY DEFINER`, ejecutable por `authenticated`, resuelve la empresa
vía `get_empresa_id()` (no recibe `empresa_id` como parámetro — no hay forma
de que un tenant cambie el plan de otro).

Reglas:
- Solo rol `dueno` o `admin`.
- Solo con `saas_plan = 'activo'` y `saas_suspendida = false` (trial y
  cuentas suspendidas no pueden autogestionar el plan — coherente con que
  el alta/reactivación ya pasa por confirmación manual de pago).
- Solo `basico` ↔ `pro`. `enterprise` excluido a propósito (precio a
  medida, requiere contacto comercial).
- Downgrade: valida usuarios activos y clientes activos contra los límites
  del plan destino (`planes_limites`); si excede, devuelve error con el
  número exacto y no aplica el cambio.
- Al aplicar: actualiza `empresas.plan_tier` + `empresas.saas_precio_mes`
  (este último ya es el campo que usa el generador de facturas SaaS
  existente — no se tocó esa lógica).

## Frontend — `mi-suscripcion.html`

Nueva card "Planes disponibles": lee `planes_limites` (lectura pública ya
otorgada desde la migración 137) y muestra Básico/Pro/Enterprise con
límites y precio. El plan actual se resalta y no tiene botón de acción;
Enterprise muestra "Consultar" (mailto); Básico/Pro muestran "Subir" o
"Bajar" según corresponda, deshabilitado con explicación si la cuenta no
es elegible (trial o suspendida).

El cambio llama directo a `sb.rpc('saas_tenant_cambiar_plan', ...)` desde
el cliente (mismo patrón que el resto de esta página, que ya lee `empresas`
y `saas_facturas` directo con RLS) — no hizo falta agregar un endpoint en
`vercel.json` ni en ningún handler.

## Pendiente / fuera de este alcance

- No hay proration automática dentro del período — el precio nuevo aplica
  recién en la próxima factura, como ya se documentó en el mensaje que ve
  el usuario al confirmar.
- No se agregó historial de cambios de plan como tabla propia (se podría
  inferir del histórico de `saas_facturas` por el monto, ya que cambia con
  el tier). Si en algún momento hace falta auditoría explícita de "quién
  cambió qué plan y cuándo", conviene una tabla dedicada en vez de audit_log
  (que solo admite INSERT/UPDATE/DELETE genéricos, no eventos de dominio).
