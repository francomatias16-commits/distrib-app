# v296 — SEC-008: catálogo cliente sin login gateado por flag explícito

## Problema
`cliente_productos_disponibles` (función `SECURITY DEFINER`, usada por
`/api/cliente/productos` y expuesta además con `GRANT EXECUTE` directo a
`anon`/`authenticated` vía PostgREST) devolvía el catálogo completo
(precios, stock disponible) de **cualquier empresa del SaaS** con solo
pasarle su `empresa_id` — sin validar sesión ni ningún otro control. Se
confirmó en el código (`resolverEmpresaCliente`, `lib/handlers/stock.js`)
que era un fallback intencional ("catálogo público sin login" para
compartir el link con clientes potenciales antes de que se registren),
pero el `empresa_id` no es secreto y no había forma de restringir el
acceso empresa por empresa. Decisión de negocio (auditoría 2026, sesión
9): restringirlo — pasa a ser opt-in explícito.

## Fix (2 capas)

**1) SQL — migración `292_fix_sec008_gate_catalogo_publico`**
`cliente_productos_disponibles` ahora exige, para cualquier caller que no
sea `service_role` ni un usuario autenticado de esa misma empresa
(`get_empresa_id() = p_empresa_id`), que la empresa tenga
`config->>'catalogo_publico_habilitado' = 'true'`. Si no, devuelve 0 filas
(no error, para no filtrar si el `empresa_id` existe). Esto cierra el
acceso directo por PostgREST, que bypasea el backend por completo.

**2) Backend — `lib/handlers/stock.js` (`resolverEmpresaCliente`)**
Mismo chequeo antes de aceptar el fallback `?empresa_id=` en
`/api/cliente/productos` y `/api/cliente/categorias`: ahora consulta
`empresas.config` y solo continúa si el flag está en `true`. Sesión
autenticada (Bearer token) sigue funcionando igual que siempre, sin
cambios — el fix solo afecta el modo público sin login.

## Cómo habilitar el catálogo público para una empresa
Es opt-in. Para habilitarlo:
```sql
UPDATE empresas
SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{catalogo_publico_habilitado}', 'true')
WHERE id = '<empresa_id>';
```
Pendiente (no incluido en esta versión, sugerido a futuro): agregar un
toggle en el panel admin (`Configuración`) para que cada empresa lo
active/desactive sin tocar SQL directo.

## Impacto / breaking change intencional
Verificado en producción (2026-07-11): solo hay 2 empresas en la base
(`Distribuidora del Litoral S.A.` y la empresa demo), ninguna tenía el
flag seteado — con el default `false` ambas quedan con el catálogo
público deshabilitado hasta que se active a propósito. Si algún link de
catálogo compartido dejó de funcionar, es este cambio: hay que habilitar
el flag para esa empresa.

## Verificación
- `node --check lib/handlers/stock.js` → OK.
- Confirmado con `pg_get_functiondef` que la función quedó aplicada en
  Supabase con el guard nuevo.
- Confirmado que `productos`/`categorias` (tablas) no eran vector de
  este hallazgo — RLS ya filtra correctamente por `get_empresa_id()`, el
  problema era exclusivo del RPC `SECURITY DEFINER`.

## Estado de la auditoría 2026 tras este fix
Etapa 2 (seguridad DB) queda con **un solo pendiente accionable por
código/SQL**: SEC-009 ya se cerró en la sesión anterior, SEC-008 se cierra
acá. Quedan solo SEC-003 (manual, dashboard de Supabase Auth) y SEC-004
(mover `pg_trgm`/`vector` de `public`, pendiente de decisión por ser de
mayor riesgo/esfuerzo — requiere tocar ~29 funciones en la misma
migración).
