-- ============================================================
-- 242_etapa1_logistica_aviso_proximidad_entrega.sql
-- Etapa 1 (Logística) — Plan por etapas.
--
-- Soporta el aviso automático al cliente ("tu pedido está a ~15 min")
-- que dispara POST /api/rutas-live?accion=posicion cuando el chofer
-- entra en el radio de ETA configurado para la próxima entrega
-- pendiente de su ruta. La columna evita reenviar el aviso en cada
-- ping de GPS (el chofer manda su posición cada ~25s).
-- ============================================================

ALTER TABLE entregas
  ADD COLUMN IF NOT EXISTS aviso_proximidad_enviado boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN entregas.aviso_proximidad_enviado IS
  'true una vez que se le avisó al cliente que el pedido está por llegar (ETA <= 15 min). Se resetea a false si la entrega se reordena hacia atrás (ver rutas-live.js).';

-- Registro en la tabla de tracking de migraciones del proyecto
INSERT INTO schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '242_etapa1_logistica_aviso_proximidad_entrega.sql',
  '242',
  'claude_assistant',
  'Etapa 1 del plan por etapas (Logística): agrega entregas.aviso_proximidad_enviado para soportar la notificación automática al cliente cuando el chofer está a ~15 min de distancia.'
)
ON CONFLICT DO NOTHING;
