# Plan de claridad del sistema — Etapa 2 (post-mapeo de flujo operativo)

## Contexto
Etapa 1 (nav-data.js, 13 labels) y Etapas 2–4 (empty states, toasts) ya se
hicieron. Este plan nace de mapear las 6 etapas del día real de un admin de
distribuidora contra las 48 pantallas actuales de `distrib`, con foco
explícito en que el **Panel principal (dashboard.html)** sea el punto de
entrada más entendible de todo el sistema.

Fuente del mapeo: conversación "flujo típico de una distri" + auditoría de
`nav-data.js` y `dashboard.html`/`dashboard-optimizado.js` sobre el código
real (no genérico).

## Principio general
No es un rediseño visual. Es hacer que cada pantalla explique, con lenguaje
llano, **qué está pasando y qué acción corresponde**, priorizando:
1. El dashboard (primera impresión, se usa todos los días)
2. Huecos de navegación reales (pantallas que existen pero nadie encuentra)
3. Labels ambiguos puntuales
4. Claridad del concepto físico/disponible/reservado en Stock (el que vos
   mismo identificaste como el que más confusión genera)

---

## Hallazgos concretos (verificados contra el código)

### A. Falso hueco (corregido tras revisar el archivo): `lotes.html`
`lotes.html` no tiene entrada en el nav, pero al revisar su contenido real
son 5 líneas: un `location.replace('/admin/vencimientos' + ...)`. Es un
stub de compatibilidad para una URL vieja, no una pantalla real. La
gestión de lotes/FEFO ya vive en `vencimientos.html`, que sí está en el
nav como "Por vencer y en oferta". **No requiere acción.**

### B. Falso hueco: `cta-cte.html`
No tiene label propio en el nav, pero **sí es alcanzable**: se accede desde
`cobranzas.html` (mismo patrón que `compras.html` desde `proveedores.html`,
que ya está documentado como intencional en `nav-data.js`). No requiere
acción — se deja como está.

### C. Label ambiguo: "Notas"
El label del nav dice simplemente "Notas", pero la pantalla es
específicamente `Notas de Crédito y Débito` (así lo dice su propio
`<title>` y `<h1>`). Nadie nuevo va a saber qué son "Notas" sin abrir la
pantalla.
**Acción:** renombrar label a "Notas de crédito y débito" en `nav-data.js`.

### D. Dashboard: estructura correcta, pero organizada como plantilla
genérica, no como "el día del admin"
El dashboard actual (`dashboard.html` + `dashboard-optimizado.js`) tiene
buena información real (KPIs de Ventas del período/Pedidos/Clientes
activos/Stock crítico, alertas, tareas, stock crítico, panel ejecutivo),
pero la organización visual arrastra nombres y agrupación de una plantilla
BI genérica (los propios comentarios en el HTML dicen "Project Analytics",
"Reminders", "Time Tracker", "Project Progress" — nombres de la plantilla
original, mapeados después a cada bloque real). El resultado: la
información correcta existe, pero no está agrupada según las 3 preguntas
que un admin se hace al abrir la app a la mañana (qué tengo para vender,
qué sale a repartir hoy, quién me debe y no debería llevarse más). Está
todo en el mismo nivel visual — KPIs, gráfico, recordatorios, tareas,
pedidos recientes, progreso, sincronización, stock crítico, panel
ejecutivo — sin jerarquía que diga "esto es urgente" vs "esto es para
consultar".
**Acción:** sin tocar la grilla CSS (`fa-*-grid`, arriesga romper el
layout responsive ya auditado), agregar microcopy de agrupación: un
subtítulo corto arriba de cada fila de tarjetas que explique en una línea
qué responde esa fila, y ajustar 2-3 títulos de tarjeta que hoy son
genéricos de plantilla ("Tareas de hoy" está bien; "Progreso de pedidos" y
"Sincronizado en vivo" son más "métricas del sistema" que información de
negocio — bajarlas de jerarquía visual sería el siguiente paso, fuera de
alcance de esta pasada de copy).

### E. Stock físico / disponible / reservado
Pendiente de auditar en detalle `stock.html` para confirmar si cada número
mostrado en la grilla deja claro cuál de los tres representa. Lo dejo como
punto 3 del plan de ejecución (no lo toqué todavía en esta pasada).

---

## Plan de ejecución, en orden de prioridad

| # | Acción | Pantalla(s) | Esfuerzo | Riesgo | Estado |
|---|---|---|---|---|---|
| 1 | ~~Agregar "Lotes" al nav~~ — descartado, era un redirect a Vencimientos | — | — | — | ❌ No aplica |
| 2 | Renombrar "Notas" → "Notas de crédito y débito" | `nav-data.js` | Bajo | Bajo | ✅ Hecho esta sesión |
| 3 | Microcopy de agrupación en Dashboard (3 preguntas de apertura) | `dashboard.html` | Medio | Bajo (solo copy, no toca grid) | ✅ Hecho esta sesión |
| 4 | Auditar física/disponible/reservado en Stock y unificar términos | `stock.html`, `stock.js` | Medio | Medio | Pendiente — próxima sesión |
| 5 | Subtítulo aclaratorio Pedido vs Presupuesto dentro de `pedidos.html` | `pedidos.html` | Bajo | Bajo | Pendiente |
| 6 | Revisar jerarquía visual del dashboard (bajar "Progreso de pedidos" / "Sincronizado en vivo" a métricas secundarias) | `dashboard.html`, CSS | Alto | Medio (toca layout) | Pendiente — requiere OK explícito antes de tocar grid |
| 7 | Pasada de empty-states/errores en pantallas nuevas desde la última auditoría (si las hay) | varias | Medio | Bajo | Pendiente, a confirmar alcance |

## Qué NO incluye este plan
- No es un rediseño visual del dashboard (eso ya está en evaluación aparte
  como `dashboard-v2.html`, "Torre de Control", todavía no promovido a
  producción).
- No toca lógica de negocio en ningún punto.
