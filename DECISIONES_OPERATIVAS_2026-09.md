# Decisiones operativas registradas — 2026-09

Este documento registra decisiones de negocio/riesgo tomadas durante el
cierre de pendientes de auditoría (`PLAN_CIERRE_INTEGRAL_PENDIENTES_2026.md`),
para que no queden como ambigüedad flotando. Formato: una entrada por
decisión, con fecha, quién decide y qué se acepta.

---

## 0.1 — Rotar `SUPABASE_SERVICE_ROLE_KEY`

- **Fecha:** 2026-09-12
- **Decide:** CLAY
- **Contexto:** la key quedó expuesta en texto plano en un chat el 02/09/2026.
  También se encontró una copia en `.env.local` dentro de un zip de entrega
  (`distrib_v1072_fix_descuento_global_pos.zip`), fuera del repo pero
  circulando igual.
- **Decisión: no se rota por ahora.** Se acepta el riesgo de que la key
  (acceso total a la base, sin pasar por RLS) siga siendo la misma que
  estuvo expuesta.
- **Qué NO se hizo como consecuencia:**
  - No se generó una nueva `service_role_key` en Supabase.
  - No se actualizó la env var en Vercel (production/preview/development).
  - No se armó `.gitignore`/limpieza adicional sobre el `.env.local` suelto
    del zip (queda como está).
- **Para revisar más adelante:** si en algún momento se sospecha o confirma
  un acceso indebido a la base (movimientos raros en `audit_log`, filas que
  no cuadran, alertas de `pg_cron`/`security-audit-alert`), la rotación deja
  de ser opcional y pasa a ser inmediata — la decisión de hoy asume que el
  chat donde se filtró era privado y sin terceros con acceso.

---

## 1.1 — Prueba de restauración de backup: EN ESPERA

- **Fecha:** 2026-09-12
- **Decide:** CLAY
- **Bloqueante encontrado (verificado en vivo vía Supabase MCP, no supuesto):**
  intentar reactivar `distrib-restore-test` (`akuwtucebjqxmibvrwsh`) devuelve
  `ForbiddenException` — la organización (`francomatias16-commits`) ya tiene
  2 proyectos activos en plan Free (el límite): `jgiquzjwoedmzwqgzubr` (prod
  de distrib) y `shlezhmyyvjumxzcquex` (`gondean-construcciones`, otro
  proyecto). Para reactivar el de prueba hay que pausar uno de los dos
  activos o subir de plan.
- **Decisión: se deja 1.1 en espera.** No se pausa `gondean-construcciones`
  ni se sube de plan por ahora. La prueba de restore sigue sin completarse
  (los 4 puntos del plan original siguen pendientes: restore end-to-end,
  conteo de filas, RTO documentado, limpieza del proyecto de prueba).
- **Consecuencia directa:** esto es evidencia concreta, no hipotética, para
  la decisión de 1.2 (upgrade Supabase Free→Pro) — el límite de proyectos
  ya está topado hoy, no es un riesgo a futuro.

## Hallazgo documentado — `restore-to-test.yml` no prueba el backup real

- **Fecha:** 2026-09-12
- **Qué se encontró:** el workflow `.github/workflows/restore-to-test.yml`
  no descifra ni restaura el artifact cifrado (`backup_YYYY-MM-DD.dump.gpg`)
  que genera semanalmente `backup-supabase.yml`. En cambio hace un
  `pg_dump` en vivo directo de prod → proyecto de prueba, sin pasar en
  ningún momento por GPG ni por el archivo que realmente queda guardado
  como backup.
- **Por qué importa:** el criterio de cierre original de la Fase 1.1
  ("descifrar GPG, `pg_restore`") apunta a probar que el artifact semanal
  —lo que existiría el día que prod esté caída de verdad— es recuperable.
  El workflow actual prueba una cosa relacionada pero distinta: que el
  schema/datos de prod se pueden clonar en caliente a otro proyecto. Nunca
  se validó que un `.dump.gpg` descargado de GitHub Actions se pueda
  descifrar y restaurar sin acceso a prod.
- **Decisión: se usa el workflow existente tal cual está.** No se arma un
  workflow nuevo que sí pruebe el artifact cifrado end-to-end. Queda
  documentado como limitación conocida del proceso de backup/restore, para
  que si el día de mañana se necesita restaurar desde el artifact real y
  falla algo del cifrado/formato, no sea una sorpresa.

---

## 1.2 — Upgrade de plan Supabase (Free → Pro)

- **Fecha:** 2026-09-12
- **Decide:** CLAY
- **Contexto:** en Free no hay PITR (point-in-time recovery) — el único
  respaldo es el backup semanal manual/automatizado (`backup-supabase.yml`),
  lo que implica hasta 6 días de pérdida de datos en el peor caso. Además
  (evidencia de hoy, no hipotética): el límite de 2 proyectos activos por
  organización ya bloqueó completar la Fase 1.1 (no se pudo reactivar
  `distrib-restore-test` sin pausar otro proyecto).
- **Decisión: se acepta el riesgo por escrito. Se sigue en plan Free.**
  No se hace upgrade a Pro por ahora.
- **Qué queda aceptado explícitamente:**
  - Hasta 6 días de pérdida de datos posible ante un incidente grave en
    prod (sin PITR).
  - El límite de 2 proyectos activos sigue vigente — cualquier prueba que
    necesite un proyecto adicional (restore-test, branches, etc.) va a
    requerir pausar otro proyecto de la organización primero.
- **Para revisar más adelante:** si `distrib` empieza a facturar clientes
  reales con plata circulando (umbral que el plan original ya marca como
  el momento en que esto deja de ser aceptable sin revisar), esta decisión
  debería re-evaluarse.

---

## 2.1 — Nota de crédito tipo M: fantasma en el combo

- **Fecha:** 2026-09-12
- **Decide:** CLAY
- **Contexto:** "Nota de Crédito M" era una opción aceptada por el combo, por
  Node (`TIPOS_NC_VALIDOS`) y por el CHECK de `notas_credito`, pero sin
  ningún soporte real contra ARCA (sin código de comprobante M, sin la
  lógica de umbral de RG 3337, sin la percepción del 3%). Verificado en
  vivo (proyecto `jgiquzjwoedmzwqgzubr`, sin mocks): 0 notas de crédito
  reales usaban tipo M — no era un incidente en curso, sí un hallazgo
  real.
- **Decisión: Opción A — sacar M del sistema.** Se elimina la opción del
  combo (`facturacion.html`), de `TIPOS_NC_VALIDOS` (`facturas.js`) y del
  CHECK de la tabla (migración `623_fix_notas_credito_quitar_tipo_m.sql`,
  aplicada en producción). Queda solo A/B/C.
- **Qué NO se hizo como consecuencia:** no se implementó Factura/NC M real
  (código de comprobante, umbral RG 3337, percepción 3%) — eso queda para
  si algún cliente de CLAY realmente factura montos que disparen esa
  categoría.
- **Para revisar más adelante:** si aparece un cliente RI que necesite
  Factura M de verdad, esta decisión debe revisarse antes de reabrir la
  opción.

---

## 2.3 — Direcciones de entrega del portal cliente

- **Fecha:** 2026-09-12
- **Decide:** CLAY
- **Contexto:** verificado en vivo (proyecto `jgiquzjwoedmzwqgzubr`, sin
  mocks) que el CRUD de `cliente_direcciones` existe solo del lado admin
  (`lib/repos/cliente-direcciones.js` + `lib/handlers/clientes.js` +
  `frontend/admin/js/clientes/direcciones.js`); 91 direcciones cargadas
  para 90 clientes, todas entradas por ese camino. El portal cliente
  (`cuenta.html`) no tiene ningún formulario ni endpoint propio —
  `listarDireccionesPorCliente()` existe en el repo pero no la llama
  nada. Las policies RLS de `cliente_direcciones` solo cubren roles admin
  (`dueno/admin/contador/vendedor`); no hay policy para el rol de portal
  cliente, así que exponerlo tal cual hoy quedaría bloqueado por RLS.
  El copy de `cuenta.html` decía "direcciones de entrega" pese a que la
  única referencia real a domicilio ahí es un campo único de solo lectura
  (`clientes.domicilio`), sin relación con `cliente_direcciones`.
- **Decisión: no se construye el CRUD real en el portal por ahora.** Se
  saca la frase del copy en `cuenta.html` ("Tus datos, direcciones de
  entrega y estado de cuenta" → "Tus datos, estado de cuenta y
  recompensas"). El cliente sigue pidiendo altas/cambios de dirección por
  WhatsApp y se cargan desde el admin, como ya pasa hoy con las 91
  existentes.
- **Qué NO se hizo como consecuencia:** no se agregaron policies RLS para
  el rol de portal cliente sobre `cliente_direcciones`, no se creó
  endpoint de portal, no se agregó formulario de alta/edición en
  `cuenta.html`.
- **Para revisar más adelante:** si algún cliente pide puntualmente cargar
  sus propias direcciones desde el portal, esta decisión debería
  revisarse — el repo (`crearDireccion`, `actualizarDireccion`,
  `listarDireccionesPorCliente`) ya está listo para reusarse, falta solo
  RLS + endpoint + UI.

<!-- Plan cerrado: 2.1 y 2.3 resueltos. 2.2 (redondeo POS vs. centavos de
facturación) sigue pendiente. -->
