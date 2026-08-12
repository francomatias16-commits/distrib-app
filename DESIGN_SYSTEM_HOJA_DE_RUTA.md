# Hoja de Ruta — Sistema de Diseño de distrib

**Estado:** Fase 0 (fundación) implementada — v482. Fase 1 en curso — v485. El seguimiento detallado (qué está hecho, hallazgos, próximos pasos) vive en `SEGUIMIENTO_HOJA_DE_RUTA.md`, separado de este documento de dirección.

## 1. Por qué existe este documento

El sistema anterior ("Electric Blue", `tokens.css` v248) era un sistema de tokens correcto en estructura pero genérico en contenido: azul corporativo #2563EB (el mismo que usan Stripe, Linear y miles de dashboards SaaS), tipografía Inter, sobre una base de tres templates de código abierto apilados (Gentelella 2013 + AdminLTE + un intento de reskin shadcn conviviendo en el mismo repo). Un sistema de tokens más prolijo no resuelve eso — le da estructura a lo genérico, pero sigue siendo genérico.

Este documento define **la dirección que lo reemplaza**, la metodología para aplicarla a las ~55 pantallas del panel admin, y el punto exacto donde quedó el trabajo para que cualquier sesión futura (yo mismo u otro desarrollador) pueda retomarlo sin perder el criterio.

## 2. La dirección: "Hoja de Ruta"

En vez de mirar a otros dashboards SaaS, la estética sale del propio rubro de distrib: remitos, guías de despacho, manifiestos de carga, señalética de depósito. Es lo que la plataforma es de verdad.

### Paleta (definida en `frontend/shared/tokens.css` y espejada en `frontend/shared/gentelella-tokens.css`)

| Token | Hex | Uso |
|---|---|---|
| `--color-bg` (paper) | `#F5F2EA` | Fondo principal — papel crudo cálido |
| `--color-surface` | `#FCFAF5` | Tarjetas, paneles |
| `--color-surface-2` (paper-2) | `#EAE4D6` | Superficie secundaria / hover |
| `--color-text` (ink) | `#16181D` | Texto fuerte, sidebar, headers — grafito casi negro, no azul-negro |
| `--color-primary` (accent-deep) | `#B87A00` | Amarillo señalética de depósito — acento, nunca fondo grande |
| `--color-success-mid` (route) | `#1F5B4A` | Verde ruta/mapa — "en tránsito" / éxito |
| `--color-danger-mid` (alert) | `#B3261E` | Rojo sello de anulado/vencido |

Deliberadamente se evitaron los tres clichés de diseño con IA por defecto: crema+serif+terracota, negro+acento ácido, broadsheet de diario. Ninguno tiene que ver con lo que es distrib.

### Tipografía

- `--font-family-display` → **Oswald** (condensada, industrial/estarcido) — títulos de sección, KPIs grandes. Aplicada globalmente a `h1/h2/h3/.titulo-seccion/.kpi-valor`.
- `--font-family` → **IBM Plex Sans** (reemplaza Inter) — UI, tablas, cuerpo. Más utilitaria, menos "neutral SaaS".
- `--font-mono` → **IBM Plex Mono** — todo dato: números de remito, CUIT, montos, códigos de producto. Clase `.dato-mono` disponible para marcar estos campos explícitamente donde el HTML no use ya `<code>` o `td.num`.

### Radios y sombras

Radios más cerrados (2–10px en vez de 6–16px) y sombras planas tipo "hoja apoyada sobre hoja" (offset duro, sin difuminado grande) en vez de la elevación difusa típica de SaaS. Definidos en las mismas variables de siempre (`--radius-*`, `--shadow-*`) — todo lo que ya las consume hereda el cambio sin tocar código.

### Elemento firma: el sello de estado

Reemplaza el badge-pill redondeado genérico. Mayúsculas condensadas (Oswald), borde doble (`border-style: double`), esquinas casi cuadradas — evoca el sello de recepción de mercadería sobre un remito.

Implementado como **alias de `.badge`** (cero cambios de marcado): todo `<span class="badge badge--success">` existente en el HTML ya se ve como sello sin tocar una línea de JS/HTML. Clases nuevas equivalentes disponibles para código nuevo: `.sello.sello--exito`, `.sello--alerta`, `.sello--anulado`, `.sello--info`, `.sello--primary`.

## 3. Qué se implementó ya

**Fase 0 (fundación, v482):**
Estos dos archivos son el punto de apalancamiento: `gentelella-tokens.css` lo importan 45 de las ~55 pantallas del admin, y `.badge` se usa en 24 archivos CSS más. Cambiar los valores acá (no los nombres de variable) empuja el cambio visual a casi toda la plataforma sin editar cada pantalla:

- ✅ `frontend/shared/tokens.css` — paleta, tipografía, radios, sombras, gradientes, y el sello de estado.
- ✅ `frontend/shared/gentelella-tokens.css` — mismos valores espejados a las variables `--ge-*` que consumen los ~40 archivos `*-gentelella.css`.

(El v481 original queda como referencia de "antes" si hace falta comparar — no se incluye en este ZIP para no duplicar peso, pero cualquier control de versiones ya lo tiene.)

**Fase 1 (migración por archivo, v483 → v485 — en curso):**
- ✅ `frontend/shared/reskin-patch.css` — 160 hex hardcodeados migrados a tokens; el bloque `CHIPS & BADGES` (sección 11 del archivo) migrado al sello de estado (doble borde, Oswald, mayúsculas).
- ✅ `frontend/admin/css/productos.css` — 113 hex hardcodeados migrados a tokens (incluye una escala de grises ad-hoc no tokenizada que existía en este archivo, mapeada a `--color-text*`/`--color-border*` por cercanía perceptual, y un acento morado/teal propio de esta pantalla mapeado a `--nav-facturacion`/`--nav-ventas`).
- ✅ `frontend/admin/css/pos.css` — 96 hex hardcodeados migrados; badges `.pos-venta-badge-anulada`/`.pos-venta-badge-facturada` migrados al sello.
- ✅ `frontend/admin/css/clientes.css` — 81 hex hardcodeados migrados (1 dejado a propósito: `#25D366` es el verde de marca de WhatsApp, no forma parte de la paleta del sistema); `.badge-estado` migrado al sello, `.badge-dot` se mantiene circular (es un indicador de punto, no un sello de texto).
- ✅ `frontend/shared/adminlte-components.css` — 78 hex hardcodeados migrados. `.topbar-workspace` (pill de navegación, no de estado) se dejó como pill redondeada a propósito — el sello es para estados/datos, no para navegación.
- ✅ `frontend/admin/css/producto-picker.css` — 62 hex hardcodeados migrados, más 2 `rgba()` decimales de la paleta vieja (invisibles a un grep de hex) migrados aparte; `.pp-card-codigo` (código de producto) pasado a `var(--font-mono)`; chips de filtro y toggle de vista dejados como pill a propósito (navegación, no estado).
- ✅ `frontend/admin/css/dashboard.css` — 61 hex hardcodeados migrados, más ~20 `rgba()` decimales de la paleta vieja (azules/verdes de Bootstrap escondidos en tints de fondo de íconos y alertas); `.tarea-badge` (nivel de confianza alta/media/baja) migrado al sello; `.dash-destacado__badge-nuevo` y `.mig-dash-badge` dejados como pill a propósito (ribbon decorativo y contador numérico, no estado).

**Nota de criterio para las próximas migraciones:** no todo elemento con `border-radius: var(--radius-full)` es un candidato al sello. Migrar al sello solo lo que comunica un *estado* (activo/anulado/pendiente/facturado). Puntos de estado (`.badge-dot`, `.status-dot`), pills de navegación (workspace, tabs) y botones circulares de ícono se mantienen redondos — es una distinción semántica, no solo visual.

## 4. Lo que falta y por qué (Fase 1 en adelante)

El cambio de tokens cubre todo lo que **ya usaba variables**. Lo que NO se actualiza automáticamente es el color/radio/sombra **hardcodeado directamente** (ej. `background: #2563EB` en vez de `background: var(--color-primary)`) — eso sigue mostrando el azul viejo hasta que se audite archivo por archivo.

Se auditó cada CSS del proyecto contando ocurrencias de hex hardcodeado fuera de los tokens, como proxy de cuánto trabajo manual falta por archivo. Prioridad Alta = 40+ ocurrencias, Media = 15–39, Baja = <15.

### Metodología por archivo (repetir para cada fila de la tabla)

1. Abrir el archivo y el HTML que lo consume.
2. Reemplazar cada hex hardcodeado por el token equivalente más cercano en significado (no solo en valor) — un rojo de error va a `var(--color-danger-mid)`, no a un hex nuevo inventado.
3. Donde haya badges/pills manuales sin usar `.badge`, migrarlos a `.sello` + modificador.
4. Donde haya títulos de sección con `font-family` propia, migrar a `var(--font-family-display)`.
5. Marcar la fila como "Hecho" en la tabla de abajo y hacer commit / nueva versión de ZIP.
6. Screenshot mental (o real si hay entorno de preview) antes de pasar a la siguiente — no migrar 5 archivos a ciegas sin mirar el resultado.

### Tabla de seguimiento

Movida a `SEGUIMIENTO_HOJA_DE_RUTA.md` — ese documento se actualiza en cada ZIP nuevo con el conteo real (hex + `rgba()` de paleta vieja) y el estado por archivo, y no se duplica acá para evitar que las dos tablas queden desincronizadas.

## 5. Para retomar en otra sesión

Si esta conversación se cierra, el próximo paso es: leer `SEGUIMIENTO_HOJA_DE_RUTA.md` completo (estado, hallazgos, próximos pasos concretos), después este documento (dirección y metodología), y seguir con las filas "Alta" pendientes en orden. Los tokens base (sección 3) ya están hechos — no hace falta tocarlos de nuevo salvo que cambie la dirección de diseño.
