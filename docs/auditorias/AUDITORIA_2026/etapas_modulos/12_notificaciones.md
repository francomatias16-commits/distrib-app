# Etapa 12 — Notificaciones (push/email/WhatsApp) fuera de pedidos

**Estado:** 🟢 Auditoría completa, Hallazgos 1 y 2 corregidos en código
(2026-07-13). 3 hallazgos: 1 baja (era media — falso positivo parcial,
la notificación ya existía y funcionaba; solo faltaba el toggle en el
panel, ya agregado), 1 baja-media corregida (se implementó el reenvío
manual de emails que la ayuda prometía — el diagnóstico real fue más
profundo que "falta un botón": 3 de 4 tipos de email ni siquiera
logueaban sus fallas), 1 nota menor de precisión en la ayuda (pendiente,
es solo texto). Cambios de esta pasada: `frontend/admin/automatizacion.html`
(Hallazgo 1) + logueo de emails en `pedidos.js`/`proveedores.js`/`notif.js`,
endpoint nuevo `reintentar-email`, botón en `notif-log.js`, migración 316
(Hallazgo 2).

Alcance revisado: registro/baja de dispositivos push, preferencias
automáticas por empresa (`notif_prefs_auto`), envío de push por evento,
historial combinado de notificaciones (`notif_log` + `email_log`), contra
`docs/ayuda/notificaciones-push-y-email.md`.

## Hallazgo 1 (CORREGIDO 2026-07-13) — El push de anomalías sí existe; faltaba el toggle en el panel
🟢 Baja (era 🟡 Media — bajado de severidad tras revisión)

**Corrección sobre la pasada anterior:** el hallazgo original decía que el
aviso de anomalías nunca se enviaba, solo se veía en un dashboard. Eso fue
un falso positivo — el grep de esa pasada solo revisó
`lib/handlers/automatizacion.js` (que en efecto solo expone
`getEstadoAuditoria()`, de lectura bajo demanda) y no encontró
`lib/handlers/auditoria.js`, un handler aparte que sí implementa el motor
completo:

- `supabase/migrations/070_auditoria_anomalias.sql` agrega la columna
  `notif_prefs_auto.auditoria_anomalia` (default `TRUE`), con el mismo
  patrón que los otros 5 motores.
- `lib/handlers/auditoria.js` → `detectarYNotificar()` llama a
  `notifAuto(sb, empresa_id, { tipo: 'auditoria_anomalia', ... })`
  (`_auto-push.js`), que respeta esa columna.
- `vercel.json` registra el cron `/api/auditoria?accion=analizar` corriendo
  todas las noches a las 4am (`"schedule": "0 4 * * *"`).
- El cron acota la ventana a 1 día (`diasLookback = esInterno ? 1 : 7`)
  específicamente para no re-avisar la misma anomalía noche tras noche —
  la ventana de 7 días es solo para la vista manual del dashboard, que no
  dispara push. Esto ya resuelve, con otro mecanismo, lo que iba a pedirle
  al usuario como "criterio de cooldown".
- No filtra por severidad para decidir si avisa o no (avisa ante cualquier
  anomalía nueva en la ventana), pero sí lo refleja en el texto del push:
  título "Anomalía detectada" si hay alguna de severidad alta, "Posible
  anomalía detectada" si no.

**Lo que sí faltaba, y ya se corrigió en esta pasada:** la migración 070
dice explícitamente que la columna es *"para que el dueño pueda apagar el
aviso push de este motor desde el panel, igual que los otros 5"*, pero
`frontend/admin/automatizacion.html` nunca tenía el checkbox
correspondiente en `#push-prefs` — de los 6 motores documentados en la
ayuda, "anomalía detectada" era el único sin toggle visible (aunque la
notificación en sí ya funcionaba, con el default `TRUE`). Se agregó el
`<label class="pref-toggle">` con `id="pref-auditoria_anomalia"`, mismo
patrón que los demás (usa `guardarPref()` genérico, que ya funciona por
`id.replace('pref-', '')` sin necesitar cambios de JS).

**Nota aparte (no es parte de este hallazgo, no se tocó):** ninguno de los
8 checkboxes de `#push-prefs` carga su estado real desde el backend al
abrir la página — todos quedan `checked` por HTML estático y solo se
actualizan al tocarlos. Es un problema preexistente que afecta a los 8 por
igual, no específico de este hallazgo; si se quiere corregir, es agregar
un GET a `push-prefs` en `automatizacion.js` (frontend) que setee
`.checked` de cada input al cargar.

## Hallazgo 2 (CORREGIDO 2026-07-13, ver CHANGELOG_v316) — La ayuda promet­ía reintentar manualmente un email fallido; ahora existe esa función

🟢 Corregido — era 🟡 baja-media (documentación / feature faltante)

**Corrección sobre la pasada anterior:** el hallazgo original decía que
faltaba el botón de reenvío y sugería que agregarlo sería "relativamente
simple para `email_log`, ya que el payload/asunto/destinatario quedan
guardados". Al implementarlo se encontró que el problema real era más
profundo: de los 4 tipos de email del sistema, **solo 1 de 4
(`confirmacion_pedido`) dejaba rastro cuando fallaba** — el resto no
tenía nada que reintentar porque las fallas nunca llegaban a
`notif_log`:

- `notificarDespachoPorEmail()` descartaba el resultado del envío por
  completo, sin loguear ni éxito ni falla.
- El insert de `recepcion_proveedor` mandaba una columna `resend_id` que
  no existe en `notif_log` (la real es `message_id`) — el insert fallaba
  en silencio porque no se revisaba el `error` de la respuesta. Cero
  filas de este tipo en producción.
- `handleEstadoCuenta()` logueaba en `email_log` (tabla legada sin
  columnas `entregada`/`motivo`) y solo cuando el envío tenía éxito — el
  `return res.status(502)` cortaba el flujo antes de llegar al insert en
  la rama de falla.

También se encontró que `notif_log.entregada` y `notif_log.motivo`
existen en la base real de producción pero nunca se agregaron con una
migración versionada — se aplicaron a mano en algún momento y el repo
había quedado inconsistente. Se agregó la migración 316 para
documentarlas (`IF NOT EXISTS`, no rompe nada).

**Implementado:** se corrigieron los 3 puntos de logueo, se agregó
`POST /api/notif/reintentar-email` (rol dueño/admin) que reconstruye el
email desde datos frescos y lo reenvía, y un botón "Reintentar" en el
panel de historial para las filas de email fallidas de los 4 tipos.
Push/WhatsApp quedan fuera de este alcance (el hallazgo original era
específicamente sobre email). Ver `CHANGELOG_v316_hallazgo2_reintento_manual_emails.md`
para el detalle completo.

## Hallazgo 3 — La ayuda dice "si se entregó correctamente"; el sistema solo sabe si el envío fue aceptado
🟢 Baja (precisión de documentación, no es un bug)

La ayuda dice que cada email queda registrado *"incluyendo si se entregó
correctamente"*. En la práctica, `email_log.resend_id` se completa cuando
Resend (el proveedor de envío) **acepta** el envío — no hay webhook de
Resend integrado que confirme entrega real al buzón, rebote o marcado
como spam. El propio código de `notif-log.js` es honesto con esto: la UI
etiqueta la fila como **"Enviado"**, no "Entregado" (ver comentario en
`normalizarFilaEmail`), así que no hay engaño de cara al usuario en la
pantalla — el desfasaje está solo en el texto de la ayuda, que es un poco
más optimista que lo que el sistema puede garantizar hoy.

**Sugerido:** cambiar "si se entregó correctamente" por "si el envío fue
aceptado por el proveedor de correo" en la ayuda; o, si se quiere tener
estado de entrega real, integrar el webhook de eventos de Resend
(`delivered`/`bounced`/`complained`) — eso sí sería un cambio de código,
no solo de texto.

## No se encontraron problemas en
- Registro/baja de dispositivos push (incluye marcado automático como
  inactivo cuando el token expira, y baja explícita acotada al propio
  usuario — no se puede desregistrar un dispositivo ajeno adivinando el
  endpoint).
- Las otras 5 preferencias automáticas (piloto, cliente bloqueado, error
  de cola, quiebre de stock, orden de compra automática, caída de score):
  todas tienen su columna en `notif_prefs_auto` y su disparo real
  verificado en el handler correspondiente.
- El historial combinado (`notif_log` + `email_log`) — se corrigió en una
  auditoría anterior (etapa 15, ya reflejada en el propio código con
  comentarios `FIX (auditoría 2026, etapa 15, ...)`) el problema de que
  los emails de factura no aparecían en el historial; verificado que
  sigue funcionando.

## Pendiente
- Hallazgo 1: ✅ corregido (toggle agregado) — pendiente `git push`/deploy
  a Vercel para que el checkbox aparezca en producción. Sin migración SQL
  nueva (columna ya existía).
- Hallazgo 2: ✅ corregido (reenvío manual implementado para los 4 tipos
  de email) — pendiente `git push`/deploy a Vercel + aplicar la migración
  316 en la base real.
- Hallazgo 3: ajuste de texto en la ayuda (trivial) u opcionalmente
  integrar webhook de Resend (más trabajo, no crítico).
- Nota aparte (no numerada como hallazgo): los 8 toggles de `#push-prefs`
  no cargan su estado real al abrir la página — ver detalle en Hallazgo 1
  arriba.
