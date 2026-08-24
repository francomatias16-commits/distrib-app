-- ─────────────────────────────────────────────────────────────────────────
-- 473_etiquetas_genericas.sql
--
-- Sistema de etiquetas (tags) genérico y reusable para cualquier entidad
-- del sistema (productos, clientes, proveedores, etc.), siguiendo el mismo
-- patrón polimórfico que ya usa notas_internas (entidad_tipo + entidad_id),
-- así no hace falta agregar columnas nuevas por cada tabla que quiera
-- etiquetas.
--
-- etiquetas          → catálogo de etiquetas por empresa (nombre + color)
-- entidad_etiquetas  → tabla puente: qué etiqueta está asignada a qué fila
--                       de qué tabla (entidad_tipo = 'productos'|'clientes'|...)
--
-- Arranca usándose en Productos (pedido del dueño), pero cualquier otra
-- pantalla puede sumarse después sin tocar el schema.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS etiquetas (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  color       TEXT DEFAULT '#6A9873',
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(empresa_id, nombre)
);

CREATE TABLE IF NOT EXISTS entidad_etiquetas (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  entidad_tipo TEXT NOT NULL,
  entidad_id   UUID NOT NULL,
  etiqueta_id  UUID NOT NULL REFERENCES etiquetas(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE(entidad_tipo, entidad_id, etiqueta_id)
);

CREATE INDEX IF NOT EXISTS idx_entidad_etiquetas_entidad
  ON entidad_etiquetas(empresa_id, entidad_tipo, entidad_id);
CREATE INDEX IF NOT EXISTS idx_entidad_etiquetas_etiqueta
  ON entidad_etiquetas(etiqueta_id);
CREATE INDEX IF NOT EXISTS idx_etiquetas_empresa
  ON etiquetas(empresa_id, nombre);

ALTER TABLE etiquetas ENABLE ROW LEVEL SECURITY;
ALTER TABLE entidad_etiquetas ENABLE ROW LEVEL SECURITY;

-- Mismo criterio de RLS que notas_internas: solo se ve/opera lo de la
-- propia empresa (empresa_id = la del usuario autenticado).
DROP POLICY IF EXISTS "etiquetas_empresa" ON etiquetas;
CREATE POLICY "etiquetas_empresa" ON etiquetas
  FOR ALL USING (
    empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid())
  );

DROP POLICY IF EXISTS "entidad_etiquetas_empresa" ON entidad_etiquetas;
CREATE POLICY "entidad_etiquetas_empresa" ON entidad_etiquetas
  FOR ALL USING (
    empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid())
  );

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '473_etiquetas_genericas.sql', '473', 'claude-session',
  'Sistema genérico de etiquetas (tags): tabla etiquetas (catálogo por empresa) + '
  'entidad_etiquetas (puente polimórfico entidad_tipo/entidad_id, mismo patrón que '
  'notas_internas). Arranca en Productos, reusable para cualquier otra tabla sin '
  'migrar el schema de nuevo. RLS por empresa igual que el resto del sistema.')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
