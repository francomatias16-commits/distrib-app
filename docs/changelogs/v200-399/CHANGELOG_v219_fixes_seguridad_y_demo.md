# v219 — Fix de seguridad/integridad en ajuste de stock

## Problema encontrado

La RPC `ajustar_stock` (vigente en producción, con la lógica de lotes/FEFO ya
integrada que no estaba en el repo local) tenía dos fallas:

1. **Clampeo silencioso**: si un egreso pedido era mayor al stock disponible,
   la función no rechazaba la operación — hacía `GREATEST(0, ...)` y devolvía
   `ok:true` con el stock forzado a 0. La única validación de "no hay stock
   suficiente" vivía en el cliente (`stock.js`), bypasseable desde devtools.
2. **Insert de auditoría separado de la escritura real**: el registro en
   `movimientos_stock` lo hacía el cliente con un `insert()` directo, con la
   cantidad *pedida* (no la que la RPC realmente aplicó). Esa tabla solo
   tiene RLS de aislamiento por empresa, sin validar coherencia contra ningún
   ajuste real — permitía insertar movimientos "fantasma" sin pasar por la RPC.

## Fix (migración `201_ajustar_stock_atomico_sin_clamp.sql`, aplicada a producción)

- La RPC ahora lockea la fila de stock (`FOR UPDATE`) y calcula el resultado
  **antes** de escribir nada.
- Si el resultado sería negativo: devuelve `ok:false` con el motivo y el
  stock disponible real. No toca stock, no toca lotes, no inserta movimiento.
- La lógica de lotes/FEFO (creación de lote en ingresos, consumo FEFO en
  egresos) se mantiene intacta, sin cambios.
- El `INSERT` en `movimientos_stock` ahora lo hace la propia RPC, dentro de
  la misma transacción, con el delta **realmente aplicado** y con
  `tipo`/`motivo`/`notas` reales recibidos por parámetro nuevo.

## Cambios en frontend (`stock.js`, `stock.html`)

- `guardarAjuste()` ya no inserta directo en `movimientos_stock`. Llama a la
  RPC (ahora con `p_tipo`, `p_motivo`, `p_notas`) y usa la respuesta `ok`/
  `error` para decidir si mostrar éxito o el motivo del rechazo.
- Si el servidor rechaza la operación (stock insuficiente detectado en el
  backend, ej. por condición de carrera o manipulación del cliente), se
  muestra el error real en vez de asumir éxito.
- `stock.html`: bump de cache-busting del script (`?v201`).

## Nota sobre transferencias

Se mantiene el mismo patrón de dos llamadas a la RPC (egreso en origen +
ingreso en destino) que ya existía — no se tocó esa arquitectura para no
interferir con la lógica de lotes por depósito. Cada llamada ahora genera su
propio registro en `movimientos_stock` (antes había un solo insert manual
para toda la transferencia), lo cual da más trazabilidad, no menos.

## Segundo hallazgo: XSS almacenado en la tabla de Stock (`stock.js`)

En `renderTabla()`, el nombre del producto se insertaba en un atributo
`onclick="abrirModal('...','${nombre.replace(/'/g,"\\'")}',...)"` con un
escape insuficiente: solo reemplazaba comillas simples, ni `escHtml` ni
comillas dobles. Un nombre de producto con un `"` (ej. `Caño 1" x 20mm`,
totalmente plausible en un rubro de distribución/ferretería) rompía el
atributo HTML y permitía inyectar HTML/JS arbitrario, ejecutándose en la
sesión de cualquier admin/depositero que viera la pantalla de Stock. También
`unidad` se insertaba sin escapar en varios lugares (celdas de la tabla y en
el modal de ajuste).

**Fix:**
- `escHtml()` ahora también escapa comillas simples y dobles (antes solo
  escapaba `& < >`), quedando segura para contexto de atributo HTML además
  de texto.
- Se eliminaron los `onclick="..."` con texto libre interpolado: los botones
  de "Ajustar stock" y el kebab ahora usan atributos `data-*` (con los
  valores pasados por `escHtml`) y un único listener delegado sobre
  `#tabla-body` que lee `dataset` y llama a `abrirModal(...)`. Esto evita
  por completo tener que escapar simultáneamente para contexto HTML y
  contexto de string JS (la causa real del bug original).
- Se escapó `unidad` donde faltaba (celdas de cantidad y modal de ajuste).

## Nota menor (no corregida, dejar registrada)

La búsqueda de productos arma el filtro de Supabase con
`.or(\`nombre.ilike.%${busq}%,codigo.ilike.%${busq}%\`)`, interpolando el
texto de búsqueda directo en la sintaxis de filtro de PostgREST. Si el
usuario escribe una coma u otros caracteres especiales de esa sintaxis, la
búsqueda puede devolver un error 400 en vez de resultados (se ve en
`cargarStock()` y en `exportarExcel()`). No es un problema de seguridad —la
RLS sigue aislando por empresa pase lo que pase en el filtro— es solo una
rotura de UX con ciertos caracteres. Lo dejo anotado para un fix aparte si
te molesta en el uso diario.

## Tercer hallazgo: seguí con el punteo de la auditoría v194 (`api/index.js`)

Repasé qué quedaba pendiente de `AUDITORIA_SEGURIDAD_DISTRIB_v194.md` (el
audit más reciente en el repo) en vez de seguir módulo por módulo a ciegas.
Estado real de los ítems P0:

- **P0-1 (CSP)**: ✅ ya resuelto — `vercel.json` tiene CSP configurada tanto
  para `/api/*` como para el HTML admin.
- **P0-3 (open redirect `?next=`)**: ✅ resuelto — ese parámetro ya no existe
  en `login.html`, no hay nada que validar.
- **P0-2 (escHtml centralizado)**: sigue pendiente como deuda técnica (7+
  copias locales de `escHtml`/`escapeHtml`), pero no es explotable por sí
  sola — cada copia bloquea `&<>"'` razonablemente bien donde se usa. Lo dejo
  como ítem de deuda, no de seguridad urgente.
- **BUG-03 (`err?.message` expuesto en los 500)**: ❌ **seguía sin
  resolver** en `api/index.js`. Cualquier excepción no controlada en
  cualquiera de los ~30 módulos del dispatcher devolvía el mensaje de error
  crudo al cliente — puede filtrar nombres de tabla, fragmentos de SQL,
  rutas internas, etc. a cualquiera que logre provocar un error.

**Fix aplicado:** el dispatcher ahora genera un `correlation_id` (UUID) por
cada excepción, loguea el detalle completo (`err.stack`) solo del lado del
servidor con ese ID, y al cliente le devuelve únicamente
`{ error: 'Error interno del servidor', correlation_id }`. Verifiqué que
ningún módulo del frontend dependía del campo `detalle` que se sacó (los
`detalle` que aparecen en otros archivos son campos de dominio no
relacionados — cheques, anomalías, notificaciones — no el genérico del
dispatcher).

## Acceso público a la demo

La infraestructura de la demo (empresa ficticia + reset por cron) ya estaba
armada en Supabase, pero no existía ningún usuario para loguearse —
literalmente nadie podía entrar. Se creó un usuario real de Supabase Auth
(`demo@distrib-test.local`) vinculado como `dueno` de "Distribuidora Demo S.A.".

Además se agregó un acceso público de un clic:
- **Landing (`frontend/index.html`)**: botón "Ver demo en vivo →" en el hero,
  apunta a `/admin/login?demo=1`.
- **Login (`frontend/admin/login.html`)**: si detecta `?demo=1`, precarga el
  email y contraseña de la cuenta demo y muestra un aviso aclarando que es
  una cuenta compartida con reseteo periódico. No autocompleta y envía sola
  — el usuario igual tiene que tocar "Ingresar al panel", para que quede
  claro que está entrando a una cuenta pública y no a la suya.

## Pendiente / fuera de alcance

- El selector "Comprobante por defecto" (Factura A/B/C) sigue siendo solo
  visual — falta columna en `facturacion_config` para persistirlo.
- No se restringió la política RLS de INSERT directo en `movimientos_stock`
  porque otros flujos legítimos (recepción de mercadería, POS) siguen
  insertando directo a esa tabla; tocar eso es un cambio más grande, fuera
  de este fix puntual.
