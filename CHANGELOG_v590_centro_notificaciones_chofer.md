# v590 — Centro de notificaciones: último portal que faltaba (chofer)

Continuación de `CHANGELOG_v589_fix_cron_hobby_eventos_reprocesar.md` y
`CHANGELOG_v550_fase4_rls_notif_log_y_centro_notificaciones.md`. Cierra el
punto que ese último dejó abierto: **admin, cliente y proveedor ya tenían
historial de notificaciones — chofer era el único portal sin ninguna**.

## Por qué se había dejado afuera en v550

En ese momento no existía ningún push logueado con destino a un chofer en
`notif_log`, así que agregar una página ahí hubiera mostrado una lista
vacía siempre — no una feature, un cascarón.

Eso ya no es así: `pushChoferHandler` (aviso de "ruta asignada") llama a
`enviarPush(chofer_id, ...)` con `logMeta`, y `enviarPush` **siempre**
loguea en `notif_log` cuando recibe `logMeta` — guarda `usuario_id` en el
`payload` jsonb. El caso de uso ya existe en el código; solo faltaba
exponerlo.

## Qué se hizo

- **`supabase/migrations/434_notif_log_usuario_id_columna_y_rls_chofer.sql`**
  — estaba escrita como borrador sin numerar (`notif_log_usuario_id_columna_y_rls_chofer.sql`),
  se renombra a la numeración correlativa para quedar lista para aplicar.
  Agrega la columna real `usuario_id` (antes solo vivía dentro del
  `payload` jsonb), la backfillea desde ahí, indexa
  `(usuario_id, tipo, created_at)` y reemplaza la política
  `notif_log_select_unificada` para sumar el caso `chofer`: solo ve filas
  donde `usuario_id = auth.uid()`, mismo criterio de aislamiento que ya
  tienen `cliente` (por `cliente_id`) y staff (por `empresa_id`).
  **Pendiente de aplicar contra la base real** — no se ejecutó en esta
  entrega, solo se dejó lista (mismo criterio que toda migración de este
  repo: se aplica en un paso aparte, no junto con el código).
- **`frontend/chofer/notificaciones.html`** (nuevo) — mismo patrón que
  `cliente/notificaciones.html`: lee `notif_log` directo con `supabase-js`
  y confía en la RLS de la migración 434 para el filtrado (no manda
  `.eq('usuario_id', ...)` a mano, mismo motivo que la versión cliente:
  si el día de mañana cambia cómo se resuelve la identidad, la política
  de la base sigue mandando). Simplificado respecto a la de cliente: no
  necesita resolver `cliente_id` (el chofer *es* directamente el
  `usuario_id`), y el mapa de tipos arranca con uno solo
  (`ruta_asignada`, único logueado hoy) — queda abierto para sumar tipos
  nuevos (ej. "cambio de entrega") sin tocar el resto de la página.
- **`frontend/chofer/index.html`** — botón nuevo en el topbar (ícono de
  reloj, junto al de activar push y el de salir) que linkea a
  `/chofer/notificaciones`.
- **`vercel.json`** — rewrite de ruta limpia `/chofer/notificaciones`
  (mismo criterio que `/cliente/notificaciones` en v550), agregado antes
  del catch-all `/chofer/(.*\.html)`.

## Estado del centro de notificaciones — los 4 portales

| Portal    | Página                              | Filtrado                          |
|-----------|--------------------------------------|------------------------------------|
| Admin     | `admin/notif-log.html`               | staff, por `empresa_id`            |
| Cliente   | `cliente/notificaciones.html`        | RLS por `cliente_id` propio        |
| Proveedor | sección en `proveedor/portal.js`     | server-side, por token de la URL   |
| Chofer    | `chofer/notificaciones.html` (nuevo) | RLS por `usuario_id` propio (434)  |

## Testing

- `vercel.json` validado como JSON.
- `frontend/chofer/notificaciones.html` y `frontend/chofer/index.html`:
  tags `<div>`, `<button>` y `<a>` balanceados.
- Suite completa: **689/689 tests pasaron** (30 archivos). Sin tests
  unitarios nuevos — mismo criterio que `cliente/notificaciones.html`, que
  tampoco los tiene (es un fetch directo a Supabase desde el navegador).

## Qué falta para que esto funcione en producción

1. **Aplicar la migración 434** contra la base real (agrega columna +
   política nueva).
2. Verificar que el link del topbar se vea bien en el PWA instalado del
   chofer (no solo en el navegador), dado que `chofer/index.html` registra
   un service worker propio.

## Archivos tocados

- `supabase/migrations/434_notif_log_usuario_id_columna_y_rls_chofer.sql` (renombrado, sin cambios de contenido)
- `frontend/chofer/notificaciones.html` (nuevo)
- `frontend/chofer/index.html` (+4/-1)
- `vercel.json` (+4)
