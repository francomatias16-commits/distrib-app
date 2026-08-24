-- ============================================================
-- 456 — Modo solo lectura para el usuario demo público
-- ============================================================
--
-- CONTEXTO:
-- El botón "Ver demo en vivo" de la landing (/demo → /admin/login?demo=1)
-- hace auto-login con demo@distrib-test.local y entra como un admin
-- normal: puede ver TODO pero también podía escribir/borrar datos de la
-- empresa demo compartida (ver lib/demo-mode.js, que solo bloqueaba
-- integraciones externas reales — ARCA/WhatsApp/email — no escritura en
-- la base).
--
-- Esta migración agrega un flag a nivel de usuario (no de empresa, para
-- poder tener en el futuro otro usuario admin real y escribible sobre la
-- misma empresa demo si hiciera falta) que el dispatcher (api/index.js)
-- usa para cortar cualquier mutación (POST/PATCH/PUT/DELETE) ANTES de
-- llegar al handler correspondiente, devolviendo 403.
--
-- De paso, renombra el usuario demo a "Marina Torres" para que la demo
-- pública se sienta como una cuenta de una persona real en vez de un
-- usuario técnico "demo@...".

ALTER TABLE public.usuarios
  ADD COLUMN IF NOT EXISTS solo_lectura boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.usuarios.solo_lectura IS
  'Si es true, el dispatcher (api/index.js) bloquea con 403 cualquier '
  'request que no sea GET/HEAD para este usuario, sin importar su rol. '
  'Pensado para la cuenta demo pública de la landing (ver lib/demo-mode.js '
  'para el bloqueo equivalente de integraciones externas reales).';

UPDATE public.usuarios
SET
  solo_lectura = true,
  nombre       = 'Marina Torres'
WHERE email = 'demo@distrib-test.local';
