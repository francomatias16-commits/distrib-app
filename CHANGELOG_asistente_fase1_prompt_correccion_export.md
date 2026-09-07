# Fase 1 (robustez conversacional): cierre de la mitad de prompt

(Nota: sin número de versión propio — este cambio es sobre
`lib/handlers/asistente.js` y tests, no toca frontend, así que no requiere
el ciclo de ZIP/deploy versionado. Se deja sin prefijo `CHANGELOG_vNNN_`
para no chocar con la numeración de `docs/changelogs/v800-984/`, que
pertenece a un plan de robustez distinto — el de escalabilidad, no el
conversacional.)

Continuación directa de la sesión anterior. El mecanismo server-side de
"corrección sin reiniciar" (`ejecutarTool`/`resolverAccionPendiente` en
`lib/asistente-tools/index.js`) ya estaba implementado y probado
(`tests/asistente/fase1-correccion-sin-reiniciar.test.js`, 10 tests). Lo
que faltaba era cerrar la mitad de **prompt**, en `lib/handlers/asistente.js`:

- `armarSystemPrompt()`: cuando hay una propuesta pendiente vigente, la
  variante `conTools` (Gemini, con function calling) recibe una nota que
  cita textualmente la herramienta y el resumen de la propuesta, para que
  el modelo la reconozca y la vuelva a llamar con el dato corregido en vez
  de reiniciar la conversación desde cero. La variante `sinTools`
  (Groq/OpenRouter, sin function calling) nunca menciona la propuesta,
  porque esos proveedores no pueden volver a invocar la tool.
- `obtenerPropuestaVigentePara()`: filtra por TTL — una propuesta ya
  vencida (`TTL_CONFIRMACION_MS`) no se ofrece para "corregir", porque ya
  no se puede confirmar y decírselo al modelo sería mentirle.

Ambas funciones ya estaban implementadas y en uso (líneas 298 y 333 de
`lib/handlers/asistente.js`); solo faltaban:

1. Exportarlas (`export { ..., obtenerPropuestaVigentePara }`) para que
   fueran testeables de forma aislada.
2. El archivo de test que las cubre:
   `tests/asistente/fase1-prompt-correccion.test.js` (11 tests) —
   verifica el contenido exacto de la nota en `conTools`, su ausencia
   total en `sinTools`, el orden relativo respecto al bloque de
   artículos de ayuda, y los 5 casos de `obtenerPropuestaVigentePara`
   (sin acción pendiente, vigente, vencida por TTL, borde del TTL, y
   fallo de consulta que no debe reventar el turno).

## Resultado

Con esto, **Fase 1 del plan de robustez conversacional queda
completamente cerrada** (mecanismo + prompt), con cobertura de test de
punta a punta: 21 tests entre los dos archivos de Fase 1.

Suite completa verificada tras el cambio: **109 archivos / 1559 tests,
sin regresiones.**

## Pendiente (fuera de Fase 1)

- Fase 3: formato único de error (mencionado en la sesión anterior,
  todavía no arrancado).
- Checklist de verificación manual sobre el mecanismo de confirmación
  (ofrecido en la sesión anterior, no confirmado si se quiere ahora).
