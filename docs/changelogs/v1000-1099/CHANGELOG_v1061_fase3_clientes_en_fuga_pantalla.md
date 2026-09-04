# v1061 — Fase 3 (última), PLAN_CLIENTES_EN_FUGA.md: pantalla "Clientes en fuga"

Continuación de la sesión anterior (cortada a mitad de la Fase 3, que había
dejado listos `lib/handlers/clientes-fuga.js`, el permiso `clientes_fuga` en
`permisos-service.js` y la entrada en el router de `api/index.js`, más la
exploración de `riesgo-cheques.html/js` y `nav-data.js` como referencia de
patrón). Se retomó desde esos tres archivos sueltos y se cerró todo lo que
faltaba para que la pantalla funcione de punta a punta.

## Gap encontrado y corregido antes de seguir

`lib/handlers/clientes-fuga.js` importaba `listarClientesEnFuga` desde
`lib/repos/clientes-fuga.js`, pero esa función nunca se había escrito (el
repo solo tenía lo de Fase 2: `resolverClienteParaFuga`,
`resolverUmbralClienteGrande`, `crearTareaFuga`). Al revisar el archivo
apareció además un segundo gap **preexistente, no relacionado con esta
sesión**: `lib/handlers/notif.js` (Fase 2) ya importaba `clientesEnFugaRpc`
del mismo repo, y esa función tampoco existía — el cron de fuga
(`handleFugaCron`) iba a romper en el primer `import` en cuanto corriera de
nuevo. Se corrigieron los dos en el mismo repo:

- `clientesEnFugaRpc(empresaId, limite)` — wrapper sobre la RPC
  `fn_clientes_en_fuga`.
- `listarClientesEnFuga(empresaId, { soloVendedorId })` — la lista para la
  pantalla: llama a `clientesEnFugaRpc`, filtra "solo lo mío" para
  vendedor, y la enriquece con qué acción ya se disparó por cliente
  (2 queries batch con `.in()`, no N+1 por cliente).

## Gap de esquema: `tareas_automatizacion` no tenía cómo volver a un cliente

Para que "acción ya disparada" tenga sentido, hacía falta poder cruzar una
tarea creada por el listener con el cliente puntual al que refiere.
`tareas_automatizacion` (migración 433) no tenía esa columna — solo
`empresa_id` + `roles`/`usuario_id` genéricos. Se agregó:

- **Migración 594** (aplicada en producción, `jgiquzjwoedmzwqgzubr`):
  `tareas_automatizacion.cliente_id` (uuid, nullable, FK a `clientes`,
  `ON DELETE SET NULL`) + índice parcial. No rompe tareas existentes de
  otras reglas (quedan con `cliente_id` NULL, igual que hasta ahora).
- `crearTareaFuga()` y las 2 llamadas del listener
  (`cliente_en_riesgo_fuga.js`, caminos 1 y 2) actualizadas para pasar
  `cliente_id: cliente.id`.

`accion_disparada` que devuelve `listarClientesEnFuga` por cliente:
`'sin_accion' | 'tarea_pendiente' | 'tarea_completada' | 'whatsapp_enviado'`
(esto último resuelto contra `notif_log`, camino 3 del listener — WhatsApp
automático a cliente chico/mediano). Si hay señales de ambas fuentes para
un mismo cliente, gana la más reciente por fecha.

## Verificado contra producción antes de tocar nada

`fn_clientes_en_fuga` ya tenía el `EXECUTE` revocado correctamente para
`anon`/`authenticated` (solo `service_role` puede ejecutarla) — confirmado
con `has_function_privilege()` directo, no contra caché. El comentario del
handler (Fase 3 de la sesión anterior) sobre esto era correcto.

## Ruteo — colisión encontrada y corregida en `vercel.json`

Ya existía `{ source: "/api/clientes(.*)", destination: "/api/index?_mod=clientes" }`
**antes** en la lista de `rewrites` que cualquier regla para
`/api/clientes-fuga` que se agregara después — Vercel aplica el primer
match, así que el endpoint nuevo hubiera caído silenciosamente en el
handler de `clientes` en vez de en el propio. Se insertó
`/api/clientes-fuga → _mod=clientes-fuga` **antes** de esa regla genérica.
Se agregó también `/admin/clientes-fuga → frontend/admin/clientes-fuga.html`
(mismo patrón que el resto de las páginas admin).

## Pantalla nueva

- `frontend/admin/clientes-fuga.html` + `frontend/admin/js/clientes-fuga.js`
  — mismo esqueleto y convenciones que `riesgo-cheques.html/js` (auth,
  `getFreshToken`, `escOnclickArg`/`sanitize`, paginación "Cargar más",
  `FiltroTabs`), pero sin CSS propio: `.franja-resumen-sololectura` /
  `.dato-sello` (KPIs) y `.badge-estado`/`.badge-ok`/`.badge-warning`/
  `.badge-critico`/`.badge-info` (estado de la acción disparada) ya
  existen en `filtro-tabs.css` / `componentes-admin.css`, compartidos.
- KPIs: total de clientes en fuga, valor anual total en riesgo, cantidad
  sin ninguna acción disparada todavía.
- Pestañas de filtro por `motivo_probable` (Todos / Freno por deuda /
  Posible fuga a competencia).
- Checkbox "Solo lo mío", visible solo para `rol === 'vendedor'` (mismo
  criterio de scope que `clientes.js` y `prospectos-competencia.js`) — llama
  de nuevo a `/api/clientes-fuga?solo_mio=1` en vez de filtrar en cliente,
  porque el backend ya resuelve ese filtro contra `vendedor_id_default`.
- `nav-data.js`: entrada "Clientes en fuga" agregada junto a "Clientes",
  mismos roles (`dueno`, `admin`, `vendedor`).

## Validado en esta sesión

- `node --check` OK en los 7 archivos JS tocados/nuevos.
- `vercel.json` sigue siendo JSON válido tras la edición.
- Contrato frontend↔backend revisado a mano línea por línea contra
  `lib/handlers/clientes-fuga.js` (`solo_mio=1`, forma del JSON de
  respuesta) — coincide.

## Lo que sigue sin hacer (a propósito, no se tocó en esta sesión)

- **No se corrió la suite de tests completa** (`npm test`, vitest) — no
  había `node_modules` en el ambiente de esta sesión y no se instaló para
  no comprometer el resto del alcance. Recomendado antes de deployar:
  `npm ci && npm test` (o al menos los tests de `repos/clientes-fuga` y
  `handlers/clientes-fuga` si Luc decide escribirlos — no existen
  todavía).
- No se probó la pantalla clickeando en un navegador real contra datos de
  producción/demo — mismo criterio que el resto de "Pendientes reales
  (post-auditoría)" (ítem 3, pase manual) ya documentado.
- Sin tests de regresión nuevos para `listarClientesEnFuga` /
  `clientesEnFugaRpc` — quedaron sin cobertura, igual que el resto de
  Fase 2 (ver "Etapa 8" del plan chico, mismo criterio: sweep de cobertura
  pendiente como tarea aparte).
