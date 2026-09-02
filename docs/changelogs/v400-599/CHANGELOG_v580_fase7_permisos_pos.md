# v580 — Fase 7, sección 2: `pos.js` migrado a PermisosService — sección 2 CERRADA

Continuación de `CHANGELOG_v579_fase7_permisos_pedidos.md`. Último
módulo pendiente de la sección 2 del plan de Fase 7 (`FASE7_PLAN_ARRANQUE.md`).
A diferencia de `pedidos.js`, ninguna de las 5 constantes de `pos.js` se
reexportaba ni se importaba desde otro archivo — autocontenido, no hizo
falta usar el helper `rolesDe()`.

## Qué se hizo

- **Recurso `pos`, 5 acciones** en `lib/permisos-service.js`, una por
  cada constante original:
  - `vender` ← `ROLES_VENTA` (`['dueno','admin','vendedor']`) — 10
    sitios: abrir/cerrar turno, búsqueda de productos, registrar venta,
    favoritos (lectura), movimiento de caja, reporte Z, cliente rápido,
    promociones (lectura), alerta de stock.
  - `transferir` ← `ROLES_TRANSFERIR` (`['dueno','admin','depositero']`)
    — 2 sitios: listado de depósitos, transferir stock entre depósitos.
  - `anular` ← `ROLES_ANULAR` (`['dueno','admin']`) — 10 sitios: anular
    venta, listado de ventas para anular, historial de transferencias,
    alta/baja de favorito, promociones (escritura), filtro
    `soloActivas` de promociones, devoluciones (lectura y alta).
  - `facturar` ← `ROLES_FACTURAR` (`['dueno','admin']`) — 3 sitios:
    emitir comprobante AFIP, config de hardware fiscal, config de PIN
    de supervisor.
  - `administrar_cajas` ← `ROLES_ADMIN_CAJAS` (`['dueno','admin']`) — 6
    sitios: forzar cierre de turno ajeno, historial de turnos, ABM de
    cajas (GET/POST), log de movimientos de caja, umbral de cajero.
  - `anular`, `facturar` y `administrar_cajas` comparten el mismo valor
    (`['dueno','admin']`) pero se preservan como 3 acciones separadas —
    eran 3 constantes con nombre distinto protegiendo endpoints
    distintos en el original, no una redundancia a simplificar de paso
    (mismo criterio que `escribir`/`pagar` en `cc_proveedores`).
- **2 usos no-gate** (no bloquean acceso, exponen/derivan un booleano)
  también migrados a `puede()`, mismo valor que antes:
  - `puede_forzar_cierre` en la respuesta de `/caja-estado` — antes
    `ROLES_ADMIN_CAJAS.includes(perfil.rol)` suelto, ahora
    `puede(perfil, 'administrar_cajas', 'pos')`.
  - `soloActivas` en `getPromocionesHandler` (filtra promociones vía
    RPC según si el que consulta puede anular) — antes
    `!ROLES_ANULAR.includes(perfil.rol)`, ahora
    `!puede(perfil, 'anular', 'pos')`.
- Reemplazo hecho con `sed` sobre los 32 sitios (`ROLES_X.includes(perfil.rol)`
  → `puede(perfil, 'accion', 'pos')`) porque el patrón era 100%
  consistente en todo el archivo (siempre `perfil.rol`, sin variantes) —
  verificado antes con `grep` que no hubiera ningún caso con otro nombre
  de variable. Luego se borraron las 5 declaraciones `const ROLES_*`
  ahora sin uso y se agregó el import de `puede`.
- `tests/permisos-service.test.js` — sumadas 26 casos para las 5
  acciones de `pos`, incluyendo un caso explícito que confirma que
  `anular`/`facturar`/`administrar_cajas` son gates independientes pese
  a compartir roles.
- `node --check` OK en `pos.js` y `permisos-service.js`; `grep
  ROLES_VENTA\|ROLES_TRANSFERIR\|ROLES_ANULAR\|ROLES_FACTURAR\|
  ROLES_ADMIN_CAJAS lib/handlers/pos.js` → 0. Verificado que
  `api/index.js` (único importador de `pos.js`) solo usa el handler por
  default export, no las constantes. Suite completa: 522/522 OK (25
  archivos).

## Sección 2 del plan de Fase 7 — cerrada

Con `pos.js` migrado no queda ningún módulo pendiente de gate simple o
múltiple. Fuera de alcance por diseño (no por volumen): las 4
exclusiones por blast radius (`usuarios.js`, `migracion.js`,
`chofer_invitacion.js`, `portal_proveedor.js` — constantes reexportadas
con mayor superficie de impacto) y la lógica jerárquica de
`ROLES_ASIGNABLES`/`ROLES_PRIVILEGIADOS` de `usuarios.js`, que no encaja
en el modelo `puede(perfil, accion, recurso)` sin forzarlo.
