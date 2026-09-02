# v477 — Fix: botón "Ver catálogo" (panel admin) abría el catálogo vacío

## Problema
El botón "Ver catálogo" del panel admin abría `/cliente/catalogo?empresa_id=...`
en una pestaña nueva, pero la página quedaba sin productos. La función
`verCatalogoCliente()` (frontend/admin/js/clientes.js) daba por hecho el
comportamiento previo a SEC-008: "el catálogo público no requiere sesión,
alcanza con `?empresa_id=`".

Desde SEC-008 (migración `292_fix_sec008_gate_catalogo_publico`, CHANGELOG_v296)
ese modo sin-login es opt-in por empresa (`config.catalogo_publico_habilitado`).
Como ninguna empresa real tenía el flag activado a propósito, el botón caía
siempre en el camino vacío.

## Fix
SEC-008 dejó explícitamente abierta la vía de sesión autenticada: un Bearer
token de un usuario real de la empresa sigue funcionando sin depender del
flag público, porque `resolverEmpresaCliente` (lib/handlers/stock.js) resuelve
`empresa_id` desde `usuarios.empresa_id` cuando hay token válido, sin distinguir
rol. El dueño/admin ya es un usuario autenticado de su propia empresa, así que
alcanza con que el catálogo reciba su `access_token`.

**1) `frontend/admin/js/clientes.js` — `verCatalogoCliente()`**
Ahora es `async`: obtiene `session.access_token` del admin (`sb.auth.getSession()`)
y lo agrega a la URL como `#preview_token=...` — en el fragmento (`#`), no en
el query string, para que nunca viaje al servidor (no queda en logs de
Vercel/Supabase ni en el header `Referer`). Si por algún motivo falla la
obtención de la sesión, abre igual en modo público (`?empresa_id=`) como
fallback silencioso — mismo comportamiento roto que antes, pero nunca peor.

**2) `frontend/cliente/catalogo.html`**
- Lee `#preview_token=` del hash al iniciar, y limpia la URL de inmediato con
  `history.replaceState` (no queda visible en la barra ni en el historial del
  navegador).
- Si hay `previewToken`, lo usa tal cual como `accessToken` — sin intentar
  resolver un `cliente_id` de perfil, porque el admin no es un cliente real y
  no debería serlo.
- Muestra un banner ("👁 Vista previa — así ve el catálogo un cliente de tu
  empresa") para que quede claro que no es la sesión de un cliente logueado,
  aunque los datos (precios, stock, categorías) sean exactamente los mismos
  que vería uno.
- Si el admin intenta "Agregar al carrito" en modo preview, el comportamiento
  existente (`agregarAlCarrito`: redirige a `/cliente/login` si `clienteId` es
  `null`) se mantiene sin cambios — correcto, porque el admin no tiene
  carrito propio.

## Por qué no se tocó el gate SEC-008
El fix no reabre ni relaja el gate de catálogo público: ese camino
(`?empresa_id=` sin token) sigue exigiendo el flag opt-in exactamente igual
que antes. Este fix usa la otra vía, ya existente y sin cambios desde v296:
sesión autenticada real, que SEC-008 nunca restringió.

## Verificación
- `node --check frontend/admin/js/clientes.js` → OK.
- JS embebido de `frontend/cliente/catalogo.html` (3 bloques `<script>`
  extraídos) → `node --check` OK.
- Revisado `resolverEmpresaCliente`: con Bearer token válido resuelve
  `empresa_id` desde `usuarios.empresa_id` sin filtrar por rol — confirma que
  el token del admin es aceptado igual que el de un cliente autenticado.
- Confirmado que el flujo público (`?empresa_id=` sin token) no fue tocado:
  sigue exigiendo `catalogo_publico_habilitado = true`.

## Pendiente (no incluido en esta versión)
- Ídem v296: agregar un toggle en `Configuración` del panel admin para activar
  `catalogo_publico_habilitado` por empresa sin tocar SQL directo — sigue sin
  hacerse.
