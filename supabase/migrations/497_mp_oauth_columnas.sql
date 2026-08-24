-- ═══════════════════════════════════════════════════════════════════════════
-- 497_mp_oauth_columnas.sql
--
-- Hoy conectar Mercado Pago exige que el dueño de cada empresa cliente
-- entre al panel de desarrolladores de MP, cree una "aplicación" y pegue
-- el Access Token a mano (guardarConfigMP, sin OAuth) — fricción técnica
-- real para un usuario no técnico. Se agrega soporte de OAuth ("Conectar
-- con Mercado Pago" en un click, ver mpOauthIniciarHandler/
-- mpOauthCallbackHandler en lib/handlers/pagos.js) sin romper el flujo
-- manual existente, que se mantiene como alternativa.
--
-- Columnas nuevas en integraciones_pago (mismo criterio que access_token:
-- refresh_token también se guarda cifrado con AES-256-GCM vía
-- lib/crypto-secrets.js, nunca en texto plano):
--   - refresh_token:    para renovar el access_token OAuth sin pedirle
--                        nada al usuario. NULL en conexiones manuales y en
--                        Prisma (no aplica).
--   - token_expires_at: vencimiento del access_token OAuth vigente. NULL
--                        en conexiones manuales/Prisma.
--   - conectado_via:    'manual' (Access Token pegado a mano, default —
--                        preserva el comportamiento de las filas ya
--                        existentes) u 'oauth' (flujo nuevo). Determina si
--                        hay que intentar refrescar el token antes de
--                        usarlo (ver obtenerAccessTokenMPValido).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.integraciones_pago
  ADD COLUMN IF NOT EXISTS refresh_token    TEXT,
  ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS conectado_via    VARCHAR(10) NOT NULL DEFAULT 'manual';

COMMENT ON COLUMN public.integraciones_pago.refresh_token IS
  'Refresh token OAuth cifrado (AES-256-GCM, igual que access_token). Solo se completa cuando conectado_via = oauth.';
COMMENT ON COLUMN public.integraciones_pago.token_expires_at IS
  'Vencimiento del access_token OAuth vigente. NULL para conexiones manuales y para Prisma.';
COMMENT ON COLUMN public.integraciones_pago.conectado_via IS
  'manual (Access Token pegado a mano) u oauth (botón "Conectar con Mercado Pago"). Default manual por compatibilidad con filas existentes.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '497_mp_oauth_columnas.sql', '497', 'claude-session',
  'Agrega refresh_token/token_expires_at/conectado_via a integraciones_pago para soportar conexión de Mercado Pago vía OAuth (elimina la fricción de pegar el Access Token a mano).')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
