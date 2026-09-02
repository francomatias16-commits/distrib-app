# Auditoría UI vs. datos demo — Distribuidora Litoral (2026-08-27)

Chequeo sección por sección de la app contra las tablas de Supabase, para
detectar huecos a nivel de **UI** (no de datos crudos): secciones/widgets que
existen y se renderizan, pero que van a mostrarse vacíos o rotos porque la
tabla que consumen tiene 0 filas.

Método: se listaron las 141 tablas del proyecto (`jgiquzjwoedmzwqgzubr`) con
su row count, se filtraron las que están en 0, y para cada una se rastreó en
el código (`lib/handlers`, `lib/repos`, `frontend/admin/js`, etc.) si existe
un endpoint/consumidor de UI real que la lea. Las que no tienen consumidor de
UI (solo aparecen en migraciones o son tablas puramente operativas) se
descartaron como falsos positivos.

## A. Huecos reales — afectan una pantalla que el usuario puede visitar hoy

| # | Tabla | Dónde se ve | Severidad | Por qué importa |
|---|-------|-------------|-----------|------------------|
| 1 | `combo_items` (0, pero `combos` tiene 3) | `admin/pedidos.html` (combos-tab.js, producto-picker.js) + flujo de pedido del cliente (`crear_pedido_cliente_combos`) | **Alta** | Hay 3 combos creados sin ningún ítem adentro. Un combo sin ítems es una entidad inconsistente: en el admin se va a ver como una tarjeta vacía, y si el cliente intenta pedirlo la RPC de combos probablemente falle o devuelva un combo sin productos. |
| 2 | `presupuesto_items` (0, pero `presupuestos` tiene 1) | `admin/presupuestos.html` | **Alta** | El único presupuesto sembrado no tiene renglones. Al abrirlo se va a ver un presupuesto con $0 / sin productos, lo cual no sirve como demo de la función. |
| 3 | `ofertas_liquidacion` (0) | `admin/liquidacion.html` (página completa: KPIs + tabla) | **Alta** | Es una sección entera del menú y va a cargar 100% vacía (0 ofertas activas, KPI "sin ofertas activas"). Se genera vía RPC `generar_ofertas_liquidacion`, no por insert directo — hay que correr esa función sobre productos reales para poblarla. |
| 4 | `ciclos_compra` (0) | `admin/clientes.html` → widget "Ciclos de compra" por cliente (`clientes-ciclos.js`, `GET /api/ciclos?cliente_id=`) | **Alta** | Con 103 clientes, es una función que se va a mostrar en casi cualquier ficha de cliente que se abra durante la demo, y siempre va a decir "sin datos" en vez de mostrar el patrón de recompra / sugerencia de próximo pedido. |
| 5 | `alertas_stock` (0) | `admin/stock.html` (o `productos.html`) → contenedor `#alertas-stock-auto`, `GET /api/stock-auto?accion=alertas` | Media | Widget de alertas automáticas de quiebre/reposición de stock. Con 82 filas en `stock` seguro hay productos por debajo de mínimo, pero como el motor todavía no corrió/insertó nada, el widget se ve vacío. **Ver actualización 2026-08-27 más abajo — el motor real solo dispara para 1 producto con los datos actuales.** |
| 6 | `sugerencias_pedido` (0) | `admin/automatizacion.html` → "Piloto Automático — Motor de sugerencias de pedidos" | ~~Media~~ **Descartado** | Investigado 2026-08-27: es código huérfano. Ver sección D. |
| 7 | `email_log` (0) | `admin/notif-log.html` → tab/canal "Email" | ~~Media~~ **Descartado** | Investigado 2026-08-27: comportamiento esperado (migrado a `notif_log`). Ver sección D. |
| 8 | `asistente_articulos` (0) | Asistente de ayuda (chat-widget.js / `lib/handlers/asistente.js`) | **Alta (funcional, no solo visual)** | Investigado 2026-08-27: no es que falte correr el script, **el script estaba roto**. Ver actualización más abajo. |
| 9 | `integraciones_pago` (0) | `admin/mercadopago-config.html` | Baja/Media | Ninguna empresa tiene Mercado Pago conectado, así que esa pantalla siempre muestra el estado "no conectado". Es razonable que quede así en una demo (no se puede fakear un OAuth real). |

## B. Huecos silenciosos — no rompen ninguna pantalla, pero degradan un cálculo existente

| Tabla | Afecta a | Detalle |
|---|---|---|
| `cobro_facturas_aplicadas` (0) | `scores_cliente` (791 filas ya calculadas) / `admin/riesgo-cheques.html` | **Reclasificado 2026-08-27** — ver actualización más abajo. No se puede poblar con datos reales: los 140 `cobros` de la empresa y sus 3 `facturas` no tienen ningún cliente en común. Se decide dejarlo documentado, sin fabricar datos. |

## C. Se revisaron y son falsos positivos (vacías a propósito, no son huecos)

- **`ruta_items`** — tabla legacy, reemplazada por `entregas`. No tiene consumidor de UI vivo.
- **`refresh_tokens`, `tokens_wsaa`, `audit_log_pendientes`** — tablas puramente operativas. Vacías = sistema sano.
- **`dispositivos_push`, `pos_favoritos`, `chofer_invitaciones`, `anomalias_revisadas`, `asistente_uso`, `asistente_acciones_pendientes`** — estado transitorio/generado por uso real.
- **`export_contable_log`** — empty-state dedicado y prolijo.
- **`migracion_plantillas_mapeo`** — feature de onboarding, no es uso diario.
- **`producto_insumos`** — BOM/receta de producción propia. **A confirmar** si el guion de demo quiere mostrar "producción propia".

## D. Investigado 2026-08-27 y descartado (código huérfano o comportamiento esperado)

- **`sugerencias_pedido`** — código huérfano: solo la escribe `handleSugerencias` (`POST /api/stock?_svc=sugerencias`), que ningún fetch del frontend llama. El motor real ("Piloto Automático") usa `ciclos_compra`, no esta tabla. Ya documentado como hallazgo de seguridad (IDOR) en `TESTING_OPTIMIZACION.md`. Poblarla no serviría de nada porque nada la lee.
- **`email_log`** — tabla legada, dejada de escribir a propósito. El código (`lib/handlers/notif.js`) migró todo el logging de emails a `notif_log` (1.853 filas reales para esta empresa). Comportamiento esperado, no un hueco.

---

## Actualización — sesión 2026-08-27 (continuación)

### `alertas_stock` — más profundo que "faltan filas"

Se corrió `analizar_stock_autonomo()` (RPC real, solo lectura) contra
Distribuidora del Litoral. Con los datos actuales, **solo 1 producto**
(Fideos Tallarín 500g, stock 0) dispara `necesita_reponer = true`. El resto
de los productos con venta simulada tienen velocidades tan bajas
(≈0.07–0.17 u/día) contra stocks tan altos (89–2000+ u) que da miles de
"días restantes" — el motor nunca los va a marcar como críticos con los
datos que hay hoy.

Además, **ningún producto tiene `proveedor_id_default` cargado**, así que
incluso los productos que sí necesitan reponerse caen siempre en la rama
`sin_proveedor` (nunca en `crítico`/`quiebre` con orden real) — un bug ya
señalado en la investigación previa de "punto 4".

**Plan acordado (pendiente de ejecución, no escrito aún):** bajar stock real
de 2 productos con venta real (Arroz Largo Fino 1kg → crítico, Oregano x1kg →
quiebre) y asignarles `proveedor_id_default` (Alimentos del Litoral SRL) para
que el motor genere una orden de compra automática real con ambos tipos de
alerta, más 2 casos adicionales de `sin_proveedor` (Fideos Tallarín, que ya
dispara hoy, y Jugo jodi naranja, bajando su stock). Detalle línea por línea
en el hilo de chat de esta sesión.

### `asistente_articulos` — no faltaba correr el script, estaba roto

El script `scripts/generar-embeddings-asistente.js` (y los comentarios en
`lib/handlers/asistente.js`, la migración `195_asistente_ayuda.sql`, y
`chat-widget.js`) apuntan a `docs/ayuda/*.md`, pero el contenido real vive en
`docs/producto/ayuda/*.md` (28 artículos, todos con frontmatter `slug`
válido). El script fallaba en el primer paso (`No existe docs/ayuda`), antes
de siquiera intentar pegarle a Gemini.

**Ya corregido** en este repo: la ruta (`DOCS_DIR`) y los mensajes de log en
`scripts/generar-embeddings-asistente.js`. Validado localmente que los 28
`.md` parsean correctamente con la ruta nueva.

**Pendiente, no lo puede hacer Claude desde este entorno:** generar los
embeddings reales requiere `GEMINI_API_KEY` + `SUPABASE_SERVICE_ROLE_KEY`, y
llamar a `generativelanguage.googleapis.com` — dominio fuera de la whitelist
de red de este entorno de trabajo. Correr `npm run cargar-embeddings-asistente`
desde un entorno con esas env vars y acceso a internet.

### `cobro_facturas_aplicadas` — reclasificado, no se puede poblar con datos reales

El supuesto original ("sembrar aplicaciones cobro↔factura consistentes con
los 140 cobros y 6 facturas ya existentes") no se sostiene: de las 6
facturas del proyecto, solo 3 son de Distribuidora del Litoral, y **ninguno
de los 3 clientes facturados** (Autoservicio La Costanera $48.400
`error_afip`, Pizzería Ledesma $15.548,50 `pendiente`, Almacén Don Pedro
$12.329,90 `emitida`) **tiene un solo cobro registrado**. No hay overlap real
entre `cobros` y `facturas` para esta empresa.

**Decisión:** no fabricar cobros ni vínculos — se deja documentado como hueco
silencioso legítimo. El componente de puntualidad de pago en
`calcular_score_cliente` va a seguir cayendo a su valor por defecto para
todos los clientes de esta empresa hasta que existan cobros y facturas reales
del mismo cliente.

## Resumen ejecutivo (actualizado)

De los 9 huecos "reales" originales, 2 se descartaron por investigación
(`sugerencias_pedido`, `email_log` — código huérfano / comportamiento
esperado), 1 tiene un fix de código ya aplicado pero pendiente de ejecución
externa (`asistente_articulos`), 1 tiene un plan concreto pendiente de
confirmación (`alertas_stock`), y el hueco silencioso (`cobro_facturas_aplicadas`)
se reclasificó como no-fabricable y queda documentado sin acción.

## Siguiente paso sugerido

1. `combo_items` + `presupuesto_items` — inserts directos simples (no
   revisado en esta sesión).
2. `ofertas_liquidacion` — correr `generar_ofertas_liquidacion()` vía RPC
   (no revisado en esta sesión).
3. `ciclos_compra` — requiere lógica de negocio, revisar función generadora
   (no revisado en esta sesión).
4. `alertas_stock` — confirmar y ejecutar el plan de la sección de
   actualización.
5. `asistente_articulos` — correr `npm run cargar-embeddings-asistente` con
   las env vars reales, fuera de este entorno.
6. `cobro_facturas_aplicadas` — cerrado, sin acción (no fabricable).

¿Avanzamos con `combo_items`/`presupuesto_items` (los dos inserts más
simples que quedan) o confirmás primero el plan de `alertas_stock`?
