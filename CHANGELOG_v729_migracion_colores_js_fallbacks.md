# v729 — Cierre del residuo de paleta vieja en JS + fix de fallbacks desincronizados

## Contexto

`SEGUIMIENTO_HOJA_DE_RUTA.md` había quedado desactualizado desde v489 y no
reflejaba ni el fix del verde WhatsApp en `dashboard.html` (v728-v731) ni el
arranque del frente JS (v728). Antes de seguir, se sincronizó el documento
con el estado real y se retomó el frente "JS con colores hardcodeados"
donde había quedado.

## 1. Residuo del swap de paleta vieja (v728)

La migración de `#B87A00`/`#1F5B4A`/`#B3261E` de v728 no había cubierto
todos los archivos. Quedaban 33 ocurrencias de `#1F5B4A`/`#B3261E` en 12
archivos más:

`shared/offline-core.js`, `admin/js/automatizacion.js`, `admin/js/productos.js`,
`admin/js/rentabilidad-producto-vendedor.js`, `admin/js/reportes-ventas.js`,
`admin/js/stock.js`, `admin/js/reportes-financieros.js`, `admin/js/pos.js`,
`admin/js/compras.js`, `admin/js/rentabilidad-zona.js`, `admin/js/pedidos.js`,
`admin/js/reportes-stock.js`.

Swap mecánico 1:1, mismo mapeo que v728: `#1F5B4A` → `#487050`
(`--color-primary-dark` / `--nav-ventas`), `#B3261E` → `#D1594A`
(`--color-danger-mid`). Incluye tanto fallbacks `var(--token, #hex)` como
hex crudo (config de ECharts en `stock.js`, valor por defecto de un
`<input type="color">` en `pos.js`).

## 2. Fix de fallbacks `var(--token, #hex)` desincronizados

Mismo bug que ya se había encontrado y corregido en la auditoría de HTML
(v489, sección 3.5 punto 2): el nombre del token en `var(--nombre, #hex)`
es correcto, pero el hex de respaldo no coincide con el valor real que
tiene ese token en `tokens.css` — quedó de una paleta anterior.

Encontrados **144 casos en 23 archivos** vía script (comparando cada
`var(--token, #hex)` contra la tabla real de `tokens.css`), concentrados en
`--color-danger`/`--color-success`/`--color-warning` y sus variantes
`-bg`/`-mid`. El más afectado: `cc-proveedores.js` (23 casos). Corregidos
todos, respetando el nombre de variable y cambiando solo el fallback al
valor real:

| Token | Fallback viejo visto | Valor real |
|---|---|---|
| `--color-danger` | `#7A1E19` / `#B02A37` | `#7A2820` |
| `--color-danger-bg` | `#F3DAD8` / `#F8D7DA` | `#F5DDD8` |
| `--color-success` | `#17402F` | `#487050` |
| `--color-success-bg` | `#DCEDE3` | `#E2F0E5` |
| `--color-success-mid` | `#1F5B4A` (¡ojo, distinto de `--color-success`!) | `#75A37D` |
| `--color-warning` | `#7A4A00` / `#B45309` | `#8A5F13` |
| `--color-warning-bg` | `#FBEBC7` | `#FBE8C9` |
| `--color-info` | `#1E3A52` | `#1F3555` |
| `--color-info-bg` | `#DCE6EC` | `#DDE6EE` |
| `--color-info-mid` | `#2E6088` | `#33507A` |

**Corrección sobre la marcha:** al aplicar el swap del punto 1 con
reemplazo global de texto, `var(--color-success-mid,#1F5B4A)` se migró
primero a `var(--color-success-mid,#487050)` — pero `#487050` es el valor
de `--color-primary-dark`/`--color-success`, no de `--color-success-mid`
(`#75A37D`). Se detectó con el mismo script comparativo del punto 2 y se
corrigió a `#75A37D` en los 6 casos afectados (`offline-core.js`,
`automatizacion.js`, `reportes-ventas.js`, `reportes-financieros.js`,
`reportes-stock.js`) antes de cerrar la pasada — ningún nombre de variable
quedó mal, solo el fallback intermedio.

## Verificado

- 0 ocurrencias de `#B87A00`/`#1F5B4A`/`#B3261E` restantes en `frontend/**/*.js`.
- 0 mismatches restantes entre `var(--token, #hex)` y el valor real de cada
  token (re-chequeado con el mismo script comparativo).
- `node --check` sin errores en los 7 archivos con más cambios.
- Ninguno de estos cambios es visible: son fallbacks de `var()` que los
  navegadores objetivo nunca renderizan (siempre soportan custom
  properties). Es limpieza de consistencia/deuda, no un fix visual.

## Lo que queda (ver SEGUIMIENTO_HOJA_DE_RUTA.md §3.6/§4)

~261 hex/rgba crudos reales (fuera de `var()`) en 34 archivos — series de
ECharts, gradientes de sparkline, pills Material ad-hoc. Frente que sigue
sin empezar; requiere criterio por archivo, no swap mecánico.
