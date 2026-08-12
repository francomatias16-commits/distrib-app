-- 296_fix_etapa10_h1_rls_fidelizacion_aislamiento_cliente.sql
--
-- Auditoría de módulos, Etapa 10 (Fidelización) — Hallazgo 1, CRÍTICO.
-- Ya aplicada directo en producción (jgiquzjwoedmzwqgzubr) vía Supabase
-- MCP. Este archivo la deja versionada en el repo.
--
-- Las políticas RLS de saldo_puntos, movimientos_puntos, recompensas,
-- programas_fidelizacion y canjes_recompensas solo validaban empresa_id,
-- sin restringir por cliente_id ni por rol. Como un cliente autenticado
-- (rol='cliente' en usuarios) tiene el mismo empresa_id que el resto de
-- su empresa, esto permitía a CUALQUIER cliente, con su propia sesión
-- (vía supabase-js directo, sin pasar por el backend):
--
--   a) Leer el saldo de puntos, historial de movimientos y canjes de
--      TODOS los clientes de la empresa (fuga de datos entre clientes).
--   b) Escribir directo en saldo_puntos.puntos_disponibles (UPDATE) y
--      regalarse puntos ilimitados -- que luego canjea de verdad a
--      través del flujo legítimo (canjear_recompensa ya es seguro, pero
--      confía en un saldo que se pudo haber falsificado antes).
--   c) Crear/editar recompensas y la configuración del programa
--      (puntos_por_peso, bonus_pct_categoria), pese a que el código
--      decía en comentarios "solo dueño/admin".
--
-- Mismo patrón ya usado en pedidos_select/clientes_select (migración
-- 040_fix_rls_duplicates.sql): es_admin() para acceso interno amplio,
-- más "cliente_id IN (SELECT id FROM clientes WHERE usuario_id = auth.uid())"
-- para que un cliente solo vea/toque lo propio.

-- ── saldo_puntos ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS saldo_puntos_acceso ON public.saldo_puntos;
DROP POLICY IF EXISTS saldo_puntos_select ON public.saldo_puntos;
CREATE POLICY saldo_puntos_select ON public.saldo_puntos
  FOR SELECT USING (
    es_admin()
    OR cliente_id IN (SELECT id FROM public.clientes WHERE usuario_id = auth.uid())
  );

DROP POLICY IF EXISTS saldo_puntos_insert ON public.saldo_puntos;
CREATE POLICY saldo_puntos_insert ON public.saldo_puntos
  FOR INSERT WITH CHECK (es_admin());

DROP POLICY IF EXISTS saldo_puntos_update ON public.saldo_puntos;
CREATE POLICY saldo_puntos_update ON public.saldo_puntos
  FOR UPDATE USING (es_admin()) WITH CHECK (es_admin());

-- ── movimientos_puntos ──────────────────────────────────────────────────
DROP POLICY IF EXISTS movimientos_puntos_acceso ON public.movimientos_puntos;
DROP POLICY IF EXISTS movimientos_puntos_select ON public.movimientos_puntos;
CREATE POLICY movimientos_puntos_select ON public.movimientos_puntos
  FOR SELECT USING (
    es_admin()
    OR cliente_id IN (SELECT id FROM public.clientes WHERE usuario_id = auth.uid())
  );

DROP POLICY IF EXISTS movimientos_puntos_insert ON public.movimientos_puntos;
CREATE POLICY movimientos_puntos_insert ON public.movimientos_puntos
  FOR INSERT WITH CHECK (es_admin());

-- ── recompensas: el catálogo activo sigue siendo visible para toda la
--    empresa (es intencional, es la vidriera de canje) -- se deja el
--    SELECT como está. Se restringe escritura a es_admin().
DROP POLICY IF EXISTS recompensas_insert ON public.recompensas;
CREATE POLICY recompensas_insert ON public.recompensas
  FOR INSERT WITH CHECK (es_admin());

DROP POLICY IF EXISTS recompensas_update ON public.recompensas;
CREATE POLICY recompensas_update ON public.recompensas
  FOR UPDATE USING (es_admin()) WITH CHECK (es_admin());

DROP POLICY IF EXISTS recompensas_delete ON public.recompensas;
CREATE POLICY recompensas_delete ON public.recompensas
  FOR DELETE USING (es_admin());

-- ── programas_fidelizacion: mismo criterio, el comentario original ya
--    decía "solo dueño/admin" pero la condición nunca lo exigía.
DROP POLICY IF EXISTS programas_fidelizacion_insert ON public.programas_fidelizacion;
CREATE POLICY programas_fidelizacion_insert ON public.programas_fidelizacion
  FOR INSERT WITH CHECK (es_admin());

DROP POLICY IF EXISTS programas_fidelizacion_update ON public.programas_fidelizacion;
CREATE POLICY programas_fidelizacion_update ON public.programas_fidelizacion
  FOR UPDATE USING (es_admin()) WITH CHECK (es_admin());

DROP POLICY IF EXISTS programas_fidelizacion_delete ON public.programas_fidelizacion;
CREATE POLICY programas_fidelizacion_delete ON public.programas_fidelizacion
  FOR DELETE USING (es_admin());

-- ── canjes_recompensas: el SELECT amplio por empresa dejaba ver los
--    canjes de otros clientes (qué canjearon, cuándo). Se restringe a
--    lo propio + acceso admin. Se agrega el UPDATE que nunca existió
--    (ver Hallazgo 3: el botón "Aplicar"/"Expirar" del admin fallaba en
--    silencio por falta de policy). El INSERT también se ajusta para
--    que un cliente no pueda insertar una fila fantasma con el
--    cliente_id de otro cliente de la misma empresa (sin efecto real
--    sobre saldo/stock, pero ensucia la cola de canjes pendientes).
DROP POLICY IF EXISTS canjes_select ON public.canjes_recompensas;
CREATE POLICY canjes_select ON public.canjes_recompensas
  FOR SELECT USING (
    es_admin()
    OR cliente_id IN (SELECT id FROM public.clientes WHERE usuario_id = auth.uid())
  );

DROP POLICY IF EXISTS canjes_insert ON public.canjes_recompensas;
CREATE POLICY canjes_insert ON public.canjes_recompensas
  FOR INSERT WITH CHECK (
    es_admin()
    OR cliente_id IN (SELECT id FROM public.clientes WHERE usuario_id = auth.uid())
  );

DROP POLICY IF EXISTS canjes_update ON public.canjes_recompensas;
CREATE POLICY canjes_update ON public.canjes_recompensas
  FOR UPDATE USING (es_admin()) WITH CHECK (es_admin());
