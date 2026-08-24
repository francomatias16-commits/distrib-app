-- ============================================================
-- 20260823000000_526_teaser_reglas_volumen_catalogo.sql
-- Teaser de reglas de volumen en el catálogo del portal cliente
-- ("Desde 6 un.: 5% off"), para las reglas de `reglas_precio`
-- (migración 243) con cantidad_minima > 1 — hoy esas reglas solo
-- impactaban el precio al armar el carrito con la cantidad real,
-- sin ningún aviso previo en el listado.
--
-- No requiere cambios de esquema: la tabla `reglas_precio` ya existe
-- desde 243_etapa2_motor_reglas_precio.sql con todo lo necesario
-- (producto_id/categoria_id, zona_id, cantidad_minima, tipo_descuento,
-- valor, vigencia, activa). Esta migración es solo de registro —
-- deja constancia de la nueva pieza de código que consume esa tabla:
--
--   lib/repos/stock.js       → listarReglasVolumenCatalogo(cliente_id,
--                               producto_ids, empresa_id): por cada
--                               producto, elige la regla vigente con
--                               cantidad_minima > 1 más específica
--                               (producto > categoría, luego prioridad,
--                               luego el escalón de cantidad más bajo),
--                               respetando zona si la regla la exige.
--   lib/handlers/stock.js    → handleClienteProductos adjunta
--                               `regla_volumen` a cada producto del
--                               catálogo (no pisa el precio mostrado,
--                               que sigue resolviendo
--                               resolver_precios_cliente con cantidad=1).
--   frontend/cliente/catalogo.html → textoReglaVolumen(p) pinta el
--                               teaser en la card, oculto si ya hay
--                               una oferta de liquidación activa.
-- ============================================================

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260823000000_526_teaser_reglas_volumen_catalogo.sql',
  '526',
  'claude_assistant',
  'Sin cambios de esquema (reglas_precio ya existía desde 243). Registra el teaser de reglas de volumen en el catálogo cliente: lib/repos/stock.js:listarReglasVolumenCatalogo, wiring en lib/handlers/stock.js (handleClienteProductos) y UI en frontend/cliente/catalogo.html (textoReglaVolumen).'
)
ON CONFLICT DO NOTHING;
