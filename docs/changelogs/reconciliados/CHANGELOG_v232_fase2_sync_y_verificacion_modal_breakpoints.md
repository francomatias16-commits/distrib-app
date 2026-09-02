# CHANGELOG v232 — Fase 2: sincronización del ZIP a v231 + verificación de `.modal` y breakpoints sueltos

**Fecha:** 2026-08-25

## Contexto
El ZIP recibido (`distrib_v230_fase2_filtros_bar.zip`) todavía tenía el bloque base
de `.btn-exportar, .btn-importar` duplicado en los 6 archivos (`automatizacion`,
`facturacion`, `finanzas`, `pedidos`, `reportes`, `rutas`) y un `componentes-admin.css`
sin la consolidación — es decir, correspondía al estado previo a v231. El
`componentes-admin.css` adjunto por separado sí tenía la versión consolidada.
Se sincronizó el proyecto a v231 (componentes-admin.css consolidado + bloque base
quitado de los 6 archivos, `:hover` intacto) antes de seguir.

## Verificación de los dos puntos que quedaron deliberadamente abiertos

### `.modal` (395 referencias, 40 archivos)
Se inspeccionó el bloque base `.modal { ... }` en los 11 archivos que lo declaran
directo (no `.modal-algo`). Confirmado: **no son duplicados, son variantes reales**
— cada uno define un panel distinto a propósito:
- Ancho: 460px, 500px, 520px, 540px, 560px, 580px, 600px (según cuánto contenido
  necesita el formulario de esa página).
- Dirección de entrada: paneles laterales que deslizan desde la derecha
  (`clientes`, `facturacion`, `pedidos`, `productos`, `stock`) vs. modales
  centrados con `border-radius` (`finanzas`, `rutas`) vs. el genérico de
  `adminlte-components.css` con `scale()`.
- `productos.css` incluso documenta explícitamente por qué necesita `transform: none`
  para no heredar el `scale(.96)` del genérico.
No hay nada para consolidar sin decidir cuál de estos 7+ anchos/comportamientos
"gana" — es una decisión de diseño, no un bug mecánico. Se confirma la decisión
anterior de dejarlo fuera de esta ronda.

### Breakpoints sueltos (24 valores, ~160 usos)
Se revisaron los `max-width` de los 4 archivos compartidos (los que cargan las
57 páginas) buscando específicamente selectores que reciban una segunda
declaración competidora en el CSS de una página con un breakpoint distinto —
el mismo patrón real que causaba el bug de `.filtros-bar`. Encontrado un caso
candidato: `.page-intro-row` tiene una regla en `adminlte-components.css`
(pasa a columna en `≤780px`) y otra en `pedidos.css` (pasa a columna en
`≤900px`). Se verificó el orden real de carga en `pedidos.html`
(`adminlte-components.css` antes que `pedidos.css`) y el resultado: no es un
bug visible — ambas reglas piden lo mismo (columna) en su rango, sólo son
redundantes entre 780-900px, no contradictorias. El resto de los breakpoints
sueltos siguen siendo, como se documentó antes, valores de layout de página
que no compiten porque viven en archivos que no se solapan. Se confirma la
decisión anterior de no migrarlos de una sola pasada.

## Estado
Sin cambios de riesgo esta ronda — se corrigió el desfasaje del ZIP y se
revalidó (con evidencia concreta, no solo repetir la conclusión anterior) que
`.modal` y los breakpoints sueltos siguen bien fuera de alcance sin QA visual
real. Fase 2 se mantiene cerrada en los mismos términos que v231.
