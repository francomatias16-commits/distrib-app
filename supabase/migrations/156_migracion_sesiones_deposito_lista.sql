-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 156: migracion_sesiones.deposito_id / lista_precio_id
--
-- El wizard de migración de productos siempre escribía el stock en el
-- depósito "es_principal" y el precio en la lista "es_default", sin
-- preguntar. Una distribuidora con depósito central + sucursal, o con
-- lista mayorista/minorista, no tenía forma de elegir destino.
--
-- Se agregan dos columnas opcionales a la sesión: si vienen NULL, el
-- handler sigue cayendo al comportamiento anterior (principal/default),
-- así que esto es retrocompatible con sesiones ya creadas o en curso.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE migracion_sesiones
  ADD COLUMN IF NOT EXISTS deposito_id     UUID REFERENCES depositos(id),
  ADD COLUMN IF NOT EXISTS lista_precio_id UUID REFERENCES listas_precios(id);
