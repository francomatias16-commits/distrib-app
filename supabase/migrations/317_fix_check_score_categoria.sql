-- ═══════════════════════════════════════════════════════════════════════════
-- 317_fix_check_score_categoria.sql
--
-- Contexto (diagnóstico v319/v320 — panel de automatización):
-- clientes.score_categoria debería tener solo los valores que escribe
-- calcular_score_cliente(): 'premium' | 'bueno' | 'normal' | 'riesgo' |
-- 'bloqueado' (así se definió en 036_score_cliente.sql / 049). En producción
-- se verificó que el CHECK constraint no existe hoy (se perdió en algún
-- punto — probablemente porque ADD COLUMN IF NOT EXISTS no reaplica el
-- CHECK si la columna ya existía en una corrida anterior de la migración).
-- Eso permitió que ~1580 clientes quedaran con valores legacy 'A'/'B'/'C'/
-- 'D' de una importación vieja, que ningún código actual asigna ni espera.
--
-- Este fix NO es necesario para el bug de automatizacion.js (ese ya se
-- arregló solo en JS: el filtro ahora usa los valores reales). Esta
-- migración es un blindaje aparte a nivel de esquema para que no vuelva a
-- colarse silenciosamente un valor fuera de dominio.
--
-- Se usa NOT VALID a propósito: valida todo INSERT/UPDATE nuevo desde ya,
-- pero NO rompe con las filas legacy A/B/C/D que todavía están pendientes
-- de que el cron de recálculo las reprocese. Cuando ya no queden filas
-- fuera de dominio, correr manualmente:
--   ALTER TABLE public.clientes VALIDATE CONSTRAINT chk_score_categoria;
-- (no se hace automático acá porque no es idempotente barato en una tabla
-- grande y no es necesario para que el constraint proteja hacia adelante).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.clientes DROP CONSTRAINT IF EXISTS chk_score_categoria;

ALTER TABLE public.clientes
  ADD CONSTRAINT chk_score_categoria
  CHECK (score_categoria IS NULL OR score_categoria IN ('premium','bueno','normal','riesgo','bloqueado'))
  NOT VALID;

-- Verificación: cuántas filas violarían el constraint hoy (deberían ser las
-- ~1580 legacy A/B/C/D — informativo, no bloquea la migración).
SELECT score_categoria, count(*) AS filas_pendientes_de_normalizar
FROM public.clientes
WHERE score_categoria IS NOT NULL
  AND score_categoria NOT IN ('premium','bueno','normal','riesgo','bloqueado')
GROUP BY score_categoria
ORDER BY filas_pendientes_de_normalizar DESC;
