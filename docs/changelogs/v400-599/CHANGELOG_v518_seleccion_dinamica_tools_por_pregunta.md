# v518 — Selección dinámica de tools por pregunta (Groq/OpenRouter)

## Pedido

Seguimiento directo del v517: quedó documentado como pendiente que
dueno/admin seguían viendo las 68 tools sin importar el filtro por rol
(porque su `roles` las incluye casi todas), y el esquema solo, para esos
roles, ya superaba el límite de 12.000 TPM de Groq. CLAY pidió una
respuesta directa: ¿se puede resolver de verdad o no? Se confirmó que sí y
se implementó en el momento.

## Cambios

### `lib/asistente-tools.js`

- `palabrasSignificativas(texto)` / `raizAproximada(palabra)`: normalizan
  un texto a una lista de palabras clave (sin tildes, sin stopwords, con
  una heurística simple de plural→singular) para poder comparar la
  pregunta del usuario contra nombre+descripción de cada tool.
- `seleccionarToolsRelevantes(toolsDelRol, pregunta)`: puntúa cada tool del
  rol por coincidencia de palabras clave con la pregunta (match en el
  `name` pesa 3x, match en la `description` pesa 1x), ordena por score y
  devuelve como máximo `TOOLS_MAX_PROVEEDOR_TPM_CHICO` (20). Si ninguna
  tool matchea nada (pregunta genérica tipo saludo), cae a
  `TOOLS_NUCLEO_FALLBACK`, una lista curada de ~15 tools de consulta más
  pedidas — para no dejar al asistente sin ninguna herramienta en ese caso.
- `esquemaParaOpenAI(rol, pregunta)`: ahora acepta `pregunta` opcional.
  Si viene, arma el esquema solo con `seleccionarToolsRelevantes(...)` en
  vez del catálogo completo del rol. Si no viene (compatibilidad hacia
  atrás), se comporta igual que antes del v518.
- `esquemaParaGemini(rol)` queda SIN CAMBIOS — Gemini no tiene el problema
  de tamaño (su falla observada era 429 de cuota diaria, no un límite de
  tokens por request), así que sigue recibiendo el catálogo completo del
  rol. Reducirle tools ahí no arregla nada y sí le saca capacidad real.

### `lib/handlers/asistente.js`

- Se pasa `pregunta` a `esquemaParaOpenAI(perfil.rol, pregunta)` — antes
  solo `perfil.rol`.

## Resultado medido (mismos preguntas de prueba, rol `admin`)

| pregunta                                                    | tools antes (v517) | tools ahora | tokens aprox. antes | tokens aprox. ahora |
|---------------------------------------------------------------|---:|---:|---:|---:|
| "Dame una lista de los productos ... pedidos pendientes" (caso real reportado) | 68 | 20 | ~13.860 | ~4.084 |
| "cuanto le debo al proveedor Molinos"                          | 68 | 18 | ~13.860 | ~3.877 |
| "que cheques estan por vencer"                                 | 68 |  5 | ~13.860 |   ~662 |
| "hola como estas" (sin match → set núcleo)                     | 68 | 15 | ~13.860 | ~2.228 |

En el caso real reportado por Marina Torres (rol admin, "dame una lista de
los productos... de los pedidos pendientes"), el esquema elige primero
`listar_pedidos_pendientes` y `contar_pedidos_pendientes` — las tools
correctas — y el total (esquema + system prompt + hasta 3 artículos de
ayuda + historial) queda cómodo por debajo del límite de 12.000 TPM de
Groq.

## Riesgo residual (no eliminado del todo, sí muy improbable)

El matching es por palabras clave, no semántico — una pregunta redactada
de forma muy indirecta, sin ninguna palabra en común con el nombre/
descripción de la tool que necesita, podría no seleccionarla (cae al set
núcleo, que no cubre las 68). Igual de improbable, pero technically
posible: una pregunta con MUCHAS palabras clave distintas podría llegar a
los 20 tools tope y aun así, sumado a un historial largo + 3 artículos
grandes, superar el límite — mucho menos probable que antes (de "siempre
pasa para admin" a "caso extremo"), pero no matemáticamente imposible sin
un chequeo de tokens real antes de mandar la request (no implementado acá).

## Archivos modificados

- `lib/asistente-tools.js`
- `lib/handlers/asistente.js`
