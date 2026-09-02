# v968 — Cierre etapa 8: tests de regresión XSS frontend

## Resumen

Cierre de la etapa 8 (tests de regresión sobre los hallazgos de XSS de
AUDITORIA_BUGS_v954.md en scripts de frontend sin bundler). Se integran
7 archivos de test nuevos/actualizados en `tests/frontend/` y el fix
definitivo del helper compartido `tests/helpers/cargar-script-frontend.js`.

## Causa raíz del problema arrastrado de la sesión anterior

Con `tests/helpers/cargar-script-frontend.js` en su versión previa, 2
tests fallaban de forma intermitente por conteo de elementos en el DOM
falso — no era un bug de producción, sino una limitación de
`crearElementoFake()`: la propiedad `innerHTML` era un campo plano, así
que la agregación interna que hace `appendChild()` (para reflejar el
HTML de los hijos en el padre) y una asignación externa directa
(`el.innerHTML = '...'`, típica para limpiar antes de un loop de
renderizado) usaban el mismo setter — cualquiera de las dos pisaba a la
otra.

## Fix aplicado (una sola vez, en el helper — beneficia a los 7 archivos)

- `innerHTML` pasa a ser un accessor (`get`/`set`) respaldado por una
  variable de closure `_html` + array `_children`:
  - la asignación **externa** (`el.innerHTML = '...'`) limpia `_html` y
    vacía `_children`, como el DOM real.
  - la agregación **interna** de `appendChild()` escribe `_html`
    directo (sin pasar por el setter público), así no dispara la
    limpieza y no se pisan los hijos ya agregados.
- Se agregó `buscar()` — resolución mínima de selector de clase
  (`.algo`) recorriendo `children` recursivamente, usada por
  `querySelector` del elemento falso (cubre el patrón real
  `_toastEl.querySelector('.toast-msg')` de `ui-utils.js`).
- Se mantienen `asignarVariableDeModulo()` (para mutar `let`/`const` de
  nivel superior de los scripts cargados en el `vm.Context`, que no son
  propiedades del `sandbox`) y `extraerScriptDeHtml()` (para testear
  bloques `<script>` inline de `checkout.html` y `facturacion.html` sin
  parsear HTML de verdad).

## Archivos de test integrados en `tests/frontend/`

| Archivo | Hallazgo(s) cubiertos | Tests |
|---|---|---|
| `cobranzas.test.js` | #19 — tabla priorizada + tabla por pestaña | 4 |
| `remito.test.js` | #23 (2ª mitad) — CUIT empresa/cliente en remito imprimible | 3 |
| `checkout.test.js` | #24 — portal cliente público (link de WhatsApp sin login) | 3 |
| `rutas.test.js` | #22, #23 — popup mapa seguimiento en vivo, select invitar chofer | 7 |
| `facturacion-comprobantes-historicos.test.js` | #21 — pestaña Comprobantes históricos | 5 |
| `cta-cte.test.js` | regresión preventiva — tabla Saldos por cliente | 4 |
| `ui-utils-sanitize.test.js` | ya existía en el repo, sin cambios | 6 |

Total `tests/frontend/`: **7 archivos, 32 tests, todos en verde.**

## Verificación

- `npx vitest run tests/frontend/` → 7 archivos, 32 tests, OK.
- `npx vitest run` (suite completa) → **65 archivos, 1084 tests, OK.**
  Confirma que el fix del helper no rompió ningún otro test que ya lo
  usara.

## Estado de la etapa 8

Cerrada. Los 6 hallazgos de XSS de frontend de AUDITORIA_BUGS_v954.md
con test de regresión pendiente (#19, #21, #22, #23×2, #24) ahora tienen
cobertura automatizada.
