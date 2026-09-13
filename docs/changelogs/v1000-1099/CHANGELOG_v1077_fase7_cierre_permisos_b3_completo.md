# v1077 — Cierre B3: PermisosService al 12/12 (plan de cierre 2026-09)

## Contexto
B3 del `PLAN_CIERRE_DEFINITIVO_2026-09.md` venía en 7/12 handlers migrados a
`puede(perfil, accion, recurso)` / `rolesDe(recurso, accion)`
(`lib/permisos-service.js`). Quedaban 5: `usuarios.js`, `migracion.js`,
`chofer_invitacion.js`, `portal_proveedor.js` y `notif.js` (parcial).

## Cambios

**`lib/permisos-service.js`**
- Nuevos recursos: `usuarios` (`acceder`), `chofer_invitacion` (`gestionar`),
  `portal_proveedor` (`escribir`), `migracion` (`acceder`), `notif_push_chofer`
  (`enviar`), `notif_reintentar_email` (`reintentar`).
- La razón original para dejar `usuarios`/`migracion` afuera ("blast radius"
  porque `ROLES_GESTION`/`ROLES_MIGRACION` se reexportan hacia
  `asistente-tools.js`) dejó de aplicar: mismo patrón ya resuelto por
  `pedidos`/`presupuestos` con `rolesDe()` — el handler sigue exportando la
  constante como valor, solo que ahora es `rolesDe(...)` en vez de un array
  suelto. Contrato de `asistente-tools.js` sin cambios.

**`lib/handlers/usuarios.js`** — `ROLES_GESTION` pasa a `rolesDe('usuarios',
'acceder')`; el gate del handler usa `puede(perfil, 'acceder', 'usuarios')`.
`ROLES_ASIGNABLES`/`ROLES_PRIVILEGIADOS` NO se migran a propósito: no son
gates de acceso sino validación de valores y jerarquía actor-vs-objetivo.

**`lib/handlers/chofer_invitacion.js`** — `ROLES_GESTION` pasa a
`rolesDe('chofer_invitacion', 'gestionar')`.

**`lib/handlers/portal_proveedor.js`** — `ROLES_ESCRITURA` pasa a
`rolesDe('portal_proveedor', 'escribir')` (solo `handlePortalAdmin`; el portal
público sigue resuelto por token, sin cambios).

**`lib/handlers/migracion.js`** — `ROLES_MIGRACION` pasa a
`rolesDe('migracion', 'acceder')`.

**`lib/handlers/notif.js`** — los dos gates que quedaban como arrays
`['dueno','admin']` inline y sin nombre (`pushChoferHandler`,
`handleReintentarEmail`) pasan a `puede(perfil, 'enviar', 'notif_push_chofer')`
y `puede(perfil, 'reintentar', 'notif_reintentar_email')`.

`ROLES_POR_TIPO` (destinatarios de `pushInternoHandler`, protegido por
`INTERNAL_PUSH_SECRET`, no por rol del que llama) y los `.in('rol', [...])`
sueltos de selección de destinatarios (`alertarTokenWhatsAppVencido`,
`marcarDerivada`, `enviarAvisoChequesPorVencer`) quedan sin tocar a propósito:
son "a quién le aviso", no "quién puede llamar esto" — forzarlos en
`puede()` sería forzar la abstracción.

## Resultado
B3 cerrado: 12/12 handlers en `PermisosService`. Sin cambio de comportamiento
en ningún gate (mismos roles, mismo criterio, solo tabla centralizada).

## Verificación
`npx vitest run` — 145 archivos / 2024 tests, todos verdes (incluye
`tests/permisos-service.test.js`, `tests/handlers/usuarios.test.js`,
`tests/handlers/whatsapp-notif-permisos.test.js`, `tests/repos/notif.test.js`,
`tests/repos/migracion.test.js`, `tests/repos/portal-proveedor.test.js`).
