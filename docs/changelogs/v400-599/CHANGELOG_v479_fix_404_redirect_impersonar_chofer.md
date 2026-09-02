# v479 — Fix: "Ingresar como chofer" tiraba 404 tras el magic link

## Problema
Con el Site URL de Supabase ya corregido (apuntando a producción, no a
`localhost:3000`), el link de "Ingresar como" (impersonar chofer) redirigía
correctamente a `distrib-app-nine.vercel.app`, pero a una ruta que no existe:

```
https://distrib-app-nine.vercel.app/chofer/index#access_token=...
→ 404: NOT_FOUND
```

## Causa
`lib/handlers/chofer_invitacion.js` (`accion=impersonar`) arma el
`redirectTo` del magic link como `${baseUrl(req)}/chofer/index`. Esa ruta
nunca existió en `vercel.json` — la ruta real del panel del chofer es
`/chofer` a secas:

```json
{ "source": "/chofer", "destination": "/frontend/chofer/index.html" }
```

Aparentemente se escribió por analogía con el patrón `/admin/dashboard`,
`/cliente/catalogo`, etc., sin confirmar contra el rewrite real del portal
chofer.

## Fix
`redirectTo: `${baseUrl(req)}/chofer` en vez de `/chofer/index`.

No se tocó nada de `frontend/chofer/index.html`: el cliente de Supabase ahí
se crea sin `detectSessionInUrl: false`, así que por default (`true`) ya
detecta el `access_token`/`refresh_token` del fragmento de la URL apenas
carga la página y arranca la sesión — no hacía falta ningún cambio ahí, solo
que el link apuntara a una ruta que exista.

## Verificación
- `node --check lib/handlers/chofer_invitacion.js` → OK.
- Confirmado en `vercel.json` que `/chofer` (sin `/index`) es la única ruta
  que resuelve a `frontend/chofer/index.html`; no existe ningún rewrite para
  `/chofer/index`.
- Revisado que no haya otras referencias a `/chofer/index` en el código
  (`grep` en todo `lib/` y `frontend/` — solo aparecía en esta línea).

## Contexto (para no perder el hilo)
Esta sesión encadenó 3 causas distintas para el mismo síntoma ("Ingresar
como chofer" no funciona):
1. Site URL de Supabase apuntando a `localhost:3000` (config del proyecto,
   corregida por Ruben en el dashboard de Supabase — no requirió código).
2. `localhost:3000` coincidía por casualidad con otro proyecto local
   corriendo en la misma máquina ("PanelaApp"), lo que generó confusión
   pero no era parte del bug.
3. Esta: la ruta `/chofer/index` no existe — fix de código de este
   changelog.
