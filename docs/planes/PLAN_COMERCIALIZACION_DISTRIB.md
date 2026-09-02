# Plan de Comercialización — distrib (v1.47.2)

> Actualizado. Los 4 ítems de la sección 2 (§2.1–§2.3 ya en producción, más
> los ítems 1–4 de sofisticación comercial) están cerrados. El detalle de los
> 4 hallazgos de la auditoría de integridad de datos (ítem 4) y su resolución
> está documentado en `CHANGELOG_v1.47.2_fixes_validacion.md` — este archivo
> deja de repetir ese detalle y solo referencia el estado final.

---

## 1. Estado de la capa de comercialización (ya implementado)

| Sección | Contenido | Estado |
|---|---|---|
| §2.1 | Registro público con validación de CUIT + email vía Resend | ✅ Producción |
| §2.2 | Setup wizard, flag `setup_completado`, redirect en primer login | ✅ Producción |
| §2.3 | Automatización de trial vía `pg_cron` (con fix de Edge Function por vault secret faltante) | ✅ Producción |

## 2. Próximos pasos de sofisticación comercial

1. **Onboarding guiado post-trial**: checklist de activación (primera carga de productos, primer pedido, primera venta POS) para medir *time-to-value* real y disparar emails de nurturing si una empresa no activa en N días.
   ✅ **Cerrado.** Backend (migración 186: `saas_panel_admin` + `saas_dashboard_kpis` con
   `activadas`/`en_riesgo`, cron `saas_cron_activacion_check` + email
   `onboarding_nudge` vía Resend) y checklist visual en el dashboard del
   cliente (`GET /api/admin/onboarding` + card en `dashboard.html`)
   implementados y ahora validados de punta a punta (harness jsdom cargando
   `dashboard.html` + `api-client.js` + `dashboard-optimizado.js` reales, sin
   modificarlos, contra 5 escenarios: 0/2, 1/2, activada, cerrado a mano,
   backend caído). Los 5 pasaron sin encontrar bugs: progreso (0%/50%),
   link "Continuar" al paso correcto (`/admin/productos` → `/admin/pos`),
   auto-ocultado al activarse, persistencia del cierre manual en
   `localStorage`, y degradación correcta si el endpoint falla (no rompe el
   dashboard). Fix de la migración 188 (`dias_desde_alta >= 3`) verificado
   aplicado en la base real (`jgiquzjwoedmzwqgzubr`), cron
   `saas_activacion_check_diario` confirmado activo (`30 11 * * *`).
   Sigue sin ser un click real en Chrome (no hay conector de navegador
   disponible en esta sesión) — es la validación más fuerte posible sin uno.
2. **Métricas de conversión trial→pago**: vista/rpc que cruce `empresas.trial_vence` con uso real (pedidos, ventas_pos) para segmentar leads calientes vs. en riesgo de churn.
   ✅ Cubierto por la misma migración 186 — KPIs `activadas`/`en_riesgo` ya
   visibles en `saas-billing.html` (panel superadmin).
3. **Self-serve upgrade/downgrade de plan**: hoy el alta es 100% manual salvo el trial; falta un flujo de cambio de plan sin intervención humana.
   ✅ Implementado (migración 187 — `saas_tenant_cambiar_plan`): el dueño/admin
   de una cuenta activa y al día puede subir o bajar entre Básico/Pro desde
   `mi-suscripcion.html`. Enterprise queda fuera del self-serve (precio a
   medida). El downgrade se bloquea con mensaje claro si el uso actual
   (usuarios/clientes) excede el límite del plan destino. El billing sigue
   siendo transferencia manual — el RPC solo actualiza `plan_tier` +
   `saas_precio_mes`, que ya toma el generador de facturas existente para
   el próximo período.
4. **Auditoría de integridad de datos como argumento de venta**: el anexo de abajo no es solo QA interno — es la base para poder decir "cada dato que cargás está validado contra reglas de negocio reales", algo vendible a distribuidoras que migran de Excel.
   ✅ **Cerrado** (ver `CHANGELOG_v1.47.2_fixes_validacion.md` para el detalle
   completo). Los 26 constraints están auditados; los 4 hallazgos accionables
   quedaron resueltos: #1 (`crear_nota_credito` sin whitelist) y #2
   (`audit_log` rompía en rollback de migración) tienen fix de código
   aplicado; #3 (`ordenes_compra` PATCH) se confirmó que **no** era bug —
   los 3 estados faltantes los setean RPCs/jobs automáticos a propósito; #4
   (`recepciones_mercaderia = 'descartada'` sin código) era un gap real, ya
   implementado (endpoint `descartar-recepcion` + botón en `compras.html`).
   La opción **M** ya está presente en ambos `<select>` de tipo de
   comprobante (`cc-proveedores.html` y `facturacion.html`), verificado
   directamente en el código.

**Único pendiente real de toda la sección 2**: el ítem 1 (onboarding
guiado) está implementado en backend y frontend, pero solo se validó por
lectura de código, no en un navegador real. En esa revisión de código apareció
un bug real y ya corregido: `saas_cron_activacion_check()` (migración 186)
usaba `dias_desde_alta = 3` (igualdad exacta) — si el cron diario no corría
justo ese día, la empresa perdía el nudge de onboarding para siempre. Fix
aplicado en migración 188 (`>= 3`, mismo criterio que `en_riesgo`). Falta
todavía el test end-to-end en navegador del checklist completo.

---

## 3. Anexo: Validación integral de tablas con valores fijos (CHECK constraints)

Fuente de verdad: `pg_constraint` en Supabase (proyecto `jgiquzjwoedmzwqgzubr`),
26 constraints `CHECK (... = ANY (ARRAY[...]))` en 21 tablas. Cruzado contra
cada handler (`lib/handlers/*.js`), RPC de Postgres y `<select>` de frontend
que alimenta esos campos.

Leyenda: ✅ validado en cada capa · ⚠️ gap de defensa-en-profundidad (el front
restringe bien, pero el handler/RPC no revalida, así que una llamada directa a
la API rompe con un 500 crudo de Postgres en vez de un 400 prolijo) · 🔴 bug
real encontrado · 🔍 pendiente de confirmar

| Tabla.columna | Valores permitidos (DB) | Backend | Frontend | Estado |
|---|---|---|---|---|
| `devoluciones.estado` | pendiente, aprobada, rechazada | `pedidos.js` valida antes de RPC | — | ✅ |
| `devoluciones.motivo` | producto_defectuoso, error_pedido, cliente_arrepentido, vencido, otro | `MOTIVOS_VALIDOS` en `pedidos.js` | — | ✅ |
| `facturas_proveedor.estado` | pendiente, parcial, pagada, anulada | Transición real solo vía RPC `registrar_pago_proveedor` (valida `anulada`/`pagada`) | Solo lectura, no envía `estado` | ⚠️ el PATCH genérico acepta `estado` crudo sin whitelist — inalcanzable desde la UI hoy, pero expuesto a nivel API |
| `facturas_proveedor.origen` | admin, proveedor | `portal_proveedor.js` fija `'proveedor'` a mano | — | ✅ |
| `facturas_proveedor.tipo` | A, B, C, M, X | Recibido del body sin whitelist | `cc-proveedores.html` solo ofrece A/B/C/X (falta **M**) | ⚠️ gap de feature, no de seguridad |
| `notas_credito.estado` | pendiente, emitida, aplicada, anulada, error_afip | Gestionado 100% por flujo AFIP en `facturas.js` | — | ✅ |
| `notas_credito.tipo` | A, B, C, M | `facturas.js` pasa `tipo \|\| 'C'` **sin whitelist** al RPC `crear_nota_credito`, que tampoco valida ni tiene `EXCEPTION WHEN OTHERS` | `facturacion.html` (`#nc-tipo`) solo ofrece A/B/C | 🔴 **ver hallazgo 1** |
| `notas_debito_proveedor.estado` | pendiente, aplicada, anulada | Usos consistentes verificados | — | ✅ |
| `movimientos_caja.tipo` | sangria, refuerzo, retiro_final | Whitelist explícita en `pos.js:1107` | — | ✅ |
| `turnos_caja.estado` | abierto, cerrado | Gestionado por RPC de apertura/cierre, nunca input directo | — | ✅ |
| `venta_pos_pagos.medio` | efectivo, transferencia, tarjeta, qr, cuenta_corriente | Handler solo chequea `truthy`, confía en el `CHECK` vía RPC `registrar_venta_pos` | `MEDIOS_PAGO` en `pos.js` frontend calza exacto con los 5 valores | ⚠️ defensa en profundidad débil en el handler, pero el path real de uso está cerrado |
| `promociones.tipo` | nxm, descuento_categoria, descuento_producto | Whitelist explícita en `pos.js:1712` | — | ✅ |
| `ordenes_compra.estado` | borrador, pendiente_aprobacion, enviada, confirmada, recibida_parcial, recibida, cancelada | PATCH en `proveedores.js:487` solo permite 4 de los 7 valores (`borrador, enviada, confirmada, cancelada`) | — | 🔍 **ver hallazgo 2** — a confirmar si es restricción intencional (los otros 3 estados los setean `stock-auto.js` y el flujo de recepción, no el PATCH manual) |
| `recepciones_mercaderia.estado` | borrador, confirmada, descartada | `importar.js` setea `borrador`, `proveedores.js` setea `confirmada` | — | 🔍 no se encontró ningún camino de código que setee `descartada` — posible funcionalidad de UI faltante |
| `cola_financiera.estado` | pendiente, procesando, completado, error, omitido | Máquina de estados interna en `cierre.js`, sin input externo | — | ✅ |
| `comprobantes_historicos.tipo` | factura, nota_credito, nota_debito | Validado explícitamente en `migracion.js` con mensaje de error claro | — | ✅ |
| `audit_log.accion` | INSERT, UPDATE, DELETE | `migracion.js:3319` inserta `accion: 'ROLLBACK_MIGRACION'` | — | 🔴 **ver hallazgo 3** |
| `presupuestos.estado` | borrador, enviado, aceptado, rechazado, vencido | `pedidos.js` valida `['aceptado','rechazado']` en el endpoint de decisión | — | ✅ para ese endpoint · 🔍 no se encontró job que setee `vencido` automáticamente — confirmar si existe o es estado muerto |
| `pagos_proveedor.medio_pago` | efectivo, transferencia, cheque, otro | Protegido por RPC `registrar_pago_proveedor` (default JS `'transferencia'`, pero sin whitelist si se manda otro valor) | Select del frontend calza exacto | ⚠️ igual patrón que arriba, bajo riesgo |
| `lotes.estado` | activo, agotado, vencido | 🔍 no auditado en esta sesión | — | 🔍 pendiente |
| `cheques.estado` | 7 valores | Auditado en sesión anterior | — | ✅ (según auditoría previa) |
| `ventas_pos.estado` | completada, anulada | Auditado en sesión anterior | — | ✅ (según auditoría previa) |
| `migracion_sesiones.entidad` / `.estado`, `migracion_staging_rows.accion`, `schema_migrations_registry.carpeta` | internos | Sin input de usuario final, generados por el propio backend | — | ✅ bajo riesgo estructural |

### Hallazgos accionables — todos cerrados

Detalle completo de causa, fix y verificación de los 4 hallazgos (#1 y #2
bugs de código con fix aplicado; #3 confirmado como diseño correcto, no bug;
#4 gap real, implementado) en `CHANGELOG_v1.47.2_fixes_validacion.md`. No se
repite acá para evitar que este documento y el changelog queden
inconsistentes entre sí otra vez.

Pendiente fiscal (no técnico, requiere confirmación tuya): `crear_nota_credito`
trata el tipo **M** igual que **C** (sin IVA discriminado) — confirmar si tu
operatoria con monotributistas sociales requiere otro tratamiento.

---

## 4. Estado general

Ítems 1–4 de la sección 2 cerrados, incluido el ítem 1 (onboarding), ahora
validado en harness jsdom + verificación directa contra Supabase real. No
queda ningún pendiente conocido en el plan de comercialización. Único matiz:
ninguna de las dos validaciones de UI de esta ronda (migración maestra,
checklist de onboarding) fue un click real en un navegador Chrome — no hay
conector de navegador disponible en esta sesión —, así que sigue siendo
recomendable un smoke test manual liviano en algún momento antes de un
lanzamiento grande.
