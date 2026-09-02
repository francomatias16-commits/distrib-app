# v967 — Etapa 8 (cobertura de tests vs. bugs históricos), continuación

Sigue al plan de 9 etapas de `AUDITORIA_BUGS_v954.md`. v966 había agregado
tests de regresión para los 2 hallazgos 🔴 Crítico del documento y dejado
pendiente investigar 5 tests preexistentes que fallaban, sin decidir si
eran mocks desactualizados o bugs reales.

## Instalación de dependencias y corrida real de la suite

v966 solo había hecho análisis estático de los mocks rotos (lectura de
código, sin ejecutar). Esta ronda instaló dependencias (`npm install`,
499 paquetes) y corrió `npx vitest run` real contra el repo.

## Diagnóstico: los 5 fallos eran mocks desactualizados, no bugs reales

1. **`tests/handlers/usuarios.test.js`** (2 fallos) — `repoMock` (objeto
   literal mockeado con `vi.mock`) no exponía `revocarSesionesRefreshTokens`.
   La función existe y está bien implementada en
   `lib/repos/usuarios.js:151` — es el fix real del hallazgo #10
   (invalidar sesiones al resetear contraseña, v957). El mock simplemente
   no se había actualizado cuando se agregó esa llamada al handler.
   → Fix: agregado `revocarSesionesRefreshTokens: vi.fn(async () => {})`
   al `repoMock`.

2. **`tests/repos/empresas.test.js`** (1 fallo) — el test esperaba
   `select('nombre, cuit, domicilio, telefono, email, logo_url, config')`.
   El código real de `obtenerDatosEditables()` agrega `slug` a esa lista,
   a propósito: es el campo real detrás del link del catálogo público
   (`actualizarSlug()`, mismo archivo). Test desincronizado de una
   feature real y vigente.
   → Fix: actualizada la assertion para incluir `, slug`.

3. **`tests/repos/migracion.test.js`** (1 fallo) — el test esperaba
   `.limit(20)`. `listarSesionesPorEmpresa()` fue refactorizada a
   paginación real por `offset`/`limit` vía `.range(inicio, inicio +
   cantidad - 1)`, con el `limit` cappeado a 50. El `.limit()` viejo ya
   no se llama.
   → Fix: reescrita la assertion contra `.range(0, 19)` (caso default) y
   agregado un caso nuevo que verifica el cap de 50 con `offset`/`limit`
   explícitos.

## Hallazgo adicional durante la verificación

Corrida la suite completa después de los 3 fixes de arriba, apareció un
**sexto fallo no contado en los "5 preexistentes" que documentó v966**:
`tests/handlers/eventos-dispatcher.test.js`, test "procesa solo los
eventos pendientes" (`describe('despacharPendientes')`).

Mismo patrón que los 3 anteriores: el mock de `../../lib/supabase-lazy.js`
reflejaba una forma vieja de `reclamarEventos()` —
`.select().in('estado', estados).order().limit()` y un `update().eq(id)`
simple. El código real (comentario `SYNC-06` en `lib/eventos-dispatcher.js`)
fue refactorizado a:

- **Lectura de candidatos**: `.select('*').order('creado_en').limit(n)`
  seguido opcionalmente de `.eq('empresa_id', x)` y luego `.or(filtroOr)`
  — el `filtroOr` combina `estado.in.(pendiente,error)` con la rama de
  lease vencido para eventos `procesando` que quedaron colgados por un
  worker caído a mitad de camino. Ya no usa `.in()` directo.
- **Claim atómico**: `.update(cambios).eq('id', x).eq('estado', y)
  .select('*').maybeSingle()` — el segundo `.eq('estado', ...)` es la
  condición de carrera: si dos barridos concurrentes leen el mismo evento,
  solo el que llega primero al UPDATE lo reclama.

El mock viejo no soportaba ninguna de las dos formas. Reescrito para
reflejar el contrato real, incluyendo la condición de carrera del claim
(el mock solo "reclama" un evento si su estado en `dbMock.eventosPendientes`
sigue siendo el que se leyó, igual que el código real). Se preservó la
forma simple `.update(cambios).eq('id', x)` awaited directo, que sigue
usando `despacharEvento()` para los tests que ya pasaban.

## Resultado

Suite completa corrida 3 veces seguidas: **1032/1032 tests pasando,
52/52 archivos, cero fallos** (antes: 1026 passed / 5 failed de 1031,
más el sexto no documentado). No se tocó ningún archivo de `lib/` — los
4 fixes fueron 100% en tests.

## Pendiente

Etapa 8 sigue en curso: falta el barrido completo de los hallazgos
🟠/🟡 ya resueltos del documento contra `tests/` (esta ronda y la
anterior priorizaron severidad real y arreglar lo roto, no cobertura
exhaustiva). Ver lista puntual en `AUDITORIA_BUGS_v954.md`, hallazgo #18.
