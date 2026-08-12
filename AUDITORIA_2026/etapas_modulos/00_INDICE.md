# Auditoría por módulos de negocio (pedidos, stock, AFIP, etc.)

**Distinta de `AUDITORIA_2026/etapas/` (esa es la auditoría de seguridad/infra,
11-12 etapas, 🟢 cerrada por completo).** Esta es una segunda auditoría, de
18 módulos de negocio, mencionada solo de pasada en
`CHANGELOG_v304_auditoria2026_etapas13_18.md`. Los archivos de detalle de
las etapas 1-12 se habían perdido (mismo problema que tuvo originalmente
"12_riesgo_cheques.md" de la otra auditoría) — se están recuperando a
medida que aparecen.

## Estado

| # | Módulo | Estado | Archivo |
|---|--------|--------|---------|
| 1 | Pedidos (carrito → confirmación → stock → notificaciones) | 🟢 4/4 hallazgos corregidos en código — desplegado (confirmado por el usuario 2026-07-13; ver nota de deploy) (migraciones SQL de Hallazgo 3 ya activas en producción) | `01_pedidos.md` |
| 2 | Stock y depósitos | 🟢 4/4 hallazgos corregidos (backend + interfaz) — DB aplicada en producción, código desplegado (confirmado por el usuario 2026-07-13) | `02_stock_depositos.md` |
| 3 | Cta. cte. y cobros | 🟢 3/3 hallazgos corregidos (backend + interfaz) — sin migraciones SQL, solo código desplegado (confirmado por el usuario 2026-07-13) | `03_cta_cte_cobros.md` |
| 4 | Facturación AFIP/ARCA | 🟢 3/3 hallazgos — Hallazgo 3 (RLS) ya aplicado en Supabase; Hallazgos 1 y 2 (código) ya desplegados (confirmado por el usuario 2026-07-13) | `04_facturacion_afip.md` |
| 5 | Medios de pago online | 🟢 4/4 hallazgos corregidos en código (sin migraciones SQL) — desplegado (confirmado por el usuario 2026-07-13; ver nota de deploy) | `05_medios_pago.md` |
| 6 | Rutas y entregas | 🟢 2/2 hallazgos corregidos (backend + interfaz), 1 corrección manual de datos ya aplicada en Supabase — código desplegado (confirmado por el usuario 2026-07-13). **Corregido en el índice el 2026-07-12: este módulo sí se auditó (v313), estaba mal marcado como pendiente por desactualización del índice, no por falta de trabajo real.** | `06_rutas_entregas.md` |
| 7 | POS (venta, caja, devoluciones) | 🟢 Auditoría completa — 5 hallazgos: 2 housekeeping/deuda técnica (migraciones), 2 documentación de usuario, 1 ya resuelto antes de esta auditoría. Sin fixes de código pendientes de deploy (la renumeración de migración ya se aplicó directo al repo). | `07_pos.md` |
| 8 | Portal de proveedores / órdenes de compra | 🟢 4/6 hallazgos corregidos en código (2 informativos/higiene sin acción) — desplegado (confirmado por el usuario 2026-07-13; ver nota de deploy) (sin migraciones SQL) | `08_portal_proveedores_ordenes_compra.md` |
| 9 | Notas de crédito y débito / devoluciones | 🟢 3/3 hallazgos corregidos (1 crítico ya aplicado en Supabase, backend+interfaz ya desplegados (confirmado por el usuario 2026-07-13)) | `09_notas_credito_debito_devoluciones.md` |
| 10 | Fidelización (puntos y recompensas) | 🟢 6 hallazgos (1 crítico) — 5/6 corregidos en código/DB (desplegado, confirmado por el usuario 2026-07-13); el 6to resuelto por decisión de producto (2026-07-13): no se implementa POS+puntos, se ajustó la ayuda | `10_fidelizacion_puntos_recompensas.md` |
| 11 | Usuarios, roles y permisos | 🟢 4/4 hallazgos corregidos en código (sin migraciones SQL) — desplegado (confirmado por el usuario 2026-07-13; ver nota de deploy) | `11_usuarios_roles_permisos.md` |
| 12 | Notificaciones (push/email/WhatsApp) fuera de pedidos | 🟢 Auditoría completa, Hallazgos 1 y 2 corregidos en código (2026-07-13) — pendiente `git push`/deploy + aplicar migración 316. 3 hallazgos: 1 baja (era media — falso positivo parcial: el push de "anomalía detectada" ya existía y funcionaba vía cron `/api/auditoria`, solo faltaba el toggle en el panel admin, ya agregado), 1 baja-media corregida (reenvío manual de emails implementado — el diagnóstico real fue más profundo que "falta un botón": 3 de 4 tipos de email ni logueaban sus fallas), 1 ajuste de texto en la ayuda (pendiente). | `12_notificaciones.md` |
| 13-18 | (21 hallazgos: puntos, migración, fechas UTC/ART, suspensión SaaS, límite de plan, notif-log) | 🟢 Corregidos y documentados | `../../CHANGELOG_v304_auditoria2026_etapas13_18.md` |

## Etapa 1 — Pedidos: resumen de hallazgos

| Hallazgo | Severidad | Estado |
|---|---|---|
| 1. Factura con error de ARCA invisible en `pedidos.html` (**375 casos reales confirmados en producción hoy**) | 🔴 Alta | Pendiente |
| 2. Notificaciones de confirmación (WhatsApp/email/push) fallan en silencio, sin registro | 🔴 Alta-media | ✅ Corregido en código — `CHANGELOG_v305_etapa1_hallazgo2_notif_log.md`. Sin migración SQL (no hacía falta, `notif_log` ya tenía las columnas). **Ya desplegado (confirmado por el usuario 2026-07-13).** También se encontró y corrigió, de paso, un bug no documentado en el hallazgo original: el push de "pedido confirmado" al cliente le pegaba al endpoint equivocado y nunca se entregó desde que existe la función. |
| 3. Pedido duplicado por reintento tras timeout de red (sin idempotencia) | 🟡 Media | Pendiente |
| 4. Mensaje de sesión vencida poco accionable en el carrito | 🟡 Baja-media | Pendiente |

Los 4 son fixes de código, ninguno requiere decisión de costo/plan.

## Nota de metodología (agregada tras revisar etapas 2 y 3)
Cada etapa nueva de acá en más cubre **backend y la interfaz real**
(mensajes, botones, estados de carga, campos que parecen funcionar pero no
hacen nada) en la misma pasada — no como revisión separada después.

## Nota de corrección del índice (2026-07-12)
Al retomar la auditoría se detectó que este índice marcaba la etapa 6
(Rutas y entregas) como "⚪ Pendiente, salteada a pedido del usuario", pero
existía `CHANGELOG_v313_etapa6_no_entrega_y_rutas_duplicadas.md` con una
auditoría completa de ese módulo (2 hallazgos, ambos corregidos en código,
uno con corrección manual de datos ya aplicada en Supabase). El archivo de
detalle `06_rutas_entregas.md` nunca se creó en su momento — mismo problema
de pérdida de archivos que motivó esta reconstrucción del índice. Se
recuperó el contenido desde el changelog y se corrigió el estado acá. La
etapa 7 (POS), en cambio, sí estaba genuinamente pendiente: no había
ningún changelog ni archivo de detalle para ese módulo.

## Nota sobre esta integración (etapas 9, 10 y 11)
Las etapas 9, 10 y 11 se auditaron en sesiones distintas, cada una
partiendo del mismo estado base (post-etapa 8) sin verse entre sí. Al
integrarlas en un solo codebase se detectó una sola superposición real:
etapa 9 y etapa 10 tocaban `lib/handlers/pedidos.js` en secciones
distintas del mismo archivo (etapa 9: revisión de devoluciones; etapa 10:
cancelación de pedido) — se mergearon ambos cambios sin conflicto. El
resto de los archivos tocados por cada etapa no se solapa. Las
migraciones SQL de las tres etapas (296-298 de etapa 10, 315 de etapa 9)
ya estaban aplicadas en producción antes de esta integración — se
versionan acá solo para que queden en el repo.

## Cómo continuar en una sesión nueva
Subí este zip de trabajo (o al menos este archivo) y decime:

**"Seguí con la auditoría de módulos, etapa 12"**

Con eso retomo directo de la tabla de arriba, sin que tengas que repetir
el orden ni el contexto. El mecanismo es siempre el mismo: audito el
módulo, aplico las migraciones SQL que hagan falta directo en Supabase, y
te paso un zip chico solo con lo que cambió (código + este índice
actualizado) para que hagas `git push`/deploy.

## Nota de deploy (2026-07-13)
El usuario confirmó haber hecho `git push`/deploy a Vercel del código
acumulado de las etapas 1-11 (backend + frontend). No se pudo verificar
técnicamente desde acá (sin conector de Vercel/GitHub conectado en esta
sesión), así que queda registrado como confirmado por el usuario, no
verificado por la auditoría. Las migraciones SQL de estas etapas ya
estaban confirmadas aplicadas en Supabase de forma independiente (ver
notas de cada etapa arriba).

## Próximo paso
Las 12 etapas de este bloque de la auditoría por módulos están completas,
y las dos decisiones de producto que quedaban abiertas (etapa 10,
Hallazgo 6, y etapa 12, Hallazgo 1) ya se resolvieron el 2026-07-13.

Queda código nuevo sin desplegar: el fix de Etapa 12, Hallazgo 1
(checkbox `pref-auditoria_anomalia` en
`frontend/admin/automatizacion.html`) — sin migración SQL, se puede
incluir en el próximo `git push`/deploy junto con lo que se acumule. El
ajuste de la ayuda de fidelización (Hallazgo 6, etapa 10) es contenido
markdown, no requiere build especial pero sí que se despliegue el repo
igual que el resto.

No quedan etapas de este bloque (1-12) sin auditar, ni decisiones de
producto pendientes. Recordar que las etapas 13-18 son un bloque aparte,
ya cerrado (ver fila correspondiente arriba), y que la auditoría de
seguridad/infra (`AUDITORIA_2026/etapas/`, 11 etapas) es una auditoría
totalmente distinta y ya está cerrada por completo.
