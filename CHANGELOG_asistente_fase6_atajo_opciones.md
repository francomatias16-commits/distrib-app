# Fase 6 (robustez conversacional): atajo numérico para elegir una opción

## Contexto

Cuando `ambiguo()` (`lib/asistente-tools/_respuestas.js`, Fase 3) deja
varios candidatos sin poder elegir uno solo, el frontend ya pintaba una
lista de botones tappable (`opciones`/`onElegirOpcion` en
`chat-widget.js`). Eso funciona bien tocando la pantalla, pero en modo
manos libres (dictado + lectura en voz alta, Fase 4) obligaba a cortar
el flujo de voz para ir a tocar un botón — justo el caso que el modo
manos libres existe para evitar.

## Qué se agregó

`resolverAtajoOpcion(texto, opciones)` en `frontend/shared/chat-widget.js`:
función pura a nivel de módulo (mismo patrón que
`normalizarNumerosParaVoz` de Fase 4, fuera del IIFE a propósito para
poder testearla sin simular todo el panel). Interpreta `texto` como el
número 1-based de una de las `opciones` ({id,label}) que dejó pendiente
la última respuesta — solo el número ("2"), o con alguno de los
prefijos típicos de cómo transcribe el navegador un dictado
("opción 2", "número 2", "la 2", "nro 3") — y devuelve el `label` exacto
para reusar el mismo camino que un click en el botón, sin mandarle un
número pelado al modelo.

Cableado en el flujo de envío:

1. `opcionesPendientes` — nuevo estado a nivel de widget, se carga con
   `data.opciones` de cada respuesta del asistente y se pisa a `null` en
   la siguiente (nunca queda una lista vieja aplicable después de que
   scrolleó hacia arriba).
2. Antes de mandar el form (texto o dictado), si hay `opcionesPendientes`
   y lo que se va a enviar resuelve a un atajo válido, se reemplaza por
   el `label` y se limpia `opcionesPendientes` — mismo round-trip que un
   click, sin uno nuevo.
3. No aplica si hay una imagen adjunta (se interpreta como texto/caption
   literal, no como atajo).
4. Placeholder del input en modo escucha ahora distingue: "Escuchando:
   decí el número de la opción..." cuando hay una lista pendiente, en
   vez del genérico "Escuchando...".
5. Pista visual bajo la lista de botones ("También podés escribir o
   decir el número de la opción"), con estilo nuevo
   `.chat-asistente-opciones-pista` en `chat-widget.css` (texto chico y
   apagado, siguiendo el mismo patrón que `.chat-asistente-adjunto-nombre`).

## Tests

`tests/frontend/chat-widget-voz.test.js` — 8 casos nuevos para
`resolverAtajoOpcion` (14 asserts): número solo, los 5 prefijos de
dictado, espacios/mayúsculas, fuera de rango, texto que no es un atajo
("2 kilos de asado", "el segundo" no cuentan), sin opciones pendientes,
texto vacío. 17 tests en total en el archivo (9 de Fase 4 + 8 de esta
fase), todos verdes.

## Resultado

Suite de frontend verificada tras el cambio: **11 archivos / 65 tests,
sin regresiones.**
