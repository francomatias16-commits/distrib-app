# v1039 — Fix check-schema: columnas de una tabla atribuidas a otra (ventana de búsqueda sin acotar) (2026-08-31)

## Por qué

Después del fix de paginación (v1038), `check-schema` bajó de 337 a 142
errores — pero varios de los que quedaban eran incoherentes: por ejemplo
`[SELECT L59] Columna 'nombre' no existe en 'refresh_tokens'`, cuando la
línea 59 de `auth.js` es un `UPDATE` (`.eq('usuario_id', ...)
.eq('revocado', false)`), sin ningún `SELECT` ahí, y `nombre` ni siquiera
es una columna que el código intenta leer de `refresh_tokens`.

## Causa

En `extractReferences()`, para cada `.from('tabla')` encontrado se
buscaba el `.select()`/`.insert()`/`.update()`/`.upsert()` más cercano
con `after.match(...)`, donde `after = src.slice(m.index)` — **el resto
del archivo completo, sin límite**. Cuando una cadena `.from()` no tenía
uno de esos métodos propio (ej. un `.from('refresh_tokens').update({
revocado: true })` sin `.select()`), el regex de `.select()` seguía
buscando cientos de líneas más abajo y encontraba el primer `.select()`
de una cadena totalmente distinta — atribuyéndole esas columnas a la
tabla equivocada. Con `auth.js` teniendo ~10 llamadas a
`.from('refresh_tokens')` en el archivo, cada una terminaba
"robándose" queries de otras tablas (`usuarios`, `empresas`,
`whatsapp_reset_codigos`) más adelante en el archivo.

## Fix

`scripts/check-schema.js` — la ventana de búsqueda (`after`) ahora se
acota al próximo `.from(` (inicio de otra cadena) o a un límite duro de
800 caracteres, lo que venga primero, en vez de al resto del archivo.

Verificado extrayendo referencias de `lib/handlers/auth.js` con la
función parcheada: las 4 tablas que aparecen (`refresh_tokens`,
`usuarios`, `empresas`, `whatsapp_reset_codigos`) ahora devuelven
exactamente sus columnas reales — confirmado 1:1 contra
`information_schema.columns` vía Supabase MCP, cero falsos positivos.

## Pendiente

No pude re-correr `npm run check-schema` completo en el sandbox (sin
`.env` con credenciales de Supabase) — verificado con un harness
standalone que aísla `extractReferences()` y la corre sobre
`auth.js` real. Falta la corrida completa contra los 193 archivos para
confirmar el conteo final de errores reales (debería seguir bajando
respecto a los 142 de la corrida anterior; lo que quede debería ser
señal real, salvo `productos-fotos`, que es un bucket de Storage).
