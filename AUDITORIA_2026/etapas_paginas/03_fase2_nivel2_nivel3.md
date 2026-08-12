# Fase 2 (resto) — Análisis estático sobre Nivel 2 y Nivel 3

**Fecha:** 2026-08-06.
**Alcance:** las 53 páginas de Nivel 2 (27) y Nivel 3 (26) que quedaban
pendientes tras cubrir Nivel 1 (22 páginas del flujo de venta) en una
sesión anterior. Con esto, Fase 2 cubre el 100% de las 75 páginas reales
en su parte de análisis estático (falta el pase manual en navegador,
igual que para Nivel 1).

## Metodología (misma que Nivel 1)
5 chequeos automáticos por página:
1. Scripts `<script src>` e inline con sintaxis rota (`node --check`).
2. Scripts/CSS referenciados que no existen en el filesystem (404 local).
3. Hojas de estilo (`<link rel="stylesheet">`) que no existen.
4. IDs usados en `getElementById()` que no existen como `id=` en el HTML
   ("IDs huérfanos" — candidatos a bug, la mayoría son falsos positivos
   por inyección dinámica de HTML vía `innerHTML`/template strings).
5. Modales (`.modal-overlay`, `.modal-backdrop`, etc.) sin protección
   visible en el HTML contra el patrón que causó UI-001.

## Resultado de los chequeos 1-3
0 errores de sintaxis, 0 scripts rotos, 0 links CSS rotos en las 53
páginas.

## Resultado del chequeo 4 (IDs huérfanos)
72 IDs candidatos únicos. Se revisaron uno por uno con `grep` recursivo
en `frontend/`: **todos son falsos positivos**, generados por:
- IDs armados con concatenación de strings en runtime
  (`'f-' + fieldId`, `'tab-' + t`, `'fl' + i`) que el regex estático no
  resuelve pero sí existen en el HTML con el prefijo correcto.
- IDs definidos en `frontend/shared/*.js` (topbar, nav mobile) cargados
  como script compartido, fuera del árbol de búsqueda inicial.
- Elementos creados dinámicamente por el propio JS antes de buscarlos
  (`overlay.id = 'export-menu-overlay'` seguido de
  `getElementById('export-menu-overlay')`).

Ningún ID huérfano real.

## Resultado del chequeo 5 (modales) — el que importa

El primer barrido (heurística: ¿tiene el modal `style="display:none"` o
clase `hidden` en su propio tag?) marcó 19 candidatos en 10 páginas.
Se verificó cada uno contra el CSS real cargado por su página (cascada
completa, no solo el tag):

| Página | Modal | Resultado |
|---|---|---|
| `cc-proveedores.html` | `modal-factura`, `modal-cruce` | Falso positivo — protegidos por `.modal-overlay { display:none }` + `.active` en `compras.css` |
| `rutas.html` | `modal-entrega-body` | Falso positivo — es el contenido interno, no el contenedor que se togglea |
| `reglas-precio.html` | `modal-regla` (vía `modal-regla-backdrop`) | Falso positivo — protegido por clase `.hidden` con `!important` en `<style>` propio de la página |
| `fidelizacion.html` | `modal-recompensa` (vía `modal-overlay-recomp`) | Falso positivo — mismo patrón `.hidden` propio |
| `puntos.html` | `modal-puntos`, `modal-saldo`, `modal-panel-historial` | Falso positivo — mismo patrón `.hidden` propio |
| `anomalias.html`, `notif-log.html`, `whatsapp-conversaciones.html`, `auditoria.html` | varios `modal-*-content/meta/diff` | Falso positivo — son contenido interno; los contenedores reales (`modal-detalle`, `modal-payload`, etc.) sí tienen clase `hidden` |
| `saas-billing.html` | `modal-overlay`, `modal-config` | Falso positivo — protegidos por `<style>` propio de la página (`display:none` explícito, sin depender de ninguna clase) |

**Ningún hallazgo entre los 19 candidatos originales.**

Sin embargo, para no depender solo de la heurística "¿tiene el tag el
atributo?", se corrió un segundo script que reconstruye la **cascada CSS
real** para todo elemento controlado por `.style.display` desde JS: junta
todos los `<link rel="stylesheet">` de la página en orden, busca la
última regla `.clase { display: ... }` que aplica, y compara contra
`none`. Este script encontró:

### UI-003 (nuevo hallazgo, corregido)
`admin/rutas.html` → `#modal-zona` (pestaña "Zonas", controlado por
`zonas.js`: `getElementById('modal-zona').style.display = 'flex'/'none'`).

La página carga `rutas.css` (define `.modal-overlay { display:flex }` por
defecto, pensado para togglearse con `.modal-overlay.hidden`) **y
después** `compras.css` (define `.modal-overlay { display:none }` por
defecto, pensado para togglearse con `.modal-overlay.active`). Mismo
selector, misma especificidad, dos convenciones de toggle distintas
conviviendo en la misma página — exactamente el patrón que causó UI-001
en `vencimientos.html`. Hoy "gana" `display:none` porque `compras.css` se
carga después en el `<head>`, pero es puro orden de `<link>`, no una
protección real: si algún día se reordenan los `<link>`, se quita la
dependencia a `compras.css`, o se actualiza `rutas.css`, el modal de
Zonas se abre solo al entrar a la pestaña — nadie lo notaría en el acto
porque "Zonas" es una pestaña secundaria dentro de Repartos.

**Corrección aplicada:** `style="display:none"` agregado directamente al
`<div id="modal-zona">`, mismo patrón que UI-001/UI-002 — ya no depende
del orden de carga de CSS.

El mismo chequeo de cascada se corrió también sobre clases no-modal
(`btn`, `filtro-group`, `form-group`, `alert-box`) togglear vía
`.style.display`; esos casos son ruido del script (nombres de clase
genéricos reutilizados con distinto propósito, no relacionados a
modales) y no ameritan revisión — el patrón de riesgo real es específico
de contenedores tipo modal con dos hojas de estilo del mismo módulo
compitiendo por el mismo selector.

## Conclusión de Fase 2
Con Nivel 1 + Nivel 2 + Nivel 3 completos, el análisis estático de las 75
páginas terminó. Un hallazgo real (UI-003), ya corregido. Queda pendiente
el pase manual en navegador real (nunca hecho para ningún nivel) y toda
la Fase 3.
