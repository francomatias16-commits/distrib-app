-- 20260902_fix_cobros_qr_pos_reconstruccion.sql
--
-- AUDITORÍA ETAPA 3 (Pagos online Mercado Pago + Conciliación bancaria,
-- PLAN_AUDITORIA_FUNCIONAL_PRELANZAMIENTO_2026.md): mismo patrón de
-- "disaster-recovery gap" ya encontrado antes (v880/v892/v899) — la tabla
-- `cobros_qr_pos` (puente Realtime entre el webhook de MP y el POS, ver
-- lib/repos/pagos.js y frontend/admin/js/pos-terminal.js, driver mp_qr)
-- existe y está en uso real en producción (proyecto jgiquzjwoedmzwqgzubr,
-- migración de referencia 480_integraciones_pago_qr_columnas.sql) pero
-- nunca tuvo su propio archivo de migración en el repo — quedó fuera del
-- historial versionado. Reconstruida acá desde el estado real de la base
-- (columnas, índices, trigger y políticas RLS confirmados vía MCP), no
-- reemplaza nada existente: todo con IF NOT EXISTS / DROP+CREATE POLICY
-- para poder reaplicarse sin romper si ya está.
--
-- No se encontró ningún bug funcional nuevo en esta ronda de auditoría de
-- Mercado Pago ni de Conciliación bancaria — ambos módulos ya venían de
-- varias rondas previas bien documentadas en el código (BUG-01, SEC-10,
-- MERCADOPAGO-AUDIT-01, DT-04, SEC-013 en lib/handlers/pagos.js;
-- CONCILIACION-AUDIT-01/02 y el fix de v899 en conciliación bancaria).
-- Este es el único hallazgo real de la pasada: un gap de versionado, no
-- de lógica.

CREATE TABLE IF NOT EXISTS public.cobros_qr_pos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  referencia   text NOT NULL,
  order_id     text NOT NULL,
  monto        numeric NOT NULL,
  estado       text NOT NULL DEFAULT 'pendiente',
  payment_id   text,
  metodo_pago  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cobros_qr_pos_order_id_key ON public.cobros_qr_pos(order_id);
CREATE INDEX IF NOT EXISTS cobros_qr_pos_empresa_id_idx ON public.cobros_qr_pos(empresa_id);

COMMENT ON TABLE public.cobros_qr_pos IS
  'Puente Realtime entre el webhook de MP (topic order) y el POS: pos-qr-cobrar crea la fila pendiente, el webhook la actualiza al confirmar la orden y pos-terminal.js (driver mp_qr) escucha el UPDATE por Realtime en vez de depender solo del polling. Reconstruida en 20260902 tras detectar que no tenía migración propia en el repo pese a estar en uso real (ver 480_integraciones_pago_qr_columnas.sql como referencia de la etapa que la introdujo).';

-- Trigger de updated_at: reusa la función compartida del proyecto
-- (set_updated_at), ya trackeada en otras migraciones — no se redefine acá.
DROP TRIGGER IF EXISTS trg_cobros_qr_pos_updated_at ON public.cobros_qr_pos;
CREATE TRIGGER trg_cobros_qr_pos_updated_at
  BEFORE UPDATE ON public.cobros_qr_pos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: SELECT por tenant (mismo patrón que el resto del proyecto),
-- escritura (INSERT/UPDATE/DELETE) exclusiva de service_role — el
-- frontend nunca escribe esta tabla directo, solo escucha por Realtime.
ALTER TABLE public.cobros_qr_pos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cobros_qr_pos_select_propia ON public.cobros_qr_pos;
CREATE POLICY cobros_qr_pos_select_propia ON public.cobros_qr_pos
  FOR SELECT
  USING (empresa_id = (SELECT usuarios.empresa_id FROM usuarios WHERE usuarios.id = (SELECT auth.uid())));

DROP POLICY IF EXISTS service_role_all_cobros_qr_pos_insert ON public.cobros_qr_pos;
CREATE POLICY service_role_all_cobros_qr_pos_insert ON public.cobros_qr_pos
  FOR INSERT
  WITH CHECK ((SELECT auth.role()) = 'service_role');

DROP POLICY IF EXISTS service_role_all_cobros_qr_pos_update ON public.cobros_qr_pos;
CREATE POLICY service_role_all_cobros_qr_pos_update ON public.cobros_qr_pos
  FOR UPDATE
  USING ((SELECT auth.role()) = 'service_role')
  WITH CHECK ((SELECT auth.role()) = 'service_role');

DROP POLICY IF EXISTS service_role_all_cobros_qr_pos_delete ON public.cobros_qr_pos;
CREATE POLICY service_role_all_cobros_qr_pos_delete ON public.cobros_qr_pos
  FOR DELETE
  USING ((SELECT auth.role()) = 'service_role');

-- Registro en la tabla de tracking de migraciones del proyecto
INSERT INTO schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260902_fix_cobros_qr_pos_reconstruccion.sql',
  '20260902',
  'claude_assistant',
  'Auditoría etapa 3 (Mercado Pago + Conciliación bancaria): reconstrucción de cobros_qr_pos, tabla en uso real que nunca tuvo migración propia en el repo (disaster-recovery gap, mismo patrón que v892/v899). Sin cambios de esquema real, solo versionado — tabla, índices, trigger y RLS confirmados 1 a 1 contra el estado real de producción vía MCP.'
)
ON CONFLICT DO NOTHING;
