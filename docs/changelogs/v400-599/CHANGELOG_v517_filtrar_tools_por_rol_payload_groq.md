# v517 — Filtrar el catálogo de tools por rol antes de armar el esquema

## Pedido

Seguimiento de la investigación del v516 (mensaje de error honesto): quedaba
pendiente confirmar si el fallo real de Groq/OpenRouter en la cadena de
fallback era 100% cuota agotada (como asumía el mensaje genérico) o si había
algo más para arreglar en el código.

## Diagnóstico auditado

Se tomó un caso real de log (2026-07-31 01:03) donde los 3 proveedores
fallaron en la misma pregunta:

- `gemini`: HTTP 429, cuota diaria agotada. Legítimo, nada para arreglar.
- `groq`: HTTP 413 — `Request too large ... Limit 12000, Requested 24546`.
  **No es un problema de cuota**: es que el body de la request pesa más del
  doble del límite de tokens por minuto (TPM) del tier gratuito.
- `openrouter`: timeout a los 17000ms. Probablemente el mismo problema de
  fondo (un body más grande tarda más en procesarse en un modelo gratuito),
  aunque no se puede confirmar con la misma certeza que el 413 de Groq.

Se ejecutó `esquemaParaOpenAI()` (import real del proyecto, con los módulos
de `handlers/*` stubbeados solo para poder correrlo aislado) para medir el
tamaño real del catálogo de 68 tools tal como se manda hoy: **55.450 bytes
de JSON, ~13.860 tokens estimados — antes de sumar el system prompt, los
artículos de la base de ayuda y el historial**. Ya el catálogo solo, para un
usuario `dueno`/`admin`, pisa el límite de 12.000 TPM de Groq.

Un dato que confirma que el filtro correcto ya existía a medias:
`ejecutarTool()` (en el mismo archivo) ya rechaza en tiempo de ejecución
cualquier tool fuera de los `roles` declarados para el usuario — pero
`esquemaParaGemini()`/`esquemaParaOpenAI()` armaban igual el catálogo
completo de 68 al declarárselo al modelo, sin usar ese mismo campo `roles`.
Un `vendedor`, `contador` o `depositero` recibía en el prompt tools que
jamás iba a poder ejecutar.

## Cambios

### `lib/asistente-tools.js`

- Helper nuevo `toolsParaRol(rol)`: filtra `TOOLS` con el mismo criterio que
  ya usaba `ejecutarTool()` (`!t.roles || t.roles.includes(rol)`), pero
  ANTES de armar el esquema en vez de después.
- `esquemaParaGemini(rol)` y `esquemaParaOpenAI(rol)`: ahora reciben el rol
  y arman el esquema solo con `toolsParaRol(rol)` en vez de con `TOOLS`
  completo.

### `lib/handlers/asistente.js`

- Se pasa `perfil.rol` en ambas llamadas (`esquemaParaGemini(perfil.rol)`,
  `esquemaParaOpenAI(perfil.rol)`).

## Resultado medido (mismo método que el diagnóstico)

| rol         | tools antes | tools ahora | tokens aprox. antes | tokens aprox. ahora |
|-------------|------------:|------------:|---------------------:|---------------------:|
| dueno/admin |          68 |          68 |               ~13.860 |               ~13.860 |
| contador    |          68 |          15 |               ~13.860 |                ~2.500 |
| depositero  |          68 |          12 |               ~13.860 |                ~2.038 |
| vendedor    |          68 |          16 |               ~13.860 |                ~3.170 |

## Pendiente (no resuelto en este fix)

Para `dueno`/`admin` el catálogo filtrado sigue siendo el completo (68/68,
porque son los únicos roles con `roles` incluyendo prácticamente todo) y
sigue por encima del límite de Groq **solo con el esquema**, sin contar
system prompt + artículos + historial. Es decir: **el fallback a Groq va a
seguir fallando con 413 para dueño/admin** hasta que se aborde por separado
(catálogo reducido específico para proveedores con TPM chico, selección
dinámica de tools por la pregunta, o acortar descriptions/parameters). El
mensaje de error del v516 ("se quedó sin cupo gratuito") sigue sin ser 100%
preciso para ese caso — sigue pendiente también.

## Archivos modificados

- `lib/asistente-tools.js`
- `lib/handlers/asistente.js`
