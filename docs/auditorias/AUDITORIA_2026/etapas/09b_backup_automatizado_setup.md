# Etapa 9 (cont.) — Setup del backup automatizado (opción 2 de BACKUP-01)

**Estado:** 🟢 Resuelto — workflow corriendo en verde, backups semanales
automáticos activos. Pendiente solo la prueba de restauración (ver abajo).

## Qué se hizo (2026-08-15/16)

### 1. Backup manual inmediato (red mínima mientras se arreglaba lo automático)
Export completo de las 121 tablas del schema `public` (18.842 filas, ~8.8 MB)
vía SQL directo contra producción, verificado fila por fila contra
`pg_stat_user_tables` (sin desvíos), comprimido y cifrado con GPG (AES256).

⚠️ La passphrase de una corrida anterior de este mismo proceso había quedado
impresa en texto plano en el historial de otra conversación — se la
consideró comprometida y no se reutilizó. Recomendado: para backups
recurrentes, generar la passphrase localmente (`openssl rand -base64 24`) en
lugar de pedírsela al asistente, así nunca queda en un chat.

### 2. Workflow automatizado (`.github/workflows/backup-supabase.yml`) — 3 bugs encontrados y resueltos

El workflow ya existía desde julio (`#1`–`#15` en el historial de Actions,
con corridas mezcladas éxito/fallo), pero fallaba de forma intermitente.
Se reescribió y depuró en 3 iteraciones, cada una diagnosticada con el log
real de una corrida fallida:

1. **Auth error por password sin URL-encoding.** Antes se armaba a mano una
   única URL de conexión en el secret `SUPABASE_DB_URL`. Si el password de
   la base tenía caracteres especiales (`@ / : % ? #`), la URL quedaba mal
   formada. Fix: se reemplazó ese secret único por 5 secrets separados
   (`SUPABASE_DB_HOST`, `_PORT`, `_NAME`, `_USER`, `_PASSWORD`) y el
   workflow arma la URL él mismo, aplicando URL-encoding solo sobre el
   segmento del password.

2. **`FATAL: Tenant or user not found`.** El host del pooler estaba mal:
   `aws-0-us-west-2.pooler.supabase.com` en vez del real,
   `aws-1-us-west-2.pooler.supabase.com` (Supabase tiene varios clusters
   por región y cada proyecto usa uno específico — solo se ve en el
   dashboard, Connect → Connection string → Session, no por API). Fix:
   secret `SUPABASE_DB_HOST` corregido al valor exacto.

3. **`pg_dump: error: aborting because of server version mismatch`.** El
   runner de GitHub Actions trae preinstalado `pg_dump` 16.x, pero el
   proyecto corre Postgres 17.6 — `pg_dump` no puede volcar un servidor más
   nuevo que él mismo. Fix: se suma el repo oficial de PostgreSQL (PGDG)
   para instalar `postgresql-client-17`, y se antepone su carpeta de
   binarios al `PATH` (el paquete no pisa el `pg_dump` viejo
   automáticamente).

**Resultado:** corrida manual de prueba en verde, con `pg_dump --version`
confirmando 17.x en el log y artifact cifrado generado correctamente.

## Qué hace el workflow (versión final)
`.github/workflows/backup-supabase.yml`:
1. Corre todos los domingos 06:00 UTC (03:00 hora Argentina), o a mano desde
   **Actions → Backup Supabase (semanal) → Run workflow**.
2. Instala `pg_dump` 17 (matching la versión del servidor).
3. Arma la cadena de conexión con URL-encoding automático del password.
4. `pg_dump -Fc` (formato custom, comprimido, permite restore selectivo).
5. Cifra el dump con GPG simétrico (AES256).
6. Lo sube como **artifact** de GitHub Actions, retención 90 días.

## Secrets configurados en GitHub (Settings → Secrets and variables → Actions)

| Secret | Valor |
|---|---|
| `SUPABASE_DB_HOST` | `aws-1-us-west-2.pooler.supabase.com` |
| `SUPABASE_DB_PORT` | `5432` (modo Session del pooler) |
| `SUPABASE_DB_NAME` | `postgres` |
| `SUPABASE_DB_USER` | `postgres.jgiquzjwoedmzwqgzubr` |
| `SUPABASE_DB_PASSWORD` | password de la base, sin codificar — el workflow lo codifica solo |
| `BACKUP_GPG_PASSPHRASE` | passphrase de cifrado, generada localmente y guardada en gestor de contraseñas aparte |

El viejo `SUPABASE_DB_URL` (single-secret) quedó dado de baja.

## Cómo restaurar un backup (pendiente de probar, no cuando haya una emergencia)

```bash
# 1. Descargar el artifact desde la pestaña Actions del run correspondiente
#    (se descarga como .zip, adentro está el .dump.gpg)

# 2. Descifrar
gpg --batch --yes --passphrase "LA_PASSPHRASE" \
    --decrypt backup_2026-08-16.dump.gpg > backup_2026-08-16.dump

# 3. Restaurar contra un proyecto Supabase de prueba (NO directo sobre
#    producción, para no pisar nada por error)
pg_restore --no-owner --no-privileges \
    -d "postgresql://postgres.NUEVO_PROYECTO:[PASSWORD]@aws-1-us-west-2.pooler.supabase.com:5432/postgres" \
    backup_2026-08-16.dump
```

**Pendiente de verificación (marcar cuando se haga):** correr este proceso de
restauración al menos una vez contra un proyecto Supabase de prueba — un
backup nunca probado no es un backup confiable. Es el único punto que falta
para cerrar BACKUP-01 del todo.

## Límites de esta solución (por qué no reemplaza el upgrade a Pro)
- Retención de 90 días en artifacts (no indefinida).
- Sin PITR — solo se puede volver al punto del último dump semanal (hasta 7
  días de pérdida de datos en el peor caso), no a un segundo específico.
- Mantenimiento del workflow y rotación de la passphrase a cargo del
  usuario, no de Supabase.
- Plan Free se pausa tras 7 días de inactividad (no es riesgo hoy por
  actividad constante, pero es otra razón para el upgrade a Pro a mediano
  plazo).

Sigue recomendado el upgrade a Pro ($25/mes) como solución definitiva; este
workflow es la red de seguridad mínima mientras esa decisión se toma.
