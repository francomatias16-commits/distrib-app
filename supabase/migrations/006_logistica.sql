-- 006_logistica.sql
-- Etapa 3 — Logística y reparto
--
-- Ejecutar después de 005_notif_log.sql
-- ────────────────────────────────────────────────────────────────────────────

-- ── 1. Tabla: rutas ──────────────────────────────────────────────────────────
-- Agrupa un conjunto de pedidos asignados a un chofer para un día.

CREATE TABLE rutas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID REFERENCES empresas(id) ON DELETE CASCADE,
  chofer_id       UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  fecha_entrega   DATE NOT NULL,
  nombre          TEXT,                         -- ej: "Zona Norte - Martes"
  estado          TEXT NOT NULL DEFAULT 'pendiente',
                  -- pendiente | en_camino | completada | cancelada
  notas           TEXT,
  despachado_at   TIMESTAMPTZ,
  completado_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_rutas_empresa_fecha ON rutas (empresa_id, fecha_entrega DESC);
CREATE INDEX idx_rutas_chofer        ON rutas (chofer_id, fecha_entrega DESC);

-- ── 2. Tabla: ruta_items ─────────────────────────────────────────────────────
-- Asocia pedidos a rutas con su orden de entrega.

CREATE TABLE ruta_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ruta_id      UUID REFERENCES rutas(id) ON DELETE CASCADE,
  pedido_id    UUID REFERENCES pedidos(id) ON DELETE CASCADE,
  empresa_id   UUID REFERENCES empresas(id) ON DELETE CASCADE,
  orden        INT  NOT NULL DEFAULT 1,         -- posición en el recorrido
  estado       TEXT NOT NULL DEFAULT 'pendiente',
               -- pendiente | en_camino | entregado | no_entregado | devolucion_parcial
  created_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE (ruta_id, pedido_id)
);

CREATE INDEX idx_ruta_items_ruta   ON ruta_items (ruta_id, orden);
CREATE INDEX idx_ruta_items_pedido ON ruta_items (pedido_id);

-- ── 3. Columnas adicionales en pedidos ──────────────────────────────────────
-- Registran el resultado final de cada entrega.

ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS entregado_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS motivo_no_entrega  TEXT,
  -- 'nadie_en_casa' | 'rechazo' | 'direccion_incorrecta' | 'otro'
  ADD COLUMN IF NOT EXISTS firma_url          TEXT,   -- URL pública en Supabase Storage
  ADD COLUMN IF NOT EXISTS foto_url           TEXT,   -- URL pública en Supabase Storage
  ADD COLUMN IF NOT EXISTS ubicacion_entrega  JSONB;  -- { lat, lng } al confirmar

-- ── 4. Tabla: devoluciones ───────────────────────────────────────────────────
-- Registra mercadería devuelta por el chofer durante la ruta.

CREATE TABLE devoluciones (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    UUID REFERENCES empresas(id) ON DELETE CASCADE,
  pedido_id     UUID REFERENCES pedidos(id)  ON DELETE SET NULL,
  cliente_id    UUID REFERENCES clientes(id) ON DELETE SET NULL,
  chofer_id     UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  motivo        TEXT NOT NULL,
  -- 'rechazo_cliente' | 'producto_danado' | 'pedido_incorrecto' | 'exceso_stock' | 'otro'
  notas         TEXT,
  estado        TEXT NOT NULL DEFAULT 'pendiente',
  -- pendiente | stock_liberado | nota_credito_emitida | cerrada
  foto_url      TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE devolucion_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  devolucion_id   UUID REFERENCES devoluciones(id) ON DELETE CASCADE,
  producto_id     UUID REFERENCES productos(id) ON DELETE SET NULL,
  cantidad        NUMERIC NOT NULL,
  precio_unitario NUMERIC NOT NULL DEFAULT 0
);

CREATE INDEX idx_devoluciones_empresa  ON devoluciones (empresa_id, created_at DESC);
CREATE INDEX idx_devoluciones_pedido   ON devoluciones (pedido_id);

-- ── 5. RLS ───────────────────────────────────────────────────────────────────

ALTER TABLE rutas            ENABLE ROW LEVEL SECURITY;
ALTER TABLE ruta_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE devoluciones     ENABLE ROW LEVEL SECURITY;
ALTER TABLE devolucion_items ENABLE ROW LEVEL SECURITY;

-- Admin / coordinador: acceso total a su empresa
CREATE POLICY "rutas: admin acceso empresa"
  ON rutas FOR ALL
  USING (empresa_id IN (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

CREATE POLICY "ruta_items: admin acceso empresa"
  ON ruta_items FOR ALL
  USING (empresa_id IN (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

-- Chofer: solo ve sus rutas del día
CREATE POLICY "rutas: chofer ve las suyas"
  ON rutas FOR SELECT
  USING (chofer_id = auth.uid());

CREATE POLICY "ruta_items: chofer ve los de sus rutas"
  ON ruta_items FOR SELECT
  USING (
    ruta_id IN (SELECT id FROM rutas WHERE chofer_id = auth.uid())
  );

-- Chofer: puede actualizar estado de ruta_items (al confirmar entregas)
CREATE POLICY "ruta_items: chofer actualiza estado"
  ON ruta_items FOR UPDATE
  USING (
    ruta_id IN (SELECT id FROM rutas WHERE chofer_id = auth.uid())
  );

CREATE POLICY "devoluciones: admin acceso empresa"
  ON devoluciones FOR ALL
  USING (empresa_id IN (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

CREATE POLICY "devolucion_items: acceso via devolucion"
  ON devolucion_items FOR ALL
  USING (
    devolucion_id IN (
      SELECT id FROM devoluciones
      WHERE empresa_id IN (SELECT empresa_id FROM usuarios WHERE id = auth.uid())
    )
  );

-- ── 6. Trigger: updated_at en rutas ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER rutas_updated_at
  BEFORE UPDATE ON rutas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 7. Ampliar notif_log: nuevos tipos ──────────────────────────────────────
-- Los nuevos tipos de notificación que genera notif-entrega.js:
--
--   'pedido_entregado'      → chofer confirmó entrega
--   'pedido_no_entregado'   → chofer registró no-entrega
--
-- No requieren cambios en el schema (la columna `tipo` es TEXT libre),
-- pero se documentan aquí para referencia y se agregan al índice de cooldown.

COMMENT ON COLUMN notif_log.tipo IS
  'Valores conocidos: confirmacion_pedido | pedido_despachado | pedido_entregado | pedido_no_entregado | pedido_cancelado | deuda_vencida';

-- ── 8. Storage buckets (ejecutar desde el dashboard de Supabase) ─────────────
--
-- Crear dos buckets privados en Supabase Storage:
--
--   firmas-entregas   → almacena las imágenes PNG de firma digital
--   fotos-entregas    → almacena las fotos tomadas por el chofer
--
-- Configuración recomendada:
--   • Privado (acceso solo con URL firmada de corta duración)
--   • Tamaño máximo: 2 MB por archivo
--   • Tipos permitidos: image/png, image/jpeg
--
-- Política de acceso (SQL):
--
-- CREATE POLICY "choferes pueden subir firmas"
--   ON storage.objects FOR INSERT
--   WITH CHECK (
--     bucket_id IN ('firmas-entregas', 'fotos-entregas')
--     AND auth.role() = 'authenticated'
--   );
--
-- CREATE POLICY "admin puede ver firmas y fotos de su empresa"
--   ON storage.objects FOR SELECT
--   USING (
--     bucket_id IN ('firmas-entregas', 'fotos-entregas')
--     AND auth.uid() IN (SELECT id FROM usuarios WHERE rol IN ('admin', 'coordinador'))
--   );
