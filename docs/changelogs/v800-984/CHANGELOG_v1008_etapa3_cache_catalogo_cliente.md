# v1008 — Etapa 3 del plan de robustez (generalización): caché en el catálogo de cliente

## Contexto

`docs/planes/PLAN_ROBUSTEZ_ESCALABILIDAD_PROFESIONAL_2026.md` — Etapa 3. El
piloto de `lib/cache.js` (2026-08-28) solo cubría los KPIs del dashboard
admin. El diagnóstico original también señalaba el catálogo público de
cliente (`cliente_productos_disponibles`) y `plan-limits.js` como
candidatos — quedaban pendientes de decidir.

## Cambio

`lib/handlers/stock.js`:

- **`handleClienteCategorias`**: cachea la respuesta completa
  (`categorias-cliente:${empresa_id}`, TTL 60s) — es 100% no personalizada,
  solo depende de `empresa_id`.
- **`handleClienteProductos`**: cachea únicamente la RPC base
  `cliente_productos_disponibles` (precio de lista general + stock
  agregado — igual para cualquier visitante con los mismos filtros).
  Clave incluye `empresa_id`/categoría/búsqueda/límite/offset/destacados,
  TTL 15s. **Todo lo que se resuelve por cliente autenticado después de la
  RPC — `resolver_precios_cliente`, ofertas de liquidación, reglas de
  volumen — sigue sin cachear, corre fresco en cada request.** Cachear esa
  parte filtraría el precio/oferta de un cliente a otro.

## Decisión: `plan-limits.js` queda fuera, a propósito

`exigirLimitePlan` no es una lectura — es un gate de enforcement que se
llama antes de crear un recurso. Cachear su resultado abre una ventana
donde varias creaciones concurrentes leen el mismo "todavía no llegaste al
límite" cacheado y lo superan, justamente bajo el tipo de pico de tráfico
que la Etapa 3 busca abaratar. El ahorro de carga no justifica ese riesgo
de negocio. Si hace falta optimizar esta ruta más adelante, la vía correcta
es la RPC SQL (`chequear_limite_plan`) o cachear solo el numerador/
denominador para mostrar en UI, nunca el resultado binario del que depende
el bloqueo.

## Tests

- `tests/cache.test.js` (nuevo): el módulo `lib/cache.js` en sí no tenía
  cobertura propia — TTL, fail-open (`calcular()` que tira no cachea nada),
  scope por clave, e `invalidar()`. Cubre por extensión cualquier handler
  que lo use, no solo los dos de este cambio.

## Verificación

- `npx vitest run`: 74 archivos, 1197 tests (1192 + 5 nuevos), sin
  regresiones.
- `npm run predeploy`: mismos 6 warnings preexistentes del dispatch
  heurístico (`chofer-offline.js`/`gps-tracker.js`), no relacionados a
  este cambio.
- Pendiente, como ya estaba documentado: medir impacto real (antes/después)
  con el load test de la Etapa 4 una vez que se corra.
