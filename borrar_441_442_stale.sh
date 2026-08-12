#!/bin/bash
# Borra las migraciones locales 441/442 de offline dedup que quedaron
# huérfanas: nunca se aplicaron contra Supabase con esos números (ya
# estaban tomados por otras migraciones no relacionadas) y su contenido
# está desactualizado (el 442 es anterior al soporte multi-factura de
# registrar_cobro_completo). Reemplazadas por
# supabase/migrations/444_offline_dedup_entregas_devoluciones_cobro.sql
# (ver CHANGELOG_v646_offline_etapa3_aplicacion_real_supabase.md).
#
# Correr desde la raíz del repo.
set -e

git rm supabase/migrations/441_offline_dedup_entregas_devoluciones.sql
git rm supabase/migrations/442_offline_dedup_registrar_cobro_completo.sql
git commit -m "Borra migraciones 441/442 offline huérfanas (nunca se aplicaron con esos números, reemplazadas por 444_offline_dedup_entregas_devoluciones_cobro.sql)"

echo "Listo. Revisá con 'git log -1' y 'git push' cuando quieras."
