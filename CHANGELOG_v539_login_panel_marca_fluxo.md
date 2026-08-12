# v539 — Panel de marca del login: bug de "Cargando..." fijo + rediseño Fluxo

## Bug reportado
En dominios sin tenant resuelto (ej. el propio *.vercel.app sin mapear a una
empresa), la RPC `empresa_publica_actual` devuelve null y la función salía
temprano (`if (!data) return`) — pero el HTML ya mostraba "Cargando..." como
contenido inicial del título, así que quedaba colgado ahí para siempre.

## Cambio de fondo
El panel derecho dejó de depender de datos de tenant para tener contenido.
Antes: nube + card blanca con logo/nombre de empresa (con placeholder de
carga visible por defecto). Ahora: panel 100% marca Fluxo, estático, no
puede quedar en un estado roto porque no espera ninguna respuesta de red.

La identificación de la empresa (cuando la RPC sí resuelve datos) se movió
a un badge chico y discreto arriba del formulario (`.login-tenant-badge`):
oculto por defecto, sin placeholder — solo aparece si hay datos reales.

## Panel de marca — rediseño
- Fondo: gradiente ámbar diagonal de tokens del proyecto, sin el recorte de
  nube blanca (era el patrón "genérico" a evitar).
- Líneas de flujo animadas (`stroke-dashoffset`) de fondo — eco visual de
  "red de distribución", coherente con el propio ícono de Fluxo (flechas /
  recorridos) en vez de una forma decorativa sin relación con el producto.
  Se desactivan con `prefers-reduced-motion`.
- Ícono real de Fluxo (`logo-fluxo-icon.png`) en blanco sólido (filter
  brightness/invert) con glow radial detrás y animación de flotado sutil.
- Wordmark "FLUXO" tipográfico (no imagen), en la fuente display del
  proyecto (`--font-family-display`), no el logo raster — mantiene
  coherencia con el resto del sistema de tipografía.
- Tagline profesional: "La tecnología que conecta tu distribuidora".
- Responsive (≤760px): hero en fila horizontal arriba del form, ícono chico,
  tagline oculto, líneas de flujo sin animar.

## Archivos modificados
- `frontend/admin/login.html` (bump cache-bust `login.css?v=199`)
- `frontend/admin/css/login.css`

## Sin cambios de backend
Solo frontend estático del login admin.
