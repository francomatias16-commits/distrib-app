# Etapa 4 — Facturación AFIP/ARCA

**Flujo auditado:** `lib/arca/wsaa.js` (autenticación WSAA) + `lib/arca/wsfev1.js`
(emisión WSFEv1: Factura C y Nota de Crédito C) + `lib/arca/comprobante-pdf.js`
(PDF con código de barras) + `lib/facturas.js` (orquestador) +
`lib/handlers/facturas.js` (endpoints, incluye config y notas de crédito) +
`frontend/admin/js/facturacion.js` + `frontend/admin/facturacion-config.html`.
Se revisó también el esquema en Supabase (`facturacion_config`, `tokens_wsaa`,
`facturas`) contra lo documentado en `102_facturacion_arca.sql`.

**Lo que ya estaba bien** (se verificó, no se tocó): `wsaa.js` firma el TRA
con `node-forge` (sin depender de `openssl` binario, correcto para
serverless), cachea el token respetando el margen de renovación, y da
mensajes de error accionables ante fallos SOAP. `wsfev1.js` no reintenta
automáticamente `FECAESolicitar` (correcto: reintentar a ciegas podría
numerar un comprobante dos veces), sí reintenta `FECompUltimoAutorizado`
(idempotente, seguro). El corte de modo demo es consistente en los tres
puntos de entrada (emitir, NC, test de credenciales) — ninguna empresa
demo puede tocar AFIP real. `cert_pem`/`key_pem` se cifran con AES-256-GCM
antes de guardarse (`lib/crypto-secrets.js`) y `get_facturacion_config()`
nunca los expone. El rate limiting distingue lectura (60/min) de emisión
(10/min, las que pegan contra ARCA). El manejo de timeout en `anular()`
del frontend (AbortController 45s + "verificar estado" en vez de asumir
error) es un buen patrón ya usado en cta_cte.

---

## 🔴 Hallazgo 1 — La integración ARCA solo emite Factura C, sin importar la condición de IVA configurada de la empresa

**Lo que encontré:** `facturacion-config.html` deja elegir la condición de
IVA de la propia empresa — Monotributista, **Responsable Inscripto** o
Exento — y la guarda en `facturacion_config.condicion_iva`. Pero
`wsfev1.js` (`emitirComprobanteARCA` y `emitirNotaCreditoARCA`) nunca lee
ese campo: siempre arma el request con `TIPO_CBTE.FACTURA_C` (tipo 11) y
siempre fuerza `impIVA = 0`, sin discriminar IVA. El campo `facturas.tipo`
que `crearFacturaPendiente()` (en `lib/facturas.js`) calcula correctamente
como `'A'` para un cliente Responsable Inscripto queda pisado por `'C'` en
cuanto `wsfev1.js` persiste el resultado exitoso.

Para una empresa monotributista esto es correcto (un monotributista
factura C a todo el mundo). El problema es que la pantalla de
configuración deja elegir "Responsable Inscripto" como si fuera una opción
soportada — y una empresa RI **debe** emitir Factura A o B discriminando
IVA; emitir Factura C en su lugar es fiscalmente inválido. Encontré además
que `comprobante-pdf.js` ya tiene la lógica para mostrar el desglose
Neto/IVA cuando `empresa.condicion_iva !== 'monotributo'` — pero como
`factura.iva` siempre llega en 0 y `factura.tipo` siempre en `'C'`, el PDF
terminaría mostrando un comprobante rotulado "FACTURA C" con una fila
"IVA (21%): $0,00" agregada, que no tiene sentido en una Factura C real.
Es la misma señal de siempre: una función construida a medias, sin cortar
el camino que no está terminado.

**Severidad:** alta — riesgo fiscal, no solo de UX. Verificado en Supabase:
hoy la única empresa activa con `facturacion_config` está en `monotributo`
(sin impacto actual), pero la opción "Responsable Inscripto" está
disponible en la pantalla ahora mismo para cualquier empresa nueva.

**Fix aplicado (código, pendiente de deploy):** guard explícito en
`emitirComprobanteARCA` y `emitirNotaCreditoARCA`: si
`facturacion_config.condicion_iva` no es `monotributo`/`monotributista`,
la emisión se corta con un error claro (`estado: 'error_afip'` con el
motivo) en vez de emitir una Factura C inválida en silencio. No se
implementó Factura A/B en esta pasada — es un desarrollo bastante más
grande (discriminar IVA por ítem, distinto cálculo de totales) que excede
el alcance de una corrección puntual.

---

## 🔴 Hallazgo 2 — Búsqueda, filtros y KPIs del panel de Facturación operaban sobre la página cargada en memoria, no contra el servidor

**Lo que encontré:** el propio código documenta que la migración 262
(`fn_facturas_lista`, `fn_facturas_contadores`) se hizo específicamente
para dejar de traer un recorte fijo (300 facturas) y filtrar todo en el
navegador — el comentario dice literalmente *"con 1.505 facturas en el
tenant demo, 'Todo el historial' mostraba en realidad las últimas 300
nomás"*. Confirmé en Supabase que el tenant demo tiene **1502 facturas**
reales hoy.

El problema: la migración a `fn_facturas_lista` solo se completó en
`cargarFacturas()` (la que carga cada página, 200 filas). Pero la
**búsqueda por texto** (debounce en `input-busqueda`), el **selector de
estado** (pills y tarjetas KPI clicables) y el **selector de período**
seguían llamando a una función separada, `aplicarFiltros()`, que filtraba
en memoria sobre el array `facturas` — es decir, sobre la página ya
cargada, nunca sobre las 1502 facturas reales de la empresa. Buscar una
factura que no estuviera en esa página (lo normal, dado que son 8 páginas
de 200) devolvía "sin resultados" aunque la factura existiera. Mismo
problema para "ver solo pendientes/con error": si esas facturas no
estaban en la página cargada, no aparecían.

De paso encontré que las 4 tarjetas KPI (pendientes, con error,
emitidas del mes, total del mes) tienen el mismo defecto por partida
doble: `cargarContadoresFacturas()` sí trae los números correctos desde
`fn_facturas_contadores` (sobre el universo completo) y los guarda en
`contadoresFacturas` — pero `actualizarKpis()`, la función que efectivamente
pinta las tarjetas, ignoraba esa variable por completo y recalculaba los
4 números a mano desde `facturas` (la página). `contadoresFacturas` se
cargaba y quedaba sin usar.

**Severidad:** alta — es exactamente el bug que la migración 262 dice
haber resuelto, reintroducido por una segunda función de filtrado que
nunca se actualizó cuando se hizo esa migración. Con 1502 facturas reales
en el tenant demo, este no es un caso límite raro: es el comportamiento
normal de la pantalla hoy.

**Fix aplicado (código, pendiente de deploy):**
- Búsqueda, pills de estado y selector de período ahora llaman a
  `cargarFacturas()` (resetenado a página 1), que sí consulta
  `fn_facturas_lista` con los filtros aplicados en SQL. Se mantuvo el
  nombre de función `aplicarFiltros()` para no romper los `onchange` de
  los inputs de rango de fecha en `facturacion.html`, pero su
  implementación ahora delega al camino correcto.
- `actualizarKpis()` reescrita para leer `contadoresFacturas` (los 4
  números ya vienen bien calculados desde el servidor) en vez de
  recalcular desde la página.
- `reintentar()` y `anular()` ahora también refrescan `contadoresFacturas`
  después de la acción (antes solo se cargaba una vez, al entrar a la
  pantalla, así que las tarjetas quedaban desactualizadas tras cualquier
  cambio de estado).

Sin migraciones SQL — `fn_facturas_lista`/`fn_facturas_contadores` ya
existían y funcionan bien; el problema era exclusivamente que el frontend
no las usaba en todos los caminos.

---

## 🔴 Hallazgo 3 — RLS de `facturacion_config` exponía el certificado y la clave privada de ARCA (cifrados) a cualquier usuario autenticado de la empresa

**Lo que encontré (en producción, Supabase, no en el repo):** la migración
documentada (`102_facturacion_arca.sql`) es explícita: *"la tabla solo es
accesible por service_role"*, con una única policy `service_role_all_...`.
Consulté las policies reales en Supabase y encontré 4 policies adicionales
(`fc_select`, `fc_insert`, `fc_update`, `fc_delete`) que **no existen en
ningún archivo de migración del repo** — se crearon fuera de control de
versiones. `fc_insert`, `fc_update` y `fc_delete` sí están bien (atadas a
`service_role`), pero `fc_select` tenía:

```
(auth.role() = 'service_role') OR (empresa_id = auth_empresa_id())
```

`auth_empresa_id()` solo verifica que el usuario logueado pertenezca a esa
empresa — **sin chequeo de rol**. Es decir: cualquier usuario autenticado
de la empresa (vendedor, chofer, cualquier rol) podía hacer
`supabase.from('facturacion_config').select('*')` desde el propio navegador
y traerse la fila completa, incluidos `cert_pem` y `key_pem`. Los valores
viajan cifrados (AES-256-GCM), así que no es una fuga directa de la clave
en texto plano, pero contradice frontalmente el diseño documentado
("nunca deben ser legibles desde el frontend") y es exactamente el tipo de
drift no versionado que ya había aparecido en otras tablas durante la
auditoría de seguridad original.

**Severidad:** alta — defensa en profundidad rota en la tabla más sensible
del módulo (contiene la identidad fiscal de la empresa ante AFIP).

**Fix aplicado (ya en Supabase, no requiere deploy):**
`DROP POLICY fc_select ON facturacion_config;`
Verifiqué que ningún frontend seleccionaba esta tabla directamente (todo
el acceso legítimo pasa por `get_facturacion_config()`, que sí filtra las
columnas sensibles), así que el cambio no rompe nada. Con las 4 policies
`fc_*` reducidas a 3 y la policy original de `service_role`, el acceso
directo queda denegado por defecto para `anon`/`authenticated`.

---

## Resumen de la etapa

| Hallazgo | Severidad | Estado |
|---|---|---|
| 1 — ARCA emite Factura C sin importar la condición de IVA de la empresa (riesgo fiscal para futura empresa Responsable Inscripta) | 🔴 Alta | ✅ Corregido (código, pendiente de deploy) |
| 2 — Búsqueda/filtros/KPIs de facturación operaban sobre la página en memoria, no contra el servidor | 🔴 Alta | ✅ Corregido (código, pendiente de deploy) |
| 3 — RLS de `facturacion_config` exponía cert/clave (cifrados) a cualquier usuario de la empresa, vía policy no versionada | 🔴 Alta | ✅ **Corregido y aplicado en Supabase** |

**Pendiente de `git push`/deploy a Vercel:** hallazgos 1 y 2 (código).
El hallazgo 3 ya está activo en producción (se aplicó directo en Supabase,
no requiere deploy de código).

**No se tocó en esta pasada:** implementar Factura A/B real. El guard del
Hallazgo 1 evita el daño (corta con error en vez de emitir mal), pero si
en algún momento una empresa Responsable Inscripta necesita facturar,
hace falta ese desarrollo — no es un fix chico.
