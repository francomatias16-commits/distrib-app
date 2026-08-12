# Auditoría pre-lanzamiento — distrib-app

> Generado a partir de: Supabase advisors (`jgiquzjwoedmzwqgzubr`), `PLAN_COMERCIALIZACION_DISTRIB.md`, `TESTING_OPTIMIZACION.md`, `checklist_pase_manual.md` y revisión directa del repo (v699/v700).
> Marcá cada casillero a medida que lo ejecutás. Orden = prioridad de ejecución.

---

## 🔴 BLOQUEANTE — antes de publicar

### 1. Confirmar deploy de los fixes de seguridad críticos (sesión 26/07)

`TESTING_OPTIMIZACION.md` documenta 11 fixes cross-tenant/escalación de rol corregidos en código pero con estado "pendiente deploy". 5 son 🔴 crítico.

- [ ] Verificar en Vercel (Project → Deployments) si el último deploy a `main` es posterior a los commits de estos fixes. **No verificable sin acceso a Vercel — pendiente de confirmación manual.**
- [ ] Si no: correr `vercel --prod`.
- [x] **FACTURAS-002** — confirmado en el código (`lib/handlers/facturas.js` línea 150: valida `pedidoCheck.empresa_id !== empresa_id`). Deploy a Vercel sin confirmar.
- [x] **PUNTOS-001** — confirmado en vivo contra Supabase (2026-08-10): `acreditar_puntos`/`canjear_puntos` validan `empresa_id` propio y rol `dueno`/`admin`.
- [x] **COMPRAS-001** — confirmado en vivo contra Supabase (2026-08-10): `recepcionar_orden_compra` y `crear_orden_compra` validan tenant (`assert_empresa_access`).
- [x] **SCORE-001** — confirmado en vivo contra Supabase (2026-08-10): `calcular_score_cliente` tiene el guard de tenant.
- [x] **CRON-001** — código confirmado (`score.js`, `stock.js`, `stock-auto.js`, `cierre.js`, `notif.js` ya validan `Authorization: Bearer $CRON_SECRET`).
  - [ ] `CRON_SECRET` en Vercel → Settings → Environment Variables — no verificable sin acceso a Vercel.
  - [x] **Curl manual verificado — 200 OK, confirmado por el usuario (2026-08-10).**

### 2. Ejecutar el checklist de pase manual completo

Archivo `checklist_pase_manual.md` en el repo — 9 fixes verificados solo por lectura de código, nunca clickeados. ~45 min.

- [ ] **F4-01** — Filtro "Borrador" en `/admin/pedidos` (chip dice "Borrador", filtra bien).
- [ ] **F4-02** — Precio de catálogo cliente vs. carrito vs. checkout: los 3 deben coincidir con precio especial/regla aplicada (**toca plata real, no saltear**).
- [ ] **F4-03** — Portal proveedor no debe mostrar OCs en borrador/pendientes de aprobar.
- [ ] **F4-04** — `cantidad_disponible` consistente entre `/admin/stock` y `/cliente/catalogo` en: venta POS, anulación de venta, transferencia entre depósitos.
- [ ] **UI-003** — Modal "Zona" en `/admin/rutas` no se abre solo al entrar a la pestaña.
- [ ] **F3-03** — Banner "por vencer" y badges de lotes (`/admin/vencimientos`) muestran estado real (Vencido/Agotado/Activo).
- [ ] **F3-04** — KPIs de Cobranzas se actualizan en vivo tras registrar un cobro (sin F5).
- [ ] **F3-05** — Emitir una Nota de Crédito actualiza el tab "Facturas" (factura pasa a "Anulada", botón "Anular" desaparece) sin recargar.
- [ ] **UI-001/002** — Recargar rápido (Ctrl+R ×3-4) en `/admin/vencimientos`, `/admin/cc-proveedores`, `/admin/reglas-precio`, `/admin/fidelizacion`, `/admin/puntos`, `/admin/anomalias`, `/admin/notif-log`, `/admin/whatsapp-conversaciones`, `/admin/auditoria`, `/admin/saas-billing` — ningún modal debe quedar abierto solo.
- [ ] **Dashboard animaciones (sesión actual)** — sumar a esta tanda: odómetros, pulso "en vivo", flash de pedido nuevo, burbuja WhatsApp + "escribiendo...", idle/ca-ching POS, glow ARCA, barra y gauge que se dibujan. Todo validado por sintaxis, nunca en navegador real.

---

## 🟠 ALTO — muy cerca del lanzamiento

### 3. Auth — protección de contraseñas filtradas
- [ ] Supabase → Authentication → Policies → habilitar "Leaked password protection" (HaveIBeenPwned). 1 click, cero motivo para no tenerlo antes de abrir registro público.

### 4. ARCA en modo producción (no homologación)
- [ ] Por cada cliente real que se dé de alta: cargar certificado/clave real en `facturacion-config.html`.
- [ ] Confirmar que el flag `homologacion` queda en `false` para ese tenant.
- [ ] (Mejora sugerida, no bloqueante) Agregar un indicador visible en el admin ("Facturando en modo TEST") para que no pase desapercibido si un tenant queda mal configurado.

### 5. Definir tratamiento fiscal de comprobante tipo M
- [ ] Decisión de negocio pendiente (no técnica): `crear_nota_credito` trata tipo **M** igual que **C** (sin IVA discriminado). Confirmar si la operatoria con monotributistas sociales requiere otro tratamiento antes de habilitarlo a un cliente que lo use.

### 6. Cerrar los últimos 🔍 pendientes de auditoría de datos
- [x] `lotes.estado` — **cerrado 2026-08-10.** Consistente: 0 lotes vencidos marcados "activo", 0 agotados marcados "activo". Sin acción.
- [x] `pagos_proveedor.medio_pago` — **cerrado 2026-08-10, la premisa original era incorrecta.** Sí existe whitelist: `CHECK (medio_pago = ANY (ARRAY['efectivo','transferencia','cheque','otro']))`. No hay riesgo.
- [x] `presupuestos.estado = 'vencido'` — **cerrado 2026-08-10.** Se registró el job `vencer-presupuestos-diario` en `pg_cron` con la misma lógica de la migración 078 (marca `vencido` los presupuestos `enviado` con `fecha_vencimiento` pasada). **Ojo:** la migración 078 tenía el cron string mal escrito — el comentario decía "3am Argentina ≈ 6am UTC" pero usaba `'0 3 * * *'` (eso corre a las 3am UTC = medianoche Argentina, no 3am Argentina). Se registró con `'0 6 * * *'`, que sí coincide con la intención original (3am Argentina). Confirmado en `cron.job`: `active = true`. **Migración `453_auditoria_prelanzamiento_indices_policy_cron.sql` agregada al repo** documentando este fix junto con los de las secciones 8 y 9 (ver abajo), para que el historial de migraciones quede sincronizado con lo aplicado en producción.

---

## 🟡 MEDIO — post-lanzamiento, no bloquea

### 7. Documentar las 7 tablas con RLS sin policy
**Reverificado en vivo contra Supabase advisors (2026-08-10): siguen siendo exactamente estas 7, sin cambios.** Ninguna se llama desde el frontend (solo backend con service role), así que no rompen nada hoy. Queda pendiente solo la documentación de intención (no hay acción de código):
- [ ] `api_rate_limits`
- [ ] `asistente_articulos`
- [ ] `asistente_uso`
- [ ] `chofer_invitaciones`
- [ ] `contador_uso_apis`
- [ ] `demo_snapshots`
- [ ] `pos_scanner_tokens`

### 8. Índices de performance
- [x] **Aplicado y verificado 2026-08-10** — índice de cobertura agregado a las 6 foreign keys que el advisor marcaba sin índice: `asistente_acciones_pendientes.empresa_id`, `banco_codigos_producto.aportado_por`, `cta_cte.anulado_por`, `pos_scanner_tokens.creado_por`, `tareas_automatizacion.completada_por`, `tareas_automatizacion.regla_id`. Confirmado contra el advisor de performance que las 6 alertas `unindexed_foreign_keys` desaparecieron (los nuevos índices figuran como "unused" simplemente porque recién se crearon, es esperable). Documentado en `supabase/migrations/453_auditoria_prelanzamiento_indices_policy_cron.sql`.
- [ ] Revisar y eventualmente eliminar ~40 índices nunca usados (lista completa disponible bajo pedido). Los 6 índices recién agregados arriba también aparecen ahora como "unused" en el advisor — es esperable, recién se crearon; no confundir con índices viejos sin uso real. No urgente con el volumen actual, revisar de nuevo cuando haya tráfico real.

### 9. Fusionar policies duplicadas
- [x] **Resuelto 2026-08-10.** `reglas_automatizacion_modify` (FOR ALL) se redujo a tres policies específicas (`reglas_automatizacion_insert`, `_update`, `_delete`, mismas condiciones `dueno`/`admin`), dejando `reglas_automatizacion_select` como única responsable de SELECT. El permiso efectivo no cambió (antes el OR de ambas quals para SELECT ya equivalía a `empresa_id = get_empresa_id()`, igual que la policy `_select` sola). Confirmado contra el advisor de performance: la alerta `multiple_permissive_policies` para esta tabla ya no aparece. Documentado en `supabase/migrations/453_auditoria_prelanzamiento_indices_policy_cron.sql`.

### 10. SEO básico
- [ ] Agregar `robots.txt` y `sitemap.xml` a `frontend/`. **Confirmado 2026-08-10: ninguno de los dos existe en el repo.** La landing (`frontend/index.html`) ya tiene `<title>`, `meta description` y Open Graph bien resueltos, pero no tiene `<link rel="canonical">` ni `og:url` — no se encontró el dominio de producción en ningún archivo del repo (`index.html`, `replit.md`, `env-config.js`, `vercel.json`). **Falta el dominio real para poder generar `sitemap.xml` con URLs absolutas correctas — decime cuál es y los armo.**

---

## ✅ Ya cerrado — no darle más vueltas

- Multi-tenancy y RLS de tablas de negocio reales — auditado con 11 fixes cross-tenant ya encontrados y corregidos.
- 26 CHECK constraints de la capa comercial — auditados contra código y frontend (`PLAN_COMERCIALIZACION_DISTRIB.md` sección 3).
- Onboarding guiado, trial automatizado, self-serve de cambio de plan, billing SaaS — validados contra Supabase real.
- Landing page (`frontend/index.html`) — meta tags y Open Graph completos.

---

## Orden de ejecución sugerido

1. Sección 1 (deploy + `CRON_SECRET`) — **hoy, antes que nada más**.
2. Sección 2 (checklist manual, ~45 min).
3. Sección 3 (toggle de Auth, 1 min).
4. Secciones 4-6 según qué clientes reales estés por dar de alta primero.
5. Secciones 7-10 cuando haya aire, no bloquean el lanzamiento.
