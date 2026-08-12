# v596 — Fase 7, migración de `notifAuto` (_auto-push.js) y `enviarPush` (_push.js) — CERRADO

Quinto y sexto módulo del lote de migración a la capa de repos: los dos
helpers de notificaciones push que no son handlers HTTP propios (el prefijo
`_` los excluye del conteo de Serverless Functions de Vercel), pero que
tenían acceso directo a Supabase repartido por todos lados.

## Qué se hizo

### `_auto-push.js` (notifAuto)

Antes recibía `sb` como primer parámetro, y cada uno de los 13 callers
(migracion.js, score.js, stock.js, stock-auto.js ×3, pedidos.js ×2,
cierre.js, rutas-live.js, piloto.js ×2, auditoria.js) le pasaba su propia
instancia de cliente (`sb`, `db` o `supabase` — todas apuntando al mismo
backend). Se cambió la firma a `notifAuto(empresa_id, { tipo, ... })`, sin
cliente — usa el singleton `db` internamente vía `NotifRepo`. Se
actualizaron los 13 call sites (mecánico, bajo riesgo).

**`lib/repos/notif.js`** — 3 funciones nuevas:

- `obtenerPrefsAuto(empresa_id, tipo)` — reemplaza el `.select(tipo)`
  dinámico contra `notif_prefs_auto`.
- `listarTokensPushDeUsuarios(usuario_ids)` — tokens VAPID de un batch de
  usuarios (mismo `.limit(30)` defensivo del original).
- `desactivarDispositivoPushPorEndpoint(endpoint)` — baja lógica por
  endpoint (no por token+usuario: acá solo se conoce el endpoint que
  rebotó al mandar el webpush).

`listarAdminsDueno` ya existía (lote 1) y cubría exactamente lo que
necesitaba el paso 2 (`campos: 'id'`), así que no se dupicó.

### `_push.js` (enviarPush y notificadores)

Mismo criterio: se sacó el cliente Supabase propio
(`crearClienteSupabaseLazy`) del módulo, todo pasa por `NotifRepo`.

**`lib/repos/notif.js`** — 4 funciones nuevas:

- `obtenerTokensPushDeUsuario(usuario_id)` — dispositivos FCM activos de un
  usuario (devuelve `{ data, error }`, `enviarPush` distingue en el log si
  no había dispositivos porque falló la query o porque no había ninguno).
- `obtenerEmpresaIdDeUsuario(usuario_id)` — resuelve `empresa_id` cuando
  `logMeta` no lo trae (2 sitios idénticos en el original).
- `listarClientesActivosDeEmpresa(empresa_id)` — usuarios de portal con rol
  `cliente` activos, para `notificarOfertaRelampago`.
- `obtenerUsuarioPorClienteId(cliente_id)` — usado por los 4 notificadores
  dirigidos a un cliente puntual (deuda vencida, pedido entregado, puntos
  ganados, pedido en camino), todos con el mismo select exacto en el
  original.

Firebase Admin (init perezoso, bump v14) y el envío por `webpush`/FCM no se
tocaron — son ajenos a la capa de datos.

## Verificación

- `node --check` en todos los archivos tocados.
- Suite completa (`vitest run`): 779 tests pasan (incluye
  `tests/repos/notif.test.js` y `tests/repos/stock-auto.test.js`). Los 6
  fallos restantes son preexistentes y ajenos a este cambio (faltan
  `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` en el entorno de test para
  `lib/repos/admin.js`, no tocado acá).
