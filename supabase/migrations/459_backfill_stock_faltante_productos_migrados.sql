-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 459: backfill — repara los productos que ya se migraron ANTES del
-- fix 458 y quedaron sin ninguna fila en `stock` (por eso no aparecían en
-- Stock.html ni en las alertas de reposición/crítico, aunque existieran en
-- Productos).
--
-- Para cada producto activo que no tiene NINGUNA fila en `stock`, se le crea
-- una con cantidad = 0 en su depósito principal (es_principal = true), o si
-- la empresa no tiene uno marcado como principal, en algún otro depósito
-- suyo (orden estable por id, ya que `depositos` no tiene created_at). Es
-- el mismo criterio de "depósito por defecto" que usa el resto del sistema
-- (obtenerDepositoPrincipal).
--
-- Es un backfill idempotente: usa ON CONFLICT DO NOTHING y solo toca
-- productos que hoy no tienen fila alguna en stock, así que correrlo de
-- nuevo no duplica ni pisa nada.
-- ═══════════════════════════════════════════════════════════════════════════════

WITH deposito_default AS (
  SELECT DISTINCT ON (empresa_id)
    empresa_id, id AS deposito_id
  FROM public.depositos
  ORDER BY empresa_id, es_principal DESC NULLS LAST, id ASC
),
productos_sin_stock AS (
  SELECT p.id AS producto_id, p.empresa_id
  FROM public.productos p
  LEFT JOIN public.stock s ON s.producto_id = p.id
  WHERE p.activo = true
    AND s.producto_id IS NULL
)
INSERT INTO public.stock (producto_id, deposito_id, cantidad, cantidad_reservada, costo_promedio)
SELECT pss.producto_id, dd.deposito_id, 0, 0, 0
FROM productos_sin_stock pss
JOIN deposito_default dd ON dd.empresa_id = pss.empresa_id
ON CONFLICT (producto_id, deposito_id) DO NOTHING;

