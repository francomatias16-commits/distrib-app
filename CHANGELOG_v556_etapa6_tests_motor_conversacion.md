# v556 — Etapa 6 (WhatsApp bidireccional): cobertura de tests del motor de conversación

Sigue a v555 (fix de push en `derivar_humano`). Repasando el resto del
checklist de `PLAN_whatsapp_bidireccional_seguimiento.md` (Etapa 6, "Plan de
pruebas guiado"), se audita el código de cada caso restante y se agrega la
cobertura automática que faltaba — hasta esta entrega `procesarMensajeTexto`
y `procesarMensajeNoSoportado` (la máquina de estados completa del asistente)
no tenían ningún test, sólo lo tenían `crearPedidoDesdeItemsWhatsapp` (el
motor de precios/stock) y, desde v555, las tools de
`whatsapp-pedido-tools.js`.

## Auditoría de código (sin bugs nuevos encontrados)

Se revisó línea por línea cada caso del checklist buscando el mismo tipo de
gap que apareció con `derivar_humano` en v555:

- **Pedido simple**: el empalme `agregar_item` (arma `{producto_id, nombre,
  cantidad, precio}`) → `confirmarPedidoWhatsapp` → `crearPedidoDesdeItemsWhatsapp`
  es consistente; el campo `precio` del borrador no se usa ahí (el precio se
  re-resuelve siempre contra `resolver_precios_cliente`), lo cual es correcto
  — evita que un precio viejo en el borrador quede firme si cambió mientras
  el cliente decidía.
- **Corte por exceso de turnos**: el conteo es por conversación (se resetea
  al cerrarse/crearse una nueva), coherente con el diseño.
- **Arrepentirse a mitad de camino**: al cancelar, el borrador se vacía y NO
  se toca `pedido_creado_id` — no queda ningún rastro de un pedido a medio
  armar.
- Sin hallazgos para agregar a esta entrega — el foco pasó a cerrar la
  brecha de tests.

## Código

- **`lib/handlers/notif.js`**: se exportan `procesarMensajeTexto` y
  `procesarMensajeNoSoportado` (antes internas) para poder testearlas
  directamente — mismo criterio que ya se había usado con
  `crearPedidoDesdeItemsWhatsapp` ("plan 3.2"). Sin cambios de
  comportamiento.

## Tests

- **Nuevo** `tests/handlers/whatsapp-motor-conversacion.test.js`. Mockea
  `lib/supabase-lazy.js` (con colas de respuestas por tabla, ya que varias
  funciones consultan `whatsapp_conversaciones` con distintos propósitos en
  una misma corrida), `lib/demo-mode.js` (fuerza `esEmpresaDemo` a `true`
  para que `enviarTextoWhatsApp` tome el camino simulado y no dispare fetch
  real a Meta ni necesite credenciales — no es lo que se prueba acá) y
  `lib/handlers/_push.js`. Cubre:
  - **Cliente no identificado**: no responde nada ni deriva si el teléfono
    no matchea ningún cliente de ninguna empresa.
  - **Reintento de Meta / mensaje duplicado**: corta el flujo apenas
    `registrarMensaje` choca contra el unique de `wa_message_id`, sin seguir
    de largo.
  - **Arrepentirse a mitad de camino**: contestar "cancelar" en
    `esperando_confirmacion` vacía el borrador y vuelve a `activa`, sin
    avisar a nadie (no es una derivación).
  - **Corte por exceso de turnos**: más de `MAX_TURNOS_SIN_CONFIRMAR` (8)
    mensajes sin confirmar deriva y avisa por push con el motivo correcto.
  - **Mensaje no soportado**: un tipo distinto de `text` (ej. `image`)
    deriva y avisa por push, sin intentar interpretarlo con el asistente.
- **Suite completa: 69/69** (64 previos + 5 nuevos).

## Qué NO se hizo en esta entrega

- No se agregó test end-to-end para "Pedido simple" ni "Stock insuficiente"
  como flujo completo de WhatsApp (búsqueda → agregar → proponer →
  confirmar) — ya están cubiertos por separado en
  `whatsapp-pedido-borrador.test.js` (motor de precios/stock) y
  `whatsapp-pedido-tools.test.js` (tools), y armar el mock completo de la
  respuesta del asistente de IA (`responderConFallback`) para un test
  end-to-end de ese tamaño no pareció necesario dado que los dos tramos ya
  están probados por separado.
- Los 8 casos del checklist de Etapa 6 siguen figurando como pendientes de
  probar contra Meta real con el número de prueba de la Etapa 1 — esta
  entrega es cobertura automática, no reemplaza esa prueba manual.
