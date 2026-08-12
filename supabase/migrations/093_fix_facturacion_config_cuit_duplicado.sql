-- 093_fix_facturacion_config_cuit_duplicado.sql
-- DATA FIX: Resolver conflicto de CUIT duplicado en facturacion_config
-- 
-- PROBLEMA IDENTIFICADO:
-- La empresa demo "Distribuidora El Progreso" (ID 00000000-0000-0000-0000-000000000001)
-- tenía cargado el CUIT personal de Matías (20348211421) en facturacion_config,
-- cuando su CUIT real como empresa es 30-12345678-9.
-- Esto causaba que dos empresa_id distintos compitieran por el mismo Ticket de Acceso
-- ante ARCA/WSAA, generando el error "TA ya válido" que el código interpretaba como
-- "Error de red" en el flujo de homologación.
--
-- SOLUCIÓN:
-- 1. Desactivar la fila de facturacion_config de la empresa demo (CUIT incorrecto)
-- 2. Completar razon_social faltante en la fila de TEST_ARCA_Matias_Franco
-- 3. Limpiar token vencido de tokens_wsaa

-- 1. Desactivar fila incorrecta (empresa demo con CUIT personal de Matías)
UPDATE facturacion_config
SET activo = false
WHERE empresa_id = '00000000-0000-0000-0000-000000000001'
  AND cuit = '20348211421';

-- 2. Completar razon_social en la fila correcta
UPDATE facturacion_config
SET razon_social = 'Matias Exequiel Franco'
WHERE empresa_id = '5d4fd211-ca8b-49e2-adf0-c47da10c1cf2'
  AND cuit = '20348211421'
  AND (razon_social IS NULL OR razon_social = '');

-- 3. Limpiar tokens vencidos (idempotente)
DELETE FROM tokens_wsaa WHERE expiration < NOW();

-- Registrar en registry
INSERT INTO schema_migrations_registry (carpeta, archivo, numero, aplicada_en, notas)
VALUES (
  'db',
  '093_fix_facturacion_config_cuit_duplicado.sql',
  93,
  NOW(),
  'DATA FIX: Desactivado facturacion_config de empresa demo con CUIT incorrecto. Limpiado token vencido. Causa raíz del error TA ya válido en ARCA/WSAA.'
)
ON CONFLICT (carpeta, archivo) DO UPDATE SET aplicada_en = NOW();

