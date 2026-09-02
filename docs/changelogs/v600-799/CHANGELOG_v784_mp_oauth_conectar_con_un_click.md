# v784 — Conectar Mercado Pago con un click (OAuth)

## Motivo
Hasta ahora conectar Mercado Pago exigía que el dueño de cada empresa
cliente entrara al panel de desarrolladores de MP, creara una
"aplicación" y pegara el Access Token a mano (`guardarConfigMP`) —
fricción técnica real para un usuario no técnico. Se agrega un botón
"Conectar con Mercado Pago" que hace todo el flujo OAuth en un click,
sin sacar la opción manual (queda como alternativa, colapsada en un
`<details>`).

## Cambios

### DB (`supabase/migrations/497_mp_oauth_columnas.sql`, ya aplicada)
`integraciones_pago` suma `refresh_token` (cifrado, igual criterio que
`access_token`), `token_expires_at` y `conectado_via` (`manual` por
default, `oauth` para las nuevas). Las filas existentes no se tocan.

### `lib/handlers/pagos.js`
- **`mpOauthIniciarHandler`** (`GET _svc=oauth-iniciar`, requiere
  sesión dueño/admin): arma la URL de autorización de MP con un
  `state` firmado (HMAC, mismo criterio que `verificarFirmaMP`) que
  encapsula `empresa_id`/`user_id`/vencimiento a 10 min, y la devuelve
  en JSON para que el frontend redirija.
- **`mpOauthCallbackHandler`** (`GET _svc=oauth-callback`, público —
  lo pega MP directo en el browser, sin Authorization header): valida
  el `state`, canjea el `code` por `access_token`/`refresh_token` en
  `https://api.mercadopago.com/oauth/token`, guarda todo cifrado con
  `conectado_via='oauth'` y redirige de vuelta al panel con
  `?oauth=ok` o `?oauth=error&msg=...`.
- **`obtenerAccessTokenMPValido(integracion)`**: punto único de
  lectura del access_token para las 6 llamadas a la API de MP
  (crear preferencia, QR del POS ×3, polling, webhook). Para
  conexiones manuales se comporta igual que antes
  (`descifrar(integracion.access_token)`); para conexiones OAuth,
  si al token le quedan menos de 5 min refresca solo contra
  `grant_type=refresh_token` antes de devolverlo, evitando que el
  cobro falle silenciosamente cuando venza (~180 días).
- Reemplazados los 6 sitios que llamaban a `descifrar(...)` directo
  por este helper.

### `lib/repos/pagos.js`
- `obtenerIntegracionMPAccessToken` ahora trae también
  `refresh_token`/`token_expires_at`/`conectado_via` (antes solo
  `access_token`), necesarios para que `verificarPago` pueda refrescar.
- Nueva `actualizarTokensOAuthMP(empresa_id, datos)` para persistir el
  resultado de cada refresco.
- `obtenerConfigIntegracionMP` suma `conectado_via` al select (lo usa
  el panel para mostrar cómo está conectada la cuenta).

### `vercel.json`
Nuevas rutas `/api/pagos/oauth-iniciar` y `/api/pagos/oauth-callback`.

### `frontend/admin/mercadopago-config.html`
Botón primario "Conectar con Mercado Pago" arriba del formulario
manual (que pasa a un `<details>` colapsado). Al volver de MP, lee
`?oauth=ok|error` de la URL, muestra el resultado y limpia la query
string. El chip de estado ahora aclara si la cuenta está conectada
vía OAuth o con Access Token pegado a mano.

## Variables de entorno nuevas (Vercel — production y preview)
- `MP_OAUTH_CLIENT_ID` / `MP_OAUTH_CLIENT_SECRET`: de la app creada en
  el panel de desarrolladores de MP (una única app, no por empresa
  cliente — la crea quien administra la cuenta de Mercado Pago de MF
  Web Solutions).
- `MP_OAUTH_REDIRECT_URI` (opcional): si no se define, se arma sola
  como `${API_URL || APP_URL}/api/pagos/oauth-callback`. Tiene que
  coincidir EXACTO con el redirect_uri configurado en la app de MP.
- `MP_OAUTH_STATE_SECRET` (opcional): secreto para firmar el `state`.
  Si no se define, se cae a `SUPABASE_SERVICE_ROLE_KEY` (ya presente
  en todo despliegue) — funciona igual, pero se puede fijar uno
  dedicado si se prefiere no reusar la service role key para esto.

## Pendiente antes de poder usarlo en producción
1. Crear la app en https://www.mercadopago.com.ar/developers/panel/app
   (o la que ya se haya creado para el flujo manual, si soporta OAuth)
   y cargar el redirect_uri exacto:
   `https://<dominio-prod>/api/pagos/oauth-callback`.
2. Configurar `MP_OAUTH_CLIENT_ID`/`MP_OAUTH_CLIENT_SECRET` en Vercel.
3. Probar el flujo end-to-end contra una cuenta de test de MP antes de
   habilitarlo con cuentas reales.

## Sin confirmar todavía
No se probó contra la API real de MP (sin salida de red hacia
`api.mercadopago.com` desde este sandbox) — falta validar el
intercambio `code → token` y el refresco `refresh_token → token`
contra credenciales reales una vez creada la app.
