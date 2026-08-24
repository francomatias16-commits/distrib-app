# CHANGELOG v924 — Dashboard: 2do click en un card ya zoomeado redirige a la sección

## Pedido

En el dashboard admin, cada card grande (Ventas, WhatsApp, Catálogo, POS,
ARCA, Score/Cheques, Automatización, Reportes críticos) ya abría un "zoom"
in-place al hacer click en el fondo del card (`abrirZoom()`, existente desde
antes). Lo que faltaba: que el **primer click abra el zoom** (como ya hacía)
y que el **segundo click** (con el card ya ampliado) **redirija/filtre** a la
sección correspondiente del panel, en vez de no hacer nada.

## Comportamiento anterior

`abrirZoom(cardEl, url)` arrancaba con:

```js
if (zoomState) return; // ya hay uno abierto
```

Es decir: si el card ya estaba en zoom, un click adicional sobre su fondo no
hacía absolutamente nada. La única forma de ir a la sección completa era el
botón explícito "Ver sección completa →" que se inyecta dentro del card
zoomeado, o alguno de los `item-nav` internos (filas individuales que sí
navegan directo, sin pasar por el zoom).

## Cambio

Ahora, si el card que recibe el click es el mismo que ya está zoomeado
(`zoomState.card === cardEl`):

- Si el card tiene una `url` propia (todos menos "Reportes críticos") → el
  click navega ahí con `irA(url)`, igual que el botón "Ver sección completa".
- Si no tiene `url` propia ("Reportes críticos", que agrupa 5 tabs —
  Cobranza/Stock/Ranking/Compras/Gastos — sin una sección única de destino)
  → el click cierra el zoom (`cerrarZoom()`), en vez de no hacer nada. Esa
  tarjeta sigue teniendo sus propios `item-nav` por fila para ir directo a
  cobranzas, cheques, stock, etc.

También se actualizó el `title` (tooltip nativo) del card mientras está
zoomeado: pasa de vacío a `"Click para ir a la sección completa"` cuando hay
`url`, para que quede claro que el próximo click ya no repite el zoom sino
que navega. Se sigue restaurando el tooltip original ("Ver en grande") al
cerrar.

No se tocó el resto de la lógica de zoom (animación, `fixZoomGrids`,
`ZOOM_RELOAD`, cierre con Escape/backdrop, botón "Ver sección completa →",
ni los `item-nav` internos que ya redirigían directo con `event.stopPropagation()`)
— todos siguen funcionando igual que antes.

## Archivo modificado

- `frontend/admin/dashboard.html` (función `abrirZoom`, script inline)

## Verificación sugerida post-deploy

1. Click en el fondo de cualquier card grande (ej. "POS · Caja") → se abre
   el zoom in-place, como antes.
2. Click de nuevo en el fondo del mismo card (ya zoomeado) → redirige a
   `/admin/pos`.
3. Repetir con "Reportes críticos": 1er click → zoom; 2do click en el fondo
   → se cierra el zoom (no navega, porque no tiene sección única).
4. Confirmar que los `item-nav` internos (filas de datos, botones de tabs,
   flow-dots de Automatización) siguen navegando directo con un solo click,
   sin verse afectados por este cambio (usan `event.stopPropagation()`).
5. Confirmar que el botón "Ver sección completa →" y la tecla Escape siguen
   funcionando como antes dentro del zoom.
