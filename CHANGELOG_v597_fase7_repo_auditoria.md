# v597 — Fase 7, `lib/repos/audit.js` (nuevo) — CERRADO

Cierra el pendiente que quedó anotado en la cabecera de
`lib/repos/migracion.js` desde v591: *"los 2 `.from('audit_log').insert(...)`
también quedan sin migrar, a la espera de un repo de auditoría propio"*.
Al relevar el resto del código aparecieron otros 2 sitios con el mismo
problema: `proveedores.js` y `maestros.js` tenían cada uno su propia
función local `auditLog(empresa_id, usuario_id, tabla, accion, registro_id,
antes, despues)` — **idéntica carácter por carácter** entre los dos
archivos — con acceso directo a `audit_log` por fuera de la capa de repos.

## Qué se hizo

**`lib/repos/audit.js` (nuevo)** — 2 funciones, dos políticas de error
distintas porque los 3 callers originales no se comportaban igual (mismo
criterio del checklist Fase 7, punto 2: no alterar comportamiento
observable):

- `registrarAuditoria(entrada)` — insert crudo, sin try/catch. Para los 2
  sitios de `migracion.js`, que en el original tampoco atrapaban el error
  (una falla ahí puede seguir propagando, igual que antes).
- `registrarAuditoriaSilenciosa(empresa_id, usuario_id, tabla, accion,
  registro_id, antes, despues)` — best-effort con try/catch interno.
  Reemplaza uno por uno los 7 parámetros posicionales de la función local
  `auditLog` que tenían `proveedores.js` y `maestros.js` — se pudo borrar
  esa duplicación completa en los dos archivos.

`registrarAuditoriaImpersonacion` (`lib/repos/chofer-invitacion.js`, ya
existía) queda deliberadamente afuera: es un evento fijo con su propio
shape, no el logger genérico — mismo criterio que ya separa
`WhatsappBotRepo` de `NotifRepo` aunque ambos toquen tablas de notif.

**`lib/repos/index.js`** — se agregó `AuditRepo` al barrel.

**Handlers migrados:**

- `proveedores.js` — 3 call sites (alta, edición, baja de proveedor);
  función local `auditLog` eliminada.
- `maestros.js` — 3 call sites (alta, edición, baja de un maestro genérico
  vía `RECURSOS[recurso]`); función local `auditLog` eliminada, y con ella
  el único uso que le quedaba al import de `db` en ese archivo (también se
  sacó, ya no hace falta).
- `migracion.js` — 2 call sites (cierre de sesión de importación, rollback
  de migración). El comentario del fix de `audit_log_accion_check`
  (`ROLLBACK_MIGRACION` → `DELETE`, v200d) se conservó tal cual junto al
  segundo call site.

Resultado: **0** `.from('audit_log')` directos en `lib/handlers/`; toda la
tabla vive detrás de `AuditRepo` (más el caso aparte de
`chofer-invitacion.js`, ya en su propio repo desde antes).

## Tests nuevos

- `tests/repos/audit.test.js` (6 casos) — las dos políticas de error, el
  cast de `registro_id` a string, y que `datos_antes`/`datos_despues`
  queden en `null` cuando no se pasan.
- `tests/repos/notif.test.js` — se completó la cobertura que había quedado
  pendiente de los lotes 5 y 6 (v595/v596: `notifAuto` y `enviarPush`) — 12
  casos nuevos para `obtenerPrefsAuto`, `listarTokensPushDeUsuarios`,
  `desactivarDispositivoPushPorEndpoint`, `obtenerTokensPushDeUsuario`,
  `obtenerEmpresaIdDeUsuario`, `listarClientesActivosDeEmpresa` y
  `obtenerUsuarioPorClienteId`.

## Verificación

- `node --check` en todos los archivos tocados.
- Suite completa: **796/802** tests pasan (subieron de 779 con los 18 tests
  nuevos). Los 6 fallos restantes son preexistentes y ajenos a este cambio
  (falta `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` en el entorno de test
  para `lib/repos/admin.js`, no tocado en ninguna de estas dos sesiones).
