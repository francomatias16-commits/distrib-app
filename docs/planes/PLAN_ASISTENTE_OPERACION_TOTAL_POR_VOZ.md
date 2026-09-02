# Plan: asistente con cobertura operativa total (voz + confirmación)

**Relación con el plan existente:** este documento no reemplaza a
`PLAN_OPTIMIZACION_ASISTENTE_IA_PRE_PAGO.md`. Ese plan optimiza el motor
(caché, visibilidad de consumo, fallback) sobre el esquema gratuito
actual. Este plan resuelve un problema distinto: **cuánto de lo que un
usuario puede hacer a mano en el admin, hoy NO lo puede pedir por voz**.
Son paralelos — ninguno bloquea al otro, y ambos corren sobre la misma
infraestructura de tools/confirmación ya construida.

---

## 0. Punto de partida real (para no reinventar lo que ya existe)

Antes de plantear nada nuevo, esto ya está en producción:

- **Entrada por voz end-to-end**: `frontend/shared/chat-widget.js` ya
  tiene dictado por micrófono (Web Speech API), modo manos libres con
  lectura en voz alta de las respuestas, y barge-in (tocar el micrófono
  corta la lectura en curso). **No hay que construir "el asistente
  escucha audio" — ya existe.**
- **Motor de tools con function calling real**: `lib/asistente-tools.js`
  (75 tools hoy) — el modelo elige de una lista fija, nunca arma SQL,
  cada tool llama a una RPC `SECURITY DEFINER` escrita a mano y scopeada
  por `empresa_id` inyectado desde el token verificado.
- **Mecanismo de confirmación para escritura**: tools con
  `requiereConfirmacion: true` (27 de las 75 hoy) generan un `resumen()`
  en una frase, se muestran como acción pendiente, y **solo se ejecutan
  tras el click de Confirmar** — el modelo nunca ejecuta una escritura
  en el mismo turno en que la decide. Es exactamente el patrón que pediste
  ("mediante confirmación pueda operar en cualquier sentido, como yo lo
  hago ahora"): **ya está construido y funcionando para 27 acciones**.

**Conclusión:** lo que falta no es infraestructura nueva. Es **cobertura**:
extender el mismo patrón (tool de lectura + tool de escritura con
confirmación) a las áreas del admin que hoy quedaron afuera. El resto de
este plan es ese inventario y su cierre.

---

## 1. Brecha real encontrada (no es la voz — es el acceso a datos)

Al cruzar las 75 tools existentes contra las páginas del admin, aparecen
dos tipos de brecha distintos, y conviene no mezclarlos:

### 1.A — Brecha de cobertura (fácil): página sin ninguna tool
Ejemplos confirmados: no existe ninguna tool para crear/editar producto,
ajustar su precio o darlo de baja, pese a que `productos.html` es una
página entera del admin. Mismo patrón en piezas de `facturacion.html`
(emitir/anular factura) y `compras.html`.

### 1.B — Brecha arquitectónica (la que importa de verdad)
Varias pantallas del admin **no pasan por `lib/handlers/*`** — llaman
directo a Supabase desde el frontend (`sb.from(...)` / `sb.rpc(...)`) con
el JWT del usuario y RLS como única barrera. Confirmado por código en:

| Página | Qué usa el frontend directo |
|---|---|
| `productos.html` | `rpc: fn_crear_producto`, `rpc: fn_productos_lista`, `from: productos` |
| `facturacion.html` | `rpc: fn_facturas_lista`, `from: pedido_items` |
| `cta-cte.html` | `rpc: registrar_cobro_completo`, `rpc: registrar_auditoria` |
| `compras.html` | `rpc: ajustar_stock`, `from: productos` |
| `reglas-precio.html` | `from: productos/categorias/zonas` |
| `clientes.html` | `from: clientes/listas_precios/zonas/usuarios` |

**Por qué esto es lo que hay que resolver primero:** el patrón de tools
del asistente (`lib/asistente-tools.js`) exige que cada acción pase por
una RPC ya auditada y por el handler que inyecta `empresa_id` desde el
perfil verificado — **no** por el mismo camino RLS-directo que usa el
frontend. Estas RPCs ya existen y funcionan (las usa el frontend), pero
**no están expuestas como tool** porque nunca pasaron por la capa que el
asistente sabe llamar. Cerrar esta brecha es en gran parte **cablear
tools nuevas sobre RPCs que ya existen**, no escribir lógica de negocio
desde cero — el trabajo es menor de lo que parece a primera vista, pero
hay que auditar cada RPC candidata para confirmar que ya es
`SECURITY DEFINER` y ya filtra por `empresa_id` antes de exponerla.

---

## 2. Inventario completo: página del admin → cobertura actual → gap

Convención: 🟢 cubierto (lectura y escritura) · 🟡 solo lectura ·
🟠 sin tool, RPC ya existe (cablear) · 🔴 sin tool, sin RPC server-side
(hay que construir handler + RPC primero) · ⚪ excluido a propósito, no es
un gap pendiente (ver §4).

| Página admin | Handler backend | Tools hoy | Estado |
|---|---|---|---|
| pedidos.html | pedidos.js | crear/consultar/diagnosticar/modificar/cancelar pedido | 🟢 |
| presupuestos.html | pedidos.js | crear/diagnosticar presupuesto | 🟢 |
| cheques.html / riesgo-cheques.html | bcra.js | listar cheques alerta, cheque denunciado BCRA | 🟢 |
| proveedores.html | proveedores.js | crear proveedor, cta cte proveedor, deuda | 🟢 |
| clientes.html | clientes.js | crear/editar/dar de baja cliente, bloqueo, score, puntos | 🟢 |
| stock.html / lotes.html | stock.js | stock crítico, movimientos, lotes por vencer, transferir stock | 🟢 |
| conciliacion-bancaria.html | conciliacion-bancaria.js | candidatos, confirmar, deshacer, conciliar lote | 🟢 |
| notif-log.html | notif.js | preferencias notificaciones | 🟢 |
| export-contable.html | export-contable.js | configurar, generar, historial export | 🟢 |
| migracion.html | migracion.js | consultar historial/estado migración | 🟡 iniciar migración por voz excluido a propósito (requiere subir archivo) — ver §4 |
| whatsapp-onboarding / soporte (choferes) | chofer_invitacion.js | invitar/revocar chofer | 🟢 |
| portal_proveedor (links) | portal_proveedor.js | generar/revocar link | 🟢 |
| usuarios.html | usuarios.js | consultar usuarios equipo | ⚪ excluido a propósito — ver §4 |
| empresa-config.html | empresa.js | consultar/actualizar datos empresa, catálogo público | 🟢 |
| automatizacion.html | automatizacion.js + reglas-automatizacion.js | ejecutar motor automatización + listar/crear/editar regla de automatización | 🟢 (es una sola página física — la sección "reglas personalizadas" de `automatizacion.html` es la que llamábamos "reglas-automatizacion.html" en filas anteriores de esta tabla; ambas partes ya tienen tool) |
| **productos.html** | *(RPC directa, sin handler)* | crear_producto, editar_producto | 🟢 (ver limitación de reactivación en §5, ítem 2) |
| **facturacion.html** | facturas.js (parcial) | listar por vencer (proveedor), `emitir_factura`, `anular_factura` | 🟢 |
| **cta-cte.html / cobranzas.html** | *(RPC directa)* | `listar_cobros`, `registrar_cobro_cliente` (sobre `registrar_cobro_completo`) | 🟢 (falta prueba funcional contra datos reales, ver §6) |
| **compras.html** | *(RPC directa)* | listar órdenes de compra, `crear_orden_compra_asistente`, `recepcionar_orden_compra_asistente`, `ajustar_stock_asistente`, `registrar_conteo_stock_asistente` | 🟢 (falta prueba funcional contra datos reales, ver §6) |
| **reglas-precio.html** | reglas-precio.js | comparar precios proveedor-producto, `crear_regla_precio_asistente`, `editar_regla_precio_asistente` | 🟢 |
| pos.html | pos.js | diagnosticar/anular venta POS | 🟡 registrar venta manual por voz excluido a propósito — ver §4 |
| fidelizacion.html | fidelizacion.js | canjear recompensa, `crear_recompensa_asistente`, `editar_recompensa_asistente` | 🟢 |
| devoluciones.html | — | registrar devolución pedido | 🟢 |
| liquidacion.html | stock.js (`_svc=liquidacion`) | `consultar_ofertas_liquidacion_asistente`, `consultar_reglas_liquidacion_asistente`, `generar_ofertas_liquidacion_asistente`, `guardar_reglas_liquidacion_asistente` | 🟢 (Fase D, ver CHANGELOG_v716; falta prueba funcional contra datos reales, ver §6) |
| rentabilidad-*.html, reportes-*.html | varios | — | 🟡 son reportes; evaluar tools de "resumen ejecutivo" (baja prioridad, ver §5) |
| saas-billing.html, mercadopago-config.html | saas.js | — | 🔴 fuera de alcance a propósito (ver §4, exclusiones) |
| setup.html / setup-wizard.html | setup.js | — | 🔴 fuera de alcance a propósito (alta inicial, no operación diaria) |

Este inventario es la base para el backlog de la §5 — cada fila 🟠/🔴/🔴
relevante se convierte en 1-3 tools nuevas siguiendo el patrón de
`lib/asistente-tools.js` (lectura sin confirmación, escritura con
`requiereConfirmacion: true` + `resumen()`).

---

## 3. Lo que el usuario pidió, en criterios verificables

> "el usuario mediante un audio puede impartir cualquier requerimiento y
> el mediante confirmación pueda operar en cualquier sentido"

Traducido a criterios de aceptación concretos:

1. **Toda acción de escritura que hoy se hace a mano en el admin tiene
   una tool equivalente**, con el mismo patrón de confirmación que ya
   usan las 27 existentes (resumen en una frase, botón Confirmar, sin
   ejecución silenciosa).
2. **Ninguna tool nueva se salta la capa de permisos**: mismo chequeo de
   rol/permiso (`puede()`) que ya usa cada handler para esa acción
   cuando se hace desde la UI — si un vendedor no puede anular una
   factura a mano, tampoco puede pedírselo al asistente.
3. **Toda escritura queda auditada igual que si se hubiera hecho desde
   la pantalla** (mismo registro en `auditoria`/`registrar_auditoria`
   que usa el frontend hoy) — para que en `auditoria.html` no se pueda
   distinguir "lo hizo un click" de "lo hizo el asistente", salvo por el
   origen que se agregue al log (ver §5, ítem 2).
4. **Las 3-5 acciones de mayor riesgo** (anular factura, ajustar stock
   manual, dar de baja cliente/proveedor) llevan una confirmación más
   explícita que el resto (ver `crear_categoria` vs. la de mayor
   severidad ya usada como referencia en el código, línea ~1386) — no
   todas las confirmaciones deben verse igual de "livianas".
5. **Cobertura medible**: al cierre del plan, cada fila 🟠 y las 🔴
   relevantes de la tabla de §2 pasan a 🟢, y ese estado queda anotado
   en este mismo documento (no es un "listo" implícito).

---

## 4. Exclusiones explícitas (a propósito, no por olvido)

No todo lo que se hace a mano debe poder pedirse por voz. Se excluyen de
este plan, salvo pedido explícito posterior:

- **Facturación/billing de la SaaS y configuración de Mercado Pago**
  (`saas-billing.html`, `mercadopago-config.html`): tocan medios de pago
  y suscripción de la propia empresa cliente — el costo de un error por
  ambigüedad de voz es alto y la frecuencia de uso es baja. Se mantienen
  manuales.
- **Setup inicial / wizard** (`setup.html`, `setup-wizard.html`): alta
  única, no operación recurrente — no justifica el costo de mantenimiento
  de una tool.
- **Cualquier acción irreversible sin contraparte de auditoría clara**
  (ej. borrado físico, no soft-delete): si hoy la UI solo permite
  soft-delete para una entidad, la tool nueva tampoco debe ofrecer más
  que eso.
- **Reportes/dashboards puramente visuales** (gráficos de
  `rentabilidad-zona.html`, `reportes-financieros.html`): tienen valor
  como *vista*, no como respuesta de texto — se prioriza que el asistente
  pueda **linkear** a la pantalla correcta antes que replicar el gráfico
  en una respuesta hablada.
- **Alta, cambio de rol y activar/desactivar usuario del equipo**
  (`usuarios.html`, sobre `lib/handlers/usuarios.js`): a diferencia de
  `chofer_invitacion.js`/`portal_proveedor.js` — donde solo UNA acción
  puntual (impersonar) quedaba afuera y el resto sí se pudo exponer — acá
  no hay ninguna acción "inocente" que separar del resto: el alta crea
  una cuenta real con contraseña, el cambio de rol puede escalar a
  alguien a `admin`/`dueño`, y activar/desactivar corta o habilita el
  acceso real de una persona. Las tres son, exactamente, el tipo de
  acción de alto riesgo que este mismo plan (§3, ítem 4) dice que debe
  llevar más fricción que una confirmación de un click — no menos. Esta
  decisión ya estaba tomada en el código (comentario en
  `lib/asistente-tools.js`, sección de `consultar_usuarios_equipo`) desde
  antes de este plan; lo que faltaba era que el inventario de §2 dejara
  de mostrarla como una brecha pendiente de Fase B. Solo queda expuesta
  `consultar_usuarios_equipo` (lectura). Si en el futuro se quiere
  reabrir esto, mínimo debería llevar confirmación reforzada + que quien
  gestiona sea explícitamente `dueño` (nunca `admin`) para cualquier rol
  privilegiado, igual que ya exige `lib/handlers/usuarios.js` a mano.
- **Registrar venta manual de POS por voz** (`pos.html`, sobre
  `registrarVentaHandler` en `lib/handlers/pos.js`, evaluado en Fase C):
  no es una acción de "una frase, un dato, confirmar" como el resto de
  las tools de escritura — el handler real exige `caja_id` + `turno_id`
  de una caja ya abierta, un carrito con uno o más ítems (producto +
  cantidad + descuento por línea) y uno o más medios de pago, y si algún
  descuento de línea supera el umbral del vendedor, pide PIN de
  supervisor. Construir eso por voz equivale a dictar toda la pantalla de
  POS ítem por ítem con correcciones sobre la marcha — más lento que
  escanear o tipear en el POS real, que es el flujo con el que compite.
  Se descarta, no por dificultad técnica sino porque el caso de uso no
  mejora nada sobre el flujo manual.
- **Iniciar una migración por voz** (`migracion.html`, sobre
  `crearSesion` en `lib/handlers/migracion.js`, evaluado en Fase C): el
  primer paso real es subir un archivo CSV/XLSX — no hay ningún dato que
  se pueda dictar para arrancar una sesión, el archivo en sí es el input.
  A diferencia del resto de exclusiones de esta lista (que son "no
  conviene" por riesgo o frecuencia), acá es "no se puede": no existe una
  versión por voz de subir un archivo. Se mantiene solo lectura
  (`listar_sesiones_migracion` / estado de sesión), que sí está cubierto.

---

## 5. Backlog de cierre, por fases

### Fase A — Brechas arquitectónicas de mayor uso diario — ✅ cerrada
Orden sugerido por frecuencia de uso real, no por facilidad técnica:

1. ✅ **`registrar_cobro_cliente` (sobre `registrar_cobro_completo`)** —
   cableada. Ver `CHANGELOG_v709_asistente_registrar_cobro_cliente_por_voz.md`.
   Sintaxis verificada; **falta la prueba funcional contra datos reales**
   (sin credenciales de Supabase en este entorno) antes de considerarla
   lista para producción — ver checklist de §6.
2. ✅ **CRUD de productos** — `crear_producto` y `editar_producto`.
   Ver `CHANGELOG_v710_asistente_crud_productos_por_voz.md`. Nota
   importante que cambia el diagnóstico original de este ítem: no se
   pudo cablear literalmente sobre `fn_crear_producto` porque esa RPC
   depende del JWT de sesión del usuario (`get_empresa_id()`), no de un
   `p_empresa_id` explícito como sí tiene `registrar_cobro_completo` —
   incompatible con el service role del asistente. Se replicó la misma
   lógica con operaciones directas sobre tabla, filtradas por
   `empresa_id` explícito (mismo patrón que `crear_categoria`/
   `crear_deposito`/`crear_zona`), sin tocar la RPC de producción.
   **Limitación conocida y documentada:** reactivar un producto YA
   inactivo no se puede resolver por voz (la búsqueda difusa de
   productos solo indexa activos) — sigue siendo manual desde el panel.
   Falta la prueba funcional (ver §6).
3. ✅ **Emitir / anular factura** — `emitir_factura` y `anular_factura`
   ya existían en el archivo desde antes de escribir este plan (no en
   `CHANGELOG_v70x`, son más viejas) — el diagnóstico original de este
   ítem estaba mal: no era una brecha real, era un error de inventario
   al cruzar `facturacion.html` contra las tools. Confirmado por
   `grep` contra la copia del repo previa a esta tanda de trabajo.
   Ambas ya tienen `requiereConfirmacion: true` y piden motivo — sin
   cambios necesarios.
4. ✅ **Ajuste manual de stock** (`ajustar_stock_asistente`,
   `registrar_conteo_stock_asistente`) y **orden de compra**
   (`crear_orden_compra_asistente`, `recepcionar_orden_compra_asistente`) —
   cierre de `compras.html`. Ver
   `CHANGELOG_v713_asistente_stock_y_ordenes_compra_por_voz.md`. Sintaxis
   verificada; falta la prueba funcional contra datos reales (sin
   credenciales de Supabase en este entorno) — ver checklist de §6.

### Fase B — Brechas de cobertura simples (🟡 de §2) — ✅ cerrada
Extender tools existentes con las operaciones de escritura que faltaban:

1. ✅ **Editar / dar de baja cliente** — `editar_cliente_asistente`,
   `dar_de_baja_cliente_asistente`.
2. ✅ **Crear / editar regla de precio** — `crear_regla_precio_asistente`,
   `editar_regla_precio_asistente`.
3. ✅ **Crear / editar recompensa de fidelización** —
   `crear_recompensa_asistente`, `editar_recompensa_asistente` (el ítem
   original decía "campaña"; el motor real de `fidelizacion.js` trabaja
   con recompensas canjeables, no con "campañas" como entidad separada —
   se cableó sobre lo que existe de verdad en el repo).
4. ✅ **Crear / editar / listar regla de automatización** —
   `crear_regla_automatizacion_asistente`,
   `editar_regla_automatizacion_asistente`,
   `listar_reglas_automatizacion_asistente`. Ver
   `CHANGELOG_v714_asistente_reglas_automatizacion_por_voz.md`.
5. ⚪ **Invitar/editar rol/desactivar usuario del equipo** — evaluado y
   descartado a propósito, no cerrado. Ver exclusión nueva en §4 y
   `CHANGELOG_v715_plan_reconciliado_exclusion_usuarios.md`.

Con esto, Fase B no tiene ítems pendientes: lo único que queda afuera
(usuarios) es una exclusión deliberada, no una tarea sin hacer.

### Fase D — liquidacion.html — ✅ cerrada
La única fila 🔴 que quedaba sin decisión explícita en §6. Diagnóstico
original ("sin RPC server-side, hay que construir handler primero") era
incorrecto — mismo tipo de error de inventario que ya se había encontrado
con facturación en v715: `lib/handlers/stock.js` (`handleLiquidacion()`),
`lib/repos/stock.js` y la RPC `generar_ofertas_liquidacion` ya existían
completos. Se agregaron 4 tools, ver `CHANGELOG_v716_asistente_liquidacion_por_voz.md`:
1. ✅ `consultar_ofertas_liquidacion_asistente` (lectura) — ofertas activas.
2. ✅ `consultar_reglas_liquidacion_asistente` (lectura) — reglas vigentes.
3. ✅ `generar_ofertas_liquidacion_asistente` (escritura,
   `requiereConfirmacion`) — dispara `generar_ofertas_liquidacion` ahora.
   El `resumen()` corre la misma RPC en `p_dry_run: true` para mostrar el
   impacto real (cuántas ofertas se crean/actualizan/desactivan) antes de
   confirmar, en vez de una frase genérica.
4. ✅ `guardar_reglas_liquidacion_asistente` (escritura,
   `requiereConfirmacion`) — patch parcial sobre las reglas (activo,
   dias_alerta, y los 3 niveles de días/%), con validación de rango
   (0-100% en los descuentos) y de orden (nivel1 > nivel2 > nivel3 en
   días) antes de guardar, porque acá no hay formulario del panel
   poniendo límites al valor dictado por voz.

Roles: lectura calcada de `stock: { acceder: [...] }` en
`lib/permisos-service.js` (dueño/admin/vendedor/depositero, el mismo gate
que usa `handleLiquidacion()` para listar ofertas y reglas). Escritura
restringida a `['dueno','admin']`, calcada del chequeo explícito que hace
el handler para `generar` y `guardar-reglas` (vendedor/depositero pueden
ver pero no disparar la generación ni tocar reglas).

Falta la prueba funcional contra datos reales (sin credenciales de
Supabase en este entorno) — ver checklist de §6.

### Fase C — Evaluación caso por caso — ✅ cerrada
Los dos casos dudosos se evaluaron contra el código real de sus handlers
y se decidió excluirlos (ver justificación técnica en §4, ítems nuevos):
1. ✅ Registrar venta manual de POS por voz — descartado: el flujo real
   (`caja_id`/`turno_id`, carrito multi-ítem, medios de pago, PIN de
   supervisor) es más lento por voz que a mano; no era una brecha, era
   un caso que no conviene resolver por voz.
2. ✅ Iniciar migración por voz — descartado: el primer paso es subir un
   archivo, no hay nada que dictar. Queda solo lectura (ya cubierto).

### Ítem transversal (aplica a toda tool nueva de escritura)
- Reusar exactamente el patrón de `requiereConfirmacion` +
  `resumen()` documentado al inicio de `lib/asistente-tools.js` —
  no crear un mecanismo paralelo.
- Cada tool nueva pasa por el mismo chequeo `puede(perfil, accion, recurso)`
  que ya usa el handler equivalente de la UI.
- Agregar al registro de auditoría un origen (`'admin' | 'asistente'`)
  si hoy no lo distingue, para que quede trazable qué se hizo por voz.

---

## 6. Cómo verificar "completo" sin ambigüedad

Antes de dar el plan por cerrado:

- [x] La tabla de §2 no tiene ninguna fila 🟠 (verificado — todas las
      Fases A y B quedaron en 🟢 o ⚪).
- [x] Las filas 🔴 restantes están todas en la lista de exclusiones de
      §4, o resueltas. `liquidacion.html` pasó a 🟢 (Fase D, ver arriba) —
      ya no queda ninguna fila 🔴 ni 🟠 sin decisión explícita.
- [x] Fase C (dudosos) cerrada — los dos casos se evaluaron y se movieron
      a exclusión explícita en §4, con la justificación técnica de por
      qué no conviene (POS manual) o no se puede (migración) resolverlos
      por voz. El plan ya no tiene ninguna fila de la tabla de §2 ni
      ningún ítem de fase sin una decisión explícita tomada.
- [ ] Cada tool de escritura nueva tiene `requiereConfirmacion: true` y
      un `resumen()` probado con al menos un caso real por voz (dictado,
      no solo texto tipeado) antes de pasar a producción.
- [ ] Se corrió al menos una sesión de prueba end-to-end por fase: usuario
      dicta el pedido, el asistente arma el resumen correcto, el usuario
      confirma, la acción queda idéntica a como habría quedado hecha a
      mano (mismo estado en la tabla, misma entrada de auditoría).
- [ ] Los ítems de la Fase A quedaron con datos de uso real (cuántas
      veces se usó la tool por voz vs. cuántas se siguió haciendo a mano)
      para confirmar que valió la pena antes de encarar la Fase B.
