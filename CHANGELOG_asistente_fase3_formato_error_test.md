# Fase 3 (robustez conversacional): test unitario del formato único de error

## Estado encontrado

`lib/asistente-tools/_respuestas.js` ya estaba completamente implementado:
centraliza las 3 formas reales que toma un error de tool del asistente:

1. `faltaDato(campo, ejemplo)` — el usuario nunca dio ese dato.
2. `ambiguo({ tipo, texto, candidatos, campoNombre, sugerenciaExtra })` —
   varios candidatos, ninguno se destaca; cuelga `.opciones` (máx. 5,
   `{id, label}`) para que el frontend pinte botones tappable.
3. `bloqueado(motivo, salida)` — la acción es válida pero no se puede
   ejecutar ahora; explica la causa y da la salida.

`armarErrorDesambiguacion` en `_helpers.js` es un alias directo de
`ambiguo()` (se mantiene el nombre viejo por los ~13 call sites que ya lo
usaban) y `faltaDato`/`bloqueado` ya estaban re-exportados desde ahí para
que los 16 archivos de tools por dominio los puedan usar sin un segundo
import.

Lo que faltaba: **un test unitario propio del módulo**. Hasta ahora
`ambiguo()` solo se ejercitaba de forma indirecta a través de
`buscarClientePorTexto()` y afines en `desambiguacion.test.js` — eso
cubre la lógica de matching (quién es candidato), no el formato de los 3
tipos de error en sí. `faltaDato()` y `bloqueado()` no tenían ningún test,
directo ni indirecto.

## Qué se agregó

`tests/asistente/fase3-formato-error.test.js` (15 tests) — prueba
`_respuestas.js` de forma aislada, sin mocks (es un módulo puro, sin
dependencias):

- `faltaDato`: mensaje base, variante con ejemplo, ausencia de `.opciones`.
- `ambiguo`: mensaje con tipo/texto/lista numerada, instrucción fija de
  "no reformules", presencia/ausencia de `sugerenciaExtra`, forma exacta
  de `.opciones` (incluyendo `campoNombre` no-default como
  `razon_social`), tope de 5 candidatos, default de `campoNombre`, y caso
  sin candidatos (array vacío o `undefined`) sin reventar.
- `bloqueado`: con y sin `salida`, ausencia de `.opciones`.

## Pendiente (fuera de este cierre, a propósito)

- Migración de los ~90 `throw new Error(...)` sueltos en las tools por
  dominio hacia `faltaDato`/`bloqueado`: el propio diseño de Fase 3 la
  deja para "al pasar" (cuando se toque cada tool por otro motivo), no de
  una sola vez. Hoy `faltaDato`/`bloqueado` están definidos y
  re-exportados pero sin ningún call site real todavía — solo `ambiguo`
  (vía `armarErrorDesambiguacion`) está en uso.
- No se encontró en este export un archivo
  `PLAN_MAESTRO_ROBUSTEZ_CONVERSACIONAL_ASISTENTE_2026.md` (referenciado
  en el comment de cabecera de `_respuestas.js`) — puede no haber sido
  incluido en este ZIP. Si hace falta como referencia futura, avisame y
  lo reconstruyo o lo pedimos aparte.

## Verificación

Suite completa corrida después del cambio: **110 archivos / 1574 tests,
sin regresiones** (incluye los 21 de Fase 1 + los 15 nuevos de Fase 3).
