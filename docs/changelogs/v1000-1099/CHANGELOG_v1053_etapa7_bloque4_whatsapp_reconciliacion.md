# v1053 — Etapa 7, Bloque 4 (Asistente WhatsApp): reconciliación de migraciones — 1 gap encontrado y cerrado

## Corrección de alcance

El plan lista v906, v910-v911, v914, v923, v943-v944, v986, v1010-v1012
para este bloque. De esos, **v906, v910, v911, v914, v943 no son de
WhatsApp/asistente** (son UI de pastillas de confianza de clientes, avatar
de topbar/usuarios — nada que ver con el canal de pedidos). v944 sí
menciona "asistente" pero es un revert cosmético del ítem de menú, sin
lógica del asistente. Rango real reconciliado: **v923, v944, v956, v986
(hay dos changelogs v986 — se usó el de WhatsApp, no el de "split
productos"), v1010, v1011, v1012.**

## Reconciliación de migraciones

- v923 (CSP para imagen del chat): sin DDL.
- v944 (revert ítem de menú): sin DDL.
- v956: migración `537_fix_race_confirmar_pedido_sugerido.sql` — existe en
  el repo. Sin gap.
- v986 (WhatsApp business id prefill): migración
  `544_whatsapp_business_id_prefill_reconexion.sql` — existe en el repo,
  fila `544` presente en `schema_migrations_registry`. Sin gap.
- v1010, v1011: sin DDL.
- **v1012 (tab "Historial" de conversaciones) — gap real, mismo patrón que
  v796/v805/v772:** el changelog referencia
  `supabase/migrations/ — migración whatsapp_conversaciones_historial_view`
  pero ese archivo nunca existió en el repo. Confirmado contra `pg_views`
  en el proyecto real que la vista `v_whatsapp_conversaciones_historial`
  sí está en producción, con `security_invoker=true` y la misma definición
  documentada en el changelog.

## Fix

- **Migración `575_backfill_view_whatsapp_conversaciones_historial_v1012.sql`**:
  `CREATE OR REPLACE VIEW` con la definición exacta capturada de
  producción — sin cambio de comportamiento, puro backfill de
  trazabilidad. Aplicada contra `jgiquzjwoedmzwqgzubr` y verificada no-op
  (la vista ya existía idéntica). Registrada en `schema_migrations_registry`
  (fila `575`).

## Bloque 4 — estado

Reconciliación de migraciones cerrada, con 1 gap encontrado y cerrado.
Falta, si se quiere profundizar: revisión línea por línea de
`lib/asistente-tools`/`lib/asistente-providers` y el pase manual de los
casos borde del plan (fallback a humano bajo carga, doble mensaje en
paralelo con el batch de v1010).

Con esto quedan cerrados los 4 bloques de la Etapa 7 en su paso de
reconciliación de migraciones. Pendiente transversal para el cierre de la
etapa: el pase manual en navegador real (diferido en los 4 bloques) y,
si se quiere, la revisión línea por línea de código de cada bloque.
