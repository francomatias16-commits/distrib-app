# Plan — Distrib funcionando sin Internet (offline-first completo)

**Fecha:** 2026-08-06.
**Pregunta que responde:** ¿se puede hacer que absolutamente todo el
sistema funcione sin Internet, y cómo, por etapas?

**Respuesta corta:** un 95-98% del sistema sí, con un esfuerzo grande
(meses, no semanas). El 2-5% restante — facturación AFIP, cobros Mercado
Pago, mensajes de WhatsApp — no puede ser offline en el momento exacto de
esa acción puntual, porque depende de servidores de terceros que vos no
controlás. Lo máximo posible ahí es volverlos "tolerantes a offline":
encolar la intención y ejecutarla sola apenas vuelve la señal, en vez de
trabar al usuario. El resto de este documento asume esa distinción.

---

## 0. Punto de partida real (auditado, no estimado)

Hoy el offline cubre esto y nada más:

| Portal | Qué tiene | Qué NO tiene |
|---|---|---|
| **admin** | Service Worker (`sw-admin.js`) con caché de shell + datos de lectura reciente (dashboard, pedidos, stock — última foto conocida). Cola offline real solo en POS (`pos-offline.js`, IndexedDB) | Todo lo demás (crear pedido, ajustar stock, compras, cta-cte) es "solo red": si no hay Internet, el botón directamente falla |
| **chofer** | Service Worker (`sw-chofer.js`) — ruta del día y remitos con último dato bueno cacheado | Confirmar entrega/devolución es "solo red" — si falla, el chofer tiene que reintentar cuando tenga señal |
| **cliente** | **Nada.** Sin Service Worker, sin manifest, sin caché de ningún tipo | Todo — sin Internet, la página ni carga |
| **proveedor** | **Nada.** Igual que cliente | Todo |

75 páginas HTML en total, 4 portales, y hoy solo 1 pantalla (POS) tiene
una cola de escritura offline real. Ese es el tamaño real de la brecha.

---

## 1. Arquitectura objetivo (a dónde apunta todo el plan)

En vez de 75 páginas cada una resolviendo su propio offline a mano (como
pasa hoy con POS), la meta es una **capa compartida** que cualquier
pantalla nueva pueda usar sin reinventar nada:

- **`offline-core.js`** (nuevo, generaliza `pos-offline.js`): una sola
  base IndexedDB por portal, con stores genéricos por entidad
  (`productos`, `clientes`, `pedidos`, `stock`, etc.), no una tabla
  hardcodeada para ventas.
- **Un "outbox" único**: toda escritura pendiente (crear pedido, ajustar
  stock, registrar cobro, lo que sea) entra a una sola cola FIFO con el
  mismo patrón que ya probaste en POS — `offline_local_id` para
  detectar duplicados, reintentos con backoff, máximo de intentos.
- **Background Sync API** del navegador, no solo el evento `online`:
  hoy si el chofer cierra la app con ventas/entregas pendientes, no
  sincroniza hasta que la vuelva a abrir con señal. Con Background Sync,
  el sistema operativo despierta el Service Worker y sincroniza aunque
  la app esté cerrada.
- **Clasificación explícita de cada operación** en 3 categorías (esto
  se hace en la Etapa 0 y define todo lo que sigue):
  1. **Solo lectura, cacheable** — no hay riesgo, se sirve del último
     dato conocido (patrón ya usado en dashboard/pedidos/stock).
  2. **Escritura encolable** — se puede diferir sin problema (crear
     pedido, ajuste de stock, cobro registrado por el chofer). Necesita
     validación duplicada del lado del cliente, porque las funciones
     SQL (`resolver_precios_cliente()`, `registrar_venta_pos`, etc.) no
     corren en el navegador — hay que reimplementar las reglas de
     negocio críticas en JS para poder validar offline.
  3. **Bloqueante de verdad** — los 3 puntos ya mencionados (AFIP, MP,
     WhatsApp) más cualquier chequeo que dependa de un dato que solo la
     base puede confirmar en el momento exacto (ej. límite de crédito
     con saldo actualizado en tiempo real entre varios vendedores).

---

## 2. Etapas

### Etapa 0 — Decisiones y mapa completo (2-3 semanas)
**Objetivo:** no arrancar a programar sin saber el tamaño real de cada
parte.
- Clasificar las ~40-60 funciones RPC que mutan datos (`registrar_venta_pos`,
  `rpc_crear_pedido`, `ajustar_stock`, `transferir_stock`,
  `registrar_cobro_completo`, etc.) en las 3 categorías de arriba.
- Definir, entidad por entidad, la regla de conflicto: si dos ediciones
  offline chocan al sincronizar (ej. admin y depositero ajustan el mismo
  producto sin señal), ¿gana el primero en llegar, el más reciente, o se
  le muestra al usuario para que decida a mano? No hay una respuesta
  única — cada entidad necesita la suya.
- Decidir si el local-first vive en IndexedDB puro (como hoy) o si
  conviene sumar una librería de sync (ej. RxDB, Dexie con
  `dexie-syncable`) en vez de mantener todo a mano como está ahora.
- **Entregable:** una tabla igual a la de Fase 1 de la auditoría de
  páginas (Nivel 1/2/3), pero para operaciones de escritura en vez de
  páginas — con la categoría y la regla de conflicto de cada una.

### Etapa 1 — Capa de datos local genérica (4-6 semanas)
**Objetivo:** reemplazar el patrón bespoke de `pos-offline.js` por algo
reutilizable en las 75 páginas.
- Generalizar la base IndexedDB a stores dinámicos por entidad (hoy son
  3 stores fijos: `productos_cache`, `ventas_pendientes`, `sync_log`).
- Construir el outbox único con el mismo esquema de estados que ya usa
  POS (`pendiente` / `sincronizado` / `error_permanente`) pero para
  cualquier tipo de operación, no solo ventas.
- Integrar Background Sync API en los Service Workers existentes
  (`sw-admin.js`, `sw-chofer.js`) para que el outbox se procese aunque
  la app esté cerrada.
- TTL de caché configurable por entidad (hoy es un valor fijo de 2hs
  pensado solo para el catálogo de POS).

### Etapa 2 — Lectura offline en los 4 portales (4-6 semanas)
**Objetivo:** que ninguna pantalla quede en blanco sin Internet, aunque
todavía no pueda escribir.
- **Crear Service Worker + manifest.json para `cliente/` y `proveedor/`**
  — hoy no existe nada, es la brecha más grande y más barata de cerrar
  primero (mismo patrón que `sw-admin.js`, adaptado a los endpoints de
  cada portal).
- Extender las estrategias Stale-While-Revalidate / Network-First que ya
  existen en admin y chofer al resto de los endpoints de lectura de las
  75 páginas (hoy `sw-admin.js` solo cubre un puñado: KPIs, pedidos,
  clientes, stock, lotes, reportes).
- Sincronizar a IndexedDB (no solo Cache Storage del SW) los maestros
  que las pantallas de escritura de la Etapa 3 van a necesitar leer
  offline: productos, precios, clientes, depósitos.

### Etapa 3 — Escritura offline, módulo por módulo (8-14 semanas, iterativo)
**Objetivo:** extender el patrón que ya probaste en POS a las demás
operaciones encolables, de a una por vez — no todas juntas.
Orden sugerido (reusa la priorización de Nivel 1 que ya hiciste en la
auditoría de páginas — lo que frena una venta real primero):

1. **Crear pedido** (cliente y admin) — el más parecido a POS, mismo
   tipo de validación de stock/precio.
2. **Ajuste manual de stock / conteos** — el depositero suele estar en
   el depósito, con señal mala, caso de uso similar al del chofer.
3. **Confirmar entrega / devolución del chofer** — hoy es "solo red";
   pasar a encolable cierra la brecha más dolorosa en la práctica (el
   chofer en la calle es justo el escenario que motivó `sw-chofer.js`).
4. **Cobros y movimientos de cta-cte** — más delicado, necesita la regla
   de conflicto más estricta (dos cobros del mismo cliente registrados
   offline en simultáneo por dos vendedores no pueden simplemente
   "sumarse a ciegas" sin revisión).
5. **Transferencias entre depósitos** — ya tiene el `FOR UPDATE` con
   orden determinístico en `transferir_stock()`; portar esa misma
   protección contra condiciones de carrera al escenario offline (dos
   dispositivos transfiriendo el mismo producto sin verse entre sí).

Cada módulo de esta etapa repite el mismo trabajo: reimplementar en JS
la validación que hoy solo existe en la función SQL, definir su regla de
conflicto (de la Etapa 0), y sumarlo al outbox genérico de la Etapa 1.

### Etapa 4 — Sincronización entre roles sin Realtime (3-5 semanas)
**Objetivo:** hoy `Supabase Realtime` avisa cambios en vivo en 2
pantallas (`admin/dashboard.html`, `chofer/index.html`) — offline eso no
existe, así que hay que diseñar qué pasa cuando dos roles editan lo
mismo sin verse.
- Definir UI de conflicto: cuando el outbox sincroniza y detecta que el
  dato cambió mientras estaba offline (ej. el admin cambió el precio de
  un producto que el cliente ya tenía en el carrito offline), mostrar
  una pantalla de resolución en vez de pisar en silencio.
- Revisar aislamiento multi-tenant (RLS) también del lado local: si el
  dispositivo es compartido entre usuarios de distintas empresas (poco
  común pero posible en un SaaS), la base IndexedDB tiene que
  scopear por `empresa_id` igual que hace RLS en el servidor.

### Etapa 5 — Los 3 puntos que no pueden ser offline de verdad (2-3 semanas de diseño)
**Objetivo:** no eliminar la dependencia (imposible), sino que deje de
trabar al usuario.
- **AFIP/ARCA** (`lib/arca/wsaa.js`, `wsfev1.js`): la venta/pedido se
  puede confirmar offline igual (ya lo cubre la Etapa 3), pero la
  factura queda en estado "pendiente de CAE" hasta que haya señal —
  mismo patrón que ya usa el sistema hoy para offline_local_id, aplicado
  a la emisión fiscal.
- **Mercado Pago** (`lib/handlers/pagos.js`): un cobro con MP
  simplemente no se puede iniciar sin red — no hay forma de encolarlo,
  la comunicación con la pasarela es sincrónica por naturaleza. Lo único
  que se puede hacer es que la UI lo deje claro de entrada ("este medio
  de pago necesita conexión") en vez de que el usuario lo intente y
  falle.
- **WhatsApp** (`lib/whatsapp-pedido-tools.js`, bot): los mensajes
  salientes sí se pueden encolar (mismo patrón de outbox) y se envían
  solos apenas hay señal — los entrantes, por naturaleza, no existen sin
  red.

### Etapa 6 — Testing, piloto y rollout gradual (4+ semanas, continuo)
**Objetivo:** offline mal probado es peor que no tener offline — un bug
de sincronización puede duplicar una venta o perder un cobro.
- Matriz de pruebas mínima: modo avión a mitad de una operación, cerrar
  la app durante el sync, dos dispositivos offline editando la misma
  entidad al mismo tiempo, batería de reconexión intermitente (típico en
  zonas rurales, que es justo tu caso de uso real con los choferes).
- Piloto acotado: una sola empresa (podés usar el flag `es_demo` que ya
  existe) antes de habilitarlo para todos los tenants.
- Rollout módulo por módulo según el orden de la Etapa 3, no todo junto.

---

## 3. Estimación de esfuerzo total

**6 a 9 meses de trabajo dedicado**, siendo realista con el volumen (75
páginas, 4 portales, arquitectura nueva corriendo en paralelo a la
actual) y con que sos el único desarrollador. No es una cifra para
asustar — es para que la decisión de "hacer esto o no" se tome sabiendo
el tamaño real, no subestimándolo como una serie de ajustes chicos.

**Nota de infraestructura:** el plan Vercel Hobby actual ya está al
límite de funciones serverless (todo el backend consolidado en un solo
`api/index.js` por el límite de 12). El trabajo pesado de este plan es
del lado del cliente (Service Workers, IndexedDB), así que no debería
chocar con ese límite — pero es una restricción a tener presente si en
el camino aparece la necesidad de un endpoint nuevo dedicado a
sincronización masiva.

---

## 4. Recomendación

No conviene comprometerse a los 6-9 meses completos de entrada. El valor
real está concentrado en pocos módulos — los mismos que ya identificaste
como Nivel 1 en la auditoría de páginas (`02_fase1_inventario.md`).
Sugerencia concreta para arrancar sin comprometerte a todo el plan:

1. Etapa 0 completa (mapa de operaciones + reglas de conflicto) — te da
   claridad sin haber tocado una línea de código todavía.
2. Etapa 2 solo para **cliente y proveedor** (hoy en cero) — es lo más
   barato de todo el plan y cierra la brecha más obvia.
3. Etapa 3, ítem 3 (**confirmar entrega/devolución del chofer**) — es el
   caso de uso que más duele en la práctica (choferes en la calle sin
   señal) y ya tenés medio camino andado con `sw-chofer.js`.

Con esos tres pasos ya se cubre el escenario que más golpea hoy, sin
comprometerte de entrada a los 6-9 meses completos del plan.

## Cómo continuar
Decime **"arranquemos con la Etapa 0"** (o cualquier etapa puntual) y
seguimos desde ahí. Este documento queda en el proyecto para retomarlo
en cualquier sesión futura sin repetir contexto.
