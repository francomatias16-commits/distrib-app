# CHANGELOG v977 — Generador de etiquetas de precio/código de barras, Etapa 4 (precio promocional tachado)

**Fecha:** 2026-08-24.

Continuación de `PLAN_ETIQUETAS_PRECIO_CODIGO_BARRAS.md` (sección 6,
Etapa 4: "Precio tachado usando `reglas_precio` vigente para ese
producto/categoría/zona"). Cierra las 4 etapas del plan original —
queda v1 completo.

## Punto de partida (antes de tocar nada)

El motor de reglas de precio por volumen/zona/temporada ya existe
(`reglas_precio`, migración `243_etapa2_motor_reglas_precio.sql`) **con
pantalla propia de administración** en Admin → Descuentos automáticos
(`frontend/admin/reglas-precio.html`/`.js`) — el plan no lo mencionaba
explícitamente al escribir la sección 4, pero esta etapa lo reutiliza
tal cual en vez de crear un ABM nuevo. Esta entrega es solo el puente
entre esa tabla y el cartel impreso.

`resolver_precios_cliente()` (el RPC que usa POS/Pedidos para resolver
precio final) no sirve tal cual para esto: requiere `p_cliente_id` para
poder resolver la zona del cliente y aplicar reglas con `zona_id`. Una
etiqueta física de góndola no tiene cliente — es el mismo cartel para
cualquiera que la lea. Por eso se sumó una función de resolución
dedicada (ver abajo) que solo considera reglas **generales**: sin zona
(`zona_id IS NULL`) y con `cantidad_minima <= 1` (venta unitaria de
mostrador). Cualquier regla acotada a una zona o a un piso de cantidad
mayor sigue aplicando normalmente en POS/Pedidos — simplemente no tiene
forma de imprimirse sin ambigüedad en un único cartel físico, así que
no se refleja en la etiqueta.

De paso quedó al descubierto (y se corrigió acá, no en un changelog
aparte) un gap real de la Etapa 1: `config_etiquetas.lista_precio_default_id`
se guardaba desde Admin → Hardware desde el primer día, pero
`obtenerProductosParaEtiquetas` nunca lo leía — el precio impreso
siempre fue `productos.precio_base` a secas, ignorando la lista
configurada. Como el "precio regular" que se tacha en esta etapa tiene
que ser el mismo que la config dice que hay que imprimir, se resolvió
junto con esto.

## Qué entra en esta etapa

- **Migración `20260824060000_543_etiquetas_etapa4_promociones.sql`**:
  - `config_etiquetas.mostrar_promociones` (boolean, default `true`) —
    mismo patrón que `incluir_iva`: default de empresa, con override
    por impresión puntual en el modal.
  - `resolver_precios_etiquetas(empresa_id, producto_ids[])`: devuelve
    `precio_regular` (vía `lista_precio_default_id` o `precio_base`) +
    `precio_promocional`/`regla_id`/`regla_nombre` si hay una
    `reglas_precio` activa, general y vigente por fecha para el
    producto o su categoría. Nunca devuelve un "promocional" que sea
    igual o más caro que el regular (protege contra una regla de
    `precio_fijo` mal cargada o de 0% de descuento).
  - Se aprovechó para registrar en `schema_migrations_registry` tanto
    esta migración como la de Etapa 1 (`20260824050000_...`), que había
    quedado sin fila — `check-migraciones-registro.js` la reportaba
    como "sin registrar".
- **`lib/repos/productos.js`** — `obtenerProductosParaEtiquetas` ahora
  llama a `resolver_precios_etiquetas` y devuelve `precio_regular` /
  `precio_promocional` / `regla_nombre` por producto. Si el RPC falla
  (ej. empresa sin fila en `config_etiquetas` todavía), no corta la
  generación de etiquetas — sigue con `precio_base` a secas, sin
  promoción, como venía funcionando hasta la Etapa 3.
- **`lib/repos/etiquetas.js`** / **`lib/handlers/etiquetas.js`**:
  `mostrar_promociones` sumado al ciclo de lectura/escritura de
  `GET`/`PUT /api/etiquetas/config`, mismo criterio que el resto de
  los flags booleanos existentes.
- **`etiquetas-print.js`** (grilla imprimible): cuando hay
  `precio_promocional` y `config.mostrar_promociones` no está apagado,
  imprime el precio regular tachado arriba y el promocional destacado
  (rojo, más grande) abajo — igual que un cartel de oferta de góndola.
  Sin promoción vigente, imprime un único precio, sin cambio visual
  respecto de la Etapa 3. `precioConIva()` cambió de firma (recibe la
  base como parámetro en vez de leer `producto.precio_base` fijo) para
  poder aplicarse tanto al precio regular como al promocional.
- **`etiquetas-preview.js`** (modal de vista previa, compartido con
  Compras): mismo criterio — precio regular tachado + promocional
  cuando corresponde. Nuevo checkbox "Mostrar precio promocional
  tachado", que **solo aparece si algún producto de la tanda tiene una
  promoción resuelta** (si ninguno la tiene, no hay nada que el
  checkbox pudiera cambiar visualmente). Precarga desde
  `config.mostrar_promociones`, editable por esta impresión puntual —
  mismo patrón que el checkbox de IVA ya existente.
- **`etiquetas-preview.css`** / **`etiquetas-print.js` (estilos
  inline)**: clases nuevas `.etqp-precio-regular`/`.etqp-precio-promo`
  (modal) y `.etq-precio-regular`/`.etq-precio-promo` (impresión), con
  el mismo criterio de tokens que el resto de cada archivo.
- **Admin → Hardware (`pos.html`/`pos.js`)**: checkbox nuevo "Mostrar
  precio promocional tachado cuando haya una oferta vigente" en la
  sub-sección de etiquetas, junto al resto de los toggles. Sumado
  también a `previsualizarEtiquetasPrueba()` y a
  `EtiquetasPrint.datosDePrueba()` (el primer producto de la lista de
  prueba ahora trae una promo cargada, para poder ver el tachado sin
  tener que crear una regla real primero).
- Checklist de prueba manual agregado a `checklist_pase_manual.md`.

## Por qué no se tocó `resolver_precios_cliente()`

Se evaluó extenderla en vez de crear una función nueva, pero hubiera
significado hacer `p_cliente_id` opcional y ramificar toda la lógica de
zona/`precios_clientes` dentro de una función que hoy es el camino
crítico de precio de POS y Pedidos — cambiar su comportamiento para un
caso (etiqueta sin cliente) que ella no fue pensada para resolver es
más riesgo que beneficio. `resolver_precios_etiquetas()` es una función
nueva y acotada, que reutiliza la tabla `reglas_precio` (no la
duplica) pero no toca la resolución de precio de venta real.

## Qué queda afuera (no de esta etapa, del plan en general)

- Impresión nativa ZPL/EPL a impresoras Zebra/Argox dedicadas — v1
  completo sigue apoyado en el diálogo de impresión del navegador
  (sección 1 del plan, explícitamente fuera de v1).
- No hay indicador visual del *nombre* de la promoción en el cartel
  (`regla_nombre` viaja resuelto desde el backend pero no se imprime,
  a propósito — un cartel de góndola de 50×25mm ya tiene nombre +
  2 precios + código de barras; sumar el nombre de la regla lo
  saturaría). Si hace falta más adelante, es un cambio chico y
  aislado a `renderEtiqueta()`.

## Checklist de prueba manual

Agregado a `checklist_pase_manual.md`, sección "Etiquetas de precio /
código de barras — Etapa 4 (543)".
