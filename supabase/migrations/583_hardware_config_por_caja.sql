-- ============================================================
-- 583_hardware_config_por_caja.sql
-- AUDITORÍA 584 — la config de terminal de pago (Prisma/MP Point/
-- Getnet) e impresora térmica vivía en `empresas.config->pos_hardware`,
-- una sola fila por empresa, a pesar de que:
--   - `cajas_pos` está diseñada desde el origen (072_pos.sql) para
--     "Varias cajas físicas operando en simultáneo".
--   - El changelog que introdujo Prisma decía explícitamente que
--     `terminal_id` cambia por caja.
--   - GET/POST /api/pos/config-hardware nunca recibía caja_id.
--
-- Consecuencia real: con 2+ cajas abiertas en simultáneo, cada una con
-- su propia terminal física, todas terminaban compartiendo el mismo
-- terminal_id/device_id guardado — la segunda caja mandaba sus cobros
-- a la terminal de la primera.
--
-- Fix: `hardware_config` (impresora + terminal) pasa a ser una columna
-- de `cajas_pos`, una fila por caja. Se preserva la config previa de
-- empresa como valor por defecto de TODAS las cajas existentes al
-- momento de migrar, para no dejar a nadie con "terminal: manual" de
-- un día para el otro. `empresas.config->pos_hardware` queda en la
-- tabla (dato viejo, ya no se lee) — no se borra, por si hace falta
-- consultarlo para soporte.
-- ============================================================

BEGIN;

ALTER TABLE cajas_pos
  ADD COLUMN IF NOT EXISTS hardware_config JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Backfill: copiar la config de empresa (si existía) a cada caja activa
-- que todavía no tenga nada propio. Solo corre una vez (WHERE
-- hardware_config = '{}' evita pisar algo que ya se haya guardado por
-- caja después del deploy del código nuevo, si esta migración se
-- reaplica o corre tarde).
UPDATE cajas_pos c
SET hardware_config = e.config->'pos_hardware'
FROM empresas e
WHERE c.empresa_id = e.id
  AND c.hardware_config = '{}'::jsonb
  AND e.config->'pos_hardware' IS NOT NULL
  AND e.config->'pos_hardware' <> '{}'::jsonb;

COMMIT;
