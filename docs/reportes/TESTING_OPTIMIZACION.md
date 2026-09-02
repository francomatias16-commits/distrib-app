# TESTING_OPTIMIZACION — distrib

> Documento vivo. Se actualiza durante las sesiones de testing con Claude.

## 🔄 Cómo retomar esto en una sesión nueva (leer primero)

**Si estás arrancando una sesión nueva de Claude (otro chat), pegale este mensaje inicial:**

> "Estoy retomando el proceso de testing + optimización de distrib. Te subo el archivo `TESTING_OPTIMIZACION.md` actual. Tenés acceso a Supabase (proyecto `jgiquzjwoedmzwqgzubr`) para diagnosticar en modo lectura. Mirá el dashboard, elegí conmigo qué módulo sigue, y cargá los hallazgos directo en el archivo a medida que aparecen. No apliques ningún fix a la base sin que yo lo confirme antes."

**Reglas fijas de cómo trabajamos (para que Claude las siga sin que se las repitas):**

1. **Diagnóstico = libre.** Leer tablas, funciones, triggers, políticas RLS, y buscar inconsistencias en los datos reales vía Supabase no requiere tu aprobación previa — es de solo lectura.
2. **Aplicar un fix a la base = con tu OK explícito.** Cada `apply_migration` se hace de a uno, nunca en lote, y se te avisa qué se aplicó apenas termina.
3. **Todo hallazgo se carga en este archivo en el momento**, no se guarda "para después" — con su ID, tipo, impacto, y estado.
4. **Nada queda "cerrado para siempre"**, solo "vigente a la fecha". Se reabre si cambia el contexto (ver plantilla de hallazgo más abajo).
5. **Lo que requiere código (frontend `pos.js`, backend Node, etc.) queda marcado como pendiente** hasta que subas el archivo correspondiente — Claude no lo adivina.
6. **Vos bajás y commiteás el `.md` actualizado al repo al final de cada sesión.** El historial real de versiones vive en `git log`, no dentro del archivo.
7. **Las pruebas manuales de tu lado (las que requieren usar el sistema real, no solo revisar código/base) se acumulan en la lista de abajo y las hacés todas juntas al final**, no una por una interrumpiendo el flujo. Claude sigue diagnosticando y aplicando fixes de código/base sin esperarte; cuando termina una tanda, te avisa qué quedó para que verifiques vos.

## ✅ Pendientes de prueba manual (tu lado — hacer todas juntas)

> Orden de ejecución (agregado 2026-07-26): primero el deploy único que habilita casi todo, después las verificaciones de mayor a menor severidad.

**-1) ⚠️ Antes que nada, verificar en Vercel (Project → Settings → Environment Variables):**

- [ ] **CRON-001:** confirmar que `CRON_SECRET` está configurada en producción. Si no lo está, agregarla ANTES de deployar (los 10 cron jobs de `vercel.json` van a devolver 401/503 sin ella después de este deploy).

**0) Deploy (un solo paso, habilita 10 de los 12 puntos de código de abajo):**

- [ ] `vercel --prod` — sube de una BILLING-002, AUTOMATIZACION-001/002, MIGRACION-001/002, VENC-001/002, FRONTEND-001/002, SUGERENCIAS-001, CLIENTES-001/002, REGLAS-001, LISTAS-001, FACTURAS-002, CHOFER-001 y ASISTENTE-001.

**1) 🔴 Crítico — probar primero:**

- [ ] **PUNTOS-001** (no depende del deploy, ya está en Supabase): "Acreditar"/"Canjear" manual en `/admin/puntos` sigue funcionando para dueño/admin.
- [ ] **CHOFER-001:** con dos choferes reales, que el chofer B no vea ni pueda operar (detalle, entregar, no-entregar, devolución) remitos de una ruta asignada al chofer A. Confirmar que dueño/admin siguen sin restricción.
- [ ] **FACTURAS-002:** emitir una factura real desde un pedido propio (regresión del camino feliz) y confirmar que sigue funcionando igual que antes.
- [ ] **CRON-001:** después del deploy, esperar a que corra el próximo cron programado (o disparar uno manualmente con `curl -H "Authorization: Bearer $CRON_SECRET" https://tu-dominio/api/piloto?accion=generar`, por ejemplo) y confirmar en los logs de Vercel que se ejecuta OK (200), no 401/503. Si da 401/503, revisar que `CRON_SECRET` esté bien configurada.

**2) 🟠 Alto:**

- [ ] **ASISTENTE-001:** con un usuario `vendedor` o `contador` real, preguntarle al chat por deuda de un proveedor / cheques rechazados y confirmar que responde que no tiene permiso. Confirmar que dueño/admin siguen recibiendo la respuesta normal.

**2.5) 🔴 Funcional (feature rota, no seguridad):**

- [ ] **PORTALCLIENTE-001:** abrir un link de WhatsApp de "pedido sugerido" (o generar uno de prueba) y confirmar que ahora sí carga el preview con los items/total y el botón "Confirmar Pedido" funciona de punta a punta.

**3) 🟡 Funcional (cuenta corriente / cobranzas):**

- [ ] **POS-002:** venta con cuenta corriente → devolución parcial → verificar que el saldo del cliente baje lo esperado.
- [ ] **COBRANZAS-003:** cobrar una factura pendiente desde Cobranzas (parcial y total) → confirmar que no tira error y que sale de "pendientes" al saldarse.

**4) UI / doble-click / XSS (menor riesgo, regresión visual):**

- [ ] **CLIENTES-001/002:** crear precio especial/dirección con cliente y producto propios; confirmar que los botones de fila no disparan doble request.
- [ ] **REGLAS-001:** crear/editar una regla de precio con producto/categoría/zona propios.
- [ ] **LISTAS-001:** activar/desactivar lista de precio, click normal y doble-click rápido.
- [ ] **MIGRACION-001/002:** revisar tabla de filas importadas (sin XSS) y botones de plantilla de mapeo.
- [ ] **VENC-001/002:** lote con `numero_lote` con caracteres raros (sin XSS), y doble-click en "Dar de baja"/"Eliminar" lote.
- [ ] **FRONTEND-001/002:** "Confirmar match" en Conciliación bancaria (doble-click) y "Guardar" en Configuración de empresa.
- [ ] **SUGERENCIAS-001:** regresión del flujo normal de sugerencias de pedido.
- [ ] **BILLING-002:** regresión de `desbloquearSiSaldado`.
- [ ] **AUTOMATIZACION-001/002:** regresión del motor de cron (sigue disparando automatizaciones normalmente).

*(esta lista se va sumando a medida que aparecen más — no hace falta pausar el testing para resolverlas una por una)*

**Estado actual en una frase:** revisamos POS + Cuenta Corriente + Auth/RLS + Stock + Notificaciones + Portal Proveedores + Billing + Cobranzas/Riesgo de cheques + Frontend transversal + Automatización + Migración de datos + Vencimientos/Lotes/Liquidación + Sugerencias de pedido + Clientes/Productos (catálogo) + Reglas y listas de precio + Compras/Proveedores + Auditoría de regresión migración 142 + Facturación/Notas de crédito + Reportes + Choferes/Logística + Puntos/Fidelización + Asistente/IA + Portal Cliente + Infraestructura/Cron Jobs — todos sin pendientes de código conocidos salvo deploy. Se corrigieron 3 XSS almacenados (MIGRACION-001, VENC-001 ×2 archivos), 11 fixes de seguridad de cross-tenant/escalación de rol/bypass de auth (AUTOMATIZACION-001 cron-impersonation, SUGERENCIAS-001 empresa_id sin validar, CLIENTES-002 cliente_id/producto_id sin validar, REGLAS-001 producto_id/categoria_id/zona_id sin validar, **COMPRAS-001 🔴 crítico — RPC ejecutable directo por cualquier autenticado sin validar tenant, ya aplicado en Supabase**, **SCORE-001 🔴 crítico — regresión de guard de tenant en `calcular_score_cliente`, aplicado en Supabase**, NC-001 — `crear_nota_credito` sin validar `factura_id` propio, aplicado en Supabase, **FACTURAS-002 🔴 crítico — IDOR directo en `POST /api/facturas`, sin bypass de RLS necesario, corregido en código**, CHOFER-001 🟠 — chofer podía operar remitos de otro chofer, corregido en código, **PUNTOS-001 🔴 crítico — cualquier autenticado podía auto-acreditarse puntos ilimitados, aplicado en Supabase**, **ASISTENTE-001 🟠 — tools del chat sin chequeo de rol de negocio, exponían datos que el nav le oculta a vendedor/contador/depositero, corregido en código**, **CRON-001 🔴 crítico — 10 endpoints de cron confiaban en un header spoofeable (`x-vercel-cron`) en vez de `CRON_SECRET`, corregido en código**), 1 bug funcional grave (**PORTALCLIENTE-001 🔴 — el link de WhatsApp para confirmar "pedido sugerido" no cargaba nunca por una RLS que bloqueaba por completo al caller sin login, corregido en código**), y varios faltantes de protección anti-doble-click (FRONTEND-001/002, MIGRACION-002, VENC-002, CLIENTES-001, LISTAS-001) — NC-002 (`notas.js`) se revisó y no tuvo hallazgos. Falta: las pruebas manuales de confirmación de la lista de abajo y los deploys de código pendientes (los fixes de Supabase no necesitan deploy, ya están resueltos en la base) — **CRON-001 además requiere confirmar que `CRON_SECRET` esté configurada en Vercel antes de deployar.**

---

> Workflow: subir este archivo al iniciar sesión → testear módulo → cargar hallazgos en vivo → bajar archivo actualizado → commitear al repo.
> El historial real de cambios queda en `git log` de este archivo — acá no se duplica versión por versión, solo se mantiene el estado vigente + fecha de última revisión por módulo.

**Última actualización general:** 2026-07-26 — sesión 3 (Auditoría de regresión migración 142, Facturación / Notas de crédito-débito, Choferes / Logística, Puntos / Fidelización, Asistente / IA, Portal Cliente, Infraestructura / Cron Jobs)

---

## 📊 Dashboard (resumen rápido)

| Módulo | Última revisión | Hallazgos abiertos 🔴 | Hallazgos abiertos 🟠 | Hallazgos abiertos 🟡 | Estado general |
|---|---|---|---|---|---|
| Auth / RLS / Multi-tenant | 2026-07-25 | 0 | 0 | 0 | Diagnóstico OK — fix de RLS aplicado |
| POS | 2026-07-25 | 0 | 0 | 2 (POS-001, POS-004) | En curso — crítico corregido, pendiente prueba manual de confirmación |
| Cta. corriente / Facturas | 2026-07-25 | 0 | 0 | 0 | Testeado parcial — sin pendientes en lo revisado |
| Cobranzas / Riesgo cheques | 2026-07-25 | 0 | 0 | 1 (COBRANZAS-003) | ✅ Aplicado — score real habilitado, pendiente prueba manual |
| Stock / Productos | 2026-07-25 | 0 | 0 | 0 | Diagnóstico OK — constraint aplicado |
| Notificaciones (NotifManager) | 2026-07-25 | 0 | 0 | 0 | Diagnóstico OK — sin pendientes |
| Portal Proveedores | 2026-07-25 | 0 | 0 | 0 | Diagnóstico OK (parcial — falta ver autenticación del proveedor en backend) |
| Billing SaaS / Onboarding | 2026-07-25 | 0 | 0 | 0 | ✅ Cerrado — código real revisado, BILLING-002 aplicado |
| Frontend transversal (UI/reskin) | 2026-07-26 | 0 | 0 | 0 | ✅ Cerrado — FRONTEND-001 y FRONTEND-002 aplicados |
| Automatización (motor de cron) | 2026-07-26 | 0 | 0 | 0 | ✅ Cerrado — AUTOMATIZACION-001/002 aplicados (pendiente deploy) |
| Migración de datos | 2026-07-26 | 0 | 0 | 0 | ✅ Cerrado — MIGRACION-001/002 aplicados |
| Vencimientos / Lotes / Liquidación | 2026-07-26 | 0 | 0 | 0 | ✅ Cerrado — VENC-001/002 aplicados |
| Sugerencias de pedido | 2026-07-26 | 0 | 0 | 0 | ✅ Cerrado — SUGERENCIAS-001 aplicado (pendiente deploy) |
| Clientes / Productos (catálogo) | 2026-07-26 | 0 | 0 | 0 | ✅ Cerrado — CLIENTES-001/002 aplicados (pendiente deploy) |
| Reglas y listas de precio | 2026-07-26 | 0 | 0 | 0 | ✅ Cerrado — REGLAS-001, LISTAS-001 aplicados (pendiente deploy) |
| Compras / Proveedores | 2026-07-26 | 0 | 0 | 0 | ✅ Cerrado — COMPRAS-001 (crítico) aplicado directo en Supabase, sin código pendiente de deploy |
| Auditoría regresión migración 142 (22 RPCs) | 2026-07-26 | 0 | 0 | 0 | ✅ Cerrado — 21/22 sin regresión, SCORE-001 (crítico) encontrado y aplicado directo en Supabase |
| Facturación / Notas de crédito-débito | 2026-07-26 | 0 | 0 | 0 | ✅ Cerrado — NC-001 aplicado en Supabase, NC-002 (notas.js doble-click) diagnóstico OK, FACTURAS-002 (crítico) corregido en código (pendiente deploy) |
| Reportes (stock/financieros/ventas) | 2026-07-26 | 0 | 0 | 0 | Diagnóstico OK — RLS + `get_empresa_id()` interno, sin parámetros de empresa manipulables |
| Choferes / Logística (rutas, entregas, invitación) | 2026-07-26 | 0 | 0 | 0 | ✅ Cerrado — CHOFER-001 (alto) corregido en código (pendiente deploy) |
| Puntos / Fidelización | 2026-07-26 | 0 | 0 | 0 | ✅ Cerrado — PUNTOS-001 (crítico) aplicado directo en Supabase, sin código pendiente de deploy |
| Asistente / IA | 2026-07-26 | 0 | 0 | 0 | ✅ Cerrado — ASISTENTE-001 (alto) corregido en código (pendiente deploy) |
| Portal Cliente | 2026-07-26 | 0 | 0 | 0 | ✅ Cerrado — PORTALCLIENTE-001 (bug funcional, alto) corregido en código (pendiente deploy) |
| Infraestructura / Cron Jobs | 2026-07-26 | 0 | 0 | 0 | ✅ Cerrado — CRON-001 (🔴 crítico) corregido en código (pendiente deploy + verificar `CRON_SECRET` en Vercel) |

*Prioridad: 🔴 crítico · 🟠 alto · 🟡 medio/bajo — ver matriz de priorización en el framework general.*

---

## Cómo se carga un hallazgo (referencia rápida)

```
### [MODULO]-[NNN] — Título corto del hallazgo

- **Fecha:**
- **Tipo:** Bug funcional / Bug de seguridad / Optimización performance / Deuda técnica / Mejora UX
- **Impacto:** 🔴 Crítico / 🟠 Alto / 🟡 Medio / ⚪ Bajo
- **Esfuerzo:** Bajo / Medio / Alto
- **Descripción:**
- **Cómo se detectó:**
- **Propuesta:**
- **Estado:** Detectado / Priorizado / En curso / Aplicado / Vigente sin pendientes (fecha)
- **Disparador si es reapertura:** (a qué revisión anterior corresponde, y por qué se reabre)
```

Cada módulo abajo tiene su propia sección para pegar estos bloques a medida que aparecen.

---

## Auth / RLS / Multi-tenant

### AUTH-001 — Políticas basadas en `es_admin()` no validan que el `empresa_id` insertado sea el propio

- **Fecha:** 2026-07-25
- **Tipo:** Bug de seguridad (posible cross-tenant)
- **Impacto:** 🟠 Alto — requiere que el atacante ya sea admin/dueño de *alguna* empresa, pero desde ahí podría insertar filas en `movimientos_puntos`, `programas_fidelizacion`, `recompensas` o `saldo_puntos` con el `empresa_id` de **otro** tenant, si el backend llega a enviar ese campo desde el cliente.
- **Esfuerzo:** Bajo
- **Descripción:** `es_admin()` solo valida `auth.role() = 'service_role' OR rol IN ('dueno','admin')` — no compara `empresa_id`. Las políticas `WITH CHECK (es_admin())` en las 4 tablas mencionadas confían en que el backend arme el `INSERT` con el `empresa_id` correcto, sin que la base lo verifique.
- **Cómo se detectó:** Consulta a `pg_policies` cruzando `with_check` que no menciona `empresa_id`.
- **Propuesta:** Cambiar esas 4 políticas a `WITH CHECK (es_admin() AND empresa_id = get_empresa_id())`.
- **Estado:** ✅ Aplicado (2026-07-25) — migración `fix_auth001_rls_empresa_check_y_stock_no_negativo`. Verificado: las 4 políticas ahora exigen `es_admin() AND empresa_id = get_empresa_id()`.
- **Disparador si es reapertura:** Se reabre si se agrega una tabla nueva con patrón `WITH CHECK (es_admin())` sin el chequeo de empresa.

### AUTH-002 — Suspensión SaaS: defensa en profundidad correcta

- **Fecha:** 2026-07-25
- **Tipo:** Confirmación positiva
- **Descripción:** `get_empresa_id()` excluye explícitamente empresas con `saas_suspendida = true` o `activa = false`. Como *todas* las políticas RLS dependen de `get_empresa_id()`, suspender una empresa (`saas_suspender_empresa`) bloquea el acceso a nivel de base de forma centralizada — no depende de que cada pantalla del frontend chequee el estado de suspensión por separado.
- **Estado:** Vigente sin pendientes (2026-07-25).

---

## POS

### POS-001 — Tolerancia de redondeo de pago: sincronizada, pero frágil ante migraciones

- **Fecha:** 2026-07-25
- **Tipo:** Deuda técnica (riesgo de regresión)
- **Impacto:** 🟡 Medio (no hay bug activo hoy, pero ya se rompió 2 veces antes)
- **Esfuerzo:** Bajo
- **Descripción:** El RPC `registrar_venta_pos` valida `ABS(suma_pagos - total) > 1`, que hoy coincide con `TOLERANCIA_REDONDEO_PAGO` del frontend (`pos.js`). El propio código deja un comentario explícito: esto ya se reintrodujo como bug dos veces por `CREATE OR REPLACE` de migraciones basadas en una versión vieja de la función.
- **Cómo se detectó:** Lectura directa de `registrar_venta_pos` vía Supabase (`information_schema.routines`).
- **Propuesta:** Sacar el valor `1` hardcodeado del RPC y del frontend, y llevarlo a una tabla de configuración (`facturacion_config` ya existe, podría alojarlo) para que sea una sola fuente de verdad. Alternativa más simple: agregar un test de regresión automatizado que falle si ambos valores no coinciden.
- **Estado:** Detectado — vigente sin pendientes de código hoy (no hay bug activo), pero con acción de fondo recomendada.
- **Disparador si es reapertura:** Se reabre si una futura migración vuelve a tocar `registrar_venta_pos` sin revisar este comentario.

### POS-002 — Devolución POS no ajusta cuenta corriente del cliente

- **Fecha:** 2026-07-25
- **Tipo:** Bug funcional (gap de lógica de negocio)
- **Impacto:** 🔴 Crítico — afecta directamente el saldo de deuda real de un cliente
- **Esfuerzo:** Medio
- **Descripción:** `rpc_registrar_devolucion_pos` restaura stock y lotes correctamente, pero **no toca `cta_cte` en ningún caso**. Si una venta se pagó (total o parcialmente) con `cuenta_corriente` y después se hace una devolución de ítems, el cliente queda debiendo por productos que ya devolvió — el saldo de `cta_cte` nunca se acredita. (`anular_venta_pos`, que es la anulación total, sí genera el crédito correspondiente; la devolución parcial, no.)
- **Cómo se detectó:** Comparación de `rpc_registrar_devolucion_pos` vs `anular_venta_pos` + revisión de columnas de `devoluciones_pos` (no existe ni `medio_pago` ni `monto_reintegrado`).
- **Propuesta:** En `rpc_registrar_devolucion_pos`, después de calcular `v_monto_total`, verificar si la venta original tuvo pagos con `medio = 'cuenta_corriente'` y generar un `INSERT INTO cta_cte (..., tipo='credito', monto=<proporcional>)` igual que hace `anular_venta_pos`. Si el pago fue mixto (parte efectivo, parte cta_cte), definir la regla de negocio: ¿el crédito va todo a cta_cte, o se prorratea según cómo se pagó?
- **Estado:** ✅ Aplicado (2026-07-25) — migración `fix_devolucion_pos_ajusta_cta_cte` corrió directo contra la base real.
- **Corrección aplicada:** Se agregó columna `devoluciones_pos.monto_acreditado_cta_cte` (trazabilidad) y se reescribió `rpc_registrar_devolucion_pos` para que, si la venta original tuvo pago por `cuenta_corriente`, calcule la proporción pagada por ese medio (`monto_cta_cte / total_venta`) y acredite esa misma proporción del monto devuelto como `tipo='credito'` en `cta_cte`.
- **Regla de negocio asumida (revisar si no es la que esperás):** con pago mixto (parte efectivo + parte cta_cte), el crédito se prorratea según el % que representó cada medio en el total de la venta — no hay forma de saber con qué medio se pagó cada ítem puntual porque el pago no está atado a ítems.
- **Pendiente de tu lado:** probar un caso real en el POS (venta con cta_cte → devolución parcial → verificar que el saldo del cliente baje lo esperado) para confirmar antes de dar por cerrado en producción.
- **Disparador si es reapertura:** Se reabre si cambia la forma en que el POS registra pagos mixtos, o si la regla de prorrateo no es la que el negocio espera.

### POS-003 — Bloqueo de stock ante ventas simultáneas: correcto

- **Fecha:** 2026-07-25
- **Tipo:** Confirmación positiva (no requiere acción)
- **Impacto:** ⚪ N/A
- **Descripción:** `registrar_venta_pos` usa `SELECT ... FOR UPDATE` sobre `stock` antes de descontar cantidad, lo que evita la condición de carrera de dos ventas simultáneas dejando stock negativo.
- **Estado:** Vigente sin pendientes (2026-07-25).

### POS-004 — Doble click en "Confirmar venta": pendiente de verificar en frontend

- **Fecha:** 2026-07-25
- **Tipo:** Optimización / bug potencial de UX
- **Impacto:** 🟡 Medio (mitigado parcialmente)
- **Esfuerzo:** Bajo
- **Descripción:** El RPC tiene protección de idempotencia vía `offline_local_id` (si se reenvía la misma venta, devuelve la existente en vez de duplicar). Pero esto solo protege si el frontend genera un `offline_local_id` **estable** por venta y lo reenvía igual ante un doble click — no pude confirmarlo sin ver `pos.js`.
- **Propuesta:** Verificar en el código del frontend si el botón "Confirmar venta" se deshabilita al primer click, y si `offline_local_id` se genera una sola vez por intento de venta (no en cada click).
- **Estado:** ✅ Confirmado correcto (2026-07-25) — se subió `pos.js` y se verificó: `btn.disabled = true` se ejecuta de forma síncrona antes de cualquier `await` (terminal de pago, fetch, etc.), lo que bloquea un segundo click mientras la venta está en curso. No hace falta cambiar nada.
- **Nota menor (no bloqueante):** el POST online no manda `offline_local_id` (ese campo solo se usa en la cola offline), así que la dedup por `offline_local_id` de `registrar_venta_pos` no protege el camino online — pero como el botón ya se deshabilita antes del fetch, el riesgo real de duplicado es bajo. No amerita acción.
- **Disparador si es reapertura:** Si se detecta una venta duplicada real en producción, revisar si el disable del botón se está saltando por algún camino (ej. Enter en un input, doble tap táctil).

---

## Cuenta Corriente / Facturas

### CTACTE-001 — Bug histórico "tipo='factura' no reconocido": confirmado resuelto

- **Fecha:** 2026-07-25
- **Tipo:** Confirmación positiva (regresión ya corregida)
- **Impacto:** ⚪ N/A hoy — era 🔴 crítico cuando estaba activo
- **Descripción:** El trigger `sync_saldo_deuda_cliente` (v409) reconoce correctamente `'factura'` dentro de los tipos que suman al saldo. Además tiene una guarda explícita: si aparece un `tipo` no contemplado en el `CASE`, lanza excepción en vez de calcular mal en silencio — buen patrón defensivo.
- **Verificación en datos reales:** Se comparó `clientes.saldo_deuda` contra el saldo recalculado desde `cta_cte` para **todos** los clientes de la base — cero inconsistencias encontradas.
- **Estado:** Vigente sin pendientes (2026-07-25).
- **Disparador si es reapertura:** Se reabre si se agrega un nuevo `tipo` de movimiento a `cta_cte` sin sumarlo al `CASE` del trigger (el propio trigger debería frenarlo con su excepción, pero conviene revisar los logs tras cualquier cambio ahí).

---

## Cobranzas / Riesgo de Cheques

### COBRANZAS-001 — El componente "días de pago" del score de cliente nunca se calcula (siempre da el valor por defecto)

- **Fecha:** 2026-07-25
- **Tipo:** Bug funcional (lógica de negocio silenciosamente rota)
- **Impacto:** 🔴 Crítico — el score de cliente alimenta directamente `fn_riesgo_cheques_lista` y la categoría de riesgo (`premium/bueno/normal/riesgo/bloqueado`) que se usa para decisiones de crédito.
- **Esfuerzo:** Medio
- **Descripción:** `calcular_score_cliente` calcula `v_dias_prom` (promedio de días de atraso/adelanto de pago) cruzando `cobros` con `facturas` a través de `cta_cte.factura_id`. Pero `registrar_cobro_completo` — el único lugar donde se inserta un `cta_cte` de tipo `'cobro'` — **nunca completa `factura_id`**. Verificado contra datos reales: de los cobros existentes en la base, ninguno tiene `factura_id` cargado. Resultado: el `JOIN` nunca matchea nada, `v_dias_prom` da `NULL` siempre, y el componente de puntualidad de pago cae siempre en el caso por defecto (`v_pagos := 20`), sin importar si el cliente paga puntual o con 60 días de atraso.
- **Cómo se detectó:** Lectura de `calcular_score_cliente` + `registrar_cobro_completo`, y verificación en datos reales (`SELECT count(*), count(factura_id) FROM cta_cte WHERE tipo='cobro'` → 0 de 2 con `factura_id`).
- **Propuesta:** Depende de la regla de negocio real: si un cobro puede aplicarse a varias facturas (lo más común en cta_cte "abierta"), `registrar_cobro_completo` necesitaría recibir o inferir a qué factura(s) se está aplicando el pago y guardarlo — posiblemente con una tabla intermedia `cobro_facturas_aplicadas` si un cobro cubre más de una factura, en vez de un único `factura_id` en `cta_cte`. Es una decisión de diseño, no un one-liner — conviene charlarla antes de tocar el código.
- **Estado:** ✅ Aplicado (2026-07-25) — migración `cobranzas001_fix_cobro_facturas_multi_y_score`. Regla de negocio confirmada: 1 cobro puede cubrir varias facturas. Se creó `cobro_facturas_aplicadas` (cobro_id, factura_id, monto_aplicado) y `calcular_score_cliente` ahora calcula `v_dias_prom` haciendo `JOIN` contra esa tabla en vez de `cta_cte.factura_id`.
- **Pendiente de tu lado:** no hay cobros históricos con facturas aplicadas todavía (tabla nueva, 0 filas) — el score de puntualidad va a seguir usando el valor por defecto hasta que se registre al menos un cobro atado a una factura después de este fix. No es un bug, es esperable.
- **Disparador si es reapertura:** Se reabre si se agrega otra forma de registrar un cobro que no pase por `registrar_cobro_completo` (ej. un script de carga masiva) sin poblar `cobro_facturas_aplicadas`.

### COBRANZAS-003 — `registrar_cobro_completo` con `p_factura_id` fallaba en producción (migración 417 nunca aplicada)

- **Fecha:** 2026-07-25
- **Tipo:** Bug funcional (crítico, en producción)
- **Impacto:** 🔴 Crítico — el frontend (`cta-cte.js`, función `guardarCobro`) ya manda `p_factura_id` en cada cobro (para linkear el cobro a la factura desde la que se abrió el modal), pero la función real en la base no tenía ese parámetro. Cada cobro registrado así fallaba con error de "función no encontrada" en Postgres/PostgREST — el botón "Cobrar" desde una factura puntual estaba roto. Además, aunque un cobro genérico sí funcionaba, nunca actualizaba `facturas.total_cobrado`, así que las facturas quedaban "pendientes" para siempre en Cobranzas aunque se hubieran cobrado.
- **Cómo se detectó:** Se encontró la migración `417_cobro_vinculado_a_factura_y_pos_no_infla_deuda.sql` en el repo (agregaba `p_factura_id`), pero no figuraba en `schema_migrations_registry`. Se confirmó contra `pg_proc` que la función viva en Supabase no tenía ese parámetro — coincide exactamente con lo que manda el frontend.
- **Propuesta:** Aplicar la lógica de la 417, extendida a soportar múltiples facturas por cobro (ver COBRANZAS-001).
- **Estado:** ✅ Aplicado (2026-07-25) — mismo `apply_migration` que COBRANZAS-001 (`cobranzas001_fix_cobro_facturas_multi_y_score`). Se registró además la 417 en `schema_migrations_registry` con nota aclaratoria, para que el registro de migraciones no quede inconsistente con el repo.
- **Pendiente de tu lado:** probar en el sistema real — abrir una factura pendiente en Cobranzas, cobrarla parcial y total, y confirmar que (a) no tira error, (b) `facturas.total_cobrado` sube, (c) la factura sale de "pendientes" cuando se salda.
- **Disparador si es reapertura:** N/A (primera detección).

### COBRANZAS-002 — RLS de cheques, cobros, scores y alertas: correctamente aislado

- **Fecha:** 2026-07-25
- **Tipo:** Confirmación positiva
- **Descripción:** `cheques` y `cobros` filtran por `empresa_id = get_empresa_id()` **y** exigen rol `dueno/admin/contador` para modificar. `scores_cliente` y `alertas_score` filtran por `empresa_id` vía `usuarios`. No se encontraron políticas sueltas.
- **Estado:** Vigente sin pendientes (2026-07-25).

---

## Stock / Productos

### STOCK-001 — Sin restricción a nivel de base contra stock negativo

- **Fecha:** 2026-07-25
- **Tipo:** Optimización / defensa en profundidad
- **Impacto:** 🟡 Medio (hoy: 0 filas negativas en toda la base, protección solo a nivel de aplicación)
- **Esfuerzo:** Bajo
- **Descripción:** `registrar_venta_pos` protege bien la concurrencia con `FOR UPDATE` + chequeo de cantidad, pero no hay un `CHECK (cantidad >= 0)` en la tabla `stock`. Cualquier otro camino que actualice `stock` directamente (una migración, un script, un admin que corre SQL a mano) podría dejarlo negativo sin que la base lo impida.
- **Verificación en datos reales:** `SELECT count(*) FROM stock WHERE cantidad < 0 OR cantidad_disponible < 0` → 0 filas. No es un problema activo hoy.
- **Propuesta:** Agregar `ALTER TABLE stock ADD CONSTRAINT stock_no_negativo CHECK (cantidad >= 0 AND cantidad_disponible >= 0)`. Es una red de seguridad barata para un caso que hoy no pasa, pero que un futuro script mal escrito sí podría causar.
- **Estado:** ✅ Aplicado (2026-07-25) — `ALTER TABLE stock ADD CONSTRAINT stock_no_negativo CHECK (cantidad >= 0 AND cantidad_disponible >= 0)`. Se aplicó sin error, confirmando que no había filas negativas.
- **Disparador si es reapertura:** N/A.

---

## Notificaciones (NotifManager)

### NOTIF-001 — RLS de notificaciones y dispositivos push: correctamente aislado por tenant/usuario

- **Fecha:** 2026-07-25
- **Tipo:** Confirmación positiva
- **Descripción:** `notificaciones_push` y `notif_prefs_auto` filtran por `empresa_id = get_empresa_id()`; `dispositivos_push` filtra por `usuario_id = auth.uid()` en SELECT/INSERT/UPDATE/DELETE. El bug de IDOR mencionado en el historial de distrib parece estar bien corregido — no encontré políticas sueltas sin filtro en estas tablas.
- **Estado:** Vigente sin pendientes (2026-07-25).
- **Disparador si es reapertura:** Revisar si se agrega una tabla nueva de notificaciones sin heredar este mismo patrón de política.

---

## Portal Proveedores

### PROV-001 — RLS de facturas/pagos a proveedor y tokens de portal: correctamente aislado

- **Fecha:** 2026-07-25
- **Tipo:** Confirmación positiva
- **Descripción:** `facturas_proveedor`, `pagos_proveedor` y `proveedor_portal_tokens` filtran todas por `empresa_id` vía subquery a `usuarios`, con roles específicos (`dueno`, `admin`, `contador`, `depositero` según la operación). No se encontraron políticas permisivas.
- **Estado:** Vigente sin pendientes (2026-07-25).
- **Pendiente fuera de este chequeo:** No pude verificar cómo se autentica el *proveedor* en sí (no un usuario interno) contra `proveedor_portal_tokens` — esa lógica probablemente vive en el backend Node, no en RLS. Si querés que la revise, necesito ese código.

---

## Billing SaaS / Onboarding

### BILLING-001 — Webhook de MercadoPago: firma e idempotencia, confirmado correcto

- **Fecha:** 2026-07-25
- **Tipo:** Confirmación positiva
- **Descripción:** Revisado `lib/handlers/pagos.js` completo. Tiene: verificación de firma HMAC-SHA256 **fail-closed** (si falta `WEBHOOK_SECRET_MP`, rechaza en vez de aceptar — ya corregido como SEC-013, con tests en `tests/webhooks/mp-firma.test.js`), idempotencia real (si la transacción ya está `'completado'`, ignora el duplicado sin reprocesar), resolución de credenciales por empresa (no rompe con 2+ tenants activos), y registro correcto del cobro en `cta_cte` vía `registrar_cobro_completo` (mismo RPC que el cobro manual).
- **Estado:** Vigente sin pendientes (2026-07-25).
- **Disparador si es reapertura:** N/A.

### BILLING-002 — `desbloquearSiSaldado` (JS) recalcula la deuda con una fórmula incompleta que puede desbloquear clientes que todavía deben

- **Fecha:** 2026-07-25
- **Tipo:** Bug funcional
- **Impacto:** 🟠 Alto — podría desbloquear (dejar seguir comprando) a un cliente que en realidad sigue debiendo, si su deuda viene de facturas.
- **Esfuerzo:** Bajo
- **Descripción:** En `lib/handlers/pagos.js`, la función `desbloquearSiSaldado` recalcula el saldo del cliente en JavaScript con: `tipo === 'debito' ? +monto : -monto`. Pero el trigger SQL `sync_saldo_deuda_cliente` (fuente de verdad) suma como deuda **4 tipos**: `'factura'`, `'debito'`, `'cargo'`, `'nota_debito'` — no solo `'debito'`. Si la deuda de un cliente viene principalmente de `cta_cte` tipo `'factura'` (el flujo normal de facturación, distinto del POS que usa `'debito'`), esta función JS la trata como un **crédito** en vez de una deuda, calculando un saldo artificialmente bajo o negativo, y podría desbloquear al cliente aunque siga debiendo.
- **Cómo se detectó:** Comparación línea por línea entre el `CASE` de `sync_saldo_deuda_cliente` (SQL, confirmado como fuente de verdad en `CTACTE-001`) y la reducción manual en `desbloquearSiSaldado` (JS).
- **Contexto importante:** Esta función es además **lógica duplicada innecesaria** — `registrar_cobro_completo` (el RPC que se llama justo antes, tanto en el webhook como en el cobro manual) **ya hace exactamente este desbloqueo, correctamente**, leyendo `clientes.saldo_deuda` (que el trigger mantiene actualizado). El webhook llama al RPC (bien) y **después** llama a esta función JS redundante (mal) que puede pisar el resultado correcto con uno erróneo.
- **Propuesta:** Eliminar `desbloquearSiSaldado` de `lib/handlers/pagos.js` y quitar su llamada tanto en `manejarWebhook` como en `verificarPago` — `registrar_cobro_completo` ya resuelve el desbloqueo correctamente y es la única fuente de verdad que hace falta. Menos código, y elimina el bug de raíz en vez de arreglar la fórmula.
- **Estado:** ✅ Aplicado (2026-07-25) — se eliminó la función y sus 2 llamadas en `lib/handlers/pagos.js`. Verificado con `node --check` (sintaxis OK). Este cambio es de código (no toca Supabase), así que **hace falta deployar el archivo actualizado** para que tome efecto en producción.
- **Disparador si es reapertura:** N/A (primera detección).

---

## Frontend transversal (UI / Reskin)

> Nota: el reskin visual (CSS/Gentelella) tiene su propio tracking completo y al día en `docs/GENTELELLA_RESKIN_TRACKING.md` — no se duplica acá. Esta sección cubre bugs funcionales/seguridad del JS del panel (mismo tipo de chequeo que POS-004).

### FRONTEND-001 — "Confirmar match" en Conciliación bancaria sin protección de doble-click

- **Fecha:** 2026-07-26
- **Tipo:** Bug funcional (integridad de datos, menor)
- **Impacto:** 🟡 Medio — no hay riesgo de plata mal acreditada (el RPC valida `estado='pendiente'`/`conciliado_bancario=false` antes de tocar nada), pero sí puede inflar `conciliacion_bancaria_lotes.cantidad_conciliados` si dos clicks llegan casi simultáneos, porque el RPC no toma lock de fila (`FOR UPDATE`) antes de esa validación.
- **Esfuerzo:** Bajo
- **Descripción:** `confirmarMatch()` en `frontend/admin/js/conciliacion-bancaria.js` es la única función de las revisadas en este barrido (clientes, productos, cheques, proveedores, compras, devoluciones, rutas — todas con `btn.disabled = true` antes del primer `await`) que no deshabilitaba ningún botón mientras esperaba la respuesta del backend. El RPC `conciliacion_confirmar_match` hace `IF NOT EXISTS (... AND estado = 'pendiente')` sin lock, así que dos ejecuciones concurrentes pueden pasar esa validación antes de que la primera haga `COMMIT` (READ COMMITTED), y ambas incrementan el contador del lote.
- **Cómo se detectó:** Barrido de funciones `guardar*`/`confirmar*`/`registrar*` en todo `frontend/admin/js` buscando el patrón "sin `window.confirmar` y sin disable antes del primer `await`", con verificación manual de cada caso.
- **Propuesta:** Envolver el botón con `btnAsyncClick` (el wrapper anti-doble-click universal ya usado en el resto de la app).
- **Estado:** ✅ Aplicado (2026-07-26) — `confirmarMatch()` ahora se dispara vía `btnAsyncClick`.
- **Disparador si es reapertura:** N/A (primera detección).

### FRONTEND-002 — `guardar()` en Configuración de empresa sin disable antes del `await`

- **Fecha:** 2026-07-26
- **Tipo:** Bug funcional (integridad de datos, menor)
- **Impacto:** 🟡 Medio — doble-click podía disparar dos `PUT /api/empresa/datos` en paralelo.
- **Descripción:** Mismo patrón que FRONTEND-001, detectado en el mismo barrido: el botón de guardar en `empresa-config.html` no se deshabilitaba antes del `await fetch(...)`.
- **Estado:** ✅ Aplicado (2026-07-26) — el botón se deshabilita (`btn.disabled = true`, texto "Guardando…") antes del `await` y se reactiva en el flujo de respuesta.
- **Disparador si es reapertura:** N/A (primera detección).

---

## Automatización (motor de cron)

### AUTOMATIZACION-001 — El proxy de motores reenviaba el `CRON_SECRET` en vez del token del usuario

- **Fecha:** 2026-07-26
- **Tipo:** Bug de seguridad (posible cross-tenant / escalamiento de privilegios)
- **Impacto:** 🔴 Crítico — `lib/handlers/automatizacion.js` reenviaba `Authorization: Bearer ${CRON_SECRET}` a cada motor downstream sin importar quién hizo el request original, así que cualquier llamada pasaba con el secreto interno del cron en vez del token real del usuario, sin quedar scopeada a `perfil.empresa_id`.
- **Descripción:** Ahora reenvía `Authorization: <token del usuario>`, así cada motor cae en su propio branch de usuario ya existente y queda correctamente scopeado por empresa.
- **Estado:** ✅ Aplicado (2026-07-26) en `lib/handlers/automatizacion.js`. Es un handler de Vercel (Node serverless) — **hace falta `vercel --prod` para que tome efecto en producción**, no es un cambio de base.
- **Disparador si es reapertura:** N/A (primera detección).

### AUTOMATIZACION-002 — No se chequeaba `r.ok` antes de responder éxito

- **Fecha:** 2026-07-26
- **Tipo:** Bug funcional
- **Impacto:** 🟠 Alto — si el motor downstream fallaba (401/403/500), el proxy igual devolvía éxito al llamador, ocultando el error real.
- **Descripción:** Se agregó el chequeo de `r.ok`, devolviendo el error real (status + mensaje) cuando el motor downstream falla, en vez de reportar éxito.
- **Estado:** ✅ Aplicado (2026-07-26), mismo archivo que AUTOMATIZACION-001. Mismo pendiente de deploy (`vercel --prod`).
- **Disparador si es reapertura:** N/A (primera detección).

---

## Migración de datos

### MIGRACION-001 — XSS almacenado en la tabla de revisión de filas

- **Fecha:** 2026-07-26
- **Tipo:** Bug de seguridad (XSS almacenado)
- **Impacto:** 🟠 Alto
- **Descripción:** En `renderTablaFilas()` de `frontend/admin/js/migracion.js`, la celda de errores por fila (`f.errores`) se insertaba con `.join('; ')` directo en `innerHTML`, sin pasar por `escapeHtml()` — la única celda de esa tabla que no lo hacía. El backend (`lib/handlers/migracion.js`) embebe el valor crudo de la celda del archivo subido en esos mensajes de error cuando no lo reconoce (ej: `Fecha "${datos.fecha}" no se pudo interpretar`). Si una fila del Excel/CSV subido trae HTML malicioso en una columna de fecha o estado, ese HTML quedaba guardado tal cual en el mensaje de error y se ejecutaba en el navegador del dueño/admin al revisar la sesión de migración.
- **Cómo se detectó:** Barrido de patrones (disable-antes-de-await, `err.message` filtrado, `innerHTML` sin sanitizar) sobre los 3 JS del módulo de migración, mismo tipo de chequeo que FRONTEND-001. Se confirmó que el resto de los puntos que muestran datos del archivo (`renderResumenMapeo`, `mostrarPrecheck`, `mostrarResultado`, `migracion-maestra.js`, `migracion-badge.js`) sí escapan correctamente — este era el único punto suelto.
- **Estado:** ✅ Aplicado (2026-07-26) — cada `f.errores[i]` ahora pasa por `escapeHtml()` antes de unirse. También se verificó que `migracion.js` no tiene el patrón cron-impersonation de AUTOMATIZACION-001 ni toma `empresa_id` del body.
- **Disparador si es reapertura:** N/A (primera detección).

### MIGRACION-002 — Botones de plantilla de mapeo sin disable antes del `await`

- **Fecha:** 2026-07-26
- **Tipo:** Bug funcional (integridad de datos, menor)
- **Impacto:** 🟡 Medio — mismo tipo que FRONTEND-002: `guardarPlantillaMapeoActual()` y `borrarPlantillaMapeoSeleccionada()` en `migracion.js` no deshabilitaban su botón durante el request (las acciones grandes — mapear, confirmar — sí lo hacían).
- **Estado:** ✅ Aplicado (2026-07-26) — se agregaron `id="btn-guardar-plantilla"` e `id="btn-borrar-plantilla"` a los botones y ambas funciones ahora deshabilitan el botón (texto "Guardando…"/"Borrando…") antes del `await`, con `finally` que lo reactiva solo si el request falló (si tuvo éxito, `renderPlantillasMapeo()` ya reemplazó el botón al re-renderizar el contenedor).
- **Disparador si es reapertura:** N/A (primera detección).

---

## Vencimientos / Lotes / Liquidación

### VENC-001 — XSS almacenado en `numero_lote` (tabla de lotes y tabla de ofertas de liquidación)

- **Fecha:** 2026-07-26
- **Tipo:** Bug de seguridad (XSS almacenado)
- **Impacto:** 🟠 Alto
- **Descripción:** `numero_lote` es un campo de texto libre (`<input type="text">` en el modal de lote de `vencimientos.html`) que se guarda tal cual en la tabla `lotes`. Se mostraba **sin escapar** en dos lugares: la tabla de lotes (`frontend/admin/js/lotes.js`, función `renderTablaLotes`) y la tabla de ofertas de liquidación (`frontend/admin/js/liquidacion.js`, función `renderTablaOfertas`) — mismo patrón que MIGRACION-001: en ambos archivos el resto de los campos (`producto.nombre`, `producto.codigo`) sí pasaban por `sanitize()`, solo `numero_lote` quedó suelto. Cualquier usuario con permiso de escritura (dueño/admin/depositero) podía guardar HTML/JS malicioso como número de lote y ejecutarlo en el navegador de quien mirara esas dos pantallas.
- **Cómo se detectó:** Barrido de patrones (disable-antes-de-await, `err.message` filtrado, `innerHTML` sin sanitizar) sobre `vencimientos.html` + `lotes.js` + `liquidacion.js`, mismo tipo de chequeo que MIGRACION-001/FRONTEND-001. También se revisó el backend (`handleLotes`, `handleLiquidacion` en `lib/handlers/stock.js`): `empresa_id` siempre sale del perfil autenticado, nunca del body/query — sin hallazgos ahí.
- **Estado:** ✅ Aplicado (2026-07-26) — `numero_lote` ahora pasa por `sanitize()` en ambos archivos (y de paso se corrigió el mismo hueco en el nombre de depósito en `lotes.js`).
- **Disparador si es reapertura:** N/A (primera detección).

### VENC-002 — "Dar de baja" y "Eliminar" lote sin protección de doble-click

- **Fecha:** 2026-07-26
- **Tipo:** Bug funcional (integridad de datos, menor)
- **Impacto:** 🟡 Medio — "Dar de baja" descuenta stock real; un doble-click podía disparar dos requests en paralelo.
- **Descripción:** `darDeBajaLote()` y `eliminarLote()` en `lotes.js` no usaban `btnAsyncClick` (el wrapper anti-doble-click estándar del resto de la app — lo usa `guardarLote()` en el mismo archivo).
- **Estado:** ✅ Aplicado (2026-07-26) — ambos `onclick` ahora están envueltos con `btnAsyncClick`.
- **Disparador si es reapertura:** N/A (primera detección).

---

## Sugerencias de pedido

### SUGERENCIAS-001 — `empresa_id` tomado del body sin validar contra el usuario autenticado (cross-tenant)

- **Fecha:** 2026-07-26
- **Tipo:** Bug de seguridad (cross-tenant, más severo que AUTH-001)
- **Impacto:** 🔴 Crítico — a diferencia de AUTH-001 (que requería ser admin/dueño de *alguna* empresa), acá alcanzaba con **cualquier usuario autenticado, de cualquier rol**. `handleSugerencias` (ruta real: `POST /api/stock?_svc=sugerencias`) tomaba `cliente_id` y `empresa_id` directo de `req.body` sin validarlos contra el perfil del usuario. El cliente de Supabase de `lib/handlers/stock.js` usa `SUPABASE_SERVICE_ROLE_KEY` (bypassea RLS), así que el filtro manual `.eq('empresa_id', empresa_id)` era la única protección de tenant — y ese valor lo mandaba el atacante. Con un `cliente_id` real de otra empresa, se podía leer qué productos compra ese cliente (frecuencia, `precio_base`) y además insertar/ensuciar filas en `sugerencias_pedido` de esa empresa ajena.
- **Cómo se detectó:** Encontrado de pasada durante el barrido de VENC-001/002 (mismo archivo `stock.js`), comparando el patrón de esta función contra `handleLotes`/`handleLiquidacion` en el mismo archivo, que sí resuelven `empresa_id` desde el perfil.
- **Nota de alcance:** no se encontró ningún caller en el frontend actual (`_svc=sugerencias` no aparece en ningún fetch del repo — el motor "Piloto Automático" de Automatización usa `ciclos_compra` directamente, no este endpoint). Parece código huérfano de una versión anterior. Aun así, la ruta sigue viva y accesible con cualquier token válido, así que el fix aplica igual.
- **Propuesta:** Ignorar el `empresa_id` del body y resolverlo siempre desde `perfil.empresa_id` del usuario autenticado, igual que en el resto de los handlers del archivo. Scopear también el `DELETE` de limpieza de sugerencias expiradas por `empresa_id` (antes solo filtraba por `cliente_id`).
- **Estado:** ✅ Aplicado (2026-07-26) en `lib/handlers/stock.js` (`handleSugerencias`). Verificado con `node --check`. Es un cambio de código (no de base) — **hace falta deploy** para que tome efecto en producción.
- **Disparador si es reapertura:** N/A (primera detección).

---
## Clientes / Productos (catálogo)

### CLIENTES-001 — Acciones destructivas generadas dinámicamente en filas de tabla sin protección de doble-click

- **Fecha:** 2026-07-26
- **Tipo:** Bug funcional (mismo patrón que VENC-002 y FRONTEND-001)
- **Impacto:** 🟡 Media — doble-click/doble-tap podía disparar dos requests concurrentes de eliminación/cambio de estado (borrado doble de un precio especial o dirección, doble intento de revocar/dar acceso al portal, doble resolución de alerta de score).
- **Descripción:** Cuatro `onclick` generados dinámicamente en filas/paneles de `frontend/admin/js/clientes.js` llamaban directo a la función async sin pasar por `btnAsyncClick` (el wrapper estándar del resto de la app), a diferencia de sus pares estáticos (`guardarPrecioCliente`/`guardarDireccion` en `clientes.html`, que sí lo usan):
  - `eliminarPrecioCliente('${r.id}')` (fila de precios especiales)
  - `eliminarDireccion('${r.id}')` (fila de direcciones)
  - `resolverAlertaScore('${a.id}')` (panel de alertas de score)
  - `gestionarAccesoPortal('${c.id}', ...)` (botón Portal/Sin portal — la rama "revocar" hace un `fetch` sin protección)
- **Cómo se detectó:** Barrido de funciones async con `fetch` en `clientes.js` y comparación de cada call site contra el patrón `btnAsyncClick` usado en el resto del archivo y en `lotes.js`/`conciliacion-bancaria.js` (VENC-002/FRONTEND-001).
- **Propuesta:** Envolver los 4 `onclick` con `btnAsyncClick(this, () => …)`.
- **Estado:** ✅ Aplicado (2026-07-26) en `frontend/admin/js/clientes.js`. **Hace falta deploy** (es cambio de frontend, no de base).
- **Disparador si es reapertura:** N/A (primera detección).

### CLIENTES-002 — `cliente_id`/`producto_id` del body sin validar que pertenezcan a la empresa del usuario (cross-tenant)

- **Fecha:** 2026-07-26
- **Tipo:** Bug de seguridad (cross-tenant, mismo tipo de gap que el `deposito_id` de lotes — Etapa 2, Hallazgo 2 de la auditoría de módulos)
- **Impacto:** 🟠 Alto — un usuario autenticado de una empresa podía crear un precio especial (`precios_clientes`) o una dirección (`cliente_direcciones`) apuntando a un `cliente_id`/`producto_id` real de **otra** empresa. El handler sí resuelve `empresa_id` desde el perfil de sesión (no del body) y lo usa para el `INSERT`, pero los repos nunca confirmaban que el `cliente_id`/`producto_id` recibido perteneciera a esa misma empresa — quedaba una fila "huérfana" con el `empresa_id` correcto del atacante pero referenciando una entidad ajena.
- **Cómo se detectó:** Revisión de `lib/repos/clientes.js` y `lib/repos/cliente-direcciones.js` comparando el patrón contra el fix ya aplicado para `deposito_id` en `lib/handlers/stock.js` (Etapa 2, Hallazgo 2). Se confirmó por separado que `lib/handlers/clientes.js` sí resuelve `empresa_id` desde `perfil` en todas las llamadas a los repos (no viene del body en ningún caso) — el gap estaba exclusivamente en los repos, no en el handler.
- **Verificación de datos en producción:** se consultó Supabase (solo lectura) cruzando `precios_clientes`/`cliente_direcciones` contra `clientes`/`productos` por `empresa_id` — **0 filas huérfanas encontradas**. El gap existía en el código pero no llegó a explotarse (o no dejó rastro) en los datos reales.
- **Propuesta:** En `upsertPrecioCliente` y `crearDireccion`, confirmar con un `select` scopeado por `empresa_id` que el `cliente_id` (y `producto_id`, en el caso de precios) existan para esa empresa antes de insertar/upsertear; si no, tirar error "Cliente no encontrado" / "Producto no encontrado".
- **Estado:** ✅ Aplicado (2026-07-26) en `lib/repos/clientes.js` y `lib/repos/cliente-direcciones.js`. Sin migración SQL — es validación de aplicación, no constraint de base (se evaluó agregar una FK compuesta `(cliente_id, empresa_id)` pero no es necesaria: la búsqueda cross-tenant de huérfanos dio 0, y el fix de código ya cierra la vía de entrada). **Hace falta deploy** para que tome efecto en producción.
- **Disparador si es reapertura:** se reabre si aparece otro repo/tabla con el mismo patrón (FK a otra entidad tomada del body sin re-validar `empresa_id`) — revisar particularmente `reglas-precio.js` y `listas-precio.js`, que no se auditaron todavía.

---
## Reglas y listas de precio

### REGLAS-001 — `producto_id`/`categoria_id`/`zona_id` del body sin validar que pertenezcan a la empresa (cross-tenant, con fuga de datos)

- **Fecha:** 2026-07-26
- **Tipo:** Bug de seguridad (cross-tenant, mismo tipo de gap que CLIENTES-002)
- **Impacto:** 🟠 Alto — más grave que CLIENTES-002 porque acá el propio `.select()` de respuesta de `crearReglaPrecio`/`actualizarReglaPrecio` embebe `productos(nombre, codigo)`, `categorias(nombre)` y `zonas(nombre)`. `lib/handlers/reglas-precio.js` resuelve `empresa_id` correctamente desde el perfil de sesión (no del body) para el `INSERT`/`UPDATE` de la fila, pero `lib/repos/reglas-precio.js` nunca confirmaba que el `producto_id`/`categoria_id`/`zona_id` recibido perteneciera a esa misma empresa. Un usuario autenticado con rol dueño/admin/contador de **su propia** empresa podía mandar un request directo a `POST/PATCH /api/reglas-precio` con el UUID de un producto, categoría o zona de **otra** empresa (adivinado o conocido) y la respuesta de la API le devolvía el nombre (y código, si era producto) de esa entidad ajena — fuga de datos de otro tenant, no solo una fila huérfana.
- **Cómo se detectó:** Revisión de `lib/repos/reglas-precio.js` aplicando el mismo chequeo que en CLIENTES-002 (repo usa `SERVICE_ROLE_KEY`, bypassea RLS, así que la validación de aplicación es la única barrera real). El frontend (`reglas-precio.js`) sí puebla los `<select>` solo con catálogos propios vía RLS normal (`sb.from(...)` con el token del usuario), así que la vía de explotación es un request directo a la API, no la UI.
- **Verificación de datos en producción:** se consultó Supabase (solo lectura) cruzando `reglas_precio.producto_id/categoria_id/zona_id` contra el `empresa_id` real de `productos`/`categorias`/`zonas` — **0 filas cruzadas encontradas**. El gap existía en el código pero no se había explotado (o no dejó rastro).
- **Propuesta:** Antes de insertar/actualizar, confirmar con un `select` scopeado por `empresa_id` que cada id recibido (el que efectivamente venga en el body/patch) exista para esa empresa; si no, tirar error claro ("Producto/Categoría/Zona no encontrada").
- **Estado:** ✅ Aplicado (2026-07-26) en `lib/repos/reglas-precio.js` (`crearReglaPrecio` y `actualizarReglaPrecio`, vía helper `validarEntidadesPropias`). Sin migración SQL. **Hace falta deploy** para que tome efecto en producción.
- **Disparador si es reapertura:** se reabre si aparece otro repo con un `.select()` que embeba una tabla relacionada por FK tomada del body sin re-validar `empresa_id` primero — quedan sin auditar `compras.js`/`proveedores.js` (que también referencian producto_id/categoria por FK) y podrían tener el mismo patrón.

### LISTAS-001 — Botones "Dar de baja"/"Activar" de lista de precio sin protección de doble-click

- **Fecha:** 2026-07-26
- **Tipo:** Bug funcional (mismo patrón que CLIENTES-001, VENC-002, FRONTEND-001)
- **Impacto:** 🟡 Media — doble-click/doble-tap podía disparar dos requests concurrentes de activar/desactivar la misma lista de precio (el backend en `lib/handlers/maestros.js` ya valida no dejar la empresa sin ninguna lista activa, así que el peor caso es un toast de error duplicado o una carrera contra `desmarcarUnico`, no corrupción de datos).
- **Descripción:** En `frontend/admin/js/listas-precio.js`, los `onclick="desactivar('${l.id}')"` y `onclick="activar('${l.id}')"` generados por fila no pasaban por `btnAsyncClick`, a diferencia del botón estático "Guardar lista" en `listas-precio.html`, que sí lo usa.
- **Cómo se detectó:** Mismo barrido que CLIENTES-001, extendido a `listas-precio.js` por ser el módulo hermano de `reglas-precio.js` en Comercial y precios.
- **Propuesta:** Envolver ambos `onclick` con `btnAsyncClick(this, () => …)`.
- **Estado:** ✅ Aplicado (2026-07-26) en `frontend/admin/js/listas-precio.js`. **Hace falta deploy** (cambio de frontend, no de base).
- **Disparador si es reapertura:** N/A (primera detección).

---
## Compras / Proveedores

### COMPRAS-001 — `recepcionar_orden_compra` ejecutable directo por cualquier autenticado sin validar tenant (regresión de la migración 142) + `producto_id` sin validar en ambas RPCs

- **Fecha:** 2026-07-26
- **Tipo:** Bug de seguridad crítico (cross-tenant + bypass de rol) — regresión de un fix ya aplicado antes
- **Impacto:** 🔴 Crítico
  - **Regresión de tenant-check:** la migración `142_revoke_execute_rpcs_sin_tenant_check_lote2.sql` (auditoría 2026-06-30) había revocado el `EXECUTE` de `authenticated`/`anon` sobre `recepcionar_orden_compra` precisamente porque la función (SECURITY DEFINER) recibe `p_empresa_id` sin validarlo contra el usuario que llama. La migración `341_fix_recepcionar_orden_compra_stock_real.sql` (posterior, para arreglar que el stock no se acreditaba en la tabla real) creó una **firma nueva** de la función (agregó `p_deposito_id`) y volvió a otorgarle `EXECUTE` a `authenticated` — sin agregar el guard que le faltaba. Confirmado en producción vía `pg_proc`/`aclexplode` antes del fix: **`authenticated` podía ejecutar la función directo**, sin pasar por `lib/handlers/proveedores.js` ni por sus chequeos de rol (`dueno`/`admin`). La función tampoco llamaba a `assert_empresa_access()` (a diferencia de `crear_orden_compra` y otras RPCs sensibles), así que ni siquiera validaba que `p_empresa_id` fuera la propia del usuario.
  - **`producto_id` sin validar (ambas RPCs):** ni `crear_orden_compra` ni `recepcionar_orden_compra` confirmaban que los `producto_id` recibidos en `p_items` pertenecieran a `p_empresa_id` (mismo patrón que CLIENTES-002/REGLAS-001). Acá es más grave: permite crear filas de `ordenes_compra_items`/`stock`/`lotes` con `producto_id` de otro tenant, y `lib/handlers/proveedores.js` graba nombre/código de ese producto ajeno **de forma denormalizada y permanente** en `recepciones_mercaderia.items_conciliados` (queda en el historial de recepciones para siempre, no es un dato de paso).
- **Cómo se detectó:** revisando `lib/handlers/proveedores.js` (acción `recepcionar`) se notó que el `select` de productos para armar `itemsDetalle` (línea ~330) no filtraba por `empresa_id`. Al bajar a la función SQL para ver si el filtro estaba ahí, se encontró que la función no tenía NINGÚN guard de tenant, y al revisar el historial de migraciones apareció que la 142 ya había cerrado exactamente este acceso para la firma vieja — la 341 la reabrió sin querer al crear la firma nueva.
- **Verificación de datos en producción:** se cruzó `ordenes_compra_items`, `lotes` y `stock` contra el `empresa_id` real de `productos`/`depositos` — **0 filas cruzadas**. El agujero estuvo abierto pero no se explotó (o no dejó rastro).
- **Fix aplicado (migración `418_fix_ordenes_compra_rpcs_tenant_check`, aplicada directo en Supabase con tu OK):**
  1. `recepcionar_orden_compra` ahora llama `assert_empresa_access(p_empresa_id)` al inicio (no-op para `service_role`, aborta si un usuario intenta pasar el `empresa_id` de otra empresa).
  2. Ambas funciones validan que **todos** los `producto_id` de `p_items` pertenezcan a `p_empresa_id` antes de procesar nada — si no, abortan con `{ok:false, error:...}` (recepcionar) o `RAISE EXCEPTION` (crear), en vez de ignorar el item en silencio.
  3. Se revocó de nuevo `EXECUTE` de `anon`/`authenticated` en ambas funciones (mismo criterio que la 142), dejando `service_role` como único ejecutor — verificado que el único caller real es `lib/handlers/proveedores.js` con `SUPABASE_SERVICE_ROLE_KEY`.
- **Estado:** ✅ Aplicado y verificado en producción (2026-07-26). **No requiere deploy de código** — es 100% migración SQL, ya vigente.
- **Disparador si es reapertura:** se reabre si alguna migración futura vuelve a recrear estas funciones (p. ej. para agregar un parámetro) sin preservar el `GRANT` restringido y el guard — exactamente lo que pasó entre la 142 y la 341. **Recomendación de proceso:** al modificar la firma de una RPC `SECURITY DEFINER` existente, copiar también sus `GRANT`/`REVOKE` vigentes, no solo la lógica de negocio.

---

## Auditoría regresión migración 142 (22 RPCs)

### SCORE-001 — `calcular_score_cliente` perdió el guard de tenant al ser recreada por una migración posterior

- **Fecha:** 2026-07-26
- **Tipo:** Bug de seguridad crítico (cross-tenant) — regresión de un fix ya aplicado antes
- **Impacto:** 🔴 Crítico
- **Descripción:** La migración `142_revoke_execute_rpcs_sin_tenant_check_lote2.sql` identificó 22 RPCs `SECURITY DEFINER` con el patrón de riesgo `p_empresa_id` sin validar + `GRANT` a `authenticated`. `calcular_score_cliente` recibió su guard (`IF p_empresa_id IS DISTINCT FROM get_empresa_id() THEN RAISE EXCEPTION`) en la migración `fase18_guard_tenant_funciones_criticas` (2026-07-02). La migración `318_fix_alertas_score_columnas_inexistentes` (2026-07-13), al recrear la función para arreglar un bug de columnas inexistentes no relacionado con seguridad, partió de una versión previa a fase18 y perdió el guard silenciosamente. Quedó ~13 días sin protección, con `EXECUTE` habilitado para `authenticated`, permitiendo que un usuario autenticado de cualquier empresa recalculara/sobrescribiera el score crediticio de un cliente de otra empresa.
- **Cómo se detectó:** Verificación sistemática de las 22 funciones originales de la migración 142 contra el estado actual en producción (`pg_proc`/`aclexplode`), en vez de rastrear migración por migración — más confiable dado el volumen de migraciones posteriores. 21 de las 22 conservaban el guard intacto; esta fue la única con regresión real.
- **Verificación de datos en producción:** cruce de `scores_cliente`/`alertas_score` contra el `empresa_id` real de `clientes` — 0 filas cruzadas. El agujero estuvo abierto pero no se explotó (o no dejó rastro).
- **Fix aplicado (migración `419_fix_calcular_score_cliente_guard_tenant_perdido`, aplicada directo en Supabase):** se restituyó el guard `IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM get_empresa_id() THEN RAISE EXCEPTION`, idéntico en efecto al de fase18.
- **Estado:** ✅ Aplicado y verificado en producción (2026-07-26). No requiere deploy de código — es 100% migración SQL.
- **Disparador si es reapertura:** mismo patrón que COMPRAS-001 — se reabre si una migración futura recrea `calcular_score_cliente` (u otra de las 22 de la migración 142) partiendo de una versión vieja sin preservar el guard. **Recomendación de proceso:** antes de recrear una función `SECURITY DEFINER` para arreglar un bug puntual, partir de `pg_get_functiondef` del estado actual en producción, no de una copia guardada en un archivo de migración anterior.

---

## Facturación / Notas de crédito-débito

### NC-001 — `crear_nota_credito` no validaba que `factura_id` perteneciera a la empresa

- **Fecha:** 2026-07-26
- **Tipo:** Bug de seguridad (cross-tenant, mismo patrón que CLIENTES-002/REGLAS-001)
- **Impacto:** 🟠 Alto — permite vincular una nota de crédito propia a una factura de otra empresa, filtrando su número/CAE vía el `join` de la respuesta.
- **Descripción:** El RPC `crear_nota_credito` recibía `p_factura_id` sin confirmar que la factura perteneciera a `p_empresa_id` antes de insertar la nota de crédito vinculada.
- **Cómo se detectó:** Auditoría del módulo de Facturación, aplicando el mismo chequeo que en CLIENTES-002/REGLAS-001 a las RPCs de facturación/notas.
- **Verificación de datos en producción:** cruce de `notas_credito.factura_id` contra el `empresa_id` real de `facturas` — 0 filas cruzadas.
- **Fix aplicado (migración `420_fix_crear_nota_credito_valida_factura_id`, aplicada directo en Supabase):** se agregó la validación `IF p_factura_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM facturas WHERE id = p_factura_id AND empresa_id = p_empresa_id) THEN RETURN jsonb_build_object('ok', false, 'error', 'Factura no encontrada')`.
- **Estado:** ✅ Aplicado y verificado en producción (2026-07-26). No requiere deploy de código.
- **Disparador si es reapertura:** N/A (primera detección).

### NC-002 — `frontend/admin/js/notas.js`: barrido de doble-click — diagnóstico OK

- **Fecha:** 2026-07-26
- **Tipo:** Diagnóstico — sin hallazgo
- **Impacto:** N/A
- **Descripción:** Barrido pendiente de `notas.js` (mismo patrón que CLIENTES-001/VENC-002/LISTAS-001). La única acción mutante del archivo es `guardarNota()` (emite la nota de crédito/débito vía RPC `emitir_nota_cta_cte`), y su botón (`#btn-guardar-nota` en `notas.html`) ya está envuelto en `onclick="btnAsyncClick(this, guardarNota)"` — y `guardarNota()` además deshabilita el botón a mano (`btn.disabled = true`) antes del `await`, doble protección redundante pero sin gap. El resto de los `onclick` del archivo (`verDetalleNota`, `cambiarPaginaNotas`, `setTipoNota`, `abrirModalNota`/`cerrarModalNota`) son de solo lectura o solo UI (no mutan datos), así que no necesitan la protección.
- **Cómo se detectó:** Revisión de todos los `onclick=` en `notas.js` y `notas.html`, buscando un botón generado dinámicamente o estático sin pasar por `btnAsyncClick` que dispare una acción mutante — mismo criterio que en los hallazgos previos de este tipo.
- **Estado:** ✅ Diagnóstico OK — sin pendientes.
- **Disparador si es reapertura:** se reabre si se agrega un botón nuevo en este archivo/pantalla que dispare una acción async mutante sin pasar por `btnAsyncClick` (o una guarda equivalente).

### FACTURAS-002 — `POST /api/facturas` no validaba que `pedido_id` perteneciera a la empresa del usuario (IDOR directo)

- **Fecha:** 2026-07-26
- **Tipo:** Bug de seguridad crítico (cross-tenant, IDOR en código de aplicación — no requiere bypass de RLS)
- **Impacto:** 🔴 Crítico — es el hallazgo más grave de la sesión porque no depende de ningún gap de RLS ni de RPC: el handler mismo tomaba `pedido_id` del body y llamaba a `emitirFactura(pedido_id)` directo. `traerOrigenPedido()` (`lib/facturas.js`) resuelve el pedido con el cliente `service_role` (bypassea RLS) y sin filtrar por `empresa_id`, y `facturacionConfig` (certificado/CUIT ARCA) se resuelve por `pedido.empresa_id`. Resultado: cualquier usuario con rol dueño/admin/contador de **cualquier** empresa podía emitir una factura ARCA **real** (con CAE real) para un pedido de **otra** empresa, usando el certificado fiscal de esa otra empresa — un comprobante fiscal real que la empresa dueña del pedido no pidió y que después tiene que anular/explicar ante ARCA.
- **Cómo se detectó:** Al auditar `lib/handlers/facturas.js` completo se notó que `anular`/`reintentar` sí validaban `empresa_id` contra el perfil de sesión antes de operar, pero el handler principal de emisión (`POST /api/facturas`) no tenía ese mismo chequeo — asimetría que no debería existir entre endpoints del mismo módulo.
- **Verificación de callers:** se rastrearon todos los llamadores de `emitirFactura` (`pedidos.js`, `pos.js`) — los internos (post-creación de pedido, flujo POS) siempre pasan un `pedido_id`/`venta_pos_id` ya validado contra `perfil.empresa_id` antes de llegar a `emitirFactura`. El único punto de entrada sin validar era el body del `POST /api/facturas` expuesto directo al cliente.
- **Fix aplicado (código, `lib/handlers/facturas.js`):** antes de llamar a `emitirFactura`, se agregó un `select` de `pedidos` filtrando por `id = pedido_id`, y se compara `pedidoCheck.empresa_id === empresa_id` (del perfil de sesión) devolviendo 404/403 si no coincide o no pertenece.
- **Estado:** ✅ Corregido en el código del ZIP (2026-07-26). **Hace falta deploy** (`vercel --prod`) para que tome efecto en producción — no es una migración SQL.
- **Disparador si es reapertura:** se reabre si aparece otro endpoint que reciba un id de entidad de negocio (pedido, venta, factura) directo del body y lo pase a una función que resuelve datos con `service_role` sin re-validar `empresa_id` primero contra el perfil de sesión — mismo patrón que ya se vio en REGLAS-001/CLIENTES-002 pero en la capa de aplicación en vez de en un RPC.

---

## Reportes (stock / financieros / ventas)

### REPORTES-001 — RLS + `get_empresa_id()` interno: correctamente aislado

- **Fecha:** 2026-07-26
- **Tipo:** Diagnóstico — sin hallazgo
- **Impacto:** N/A
- **Descripción:** `reportes-stock.js`, `reportes-financieros.js` y `reportes-ventas.js` obtienen datos vía RPCs (`fn_reportes_stock_kpis`, `fn_reportes_stock_distribucion`, `fn_conteos_stock_kpis`, etc.) que resuelven el tenant internamente contra `get_empresa_id()`, o vía `sb.from(...)` normal con el token del usuario (RLS estándar). Ninguno recibe un `empresa_id` manipulable como parámetro desde el frontend.
- **Cómo se detectó:** Revisión de las llamadas `.rpc(...)`/`.from(...)` en los tres archivos de reportes del admin, buscando el mismo patrón de parámetro sin validar visto en módulos anteriores.
- **Estado:** ✅ Diagnóstico OK — sin pendientes.
- **Disparador si es reapertura:** se reabre si se agrega un nuevo reporte que reciba `empresa_id`/`deposito_id`/etc. como parámetro directo sin resolverlo desde la sesión.

---

## Choferes / Logística (rutas, entregas, invitación)

### CHOFER-001 — El portal del chofer autoriza por `empresa_id`, pero no valida que el remito pertenezca a la ruta del chofer que hace la request

- **Fecha:** 2026-07-26
- **Tipo:** Bug de seguridad (mismo tenant, IDOR en código de aplicación — no requiere bypass de RLS)
- **Impacto:** 🟠 Alto — no es cross-tenant (un chofer no puede tocar datos de otra empresa), pero cualquier usuario con rol `chofer` de la empresa podía operar sobre remitos que no eran de su propia ruta del día, simplemente conociendo o probando un `pedido_id` ajeno:
  - **Fuga de datos:** `GET /api/chofer/remitos?id=<pedido_id>` devolvía domicilio, teléfono y coordenadas del cliente de cualquier pedido de la empresa, esté o no en la ruta del chofer que consulta. `GET /api/chofer/clientes` tenía el mismo problema a nivel de listado: devolvía **todos** los clientes con pedidos activos hoy en la empresa, no solo los de la ruta propia.
  - **Integridad/fraude:** `PATCH /api/chofer/remitos/:id/entregar` y `.../no-entregar` no validaban que el pedido estuviera en una ruta asignada al chofer que hace la request — solo que perteneciera a su empresa. Un chofer podía marcar como "entregado" (con firma, foto y **cobro real vía `registrar_cobro_completo`**) o "no entregado" (con motivo fabricado, dispara WhatsApp al cliente) un pedido que reparte otro chofer, sin haber estado ahí.
  - `POST /api/chofer/devolucion` con `pedido_id` tenía el mismo gap: permitía registrar una devolución (y, si el motivo es "producto defectuoso", generar automáticamente una nota de débito a proveedor) contra un pedido ajeno.
- **Cómo se detectó:** Al leer `handleChofer` en `lib/handlers/pedidos.js` se notó que el listado (`GET /api/chofer/remitos` sin `id`) sí filtra por `.eq('chofer_id', chofer_id)` para no-admin, pero el resto de las rutas del mismo handler (`?id=`, `entregar`, `no-entregar`, `clientes`, `devolucion`) solo validan `empresa_id` — misma asimetría entre endpoints "de listado" y "de detalle/acción" que ya se vio en FACTURAS-002.
- **Verificación de datos en producción:** se cruzaron `entregas.cobro_id` → `cobros.usuario_id` contra `rutas.chofer_id` de la ruta de esa entrega — **0 filas con mismatch**. Todos los cobros registrados hasta ahora coinciden con el chofer efectivamente asignado a la ruta; no hay evidencia de explotación.
- **Fix aplicado (código, `lib/handlers/pedidos.js`):**
  1. Nuevo helper `pedidoEsDeEsteChofer(pedido_id, chofer_id)`: confirma que exista una entrega activa (`pendiente`/`en_camino`) de ese pedido en una ruta cuyo `chofer_id` sea el del usuario autenticado.
  2. Aplicado antes de responder/actuar en `GET remitos?id=`, `PATCH entregar`, `PATCH no-entregar` y `POST devolucion` (cuando trae `pedido_id`) — en los cuatro casos, solo para `perfil.rol === 'chofer'`; dueño/admin siguen sin esta restricción, como corresponde.
  3. `GET /api/chofer/clientes` ahora, para no-admin, resuelve primero las rutas del chofer del día y limita la lista de pedidos/clientes a esas rutas — replica el mismo filtro que ya usaba el listado de remitos.
- **Estado:** ✅ Corregido en el código del ZIP (2026-07-26). **Hace falta deploy** (`vercel --prod`) — no es una migración SQL. Recomendado probar con dos choferes reales antes/después del deploy (ver pendiente de prueba manual).
- **Disparador si es reapertura:** se reabre si se agrega un nuevo endpoint en `/api/chofer/*` que reciba un `pedido_id`/`cliente_id` y opere o lea datos sin pasar por `pedidoEsDeEsteChofer` (o el filtro equivalente) para roles no-admin.

---

## Puntos / Fidelización

### PUNTOS-001 — `acreditar_puntos`/`canjear_puntos` sin chequeo de rol: cualquier usuario autenticado podía auto-acreditarse puntos ilimitados

- **Fecha:** 2026-07-26
- **Tipo:** Bug de seguridad crítico (escalación de rol dentro del mismo tenant — no requiere bypass de RLS)
- **Impacto:** 🔴 Crítico — es el hallazgo más grave de la sesión. El menú "Puntos clientes" está restringido a `dueno`/`admin` en `nav-data.js`, pero esa restricción es **solo de navegación**: las RPCs `acreditar_puntos` y `canjear_puntos` (llamadas directo desde el frontend admin vía `sb.rpc(...)`, con `GRANT EXECUTE ... TO authenticated`) únicamente validaban que `p_empresa_id` coincidiera con la empresa del caller — nunca su rol de negocio. Esto significa que **cualquier cuenta autenticada de la empresa** (un cliente del portal, un chofer, un vendedor) podía, sin pasar por ningún panel admin, llamar directo a `acreditar_puntos` con su propio `empresa_id` y un `p_puntos` arbitrario (ej. 999.999) y acreditarse puntos reales — para después canjearlos por recompensas físicas/descuentos reales a través del flujo normal del portal cliente (`fidelizacion.js`, que sí valida correctamente `rol='cliente'` y deriva `cliente_id` de la sesión, pero confía en que el saldo ya es legítimo). Adicionalmente, ninguna de las dos RPCs validaba que `p_cliente_id` perteneciera a `p_empresa_id` (mismo patrón que CLIENTES-002/REGLAS-001/NC-001) — aunque en este caso la clave compuesta `(cliente_id, empresa_id)` de `saldo_puntos` evita que eso pise el saldo real de un cliente de otra empresa.
- **Cómo se detectó:** Al leer `frontend/admin/js/puntos.js` se notó que "Acreditar manual"/"Canjear manual" llaman RPCs directo con el `sb` del usuario logueado (no pasan por un handler serverless con `SERVICE_ROLE_KEY` como el resto de las acciones sensibles de este módulo). Al revisar la definición de esas RPCs en producción, el único chequeo presente era el de `empresa_id` — no había ningún `get_rol_usuario()` ni equivalente, a diferencia de otras RPCs administrativas del proyecto.
- **Verificación de datos en producción:** `movimientos_puntos` no tiene ninguna fila con `referencia_id IS NULL` (que es como quedan las acreditaciones/canjes manuales) — el módulo no se había usado todavía, manual o automáticamente, así que no hay evidencia de explotación ni datos que limpiar. También se verificó que no existe ningún `saldo_puntos` cuyo `cliente_id` pertenezca a una empresa distinta de la del propio `saldo_puntos.empresa_id` — 0 filas.
- **Fix aplicado (migración `421_fix_puntos_rpcs_rol_y_tenant_check`, aplicada directo en Supabase):**
  1. `acreditar_puntos` y `canjear_puntos` ahora exigen `get_rol_usuario() IN ('dueno','admin')` (o `service_role`) antes de mover un solo punto.
  2. Ambas validan que `p_cliente_id` pertenezca a `p_empresa_id` antes de operar (defensa en profundidad).
  3. `fn_puntos_lista` y `fn_puntos_kpis` (listado/KPIs del panel) reciben el mismo chequeo de rol, para ser consistentes con la restricción de `nav-data.js` — antes cualquier autenticado podía leer el listado completo de clientes con puntos y sus saldos de su empresa, aunque no pudiera editarlos.
- **Estado:** ✅ Aplicado y verificado en producción (2026-07-26). No requiere deploy de código — es 100% migración SQL, ya vigente. Falta solo la prueba manual de que dueño/admin siguen pudiendo acreditar/canjear desde el panel (ver pendiente de prueba manual).
- **Disparador si es reapertura:** se reabre si aparece una RPC nueva llamada directo desde el frontend (`sb.rpc(...)`, no vía un handler serverless con `SERVICE_ROLE_KEY`) que mueva datos sensibles (dinero, puntos, stock) validando `empresa_id` pero no el rol de negocio del caller — la lección general es que "requiere sesión" y "requiere rol X" son chequeos independientes y ambos tienen que vivir en la función si se expone a `authenticated` directo.

---

## Asistente / IA

### ASISTENTE-001 — Las tools de datos en vivo del asistente solo validaban `empresa_id`, nunca el rol de negocio del caller (mismo patrón que PUNTOS-001)

- **Fecha:** 2026-07-26
- **Tipo:** Bug de seguridad (escalación de rol dentro del mismo tenant — no requiere bypass de RLS)
- **Impacto:** 🟠 Alto — el chat flotante del asistente (`chat-widget.js`) se inyecta sin distinguir rol en las ~27 pantallas del admin vía `nav.js`, así que cualquier usuario autenticado del panel (dueño, admin, vendedor, contador, depositero — no chofer, que tiene su propio portal separado en `frontend/chofer`) podía abrirlo y usar cualquiera de las 9 tools de `lib/asistente-tools.js` (`consultar_deuda_proveedor`, `listar_facturas_proveedor_por_vencer`, `listar_cheques_alerta`, `consultar_bloqueo_cliente`, etc.). El handler (`lib/handlers/asistente.js`) resuelve `empresa_id` correctamente desde el perfil de sesión y nunca lo toma del modelo/usuario, y cada RPC detrás de las tools (`supabase/migrations/203_asistente_tools_lectura.sql`) está bien scopeada por `empresa_id`, `REVOKE`d de `PUBLIC`/`authenticated` y sólo ejecutable por `service_role` — pero ni el handler ni `ejecutarTool()` chequeaban el **rol** del caller antes de ejecutar la tool. Resultado: un **vendedor** (sin acceso en el menú a "Proveedores" ni "Cheques" — ver `nav-data.js`, roles `['dueno','admin','depositero']` y `['dueno','admin','contador']` respectivamente) podía preguntarle al chat "¿cuánto le debemos a tal proveedor?" o "¿qué cheques se rechazaron?" y obtener esos mismos datos que su propio panel le oculta. Mismo problema para un **depositero** con `consultar_bloqueo_cliente` (score/deuda/límite de crédito de cualquier cliente — pantalla "Clientes" restringida a `dueno/admin/vendedor`) o `listar_cheques_alerta`.
- **Cómo se detectó:** Al auditar el módulo Asistente/IA completo (handler, tools, RPCs y dónde se inyecta el widget en el frontend) se notó la misma asimetría ya vista en PUNTOS-001: una restricción de navegación (`nav-data.js`) que no tiene ningún equivalente real en el backend que la sirve — en este caso, 9 funciones de "tool calling" expuestas a cualquier rol autenticado del panel.
- **Verificación de datos en producción:** No aplica — es una tool de solo lectura (no muta datos), así que no hay filas que verificar; el riesgo es de fuga de información, no de integridad.
- **Fix aplicado (código, `lib/asistente-tools.js` + `lib/handlers/asistente.js`):**
  1. Cada tool sensible ahora declara `roles: [...]`, replicando exactamente los roles que ya tienen la pantalla equivalente habilitada en `nav-data.js` (ej. `consultar_deuda_proveedor`/`listar_facturas_proveedor_por_vencer` → `['dueno','admin','contador','depositero']`, `listar_cheques_alerta`/`diagnosticar_cheque` → `['dueno','admin','contador']`, `consultar_bloqueo_cliente` → `['dueno','admin','vendedor','contador']`, `consultar_ruta_dia`/`consultar_stock_critico` → `['dueno','admin','depositero']`, etc.).
  2. `ejecutarTool(nombre, { empresaId, rol, args })` ahora recibe también el `rol` del perfil ya verificado y rechaza la ejecución (con un mensaje amigable, no un 500) si el rol no está en la lista de la tool — el error se propaga como resultado de la función a Gemini (ver `asistente-providers.js`, ya envuelve `tools.ejecutar` en `try/catch`), así que el modelo simplemente le explica al usuario que no tiene permiso, sin romper la conversación.
  3. `lib/handlers/asistente.js` ahora pasa `rol: perfil.rol` al armar `tools.ejecutar`.
  4. Tools sin `roles` definido quedan igual que antes (no se restringió ninguna que no aparece mencionada arriba).
- **Estado:** ✅ Corregido en el código del ZIP (2026-07-26). **Hace falta deploy** (`vercel --prod`) — no es una migración SQL, no toca RPCs ni RLS.
- **Disparador si es reapertura:** se reabre si se agrega una tool nueva a `lib/asistente-tools.js` que exponga un dato restringido en el nav a ciertos roles, sin declarar el mismo `roles: [...]` — o si se agrega un nuevo punto de entrada al asistente que no pase por el mismo `ejecutarTool()`.

## Portal Cliente

### PORTALCLIENTE-001 — El link de "pedido sugerido" por WhatsApp mostraba "Pedido no encontrado" al 100% de los clientes (RLS bloqueaba al caller anon por completo)

- **Fecha:** 2026-07-26
- **Tipo:** Bug funcional (no de seguridad — la causa es una RLS *demasiado* restrictiva, no faltante)
- **Impacto:** 🔴 Alto (funcional) — `frontend/cliente/checkout.html` es la página que abre el link de WhatsApp generado en `lib/handlers/piloto.js` (`${appUrl}/cliente/checkout?pedido=${p.pedido_id}`) para que un cliente confirme un "pedido sugerido" (motor predictivo) sin necesidad de loguearse. La página consultaba `pedidos` directo con `supabase-js` usando la anon key, **sin llamar nunca a `signInAnonymously()` ni ningún login** — es decir, corría con `auth.uid()` NULL. La política `pedidos_select_unificada` exige que `auth.uid()` resuelva a un usuario para cualquiera de sus 3 ramas (cliente propio / staff de la empresa / service_role), así que para un caller anon ninguna rama es verdadera nunca.
- **Cómo se detectó:** Al auditar el Portal Cliente completo, se notó que `checkout.html` no hace login en ningún lado pese a consultar una tabla protegida por RLS. Se verificó empíricamente contra Supabase con `SET ROLE anon` (sin JWT): `SELECT count(*) FROM pedidos` devuelve **0 filas sobre toda la tabla**, confirmando que ningún cliente podía ver el preview de su pedido sugerido — el botón "Confirmar Pedido" nunca llegaba a mostrarse porque la carga previa siempre caía en el estado "Pedido no encontrado. El link puede haber vencido o el pedido ya fue procesado."
- **Nota importante:** la acción de confirmar en sí (`POST /api/pedidos?accion=confirmar-sugerido`) **sí funcionaba bien** — corre server-side con `service_role` y resuelve todo a partir del `pedido_id`, nunca dependió de RLS. El problema era exclusivamente la carga del preview antes de confirmar.
- **Verificación de datos en producción:** no aplica — es un bug de disponibilidad (feature rota para todos), no de fuga de datos. Al momento de la auditoría hay 0 pedidos en estado `sugerido` en la base, así que no hay manera de saber hace cuánto está rota (el motor predictivo puede no haber disparado ninguno todavía, o los que disparó nunca se pudieron confirmar por este mismo motivo).
- **Fix aplicado (código, `lib/handlers/pedidos.js` + `frontend/cliente/checkout.html`):**
  1. Nuevo endpoint público `GET /api/pedidos?accion=ver-sugerido&pedido_id=...` (rate-limited con el mismo limiter que `confirmar-sugerido`), que resuelve todo server-side con `service_role` — sin depender de RLS ni de sesión — y solo devuelve datos si `estado` es `sugerido` o `pendiente` (mismo criterio que ya usaba el front para las otras ramas).
  2. `checkout.html` ahora llama a ese endpoint en vez de consultar Supabase directo; se sacó el cliente `supabase-js` (ya no se usa nada de él en esta página) y el `<script>` del CDN que solo servía para eso.
- **Estado:** ✅ Corregido en el código del ZIP (2026-07-26). **Hace falta deploy** (`vercel --prod`) — no es una migración SQL.
- **Disparador si es reapertura:** se reabre si se agrega a `checkout.html` (o a cualquier otra página sin login) una consulta directa a una tabla con RLS sin antes pasar por un endpoint público server-side — el mismo problema aparece con cualquier tabla cuya política de SELECT no tenga una rama explícita para `anon`.
- **Resto del Portal Cliente (`carrito.html`, `catalogo.html`, `cuenta.html`, `inicio.html`, `login.html`, `pedidos.html`) — diagnóstico OK:** todas las mutaciones sensibles van por endpoints backend que resuelven `empresa_id`/`cliente_id` desde la sesión (nunca del body/URL) — mismo patrón ya visto en `confirmarPedidoHandler` y el canje de puntos del propio cliente (`lib/handlers/fidelizacion.js`). El único lugar donde el front maneja un `empresa_id` potencialmente controlado por URL es `catalogo.html` (para el catálogo público, SEC-008 de una sesión anterior) al hacer `upsert` directo sobre `carrito_items`; se verificó que la política `carrito_insert` exige `empresa_id IN (empresa real del usuario logueado)` en el `WITH CHECK`, así que un intento de agregar al carrito un producto de otra empresa se rechaza en el primer insert — no hay forma de explotarlo vía el camino de conflicto/update porque nunca se llega a crear la fila.

## Infraestructura / Cron Jobs

### CRON-001 — 10 endpoints de cron confiaban en el header `x-vercel-cron`, que cualquiera puede mandar en un request HTTP normal

- **Fecha:** 2026-07-26
- **Tipo:** Bug de seguridad (bypass de autenticación en endpoints internos/batch, multi-tenant)
- **Impacto:** 🔴 Crítico — 10 endpoints (los 10 cron jobs reales definidos en `vercel.json`: `score.js` `recalcular-todos`, `stock.js` liquidación `generar`, `stock-auto.js`, `cierre.js`, `rutas-live.js` `reporte-semanal`, `auditoria.js`, `piloto.js` `generar`/`whatsapp-cron`, y `notif.js` cheques-por-vencer/deuda-vencida) determinaban si el caller era "el cron interno" (y por lo tanto podía saltarse el login) chequeando **únicamente** `req.headers['x-vercel-cron'] === '1'`, o ese header en `OR` con el `CRON_SECRET` real. El problema: un header HTTP es un dato que cualquier cliente puede mandar en un request normal — la documentación oficial de Vercel (`vercel.com/docs/cron-jobs`) nunca lo presenta como mecanismo de seguridad, solo como forma de identificar *qué* cron disparó la llamada cuando varios comparten la misma ruta; el único mecanismo que Vercel documenta como no-spoofeable es `CRON_SECRET` (enviado como `Authorization: Bearer`). Con el `OR`, bastaba mandar ese único header para pasar como "cron" sin necesitar el secreto — y en `score.js` **ni siquiera había un `OR` con `CRON_SECRET`**, era la única condición.
  - Peor caso confirmado: `POST /api/score?accion=recalcular-todos` con solo `x-vercel-cron: 1` (sin ningún token ni secreto) disparaba el recálculo de score para **todas las empresas activas** de la plataforma.
  - Otros endpoints con el mismo bypass: generación de ofertas de liquidación (mutación real de precios/stock) en `stock.js`; procesamiento de la cola financiera (facturar/notificar/bloquear) en `cierre.js`; y en `piloto.js`, disparar el envío masivo de WhatsApp real (vía Meta Business API, con costo por mensaje) a clientes de todas las empresas activas.
- **Mitigante ya existente (reduce el impacto, no lo elimina):** se verificó que `generar_pedidos_sugeridos` (36 hs) y `obtener_sugeridos_para_whatsapp` (1 por cliente por día vía `notif_log`) tienen deduplicación a nivel RPC, así que el abuso de `whatsapp-cron` no se traduce en espamear un cliente más de una vez por día aunque se llame el endpoint repetidas veces — pero sigue permitiendo disparar el proceso en el momento que el atacante quiera, y el resto de los endpoints (score, liquidación, cierre) no tienen ese mismo resguardo.
- **Cómo se detectó:** al auditar `piloto.js` se notó el patrón `x-vercel-cron === '1' || Authorization === Bearer CRON_SECRET` y se buscó en todo el repo — apareció idéntico (algunos con y otros sin el `OR`) en 10 endpoints, todos confirmados como cron jobs reales en `vercel.json`.
- **Límite de esta auditoría:** no se pudo probar el spoofing de forma empírica contra la infraestructura real de Vercel (no hay acceso de red desde este entorno a dominios de Vercel/producción para armar un request con headers arbitrarios) — la recomendación de arreglarlo es independiente de si hoy es explotable o no, porque el fix no tiene downside: Vercel garantiza que `CRON_SECRET` va a seguir llegando en cada invocación real de cron.
- **Fix aplicado (código, 8 archivos):** `lib/handlers/score.js`, `stock.js`, `stock-auto.js`, `cierre.js`, `rutas-live.js`, `auditoria.js`, `piloto.js`, `notif.js` (2 funciones). En todos se sacó `x-vercel-cron` de la condición de autorización — ahora la única forma de pasar como "cron interno" es el `Authorization: Bearer $CRON_SECRET` real, con fail-closed (401/503) si `CRON_SECRET` no está configurada como variable de entorno.
- **⚠️ Importante antes de deployar:** verificar en el dashboard de Vercel (Project → Settings → Environment Variables) que `CRON_SECRET` esté efectivamente configurada en producción. Si no lo está, los 10 cron jobs de `vercel.json` van a empezar a fallar con 401/503 después de este deploy (antes fallaban "silenciosamente seguros" gracias al header spoofeable, ahora fallan cerrados si falta el secreto).
- **Estado:** ✅ Corregido en el código del ZIP (2026-07-26). **Hace falta deploy** (`vercel --prod`) — no es una migración SQL. **Depende de que `CRON_SECRET` esté configurada en Vercel** (ver punto anterior).
- **Disparador si es reapertura:** se reabre si se agrega un endpoint nuevo (cron o no) que vuelva a chequear `x-vercel-cron` como mecanismo de autorización, en vez de `CRON_SECRET`.
