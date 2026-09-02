# v384 — Detección de fila de encabezados + auto-generar código en Productos

Contexto: el archivo de Cristian no tenía fila de encabezados, y el wizard
de migración asumía ciegamente que la fila 0 SIEMPRE es encabezado
(`sheet_to_json(..., {header:true})` / `Papa.parse(..., {header:true})`).
Eso le rompió el archivo de dos formas encadenadas: perdió su primera fila
de datos reales (tratada como si fueran nombres de columna) y, al no tener
columna de "Código" (campo requerido con dedupe para productos), no tenía
forma de completar el mapeo.

## 1) Detección de fila de encabezados (todas las entidades)

**Antes**: `frontend/admin/js/migracion.js` parseaba el Excel/CSV
consumiendo la fila 0 como encabezado sin ninguna validación.

**Ahora**:
- `parsearExcelCrudo`/`parsearCSVCrudo` devuelven la matriz cruda (array de
  arrays), sin decidir nada todavía.
- `detectarFilaEncabezado()` corre una heurística de 4 señales (match contra
  `ETIQUETAS_CAMPO`, la fila 0 no es puramente numérica, sin valores
  repetidos en la fila 0, y consistencia de tipo por columna contra la
  muestra de datos) para sugerir un valor por defecto.
- `mostrarPreviewEncabezado()` **siempre** muestra una vista previa (primeras
  5 filas) con un checkbox — pre-marcado según la heurística, pero 100%
  editable — antes de seguir al mapeo. Si la persona lo desmarca, las
  columnas quedan como "Columna 1", "Columna 2", etc. y la fila 0 se trata
  como dato real.
- `filasDesdeMatriz()` arma los objetos `{columna: valor}` recién después de
  esa confirmación, con dedupe de nombres de columna repetidos/vacíos.

No toca `frontend/admin/js/migracion-maestra.js` en esta primera entrega —
ver punto 3 más abajo, donde sí se extiende.

## 3) Misma detección, extendida a la migración maestra (`migracion-maestra.js`)

**Por qué era más urgente acá de lo que parecía**: la migración maestra no
solo pierde la primera fila de datos con el mismo bug — además usa los
nombres de columna para **adivinar a qué entidad corresponde cada hoja**
(`detectarEntidadDeHoja`, comparando contra `ETIQUETAS_CAMPO`/sinónimos). Si
la hoja no tenía encabezados de verdad, esa detección de entidad se rompía
en cascada: comparaba nombres de campo contra lo que en realidad eran
valores de la primera fila de datos, y probablemente no reconocía la hoja
como nada (o, peor, la reconocía mal).

**Cambios**:
- `parsearArchivoMaestro()` ahora devuelve la matriz cruda por hoja/archivo
  (Excel multi-hoja, cada CSV/Excel dentro de un .zip, o un CSV suelto) en
  vez de asumir encabezado con `header:true`.
- `onArchivoMaestroElegido()` corre `detectarFilaEncabezado()` **por hoja**
  ANTES de `detectarEntidadDeHoja()` — la detección de entidad ahora sí
  recibe nombres de columna reales (o "Columna 1, 2, ..." si la heurística
  decide que no hay encabezado).
- Cada tarjeta de la pantalla de detección (`renderDeteccionMaestra`) suma
  un checkbox **"Esta hoja tiene fila de encabezados"** — pre-marcado según
  la heurística, corregible por hoja — más una línea con cómo se está
  interpretando la primera fila de datos ahora mismo (ej.
  `Columna 1: Coca Cola 500ml · Columna 2: 7790001`), para detectar de un
  vistazo si el checkbox está mal sin tener que abrir el archivo aparte.
- `onCambioEncabezadoMaestro()` recalcula columnas/filas de esa hoja desde
  la matriz cruda y vuelve a correr la detección de entidad desde cero — el
  significado de todas las columnas cambia, así que cualquier mapeo manual
  que ya hubiera para esa hoja no tiene sentido conservarlo.
- Reusa `detectarFilaEncabezado()`/`filasDesdeMatriz()` de `migracion.js`
  (se carga antes en `migracion.html`, quedan disponibles como funciones
  globales) — no se duplicó la heurística.

**Nota aparte, no relacionada con este fix**: `migracion-maestra.js` define
su propio `normalizarTexto()`, con distinta implementación a la de
`migracion.js` — como ambos son `<script>` clásicos (no módulos), la
segunda declaración pisa a la primera en el objeto global una vez que
cargan las dos. Hoy no rompe nada funcionalmente (las dos normalizan de
forma razonable), pero es una colisión de nombres preexistente que convendría
resolver en algún momento (renombrando una de las dos) para que el
comportamiento no dependa del orden de carga de los `<script>`. No lo toqué
en esta entrega — es un cambio aparte, sin relación con el bug de encabezados.

## 2) Auto-generar código (Productos)

**Antes**: `codigo` es requerido y es la clave de dedupe (`claveDedupe:
'codigo'`) para productos — si el archivo no lo traía, no había forma de
completar el mapeo sin editar el archivo a mano primero.

**Ahora**:
- `frontend/admin/js/migracion.js`: cuando el campo pertenece a
  `CAMPOS_AUTOGENERABLES[entidad]` (hoy solo `codigo` en `productos`), el
  `<select>` de mapeo suma una opción **"✨ Generar automáticamente"**
  (`SENTINEL_AUTOGENERAR = '__AUTOGENERAR__'`). Al elegirla, `confirmarMapeo()`
  la manda igual que cualquier otro valor de columna — no hizo falta tocar
  la validación de "faltantes" ni el submit.
- `lib/handlers/migracion.js`: en `mapearSesion`, si `mapeo_columnas[campo]`
  es el sentinel Y el campo está en `CAMPOS_AUTOGENERABLES[sesion.entidad]`,
  se genera el valor con `generarValorAuto()` en vez de leer
  `fila.datos_originales[colOrigen]` (esa columna no existe de verdad).
- El código generado tiene forma `AUTO-{6 últimos caracteres del id de
  sesión}-{número de fila con padding a 6 dígitos}` — determinístico y sin
  estado compartido entre lotes: como `mapearSesion` procesa la sesión en
  lotes resumibles a través de múltiples requests HTTP, no hay forma segura
  de mantener un contador secuencial en memoria. El id de sesión (UUID) y el
  número de fila dentro de esa sesión ya son únicos por diseño, así que la
  combinación es única sin consultar máximos existentes.

## No incluido en esta entrega
- Auto-generación de claves para otras entidades (`cuit` en clientes,
  `nombre` en categorías/depósitos/listas/zonas) — hoy `CAMPOS_AUTOGENERABLES`
  solo cubre `productos.codigo`, que era el gap real que Cristian pisó. Se
  puede sumar `cuit`/`nombre` con el mismo mecanismo si hace falta (aunque
  para `cuit` en particular no es buena idea — ver charla en el chat).
- Detección de filas duplicadas dentro del archivo antes de confirmar (más
  allá del dedupe por clave que ya existía). Quedó fuera de alcance de esta
  entrega — es un cambio independiente (UI de advertencia + decisión de
  dedupear o no) y no bloqueaba el caso de Cristian.
- Resolver la colisión de `normalizarTexto()` entre `migracion.js` y
  `migracion-maestra.js` (ver nota en el punto 3).

## Deploy
```
vercel --prod
```
