# v478 — Toggle de catálogo público en Configuración (pendiente de v296/v477)

## Contexto
SEC-008 (CHANGELOG_v296) dejó `catalogo_publico_habilitado` como opt-in por
empresa, activable solo con un `UPDATE` manual en Supabase. Tanto el
changelog de v296 como el de v477 (fix del botón "Ver catálogo") lo dejaron
marcado como pendiente. Esta versión lo cierra: cada empresa puede activarlo
y desactivarlo desde el panel, sin tocar SQL.

## Cambios

**1) `vercel.json`**
Nuevo rewrite `/api/empresa/catalogo-publico` → `_mod=empresa&_svc=catalogo-publico`,
siguiendo el mismo patrón que `logo`, `icon` y `datos`.

**2) `lib/handlers/empresa.js`**
- `GET /api/empresa/datos` ahora también trae `config` de la empresa y
  devuelve `catalogo_publico_habilitado` como booleano "aplanado" (no expone
  el resto de `config` — no hace falta en el frontend).
- Nuevo `PUT /api/empresa/catalogo-publico` (mismos guards que el resto del
  handler: requiere Bearer token válido y rol `dueno`/`admin`). Body:
  `{ habilitado: boolean }`. Hace *read-modify-write* sobre `config` (lee el
  valor actual, hace merge del flag, guarda) en vez de `jsonb_set` por SQL
  directo — el cliente JS de Supabase no soporta un merge atómico de jsonb en
  un solo `.update()`. Riesgo de carrera aceptado: es un toggle manual de un
  admin sobre su propia empresa, no un campo de escritura concurrente.

**3) `frontend/admin/empresa-config.html`**
- Nueva tarjeta "Catálogo público" con un switch y texto explicando qué ve
  (y qué NO ve: no compra, no ve lista de precios interna) alguien con el
  link sin cuenta de cliente.
- El switch guarda al toggle (sin botón "Guardar" aparte, patrón estándar de
  switches) contra el endpoint nuevo; si falla, revierte visualmente y
  muestra el error.
- Al activarlo, se muestra el link (`/cliente/catalogo?empresa_id=...`) con
  botón de copiar (`navigator.clipboard`, con fallback a
  `document.execCommand('copy')` para contextos sin permiso de Clipboard
  API). Al desactivarlo, se oculta.
- Estado inicial: el switch queda `disabled` hasta que `cargarDatos()`
  resuelve el valor real desde el backend (evita que el usuario lo toque
  antes de saber el estado verdadero).

## Por qué no relaja nada de SEC-008
El backend de `/api/cliente/productos` y `/api/cliente/categorias`
(`resolverEmpresaCliente`, `lib/handlers/stock.js`) no se tocó: sigue
exigiendo el mismo flag `catalogo_publico_habilitado = true` para aceptar el
fallback sin sesión. Este cambio solo agrega una forma más segura y
auditable de setear ese flag (vía endpoint con auth + guard de rol) en lugar
de un `UPDATE` manual en el dashboard de Supabase.

## Verificación
- `node --check lib/handlers/empresa.js` → OK.
- JS embebido de `frontend/admin/empresa-config.html` → `node --check` OK.
- `vercel.json` → JSON válido, rewrite agregado en el mismo bloque que el
  resto de `/api/empresa/*`.
- Revisado que el guard de rol (`dueno`/`admin`) y la resolución de
  `empresa_id` por token sigan el mismo patrón que `GET`/`PUT /api/empresa/datos`
  del mismo handler.

## Pendiente
Ninguno quedó abierto de esta sub-tarea. (Los pendientes de mayor alcance de
v296 — SEC-003 manual, SEC-004 mover extensiones de `public` — siguen sin
tocarse, no eran parte de esto.)
