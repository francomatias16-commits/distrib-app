# Auditoría UI/UX — Completa (todas las superficies)

**Fecha:** 2026-07-26
**Alcance:** `frontend/cliente` (7), `frontend/admin` (51 reales + 4 redirects), `frontend/chofer` (4), `frontend/proveedor` (1), páginas públicas (4) — **67 pantallas reales**.
**Estado:** esta pasada completa lo que las dos anteriores dejaron parcial. Sigue siendo 100% código, no render.

---

## Qué se corrigió esta sesión (aplicado, no solo documentado)

### 1. Paleta — extendida a todo el proyecto y con causas raíz reales, no solo hex sueltos

- **`admin/css/login.css` redefinía `--color-primary: #00AE70` (verde) en su propio `:root`**, cargado *después* de `tokens.css` en `login.html` → pisaba en silencio la corrección de paleta que había hecho la sesión anterior. Esta era la razón real por la que el login seguía "mal" pese al fix previo. Corregido.
- **`admin/css/automatizacion.css` y `automatizacion.js` usaban `var(--color-primario, ...)`** — con "o" final — pero la variable real es `--color-primary` (inglés). Esa variable nunca existió, así que las reglas siempre corrían con el fallback, y dos casos de `:hover` **no tenían fallback en absoluto**, rompiendo el hover sin avisar. Corregido (nombre de variable + fallback).
- Extendido el reemplazo de azul/verde viejo (`#185FA5`/`#0f2f4a`/`#1e7fc4`/`#00AE70`) a superficies que las dos auditorías anteriores no habían tocado: **portal chofer (4 páginas + manifest.json + pwa-init.js), portal proveedor, y las 4 páginas públicas** (index, registro, términos, privacidad).
- Cerrados los hardcodeos reales sueltos que quedaban en admin: `reglas-precio.html`, `rentabilidad-producto-vendedor.html`, `saas-billing.html`, `setup.html`, `auditoria.html`, `shared/tienda-nav.css`, `shared/adminlte-components.css`, `shared/chat-widget.css`, `admin/css/auditoria-gentelella.css`, un `console.log` con color de debug en `auth.js`.
- **Verificación final por grep en todo el árbol:** cero referencias reales al azul/verde viejo. Lo único que queda son comentarios históricos (`tokens.css`, `adminlte-components.css`) y paletas de colores para avatares/gráficos donde `#00AE70` es solo uno de 6-8 tonos usados a propósito para diferenciar elementos — no es un bug de marca.
- Unifiqué además los colores de éxito/error de `catalogo.html` (cliente) con el resto del portal.
- Agregué `aria-label` a los 2 `<input>` sin etiqueta (`comparador-precios.html`, `conciliacion-bancaria.html`).

Todo esto está en el zip adjunto (81 archivos, mismas rutas que tu repo).

---

## Categorías que la auditoría de admin anterior dejó superficiales — revisadas en serio ahora

### Accesibilidad de foco de teclado — mejor de lo que había reportado
La vez pasada no lo había mirado en profundidad. Ahora verifiqué específicamente si cada página tiene alguna red de seguridad para `:focus-visible` (hay dos: `a11y-focus.css`, pensado para páginas sin reskin completo, y `reskin-patch-v2-shadcn.css`, que trae su propio anillo de foco). Resultado real: **de 67 páginas, solo 5 no cargan ninguna de las dos** — y las 5 son los redirects puros (`cta-cte`, `liquidacion`, `lotes`, `presupuestos`) más `superadmin.html`, todas de contenido mínimo/transitorio. El `outline: none` disperso en decenas de archivos `*-gentelella.css` que encontré al principio **no es un problema real** — el anillo de foco de `reskin-patch-v2-shadcn.css` se carga después y con `!important`, así que gana igual. Corrijo mi propia sospecha inicial: esto está bien resuelto a nivel arquitectura.

### Responsive — sin hallazgos nuevos
Revisé anchos fijos >420px fuera de media query como candidatos a overflow en mobile, específicamente en las pantallas que de verdad importan para mobile (`cliente/*`, `chofer/*`). Los matches fueron falsos positivos (breakpoints de `min-width` dentro de la propia media query). No encontré overflow real.

### Imágenes sin `alt` — limpio
Cero `<img>` sin `alt` en las 67 páginas (el proyecto usa SVG inline para casi todo, como ya se había notado en la auditoría del portal cliente).

### Manejo de errores en JS — acá sí hay un hallazgo real y nuevo
La auditoría anterior solo contaba si aparecía la palabra "Cargando" en el HTML — no miraba el JS. Ahora comparé, por archivo, cantidad de llamadas `await fetch(...)` / `await supabase...` contra cantidad de bloques `try {}`. Con más del doble de llamadas que de try/catch:

| Archivo | Llamadas async | `try {}` |
|---|---|---|
| `depositos.js` | 4 | **0** |
| `listas-precio.js` | 4 | **0** |
| `lotes.js` | 5 | **0** |
| `usuarios.js` | 4 | **0** |
| `zonas.js` | 4 | **0** |
| `compras.js` | 12 | 4 |
| `proveedores.js` | 8 | 2 |
| `notas-credito.js` | 3 | 1 |
| `pos-terminal.js` | 3 | 1 |

En los 5 primeros no encontré ningún `.catch()` tampoco — si el fetch falla (caída de red, 401, 500), la promesa queda sin manejar: no hay mensaje de error visible, y según el flujo, un botón puede quedarse en "Guardando..." para siempre sin que el usuario sepa qué pasó. **No lo corregí** — a diferencia de un hex de color, esto es lógica de manejo de errores real (qué mensaje mostrar, si reintentar, si revertir un estado optimista), y prefiero que lo veas vos antes de que yo le agregue comportamiento a código que no escribí en esta sesión. Si querés, lo reviso módulo por módulo y te propongo el fix concreto para cada uno.

### Tipografía — inconsistencia menor, heredada, no corregida
Conviven `'Inter'` (reskin nuevo) y `'Source Sans 3'` (era Gentelella/fireart vieja) como fuente base en distintos archivos — mismo patrón de "modernización a medias" que ya se documentó para colores y radios. No lo toqué: cambiar la fuente base de archivos viejos es más parecido a un rediseño que a un fix de bug, y varias de esas pantallas (`*-gentelella.css`) capaz están en la lista de reskin pendiente igual.

---

## Lo que sigue sin resolver (documentado, no aplicado — decisión tuya)

1. **`ADMIN-003` (radios de borde)** — sigue sin tocar, incluído el hallazgo nuevo de que `login.css` tenía además su propia escala de radios (10/14/22px) distinta de `tokens.css` (6/8/10/12px) — mismo problema que con los colores, mismo archivo.
2. **Manejo de errores débil** en los 9 archivos JS de la tabla de arriba — necesita tu criterio de qué mensaje/comportamiento mostrar, no es un find-and-replace.

## CERRADO — Tipografía Source Sans 3 → Inter (verificado 2026-07-26, no reabrir)

**Este punto queda cerrado de forma definitiva.** Se corrió `grep -ri "sans"` sobre
todo `frontend/` (css, html, js) buscando específicamente `Source Sans 3` /
`Source Sans Pro` / cualquier variante: **cero coincidencias reales en las 71
pantallas** — todo lo que matcheaba "sans" era el fallback genérico
`sans-serif` dentro de `font-family: var(--font-family), 'Inter', sans-serif`,
no una fuente distinta cargada de verdad. Los 41 archivos `*-gentelella.css`
del proyecto no declaran `font-family` propio (heredan de `tokens.css` /
`base-layout.css`, ambos en `Inter`). La única tipografía no-Inter que existe
en todo el proyecto es `Space Grotesk`, un acento de display deliberado y
decorativo en la landing pública (`index.html`) — no relacionado con esta
migración y ya evaluado aparte en `GENTELELLA_RESKIN_TRACKING.md` como
decisión de identidad de marca, no como bug.

**No volver a listar esto como pendiente.** Si en una futura auditoría
aparece de nuevo "Source Sans" en algún grep, verificar primero si es
`sans-serif` genérico (falso positivo) antes de reportarlo.

¿Seguimos con alguno de los dos puntos que quedan abiertos, o preferís que revise algo puntual primero?
