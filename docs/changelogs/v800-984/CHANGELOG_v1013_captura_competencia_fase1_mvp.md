# v1013 — Captura de competencia: Fase 1 (Capa 2 — MVP) del plan de captación (2026-08-30)

## Por qué

Ver `PLAN_CAPTURA_COMPETENCIA.md` en la raíz del repo. Objetivo de negocio:
en la misma visita comercial, el vendedor de campo saca una foto de la
factura del competidor en el mostrador de un comercio no-cliente, el
sistema arma la comparación ítem por ítem contra el catálogo propio (con
margen mínimo protegido) y permite cerrar cliente + pedido en el momento,
sin perder el trabajo de relevamiento si no cierra ahí mismo.

Esta entrega es Fase 1 del plan (Capa 2, MVP) — las Fases 2 (contador de
ahorro en portal) y 3 (prospección geográfica sobre rutas) quedan para
después, tal como especifica el plan.

## Supabase

- **Migración 551**: tablas `captura_competencia` y
  `captura_competencia_items`, con RLS multi-tenant vía
  `public.get_empresa_id()` (mismo patrón que
  `asistente_acciones_pendientes`, 419). Sin acceso de escritura para
  `anon`/`authenticated` — el INSERT/UPDATE lo hace siempre el handler con
  `SERVICE_ROLE_KEY`.
- **Migración 552**:
  - `fn_captura_matchear_producto()` — matching por similitud de texto
    (`pg_trgm`, ya habilitada desde 420) del renglón crudo contra
    `productos.nombre`. Devuelve el mejor candidato por encima de un
    umbral (0.35 por defecto) o ninguna fila — nunca fuerza un match falso
    sobre un renglón que no es producto de catálogo (ej. un flete).
    `SET search_path` incluye `'extensions'` además de `'public'`: en este
    proyecto `pg_trgm` quedó instalada en el schema `extensions`, no en
    `public` (mismo ajuste que ya usan 506/507).
  - Bucket privado `capturas-competencia` (post-SEC-05: nace privado, sin
    policies de SELECT — el único acceso es server-side).

## Backend

- **`lib/repos/captura-competencia.js`** (nuevo): capa de datos —
  storage (subida al bucket privado), CRUD de captura e items, y el
  wrapper de `fn_captura_matchear_producto`.
- **`lib/handlers/captura-competencia/_extraccion.js`** (nuevo): en vez de
  sumar un servicio de OCR nuevo (plan 1.4), reutiliza el pipeline de
  visión que ya está en producción (`responderConFallback`, Gemini → Groq
  → OpenRouter — el mismo que usa el asistente de ayuda para leer fotos de
  pedidos/remitos), con un system prompt dedicado que pide JSON
  estructurado de renglones. Cero integración nueva, cero costo adicional
  de infraestructura.
- **`lib/handlers/captura-competencia.js`** (nuevo): handler HTTP con 6
  acciones —
  `crear` (sube foto + extrae + matchea) →
  `listar` →
  `detalle` (para la pantalla de revisión) →
  `confirmar_item` (ajuste manual obligatorio antes de cerrar, plan 1.5) →
  `cerrar` (totales + validación de piso de margen, nunca opcional) →
  `convertir` (alta de cliente si hace falta + creación del pedido,
  reutilizando `crearPedidoParaCliente` — mismo motor de
  precios/stock/crédito que el resto del sistema, no se duplica esa
  lógica).
- **Piso de margen**: no existía un concepto de "margen mínimo" separado
  de `reglas_precio` (que es un motor de descuentos, no de protección de
  margen). Se resolvió sin agregar columnas nuevas: se valida contra
  `productos.costo` (100% de cobertura en el catálogo auditado), con el
  umbral configurable por empresa en `empresas.config ->>
  'captura_competencia_margen_minimo_pct'` (default 8% si la empresa no lo
  configuró). `accionCerrar` rechaza con 409 si algún renglón queda por
  debajo del piso — no es una sugerencia, es un control obligatorio (plan,
  "Riesgos transversales").
- **Precio mostrado vs. precio real**: en la pantalla de revisión se
  muestra `productos.precio_base` como estimador conservador (todavía no
  hay cliente/lista de precios para un prospecto nuevo). El precio
  AUTORITATIVO se recalcula recién en `accionConvertir()` vía
  `resolverPreciosClienteRpc()` (dentro de `crearPedidoParaCliente`), una
  vez que el cliente ya existe — mismo motor que usa el portal y el POS.
- **`lib/permisos-service.js`**: nuevo recurso `captura_competencia`
  (`crear`/`leer`/`confirmar`/`convertir` para dueño/admin/vendedor).
- **`api/index.js`** / **`vercel.json`**: registrado el módulo
  `captura-competencia` en el dispatcher central y su rewrite
  `/api/captura-competencia(.*)`.

## Pendiente para cerrar Fase 1

- Pantalla de revisión en frontend (foto → renglones con badge de
  confianza → confirmar/descartar → cierre → convertir), detrás de
  feature flag para el piloto (plan 1.7).
- Tests: fixtures con fotos reales de remitos de proveedores locales,
  E2E Playwright del flujo completo, y test específico de que el piso de
  margen nunca se pisa (plan 1.6).
- Aplicar las migraciones 551/552 contra el proyecto de Supabase real.
