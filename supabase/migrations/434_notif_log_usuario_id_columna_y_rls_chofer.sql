
ALTER TABLE notif_log ADD COLUMN usuario_id uuid REFERENCES usuarios(id) ON DELETE SET NULL;

-- Backfill solo donde el usuario todavía existe (hay ids en payload de
-- choferes/usuarios ya borrados; para esos queda NULL, se pierde el
-- historial de esa fila puntual pero no bloquea la migración).
UPDATE notif_log n
SET usuario_id = (n.payload->>'usuario_id')::uuid
FROM usuarios u
WHERE n.payload ? 'usuario_id'
  AND n.payload->>'usuario_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND u.id = (n.payload->>'usuario_id')::uuid;

CREATE INDEX idx_notif_log_usuario ON notif_log (usuario_id, tipo, created_at DESC);

DROP POLICY "notif_log_select_unificada" ON notif_log;

CREATE POLICY "notif_log_select_unificada"
  ON notif_log FOR SELECT
  USING (
    (SELECT auth.role()) = 'service_role'
    OR (
      get_rol_usuario() = ANY (ARRAY['dueno','admin','vendedor','depositero','contador']::rol_usuario[])
      AND empresa_id = auth_empresa_id()
    )
    OR (
      get_rol_usuario() = 'cliente'
      AND cliente_id = (
        SELECT c.id FROM clientes c JOIN usuarios u ON u.cliente_id = c.id
        WHERE u.id = (SELECT auth.uid()) LIMIT 1
      )
    )
    OR (
      get_rol_usuario() = 'chofer'
      AND usuario_id = (SELECT auth.uid())
    )
  );
