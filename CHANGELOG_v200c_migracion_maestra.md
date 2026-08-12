# CHANGELOG v200c — Migración maestra (un solo archivo → detección automática)

Nueva funcionalidad sobre el wizard de migración existente (v200b): en vez
de subir entidad por entidad (18 pasadas separadas), la empresa puede
arrastrar **un único archivo** — un Excel con una hoja por área, o un .zip
con varios CSV/Excel — y el sistema detecta automáticamente qué hoja
corresponde a qué entidad, sugiere el mapeo de columnas, y ejecuta todo en
el orden de dependencias correcto tras confirmación humana.

## Decisión de diseño: capa de orquestación, no reescritura

No se duplicó ninguna lógica de negocio por entidad (resolución de CUIT,
agrupación de pedidos por número, parseo de montos AR/US, dedupe, etc.).
Esa lógica ya vivía, probada, en el backend (`crearSesion` / `mapearSesion`
/ `confirmarSesion` de `lib/handlers/migracion.js`). La migración maestra es
puramente una capa nueva que:

1. Detecta automáticamente la entidad de cada hoja/archivo.
2. Sugiere el mapeo de columnas.
3. Llama a los mismos 3 endpoints que ya usa el wizard manual, en loop,
   una vez por entidad detectada, en el orden de `ORDEN_GUIADO` (el mismo
   array que ya ordenaba el checklist guiado por dependencias — se
   reutilizó tal cual, no se inventó un orden nuevo).

Se descartó la alternativa de "un archivo plano con todo mezclado, fila por
fila de cualquier tipo": no hay forma confiable de inferir por fila si es
un cliente, un producto o una transacción sin un esquema — y un error de
clasificación ahí no es un dato mal cargado, es una relación rota (ver
detalle de la discusión en el chat). Se optó por multi-hoja/multi-archivo,
donde cada hoja completa es una sola entidad — ahí sí se puede detectar con
confianza razonable por el conjunto de encabezados.

## Backend (`lib/handlers/migracion.js`)

- `GET /api/migracion?accion=campos` sin `entidad` ahora devuelve el
  registro completo de las 18 entidades (antes exigía `entidad`). Fuente
  única de verdad: si mañana se agrega un campo a una entidad, el detector
  lo ve automáticamente sin tocar el frontend. Cambio 100% aditivo — el
  caso con `entidad` sigue igual.

## Frontend nuevo (`frontend/admin/js/migracion-maestra.js`)

- **Parseo**: Excel/ODS multi-hoja (SheetJS, ya cargado) o .zip con varios
  CSV/Excel (JSZip, agregado vía CDN). Cada hoja/archivo con filas es una
  hoja candidata.
- **Detección**: por hoja, se puntúa contra las 18 entidades comparando
  encabezados normalizados (sin acentos/mayúsculas/símbolos) contra las
  etiquetas de campo (`ETIQUETAS_CAMPO`, reusada de `migracion.js`) más un
  diccionario de sinónimos manual (`SINONIMOS_CAMPO`) para variantes reales
  ("Cliente" ≈ razon_social, "SKU" ≈ codigo, etc.). El score pondera fuerte
  la cobertura de campos *requeridos* (70%) sobre la de campos disponibles
  (30%) — una entidad que no cubre todos sus requeridos casi nunca es la
  correcta. Umbral de 0.5 para auto-asignar; por debajo, la hoja queda sin
  entidad asignada y la persona elige a mano.
- **Confirmación obligatoria**: nunca se sube nada sin que la persona vea y
  pueda corregir, por cada hoja: (a) qué entidad se le asignó (select con
  las 18 opciones + "omitir"), y (b) el mapeo campo→columna sugerido (grid
  de selects, campos requeridos marcados y resaltados en rojo si faltan).
- **Ejecución**: agrupa hojas por entidad (si dos hojas detectan la misma
  entidad, se combinan — se avisa en la tarjeta), filtra por
  `ORDEN_GUIADO` para respetar dependencias, y por cada una corre el mismo
  ciclo subir-en-chunks → mapear-hasta-terminar → confirmar-hasta-terminar
  que ya usaba el wizard manual (reutilizando `CHUNK_SUBIDA`, `migApi`,
  etc. de `migracion.js`). Fallos se aíslan por entidad: si una falla, las
  demás siguen procesándose.
- **Resultado**: tabla final con creados/actualizados/errores por entidad y
  totales agregados.

## Frontend — `migracion.html`

- Tarjeta de entrada nueva en la pantalla inicial ("¿Tenés todo en un solo
  archivo?").
- 4 secciones nuevas del wizard (`paso-maestra-subir`, `-deteccion`,
  `-progreso`, `-resultado`), mismas clases CSS que el wizard existente más
  algunas nuevas agregadas a `migracion.css` (tarjetas de detección, pills
  de confianza, grid de mapeo compacto).
- Script `jszip@3.10.1` agregado vía CDN.

## Validado en esta sesión (sin DOM, lógica pura extraída y probada en Node)

Casos de prueba con encabezados realistas en español:
- Hoja "Clientes" (Razón Social, CUIT, Teléfono, Email, Domicilio,
  Localidad) → detectada como `clientes`, 85% confianza, mapeo completo.
- Hoja "Productos" (Nombre, Código, Precio, Stock, Categoría) → detectada
  como `productos`, 95% confianza, mapeo completo.
- Hoja "Pedidos" (Número de Pedido, CUIT Cliente, Código Producto,
  Cantidad, Precio Unitario) → detectada como `pedidos`, 95% confianza,
  mapeo completo (los 4 campos requeridos cubiertos).
- Hoja ambigua (solo Nombre + Teléfono) → score 40%, por debajo del umbral
  → queda sin asignar automáticamente, como se espera.

## Pendiente / limitaciones conocidas (documentadas en el propio archivo)

- Si el archivo tiene más de un depósito o lista de precios, la migración
  maestra no ofrece elegir destino por defecto (cae al principal/default de
  la empresa) — para ese caso puntual conviene usar el wizard por entidad.
- El diccionario de sinónimos es heurístico y extensible; la confirmación
  humana en pantalla es la salvaguarda real, no la detección en sí.
- No se probó todavía en el navegador contra Supabase real (la lógica de
  detección se validó aislada en Node; la orquestación de
  crear/mapear/confirmar reutiliza funciones ya probadas en producción,
  pero el flujo end-to-end del wizard maestro en sí no se ejecutó en un
  browser real todavía) — recomendado como siguiente paso antes de usarlo
  con datos reales de un cliente.

## Validación post-release contra Supabase real (sin navegador) — cheques, puntos_fidelizacion, ventas_pos

Sesión de QA dirigida a las 3 entidades nuevas del plan P2 (migración 174),
ya que son las únicas que no habían pasado por un ciclo de validación contra
datos reales. Metodología: en vez de navegador (no disponible en esta
sesión), se creó una empresa/cliente/producto de prueba temporal en el
proyecto real de Supabase, se insertaron filas de `migracion_staging_rows`
simulando exactamente la salida de `mapearSesionX` para casos límite
(válidos, inválidos, opcionales, dedupe), y se ejecutaron los RPCs de
confirmación reales (`migracion_confirmar_cheques_lote`,
`migracion_confirmar_puntos_lote`, `migracion_confirmar_ventas_pos_lote`)
tal cual los llama el backend. Toda la data de prueba se borró al finalizar.

**2 bugs reales encontrados y corregidos** — mismo patrón en ambos casos:
la lista blanca de valores válidos en el código no coincidía con el CHECK
constraint real de la tabla, por lo que la fila pasaba la validación del
wizard (`es_valida: true`) y recién fallaba al confirmar, con un error
crudo de Postgres en vez de un mensaje entendible.

- **`cheques.estado`**: el código aceptaba `entregado`, pero el constraint
  real (`cheques_estado_check`) solo tiene `entregado_proveedor` (además de
  `pendiente`, `en_cartera`, `cobrado`, `depositado`, `rechazado`,
  `anulado`, que tampoco estaban contemplados). Fix: `ESTADOS_CHEQUE_VALIDOS`
  (Set) reemplazado por `MAPA_ESTADO_CHEQUE` (objeto), con los 7 valores
  reales del constraint como claves canónicas y sinónimos en español
  (`entregado` y `endosado` → `entregado_proveedor`, este último porque así
  lo etiqueta el módulo de cheques en vivo para el mismo concepto).
- **`ventas_pos.estado`**: `validarFilaVentasPos` no validaba este campo en
  absoluto — cualquier texto se lowercaseaba y se mandaba tal cual al RPC.
  El constraint real (`ventas_pos_estado_check`) solo acepta
  `completada`/`anulada`. Un valor como "Cancelada" (natural en un Excel de
  cliente) pasaba entero el wizard. Fix: nueva función
  `normalizarEstadoVentaPos` con mapa de sinónimos
  (`cerrada`/`pagada`/... → `completada`; `cancelada`/`anulado`/... →
  `anulada`) + validación agregada en `validarFilaVentasPos`.

**Barrido del resto de las listas blancas del wizard** (no solo las nuevas)
contra sus constraints reales, para confirmar que el problema era puntual
de estas 2 entidades y no sistémico:

| Entidad / campo | Constraint real | Resultado |
|---|---|---|
| `ordenes_compra.estado` | `ordenes_compra_estado_check` | ✅ coincide |
| `lotes.estado` | `lotes_estado_check` | ✅ coincide |
| `pagos_proveedor.medio_pago` | `pagos_proveedor_medio_pago_check` | ✅ coincide |
| `comprobantes_historicos.tipo` | `comprobantes_historicos_tipo_check` | ✅ coincide |
| `cta_cte.tipo` | *(sin constraint)* | ✅ sin riesgo |

**`puntos_fidelizacion`: sin bugs.** Validado con casos de ganancia, canje
y ajuste: la matemática de `saldo_puntos` (disponibles/canjeados/totales)
cierra exacta, y la preservación de la fecha histórica real del archivo
(en vez de `NOW()`, a diferencia de `registrar_movimiento_puntos()` en
vivo) funciona como está documentado más arriba.

**Detalle de infraestructura encontrado de paso:** la tabla
`movimientos_puntos` tiene un trigger (`tg_force_empresa_movimientos_puntos`)
que fuerza `empresa_id` desde `auth.uid()` — inofensivo en producción (el
usuario autenticado siempre migra su propia empresa), pero exige contexto
de sesión real para poder insertar; se desactivó temporalmente durante el
test y se reactivó al terminar. La tabla `saldo_puntos` tiene el trigger
equivalente (`tg_force_empresa_saldo_puntos`) ya deshabilitado de antes en
producción — no se tocó, queda como está.

**Hallazgo lateral sin resolver:** `frontend/admin/js/cheques.js` define un
chip para el estado `endosado` que no existe en `cheques_estado_check` de
la base real (el valor correcto es `entregado_proveedor`) — posible código
muerto o un estado que nunca se pudo grabar desde esa pantalla. Pendiente
de revisión cuando se toque ese módulo.

**Alcance de "no se probó en el navegador" (actualizado):** con esta
sesión, las 3 entidades nuevas quedan validadas de punta a punta contra
Supabase real a nivel de datos y RPCs (incluyendo los casos límite de cada
una). Lo que sigue sin probarse es específicamente la capa de UI del
wizard maestro en un browser real — parseo de Excel/zip en el cliente,
detección de hojas, pantallas de confirmación — que no se puede simular
sin herramienta de navegador.

