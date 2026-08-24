-- ═══════════════════════════════════════════════════════════════════════════
-- 462_movimientos_stock_lotes_detalle.sql
--
-- [Reconstruida en el repo — no había archivo versionado para 462-472.
--  Estas funciones/tabla YA estaban aplicadas en producción (probablemente
--  desde una sesión anterior que operó directo contra la base) pero nunca
--  quedaron versionadas como migraciones. Este archivo y los siguientes
--  (463-472) se generan leyendo la definición REAL y vigente de cada objeto
--  directamente desde information_schema/pg_proc de la base de producción,
--  no a partir de un borrador. Se aplican como CREATE OR REPLACE / CREATE
--  TABLE IF NOT EXISTS, por lo tanto son no-op funcional sobre la base
--  actual — solo dejan el repo consistente con lo que ya corre.]
--
-- Tabla de detalle: registra, por cada movimiento_stock, qué lote(s)
-- aportaron o consumieron la cantidad. Antes de esto, fn_lotes_consumir_fefo()
-- y las inserciones de lote en ajustar_stock/recepcionar_orden_compra/
-- transferir_stock/producir_con_insumos dejaban el lote actualizado pero sin
-- ningún vínculo hacia el movimiento que lo originó.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.movimientos_stock_lotes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movimiento_stock_id uuid NOT NULL REFERENCES public.movimientos_stock(id) ON DELETE CASCADE,
  lote_id             uuid NOT NULL REFERENCES public.lotes(id),
  cantidad            numeric NOT NULL CHECK (cantidad > 0),
  direccion           text NOT NULL CHECK (direccion IN ('consumo', 'alta')),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_msl_movimiento ON public.movimientos_stock_lotes (movimiento_stock_id);
CREATE INDEX IF NOT EXISTS idx_msl_lote        ON public.movimientos_stock_lotes (lote_id);

ALTER TABLE public.movimientos_stock_lotes ENABLE ROW LEVEL SECURITY;

-- Política vigente en producción: filtra por empresa del usuario autenticado
-- vía tabla usuarios (no vía get_empresa_id()).
DROP POLICY IF EXISTS movimientos_stock_lotes_empresa ON public.movimientos_stock_lotes;
CREATE POLICY movimientos_stock_lotes_empresa
  ON public.movimientos_stock_lotes
  FOR ALL
  USING (
    lote_id IN (
      SELECT l.id
        FROM public.lotes l
       WHERE l.empresa_id = (
         SELECT u.empresa_id FROM public.usuarios u WHERE u.id = auth.uid()
       )
    )
  );

REVOKE ALL ON public.movimientos_stock_lotes FROM anon;

COMMENT ON TABLE public.movimientos_stock_lotes IS
  'Detalle de qué lote(s) participaron en cada movimiento_stock (alta o consumo), '
  'con la cantidad exacta de cada uno. Poblada desde ajustar_stock, '
  'registrar_venta_pos, recepcionar_orden_compra, transferir_stock, '
  'producir_con_insumos, fn_lotes_dar_de_baja, fn_lotes_ajustar_cantidad, '
  'fn_lotes_crear, confirmar_despacho_stock y transferir_stock_entre_depositos.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '462_movimientos_stock_lotes_detalle.sql', '462', 'claude-session',
  'Reconstrucción retroactiva: crea/documenta movimientos_stock_lotes, la tabla de detalle lote<->movimiento para tracking FEFO trazable. Ya estaba aplicada en producción sin migración versionada. Base para 463-472.')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
