# v1002 — Fix real: precios suscripciones SaaS + grilla de planes colgada en "Cargando"

## Contexto
El fix v1001 (migración 545 en el ZIP) nunca se aplicó a la base de producción
`jgiquzjwoedmzwqgzubr` — el archivo `.sql` se generó pero no se ejecutó contra
Supabase, por eso "sigue sin actualizarse suscripciones saas".

Además había un segundo bug de código, independiente del anterior, que
explica el "tampoco carga los planes, queda en cargando".

## Causa 1 — Migración no aplicada (datos)
`planes_limites` seguía con `updated_at = 2026-08-18` (sin tocar) y valores:
- basico: 15.000 (landing: 30.000)
- pro: 35.000 (landing: 55.000)
- enterprise: 75.000 (landing: "Desde 95.000")

Se aplicó directamente contra la base la migración `547_fix_precios_planes_limites_vs_landing`
(reemplaza a la 545 del ZIP anterior, que colisionaba de número con
`545_fix_rl_check_and_increment_reset_at_ambiguo` ya aplicada el 25/08).
Ahora basico=30.000, pro=55.000, enterprise=95.000, coincide con la landing.

**Pendiente igual que antes:** el precio de referencia en `saas_config`
(banner de CBU) no se tocó — no hay forma de confirmar desde acá si ese valor
puntual está desactualizado.

## Causa 2 — Grilla de planes colgada en "Cargando…" (código)
En `frontend/admin/saas-billing.html`, `cargarSuscripcionTenant()` tenía dos
`return` tempranos (cuando no hay facturas todavía, y cuando falla la carga
del historial) que estaban **antes** de la línea `await cargarPlanesTenant(s)`.//
Para cualquier tenant sin facturas generadas (todo trial, y todo tenant
recién activado sin ciclo de facturación corrido aún) esa función nunca se
llamaba, y la grilla quedaba en el placeholder "Cargando…" para siempre — no
era un problema de red ni de RPC, la función simplemente no se ejecutaba.

Se reordenó el cuerpo de la función para que el historial de facturas y la
grilla de planes sean independientes: la tabla de facturas usa `if/else if/else`
según corresponda, y `cargarPlanesTenant(s)` se llama siempre al final, pase lo
que pase con las facturas.

## Archivos modificados
- `frontend/admin/saas-billing.html`

## Aplicado directamente en Supabase (proyecto jgiquzjwoedmzwqgzubr)
- Migración `547_fix_precios_planes_limites_vs_landing` (UPDATE sobre `planes_limites`)
