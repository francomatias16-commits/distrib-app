# CHANGELOG — Checklist de activación (onboarding cliente)

Ítem 1 de la sección "Próximos pasos de sofisticación comercial" de
`PLAN_COMERCIALIZACION_DISTRIB.md`. Reutiliza el mismo criterio de
"activada" ya definido en `saas_panel_admin` (migración 186): catálogo
cargado + al menos un movimiento comercial real (pedido o venta POS).

No requiere migración de base de datos — lee las mismas tablas
(`productos`, `pedidos`, `ventas_pos`, `empresas`) que ya usa el panel
superadmin, pero filtradas por la empresa del usuario logueado.

## Backend — `lib/handlers/admin.js`

- Nuevo `GET /api/admin/onboarding`, protegido por el mismo `autenticar()`
  que ya usan `kpis`/`pedidos`/`alertas` (roles `dueno/admin/vendedor/contador`).
- `handleOnboarding()`: 3 EXISTS-style queries (`limit(1)`) + fecha de alta
  de la empresa. Devuelve `{ tiene_productos, tiene_pedidos,
  tiene_ventas_pos, activada, dias_desde_alta }` — solo de la propia
  empresa, nunca de otros tenants.

## Ruteo — `vercel.json`

- Nueva regla `/api/admin/onboarding → /api/index?_mod=admin&_svc=onboarding`,
  mismo patrón que el resto de las sub-rutas de `admin.js` (necesitan regla
  explícita, el catch-all `/api/admin/(.*)` no pasa `_svc`).

## Frontend — `dashboard.html` / `dashboard-optimizado.js` / `dashboard.css`

- Card nueva (`#onboarding-checklist`) ubicada arriba del todo en el panel
  principal, junto a las otras alertas proactivas (stock, migraciones) —
  mismo componente visual `.alerta-proactiva`, variante celeste nueva
  (`--onboarding`).
- 2 pasos con checkbox visual + barra de progreso: cargar catálogo, primer
  pedido o venta. El CTA ("Continuar →") apunta al primer paso incompleto.
- Se carga en paralelo con el resto del dashboard (`cargarOnboarding()`
  dentro del mismo `Promise.allSettled` que KPIs/alertas/migraciones).
- Se oculta sola apenas la empresa está "activada" — no hace falta que el
  usuario la cierre. También tiene botón de cerrar manual (✕), que guarda
  la preferencia en `localStorage` (`distrib-onboarding-dismissed`), mismo
  patrón que la Todo List que ya vive en este dashboard.

## Pendiente (fuera de este alcance)

- El nudge por email (`onboarding_nudge`, migración 186) ya dispara a los
  3 días de trial sin actividad — este checklist es el complemento visual
  dentro del panel, no reemplaza ni duplica esa lógica.
- Si más adelante se quiere trackear cuántos usuarios cierran el checklist
  sin activarse (señal de fricción), habría que mover el flag de
  `localStorage` a una columna en `empresas` — no se hizo ahora para no
  introducir una migración por una preferencia puramente de UI.
