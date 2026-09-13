# v1079 — Cierre B6: manejo de errores en lotes.js/usuarios.js/zonas.js — sin huecos reales

## Contexto
`AUDITORIA_UX_COMPLETA.md` dejaba pendiente, sin resolver, verificar caso por
caso si la "cobertura parcial" de `try/catch` en `lotes.js`, `usuarios.js` y
`zonas.js` (frontend/admin/js) dejaba rutas reales sin manejar. La tabla
original comparaba cantidad de `await` contra cantidad de bloques `try {}`
por archivo — una métrica gruesa, porque un mismo `try` puede cubrir varios
`await` consecutivos.

## Verificación
Se listó, línea por línea, cada `await` de los 3 archivos y se clasificó
según si cae dentro de un `try {}` o no.

**Resultado: cobertura completa en los 3 archivos, sin huecos reales.**

- `lotes.js`: 6 `try` — `cargarDepositos`, `cargarLotes`, `buscarProducto`,
  `guardarLote`, `darDeBajaLote`, `eliminarLote`. Todos los `fetch`/`sb.from`/
  `sb.auth.getSession` quedan adentro de su `try`, con `toast(err.message, ...)`
  en el `catch`.
- `usuarios.js`: 3 `try` — `cargarUsuarios`, `guardarUsuario`, `cambiarEstado`.
  Mismo patrón; `tokenActual()` no tiene su propio `try` pero solo se llama
  desde dentro de los 3 anteriores, así que cualquier throw de
  `sb.auth.getSession()` lo captura el `try` del que lo llama.
- `zonas.js`: 4 `try` — `cargarZonas`, `guardarZona`, `desactivar`, `activar`.
  Mismo patrón.

Los únicos `await` fuera de un `try` en los 3 archivos son: (a) llamadas a
las propias `cargarLotes()`/`cargarUsuarios()`/`cargarZonas()` desde `init()`
— funciones que ya capturan su error internamente y nunca propagan un throw
— y (b) llamadas a `confirmar()`/`window.confirmar()` (diálogo in-page, no
red) antes de entrar al bloque protegido.

Hallazgo extra no documentado en la auditoría original: los 3 archivos usan
`window.btnAsyncClick` (`lib`/`frontend/admin/js/ui-utils.js`) para las
acciones disparadas por botón — ese wrapper universal tiene su propio
`try/catch/finally` alrededor del callback (libera el lock del botón y
muestra un toast con `err.message` si algo escapa sin capturar). Es una
segunda red de seguridad además del `try` propio de cada función.

## Resultado
**Sin cambios de código** — no hacía falta ninguno, la cobertura ya era
completa. Se actualiza `docs/auditorias/AUDITORIA_UX_COMPLETA.md` (y su
copia en la raíz del repo, que había quedado desincronizada) cerrando el
punto 2 de "Lo que sigue sin resolver" como verificado, sin reabrir salvo
que se agregue a futuro una función nueva en alguno de estos 3 archivos sin
su propio `try/catch`.

B6 del `PLAN_CIERRE_DEFINITIVO_2026-09.md` queda cerrado.
