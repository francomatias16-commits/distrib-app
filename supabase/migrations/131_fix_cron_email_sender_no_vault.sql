-- 131_fix_cron_email_sender_no_vault.sql
-- La Edge Function saas-email-sender tiene verify_jwt=false.
-- El cron la llama sin Authorization header (no necesita vault).

SELECT cron.unschedule('saas_email_sender_hourly');

SELECT cron.schedule(
  'saas_email_sender_hourly',
  '0 * * * *',
  $$
    SELECT net.http_post(
      url     := 'https://jgiquzjwoedmzwqgzubr.supabase.co/functions/v1/saas-email-sender',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body    := '{}'::jsonb
    );
  $$
);
