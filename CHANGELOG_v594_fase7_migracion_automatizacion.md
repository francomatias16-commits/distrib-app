# v594 — Fase 7, orden de migración pedido por el usuario: `automatizacion` — CERRADO

Tercer módulo del lote (después de `portal_proveedor` v592 y
`cc_proveedores` v593): `automatizacion.js` (16 `.from()`/`.rpc()`
directos — coincide con la estimación original, a diferencia de los dos
módulos anteriores). Es el handler del Panel de Control Centralizado:
push/preferencias de notificación + los 6 "motores" del panel (piloto,
cierre financiero, rutas dinámicas, stock autónomo, score de clientes,
auditoría predictiva).

## Qué se hizo

**`lib/repos/automatizacion.js` (nuevo)** — 16 funciones:

- Push/prefs: `upsertDispositivoPush`, `desactivarDispositivoPush`,
  `obtenerPrefsAuto`, `upsertPrefAuto`.
- Motor 1 (piloto): `listarCiclosProximos`, `contarCiclosActivos`.
- Motor 2 (cierre): `listarFacturasPendientesCierre`,
  `listarCobrosRecientes`, `contarBloqueosActivos`.
- Motor 3 (rutas): `listarRutasHoy`, `listarEntregasPorRutas`.
- Motor 4 (stock): `listarLotesPorVencer`, `listarOrdenesCompraPendientes`,
  `listarStockPorProductos`.
- Motor 5 (score): `listarClientesConScore`.
- Motor 6 (auditoría): `detectarAnomaliasAuditoriaRpc` (envuelve la única
  RPC del handler, `detectar_anomalias_auditoria`).

**`lib/repos/index.js`** — se agregó `AutomatizacionRepo` al barrel.

**`lib/handlers/automatizacion.js`** — los 16 `.from()`/`.rpc()` directos
originales pasan por el repo de arriba, sin cambio de comportamiento
observable. Política de error replicada tal cual: silenciosa en las 15
funciones de lectura/escritura de datos (el handler original nunca
chequeaba `error` en ninguna de ellas — todas confían en los defaults
`|| []`/`|| 0`/`|| {}` del lado del handler, que se dejaron intactos), y
propagada solo en la RPC de auditoría (`detectarAnomaliasAuditoriaRpc`),
la única que el original envolvía en `if (error) throw new Error(...)`.
`sb` (el cliente Supabase directo) sigue vivo en el handler solo para
`verificarToken(req, sb)` — identidad, no dato de negocio, mismo criterio
que `cc_proveedores.js`.

No hubo hallazgo de seguridad para corregir en este módulo — a diferencia
de `portal_proveedor`/`cc_proveedores`, las 16 queries originales ya
filtraban `empresa_id` de forma consistente (la única excepción,
`listarStockPorProductos`, no lleva `empresa_id` a propósito y ya estaba
documentada así en el original: se filtra por una lista de `producto_id`
que ya viene acotada a la empresa desde `listarProductosConStockMinimo`).

## Verificación

- `grep -c "\.from(\|\.rpc(" lib/handlers/automatizacion.js`: 0. Cero
  accesos directos a tablas/RPCs de negocio; el único uso restante de `sb`
  es `verificarToken(req, sb)`.
- Sintaxis válida (`node --check`) en handler y repo.
- Tests nuevos: `tests/repos/automatizacion.test.js` (no existía cobertura
  de repo para este módulo). Foco en los filtros de aislamiento
  (`empresa_id`, o la lista de ids ya acotada donde no aplica) de cada
  función, y en que la RPC de auditoría siga devolviendo `{ data, error }`
  tal cual para que el handler decida cuándo propagar.

**Nota sobre ejecución de tests** (mismo caveat que v593): este sandbox no
tiene `node_modules` ni red — no pude correr `vitest` acá. La sintaxis pasa
`node --check` y el mocking sigue el mismo patrón que
`tests/repos/pos.test.js`, pero recomiendo correr
`npx vitest run tests/repos/` en un entorno con dependencias instaladas
antes de dar los 3 módulos de este lote por verificados end-to-end.

## Próximo paso

Sigue `stock-auto` (13 usos), según el orden pedido. Después: `maestros`
(13), `chofer_invitacion` (12), `usuarios` (9), y el puñado chico (piloto,
export-contable, ciclos, auto-imagenes, búsqueda, asistente, fidelización,
setup, saas, importar, auditoría).
