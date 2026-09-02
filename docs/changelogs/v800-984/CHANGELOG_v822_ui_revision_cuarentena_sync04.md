# v822 — UI de revisión de cuarentena legacy (seguimiento de SYNC-04)

Sigue a `CHANGELOG_v821_auditoria_integral_2026_cierre_11_restantes.md`. SYNC-04
(v821) resolvió el riesgo de fondo — las ventas legacy migradas desde
`pos_offline_db` v1 dejaron de auto-sincronizarse bajo el tenant equivocado y
quedaron en cuarentena — pero la revisión de esa cola solo tenía API
(`PosOffline.getCuarentenaLegacy()` etc.), sin pantalla: había que resolverla
a mano por consola. Este lote agrega la UI, reusando el patrón visual ya
existente del modal de conflictos.

### `frontend/shared/offline-core.js`
- Nuevo modal genérico `_abrirModalCuarentena(portal, cfg, api, empresaIdActual)`,
  mismo componente visual que `_abrirModalConflictos` (misma hoja de estilos
  `offline-core-conflictos-*`, sin duplicar el modal). Lista cada registro en
  `cuarentena_v1` con `cfg.formatoCuarentena(reg)` (mismo criterio que
  `formatoConflicto`) y dos acciones por ítem:
  - **Confirmar y sincronizar** → `confirmarCuarentena(local_id, empresaIdActual)`,
    con `confirm()` de por medio.
  - **Descartar** → `descartarCuarentena(local_id)`, con `confirm()` de por medio.
- `_actualizarBadge` ahora recibe `contarCuarentena` y le da al badge una
  segunda prioridad visual: por debajo de conflictos activos (que siguen
  ganando siempre — bloquean sync), por encima de online/offline/syncing.
  Naranja (`warning`), no rojo (`danger`): a diferencia de un conflicto, una
  cuarentena no es un rechazo del servidor ni bloquea nada del flujo normal,
  es revisión pendiente.
- `crearOutbox` pasa `getContadorCuarentena` a `_actualizar()` y auto-registra
  `opts.badge.onClickCuarentena` (si el módulo no lo pisó a mano) igual que ya
  hacía con `onClickConflictos` — abre el modal nuevo pasándole
  `opts.getEmpresaId()` resuelto en el momento del click, no al armar el
  outbox (evita depender de que `authCtx` ya esté listo tan temprano).

### `frontend/admin/js/pos-offline.js`
- Nuevo `badge.formatoCuarentena`: título con la fecha del registro migrado,
  detalle con el monto (sumando `payload.pagos[].monto`, ya que el `body` de
  una venta no trae un total ya calculado) y la cantidad de ítems.
- Sin más cambios de wiring — el badge del POS (`.topbar-right`) ya mostraba
  conflictos; ahora también muestra cuarentena con la misma prioridad que se
  agregó en `offline-core.js`, y el click abre el modal nuevo.

### Alcance / lo que NO se hizo
- **Selector de empresa múltiple:** el modal confirma directo contra
  `opts.getEmpresaId()` (la empresa de la sesión actual del admin logueado).
  No hay selector para elegir OTRA empresa al confirmar — razonable mientras
  el admin de POS opera una sola empresa por sesión, pero si en algún
  dispositivo compartido un mismo login pudiera pertenecer a más de una
  empresa, esto no alcanza y haría falta agregar el selector mencionado en la
  conversación previa.
- `cobros-offline.js` y `stock-offline.js` no tienen migración legacy v1
  (`encolarLegacySinTenant` solo lo usa `pos-offline.js`), así que su badge de
  cuarentena simplemente nunca se activa — no hicieron falta cambios ahí.

## Validación
- `node --check` sobre `offline-core.js` y `pos-offline.js`: OK.
- No se corrió la suite de Vitest en este entorno (sin `node_modules` — mismo
  motivo que en v821/v820/v816).
- Pendiente de deploy para tener efecto real.
