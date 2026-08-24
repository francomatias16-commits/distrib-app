# v927 — fix2: navegación de cards en zoom saltea el item-nav (dashboard)

## Bug
En Catálogo, POS, Score de cheques, Automatización y Reportes críticos,
el 1er click en cualquier fila interna (item-nav) navegaba directo a la
sub-sección, salteando el zoom del card. WhatsApp y ARCA "andaban bien"
solo porque casi no tienen item-nav cubriendo el cuerpo visible del card.

## Causa real
Las filas internas llaman `irA(url, event)` con `stopPropagation()`, así
que el click nunca llega al `onclick="abrirZoom(...)"` del card
contenedor. No faltaba código de zoom: sobraba navegación directa
mientras el card todavía estaba chico.

## Fix
`irA()` ahora resuelve el card contenedor (`closest('.card-nav')`) del
elemento clickeado:
- Si el card **todavía no está en zoom** (y no es mobile, donde el zoom
  está deshabilitado) → el click se comporta como tocar el fondo: dispara
  `card.onclick()` (abre el zoom), en vez de navegar directo.
- Si el card **ya está en zoom** → navega normalmente a la URL propia del
  item (comportamiento sin cambios).
- En mobile (≤640px) se preserva la navegación directa de siempre, ya
  que ahí `abrirZoom()` está deshabilitado por completo.

## Archivo modificado
- `frontend/admin/dashboard.html` — función `irA()`

## Verificación
- Los scripts inline del HTML parsean sin errores de sintaxis (chequeo
  automático de todos los `<script>` embebidos).
- No se tocó `abrirZoom()`, `cerrarZoom()` ni el resto de la lógica de
  zoom — el fix es puramente en el punto de entrada `irA()`.
