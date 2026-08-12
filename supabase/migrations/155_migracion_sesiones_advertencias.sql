-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 155: migracion_sesiones.resumen_advertencias
--
-- migracion_confirmar_clientes_lote (migración 154) devuelve "advertencias"
-- por lote (ej: vendedor no encontrado) que antes se perdían apenas terminaba
-- la llamada HTTP, porque el wizard confirma en múltiples lotes sucesivos y
-- nada las acumulaba. Se agrega una columna para juntarlas a lo largo de toda
-- la sesión y poder mostrarlas al usuario al finalizar la importación.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE migracion_sesiones
  ADD COLUMN IF NOT EXISTS resumen_advertencias JSONB;
