# Etapa 9 (cont.) — Setup del backup automatizado (opción 2 de BACKUP-01)

**Estado:** 🟡 Workflow creado, falta que el usuario configure 2 secrets en GitHub y haga push.

Mientras se decide el upgrade a Supabase Pro, se implementó la opción 2 de
`09_backups_disaster_recovery.md`: backup semanal propio vía GitHub Actions.

## Qué hace
`.github/workflows/backup-supabase.yml`:
1. Corre todos los domingos 06:00 UTC (03:00 hora Argentina), o a mano desde
   la pestaña **Actions → Backup Supabase (semanal) → Run workflow**.
2. `pg_dump -Fc` (formato custom, comprimido, permite restore selectivo).
3. Cifra el dump con GPG simétrico (AES256).
4. Lo sube como **artifact** de GitHub Actions, retención 90 días.

## Lo que falta que hagas vos (2 secrets en GitHub)

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

1. **`SUPABASE_DB_URL`** — la cadena de conexión en **modo Session** (puerto
   `5432`), **no** el pooler en modo transacción (puerto `6543`) — `pg_dump`
   necesita sesión persistente y `pg_dump` con pooler de transacción falla.
   - Se consigue en el dashboard de Supabase: **Project Settings → Database →
     Connection string → URI**, pestaña **Session** (no "Transaction").
   - Formato: `postgresql://postgres.jgiquzjwoedmzwqgzubr:[TU-PASSWORD]@aws-0-us-west-2.pooler.supabase.com:5432/postgres`
   - El password es el de la base (no tu password de login a Supabase) — si no
     lo tenés a mano, se resetea en la misma pantalla.

2. **`BACKUP_GPG_PASSPHRASE`** — cualquier passphrase larga y random que vos
   elijas (por ejemplo generada con `openssl rand -base64 32`). **Guardala en
   un lugar seguro aparte** (gestor de contraseñas): sin ella, los backups
   cifrados no se pueden restaurar. Ni yo ni nadie con acceso solo al repo
   puede recuperarla si se pierde.

Una vez cargados ambos secrets, con el próximo push el workflow queda activo.
Podés forzar una corrida de prueba inmediatamente desde la pestaña Actions
(no hace falta esperar al domingo).

## Cómo restaurar un backup (probar esto ahora, no cuando haya una emergencia)

```bash
# 1. Descargar el artifact desde la pestaña Actions del run correspondiente
#    (se descarga como .zip, adentro está el .dump.gpg)

# 2. Descifrar
gpg --batch --yes --passphrase "LA_PASSPHRASE" \
    --decrypt backup_2026-07-13.dump.gpg > backup_2026-07-13.dump

# 3. Restaurar contra un proyecto Supabase (idealmente uno nuevo/branch de
#    prueba, NO directo sobre producción, para no pisar nada por error)
pg_restore --no-owner --no-privileges \
    -d "postgresql://postgres.NUEVO_PROYECTO:[PASSWORD]@aws-0-us-west-2.pooler.supabase.com:5432/postgres" \
    backup_2026-07-13.dump
```

**Pendiente de verificación (marcar cuando se haga):** correr este proceso de
restauración al menos una vez contra un proyecto Supabase de prueba (se puede
crear uno gratis nuevo solo para el test) — un backup nunca probado no es un
backup confiable. Sugerido como parte del cierre real de BACKUP-01.

## Límites de esta solución (por qué no reemplaza el upgrade a Pro)
- Retención de 90 días en artifacts (no indefinida).
- Sin PITR — solo se puede volver al punto del último dump semanal (hasta 7
  días de pérdida de datos en el peor caso), no a un segundo específico.
- El mantenimiento del workflow y la rotación de la passphrase quedan a cargo
  del usuario, no de Supabase.
- Sigue sin haber SLA sobre la disponibilidad del proyecto en sí (plan Free
  se pausa tras 7 días de inactividad — no es un riesgo hoy por actividad
  constante, pero es otra razón más para el upgrade a Pro a mediano plazo).

Sigue recomendado el upgrade a Pro ($25/mes) como solución definitiva; este
workflow es la red de seguridad mínima mientras esa decisión se toma.
