# Estado del proyecto distrib-app — loadtest etapa4

_Última actualización: 02/09/2026_

## Resuelto en esta sesión

1. **Bug de ruteo (Express 4 / `req.query`)** — arreglado en `server.js`.
   Causa: Express 4 arma `req.query` a partir de la URL original ANTES de
   correr cualquier middleware propio. Reescribir `req.url` no alcanza.
   Fix: recalcular `req.query` a mano con `qs.parse()` después de reescribir
   `req.url`. Ya está aplicado en la carpeta sincronizada con GitHub.

2. **Conexión local a Supabase** — el proyecto no usa `dotenv`; los env vars
   los inyecta Vercel en producción. Para correr local:
   ```powershell
   node --env-file=.env.local server.js
   ```
   El `.env.local` necesita como mínimo:
   ```
   SUPABASE_URL=https://jgiquzjwoedmzwqgzubr.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<pedirla en Supabase → Settings → API Keys → Legacy>
   ```
   Importante: `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY`
   están marcadas como **"Sensitive"** en Vercel → `vercel env pull` NUNCA las
   trae (ni development ni production). Hay que copiarlas siempre a mano
   desde el dashboard de Supabase, no desde Vercel.

3. **Datos de la empresa demo** (`4462586e-e11a-4d34-a405-17103bb9cf9f`) —
   ya tiene productos con stock y cajas activas. Se armó
   `scripts/seed-demo-loadtest.js` para chequear/completar esto si hiciera
   falta en el futuro (no destructivo, solo agrega lo que falte).

4. **Checkout probado bajo carga** — `npm run loadtest:etapa4` con
   `ESCENARIOS=checkout`: 0 errores, 0 timeouts, 0 5xx. Único aviso: p99 de
   latencia (~6.4s) supera el umbral interno de 5s — pendiente de revisar
   performance, no es un error funcional.

5. **POS probado bajo carga** — funciona, pero cada corrida deja un turno
   de caja abierto. Sin el reset automático (ver pendiente #1 abajo), hay
   que cerrarlo a mano antes de la próxima corrida.

## Pendiente (decisión tomada: no resolver por ahora)

- **Reset automático de la demo** (`POST /api/saas?_svc=demo-reset`) exige
  un usuario con `rol = 'superadmin'`, o `rol = 'dueno'` de la empresa
  llamada exactamente `"MF Web Solutions"` (o cuyo `empresa_id` coincida
  con `SUPERADMIN_EMPRESA_ID`, no seteada en `.env.local`).
  La cuenta usada en las pruebas (`francomatias16@gmail.com`) tiene
  `rol: "admin"` en la empresa "matias franco" — no cumple ninguna de las
  dos condiciones. Se decidió NO tocar el rol y resetear a mano por ahora.

## Pendiente de seguridad — hacer antes de seguir usando el proyecto

- **Rotar la `SUPABASE_SERVICE_ROLE_KEY`** (Supabase → Settings → API Keys
  → Legacy → "Disable JWT-based API keys" / regenerar). Quedó pegada varias
  veces en texto plano en el chat de esta sesión.
- Rotar también la password de `francomatias16@gmail.com` si se compartió
  en algún chat anterior (mencionado en sesiones previas).

## Comandos de referencia

Terminal 1 (servidor):
```powershell
$env:PORT="3000"; node --env-file=.env.local server.js
```

Terminal 2 (seed de datos demo, solo si hace falta):
```powershell
node --env-file=.env.local scripts/seed-demo-loadtest.js
```

Terminal 3 (load test):
```powershell
$env:ESCENARIOS="checkout,pos"
$env:BASE_URL="http://localhost:3000"
$env:SUPABASE_URL="https://jgiquzjwoedmzwqgzubr.supabase.co"
$env:SUPABASE_ANON_KEY="<anon key, sacar de Supabase>"
$env:LOAD_TEST_EMAIL="marina.torres@distribuidoradellitoral.com.ar"
$env:LOAD_TEST_PASSWORD="Distri123"
$env:LOAD_TEST_CLIENTE_EMAIL="543482477201@portal.distrib"
$env:LOAD_TEST_CLIENTE_PASSWORD="LoadTest2026!Cli"
$env:LOAD_TEST_SUPERADMIN_EMAIL="francomatias16@gmail.com"
$env:LOAD_TEST_SUPERADMIN_PASSWORD="<verificar password actual>"
$env:LOAD_TEST_DEMO_EMPRESA_ID="4462586e-e11a-4d34-a405-17103bb9cf9f"
npm run loadtest:etapa4
```
