# Etiquetas de precio: layout compacto + fix de botones sin efecto (v979)

## 1) Por qué "Guardar cambios" y "Vista previa" no tenían efecto

### Guardar cambios — bug real, confirmado
`mostrarAlerta()` se llamaba en 4 lugares del script (al cargar la config
con error, y al guardar con éxito o error) pero **nunca estaba definida en
este archivo**. Las otras páginas de configuración del panel
(`empresa-config.html`, `facturacion-config.html`, `mercadopago-config.html`)
sí definen cada una su propia `function mostrarAlerta(tipo, msg) {...}` al
final del script — es el mismo patrón en las cuatro páginas, pero en
`etiquetas-config.html` se armó el HTML (`<div id="alerta">`) y el CSS
(`.alerta`/`.alerta-ok`/`.alerta-err`) y se quedó sin la función que los usa.

Efecto real: al tocar "Guardar cambios", el `PUT /api/etiquetas/config` se
mandaba y el servidor SÍ guardaba los cambios correctamente. Pero justo
después, `mostrarAlerta('ok', ...)` tiraba un `ReferenceError` (antes de
llegar a mostrar el cartel "Guardado"), que `btnAsyncClick` atajaba y
mostraba como un toast genérico "mostrarAlerta is not defined" — un mensaje
críptico que no comunica que en realidad el guardado funcionó. Por eso el
botón "parecía" no hacer nada.

**Fix:** se agregó la función faltante, igual al patrón de las otras 3
páginas.

### Vista previa de prueba — bug relacionado encontrado de paso
`JsBarcode` se carga desde `https://cdnjs.cloudflare.com/...` (igual que en
`pos.html`), pero la Content-Security-Policy de `vercel.json` para páginas
`/frontend/*.html` no incluía `cdnjs.cloudflare.com` en `script-src` — el
navegador bloquea la carga de ese script por política de seguridad, y
`window.JsBarcode` nunca llega a existir. El motor de impresión ya tiene un
try/catch alrededor de cada llamada a `JsBarcode` (no rompe toda la grilla),
así que "Vista previa" igual abre el diálogo de impresión, pero **sin
ningún código de barras dibujado** — lo cual, a simple vista, da la
sensación de que el botón no hizo nada.

**Fix:** se agregó `https://cdnjs.cloudflare.com` al `script-src` de la CSP
en `vercel.json` (regla `/frontend/(.*)\.html`). Esto también corrige el
mismo problema latente en `pos.html`, que carga JsBarcode de la misma CDN.

## 2) Layout compactado a una sola pantalla

Antes: 2 columnas, con las 3 cards del formulario (Formato, Código de
barras, Contenido) apiladas una debajo de la otra en la columna izquierda
— la suma de las tres superaba fácil los 900px de alto, obligando a
scrollear incluso en pantallas grandes. Los botones de acción vivían
adentro de la última card (Contenido), así que si esa card no entraba en
pantalla, tampoco los botones.

Ahora:
- A partir de 1100px de ancho, la columna del formulario usa **CSS
  multi-columna** (`columns: 2`) para repartir las 3 cards en 2 columnas
  que el navegador balancea automáticamente por altura (mismo principio
  que las columnas de un diario) — sin tener que armar el reparto a mano
  en el HTML. Sumado a la columna de Vista de referencia, quedan 3
  columnas visibles en vez de 2 filas altas.
- "Guardar cambios" y "Vista previa de prueba" salieron de la card de
  Contenido y pasan a una **barra fija al pie de la ventana**
  (`.cfg-savebar`), siempre visible sin importar cuánto mida el contenido
  de arriba — ni siquiera depende de que todo entre en una pantalla.
- Paddings, márgenes y tamaños de fuente reducidos en cards, inputs y
  textos de ayuda para bajar la altura total sin perder legibilidad.
- El texto largo de ayuda de "Simbología" se acortó sin perder el
  significado.
- La vista de referencia (boceto a escala) se hizo más baja (140px en vez
  de 190px de alto mínimo).

Por debajo de 1100px de ancho se mantiene el comportamiento anterior (2
columnas simples, o 1 columna en mobile) — la barra de acciones fija sigue
ayudando ahí también, aunque en pantallas chicas seguramente siga haciendo
falta algo de scroll para ver todos los campos.

## Archivos tocados
- `frontend/admin/etiquetas-config.html`: CSS compactado + multi-columna,
  barra de acciones fija, función `mostrarAlerta()` agregada, hint de
  Simbología acortado.
- `vercel.json`: CSP de `/frontend/(.*)\.html` ahora permite
  `https://cdnjs.cloudflare.com` en `script-src`.

## No tocado
- No se tocó el backend (`lib/handlers/etiquetas.js`,
  `lib/repos/etiquetas.js`) ni el motor de impresión
  (`etiquetas-print.js`) — el guardado y la impresión ya funcionaban
  bien del lado del servidor; el problema estaba en la falta de feedback
  visual (frontend) y en la CSP.
