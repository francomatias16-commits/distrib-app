# v1012 — WhatsApp: tab "Historial" para conversaciones cerradas (2026-08-30)

## Por qué

En el panel de conversaciones de WhatsApp, `v_whatsapp_conversaciones_activas`
excluye a propósito las conversaciones con `estado='cerrada'` (para no
ensuciar la bandeja de trabajo con charlas ya resueltas). Efecto secundario
no buscado: una vez que una conversación se cerraba, desaparecía del panel
sin dejar ningún registro visible — no había forma de rastrear a qué pedido
terminó una charla del bot, ni de llevar un historial de conversaciones ya
resueltas, aunque el dato (`whatsapp_conversaciones.estado='cerrada'` +
`pedido_creado_id`) siempre estuvo en la base.

## Supabase

- **Nueva vista `v_whatsapp_conversaciones_historial`** (`security_invoker
  = true`, misma policy RLS que `v_whatsapp_conversaciones_activas`:
  `whatsapp_conversaciones_empresa`, scopeada por `empresa_id`). Mismo shape
  que la vista de activas + `pedido_creado_id` (el dato que conecta la charla
  cerrada con el pedido que generó). Filtra `wc.estado = 'cerrada'` —
  complemento exacto de la vista de activas, no hay overlap entre las dos.

## Frontend — `frontend/admin/whatsapp-conversaciones.html` / `js/whatsapp-conversaciones.js`

- Nuevo tab **"Historial"** en la barra de filtros (`FiltroTabs`), junto a
  los tabs existentes de estado.
- Al seleccionarlo, la tabla deja de filtrar client-side sobre `datos`
  (que solo trae activas) y pasa a pedirle directamente a
  `v_whatsapp_conversaciones_historial` — nueva variable de módulo
  `vistaActual` (`'activas' | 'historial'`) decide de cuál vista lee
  `cargarConversaciones()`. Se agrega límite de 200 filas (orden por
  `ultima_interaccion desc`) para no traer el historial completo de una.
- Los contadores de la barra de tabs (`actualizarStats()`) siguen siendo
  solo sobre las conversaciones activas — no se recalculan mientras se está
  mirando el historial, para no pagar una query extra solo para un número
  que no es el foco de esa vista.
- Título de la tabla y header de columna cambian según la vista
  ("Conversaciones en curso" → "Historial de conversaciones", "Atención" →
  "Pedido").
- La columna que en activas muestra quién tomó la conversación
  (`badgeAtencion`), en historial muestra en cambio un link **"Ver
  pedido"** hacia `/admin/pedidos?id=...` (misma convención de deep-link
  que ya usa `pedidos.js` para abrir un pedido puntual) cuando
  `pedido_creado_id` está presente, o "Sin pedido" si la charla se cerró
  sin llegar a generar uno.
- El modal de detalle (`metaHtml`) agrega la misma línea "Pedido generado"
  con el link, además del chat completo (sin cambios ahí — mensajes se
  siguen leyendo de `whatsapp_mensajes` igual que en activas).
- Nuevo estado visual `cerrada`: entrada en `ESTADO_LABEL`/`ESTADO_ICONO`
  (ícono de check) y clase `.badge-estado.cerrada` en
  `whatsapp-conversaciones-gentelella.css` (mismo verde/teal que
  `.badge-tomada`).
- `limpiarFiltros()` y el `onChange` de los demás tabs ahora also revierten
  `vistaActual` a `'activas'` y recargan desde la vista correspondiente si
  se venía del historial (evita quedar con `datos` de cerradas cargado pero
  filtros de activas aplicados sobre eso).
- `aplicarFiltros()`: el filtro por estado y el checkbox "solo derivadas sin
  tomar" no aplican en historial (todas las filas ya vienen con
  `estado='cerrada'` desde el server) — la búsqueda por nombre/teléfono sí
  sigue funcionando en las dos vistas.

## Verificación

- Insertada y borrada una conversación de prueba real en Supabase
  (`estado='cerrada'`, 4 mensajes, `pedido_creado_id` apuntando a un pedido
  existente) para confirmar contra datos reales: la vista nueva la trae con
  `cliente_nombre` resuelto, `cant_mensajes` correcto y `pedido_creado_id`
  presente; la vista de activas la excluye (0 filas).
- Funciones puras de render (`badgeEstado`, `badgeAtencion`, `metaHtml`)
  ejecutadas en Node contra esa fila real y contra casos sin
  `pedido_creado_id` — HTML generado verificado a mano (link a
  `/admin/pedidos?id=...`, "Sin pedido", pastilla "Cerrada").
- No se corrió la suite de tests del repo (`tests/`) para este cambio —
  es puramente frontend + una vista SQL de solo lectura, sin handler ni
  lógica de backend nueva que testear con Vitest/Playwright.

## Archivos

- `supabase/migrations/` — migración `whatsapp_conversaciones_historial_view`
  (vista `v_whatsapp_conversaciones_historial`)
- `frontend/admin/whatsapp-conversaciones.html`
- `frontend/admin/js/whatsapp-conversaciones.js`
- `frontend/admin/css/whatsapp-conversaciones-gentelella.css`

## Fuera de alcance (a propósito)

- No se agregó paginación real al historial (solo el límite de 200 filas
  más recientes) — si una empresa necesita ver más atrás, es una entrega
  aparte (cursor/offset + búsqueda server-side en vez de client-side).
- No se tocó `whatsapp-conversacion-accion` ni ningún endpoint de
  escritura — el historial es de solo lectura, coherente con que
  `whatsapp_conversaciones` no tiene policy de UPDATE desde el cliente
  (migración 271).
