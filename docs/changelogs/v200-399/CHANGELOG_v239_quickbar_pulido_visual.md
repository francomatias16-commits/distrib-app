# v239 — Pulido visual de la barra de accesos (quickbar)

Refinamiento puramente visual sobre la quickbar agregada en v238, para
que se vea más profesional y sea más legible:

- Cada botón ahora tiene un **ícono dentro de un chip** (fondo suave,
  esquinas redondeadas) en vez de un ícono suelto pegado al texto —
  patrón más prolijo, similar a barras de herramientas de apps modernas.
- Se agregó la etiqueta **"CAJA"** al grupo de movimiento/reporte Z, con el
  mismo estilo de micro-etiqueta (mayúsculas, tracking, barra de acento
  verde) que ya tenía el grupo "ADMINISTRACIÓN" — ahora ambos grupos son
  simétricos y se entienden de un vistazo.
- Botón "Caja" renombrado a **"Movimiento"** (ya no repite la palabra
  "Caja" que ahora es el título del grupo — menos redundante, más claro).
- Separador visual más marcado entre grupos, y un separador secundario
  más sutil entre Promociones y Hardware/Config POS (separa "operación
  diaria" de "configuración").
- Bordes definidos en cada botón (antes flotaban sin borde sobre el fondo),
  sombra sutil en la barra completa para darle una leve elevación sobre el
  contenido, y estados de foco/hover/click más claros (accesibilidad de
  teclado incluida con outline visible).
- Tipografía y espaciados ajustados para mejor legibilidad en mobile.

## Archivos modificados
- `frontend/admin/pos.html` — íconos envueltos en `.pos-quickbar-btn-icon`,
  etiqueta "Caja" agregada, separador secundario, botón renombrado.
- `frontend/admin/css/pos.css` — estilos de `.pos-quickbar-btn-icon`,
  labels con barra de acento, sombra y estados de foco (bump `?v=200`).

No cambia ninguna lógica de `pos.js`; solo HTML/CSS.
