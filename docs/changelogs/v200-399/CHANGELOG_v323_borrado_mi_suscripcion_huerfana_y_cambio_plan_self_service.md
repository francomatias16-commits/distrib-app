# CHANGELOG v323 — Borrado de `mi-suscripcion.html` (huérfana) + cambio de plan self-service en `saas-billing.html`

## Contexto

Continuación de v322 (vista tenant en `saas-billing.html` vía
`saas_mi_suscripcion()` / `saas_mis_facturas()`, migraciones 319/320).
Al revisar ese trabajo se encontró una segunda pantalla, más vieja,
resolviendo el mismo problema por otro camino.

## 1. Hallazgo: `frontend/admin/mi-suscripcion.html` era código muerto y bugueado

546 líneas, cero referencias entrantes en todo el codebase (grep global,
solo se referencia a sí misma vía `onclick="cargarSuscripcion()"` interno).
Todo indica que fue el intento original de esta pantalla — el que
probablemente motivó crear `saas_mi_suscripcion()`/`saas_mis_facturas()`
como RPC nuevas — pero quedó sin enlazar y sin borrar cuando se construyó
el enfoque nuevo.

Usaba `.from('empresas')` y `.from('saas_facturas')` directo, apoyándose en
RLS (`empresas_select_propio`: `id = get_empresa_id()`,
`saas_facturas_own`: `empresa_id = get_empresa_id()`). Como
`get_empresa_id()` excluye empresas suspendidas, tenía el mismo bug que
`saas_mi_suscripcion()` tenía antes del fix de 320 — pero sin arreglar,
porque nunca se tocó: para un tenant suspendido no traía ni la empresa ni
las facturas.

**Acción: se borra el archivo.** No tenía nada que migrar en materia de
datos (mismas tablas, misma info que ya cubre la vista nueva) salvo la
función de cambio de plan (punto 2).

## 2. Cambio de plan self-service portado a `saas-billing.html`

`mi-suscripcion.html` tenía una función que la vista nueva no tenía:
selector de plan (básico ↔ pro) contra `saas_tenant_cambiar_plan(p_tier)`
(migración 187, ya existente y funcionando — valida rol dueño/admin, cuenta
activa y al día, y límites de usuarios/clientes antes de permitir bajar de
plan). Al no estar enlazada la página vieja, ningún tenant podía
autogestionar su plan.

Se agregó la card "Planes disponibles" a `#vista-tenant` en
`saas-billing.html`, entre "Plan actual" y "Forma de pago", con el mismo
comportamiento que tenía en la página vieja (tarjeta por tier, botón
subir/bajar, deshabilitado si la cuenta no está activa y al día, Enterprise
siempre deriva a contacto por mail).

### 2.1. Problema al portarla: `saas_mi_suscripcion()` no expone `plan_tier`

La vista tenant nueva usa `s.plan` (que es `saas_plan`: trial/activo/
suspendido/cancelado) para decidir elegibilidad, pero para marcar "tu plan
actual" y decidir si cada opción es upgrade o downgrade hace falta
`plan_tier` (básico/pro/enterprise), que `saas_mi_suscripcion()` no
devuelve.

**No se tocó `saas_mi_suscripcion()`** para agregarle esa columna: las
migraciones 319 y 320 que la crearon y arreglaron no están en este
repositorio de trabajo (se aplicaron directo contra producción en una
sesión anterior), así que reescribirla con `CREATE OR REPLACE` a ciegas
—sin ver su cuerpo actual— arriesgaba pisar el fix de `e.activa` u otro
detalle ya validado en vivo contra la empresa suspendida real.

En su lugar: **migración nueva y aditiva**,
`321_saas_mi_plan_tier.sql`, que agrega `saas_mi_plan_tier()` — una
función chica, de solo lectura, que replica el mismo patrón de acceso
descripto en el changelog de 320 (JOIN con `usuarios`, `u.id = auth.uid()`,
`u.activo = true`, SECURITY DEFINER, sin filtro `e.activa`) para devolver
únicamente el `plan_tier`. No modifica ninguna función ni policy
existente.

`saas-billing.html` la consulta en paralelo con `planes_limites` (lectura
pública, sin cambios) dentro de la nueva `cargarPlanesTenant()`.

## 3. Archivos tocados

- **Borrado:** `frontend/admin/mi-suscripcion.html`
- **Migración nueva:** `supabase/migrations/321_saas_mi_plan_tier.sql`
- **Editado:** `frontend/admin/saas-billing.html`
  - CSS: estilos de `.plan-tarjeta` / `.planes-grid` (portados de la
    página vieja, adaptados a las variables/clases ya usadas en este
    archivo).
  - HTML: card "Planes disponibles" en `#vista-tenant`.
  - JS: `cargarPlanesTenant()` y `cambiarPlanTenant()`, llamadas desde el
    final de `cargarSuscripcionTenant()`.

## Pendiente / próximos pasos sugeridos

- **Aplicar `321_saas_mi_plan_tier.sql` en producción**
  (`jgiquzjwoedmzwqgzubr`) — no fue aplicada automáticamente, hay que
  correrla.
- Probar con login real en navegador (dueño de una empresa suspendida y
  dueño de una empresa activa) que el banner de suspendida, el CBU y ahora
  también el selector de planes rendericen y funcionen bien end-to-end —
  esto seguía pendiente desde v322 y ahora suma el flujo de cambio de plan.
- Confirmar visualmente el menú lateral para roles no-dueño (vendedor/
  admin) — también pendiente desde v322.
- Nota para la próxima sesión: si se vuelve a tocar
  `saas_mi_suscripcion()`/`saas_mis_facturas()`, conviene incluir las
  migraciones 319 y 320 en el próximo ZIP de trabajo para tener su
  definición real acá y no depender de reconstruirla de memoria.
