# v555 — Etapa 6 (WhatsApp bidireccional): fix push en derivación manual + cobertura de tests

Sigue al plan de pruebas guiado de `PLAN_whatsapp_bidireccional_seguimiento.md`
(Etapa 6). Al revisar el caso **"Derivación manual pedida por el cliente"**
del checklist se encontró que la tool `derivar_humano` nunca avisaba a nadie.

## Bug encontrado

- **`lib/whatsapp-pedido-tools.js` (`derivar_humano`)**: dejaba la
  conversación en `estado = 'derivada_humano'` pero no mandaba push — a
  diferencia de `marcarDerivada()` en `lib/handlers/notif.js` (usada para
  mensajes no soportados y el corte por exceso de turnos), que sí avisa por
  push a dueño/admin/vendedor. Un vendedor no se enteraba de que el propio
  cliente había pedido hablar con una persona hasta entrar a mirar el panel
  de conversaciones a mano.

## Fix

- `derivar_humano` ahora hace el mismo aviso que `marcarDerivada()`: busca
  `empresa_id`/`telefono` de la conversación, resuelve los usuarios con rol
  `dueno`/`admin`/`vendedor` de esa empresa, y les manda push
  (`tipo: 'whatsapp_derivado'`, link a `/admin/whatsapp-conversaciones`).
  El aviso es best-effort — si falla (o no se encuentra la conversación
  para armarlo), no rompe la derivación en sí, que ya quedó guardada por el
  `update` anterior.
- De paso, `marcarDerivada()` (`lib/handlers/notif.js`) apuntaba su link de
  push a `/admin/notif-log`, un panel que no tiene nada que ver con tomar
  la conversación derivada — se corrige a `/admin/whatsapp-conversaciones`
  (el panel real, entregado en la Etapa 5), mismo destino que ahora usa
  también `derivar_humano`.

## Tests

- **Nuevo** `tests/handlers/whatsapp-pedido-tools.test.js` — el archivo no
  tenía ninguna cobertura hasta esta entrega. Cubre las 5 tools:
  - `derivar_humano`: push a cada admin/dueño/vendedor con el motivo y
    teléfono correctos; no revienta si el push falla; no revienta si no
    encuentra la conversación para armar el aviso (sin destinatario); sí
    propaga el error si falla el `update` principal de estado.
  - `proponer_confirmacion`: rechaza con borrador vacío, pasa a
    `esperando_confirmacion` con items.
  - `agregar_item` / `quitar_item`: alta, suma de cantidad sobre producto
    existente, baja.
  - `ejecutarToolPedidoWhatsApp`: tool desconocida, falta de
    `empresaId`/`conversacionId`.
- **Suite completa: 64/64** (53 + 11 nuevos).

## Qué NO se hizo en esta entrega

- No se agregó test para `buscar_productos` (la única tool que no toca
  `whatsapp_conversaciones` sino `productos`/`stock` directamente) — se
  puede sumar en una segunda vuelta si hace falta, no estaba en el foco
  del bug de esta entrega.
- No se tocó el resto del checklist de Etapa 6 (pedido simple, corte por
  turnos, cliente no identificado, etc.) — siguen pendientes de probar
  contra Meta real con el número de prueba de la Etapa 1.
