-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 415: clientes.cuit acepta también DNI
--
-- BUG: el modal "Nuevo cliente" del POS (alta rápida) tiene un único campo
-- rotulado "CUIT / DNI", pero el constraint clientes_cuit_formato (migración
-- 077) solo aceptaba el formato estricto de CUIT (XX-XXXXXXXX-X). Cualquier
-- DNI (7-8 dígitos) o CUIT sin guiones ingresado ahí rompía el INSERT con un
-- error de constraint que el handler devolvía como "No se pudo crear el
-- cliente. Intentá de nuevo." sin explicar la causa real.
--
-- FIX: relajar el CHECK para aceptar:
--   • CUIT con guiones:      XX-XXXXXXXX-X
--   • CUIT sin guiones:      11 dígitos
--   • DNI:                   7 u 8 dígitos
-- El normalizado (agregar guiones cuando son 11 dígitos) se hace en el
-- handler (lib/handlers/pos.js), no acá — el constraint solo valida forma.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.clientes
  DROP CONSTRAINT IF EXISTS clientes_cuit_formato;

ALTER TABLE public.clientes
  ADD CONSTRAINT clientes_cuit_formato
    CHECK (
      cuit IS NULL
      OR cuit ~ '^\d{2}-\d{8}-\d{1}$'   -- CUIT con guiones
      OR cuit ~ '^\d{11}$'              -- CUIT sin guiones (se normaliza en el handler)
      OR cuit ~ '^\d{7,8}$'             -- DNI
    );
