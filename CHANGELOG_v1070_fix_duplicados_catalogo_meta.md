# v1070 — fix: la sync con el catálogo de WhatsApp duplicaba productos en vez de vincularlos (FIX-DUP-01)

Responde a la pregunta de si la sync de catálogo con WhatsApp queda
"100% optimizada para que cualquier usuario pueda conectar su catálogo y
se transfiera todo (imágenes, precios, todo)". Encontró dos problemas:
uno bloqueante (fuera del código, ver
`ACCION_REQUERIDA_META_CATALOG_CONFIG_ID.md`) y uno real de lógica que
esta entrega corrige.

## El bug

Tanto el pull (`importar` / `importar-cron`) como el push
(`carga-inicial`) usaban ÚNICAMENTE `retailer_id` para decidir si algo
"ya existía" del otro lado. Eso funciona perfecto una vez que todo pasó
por acá al menos una vez, pero para una empresa que se conecta por
primera vez y **ya tenía productos cargados de antes en los dos lados**
(su catálogo de WhatsApp armado a mano en Commerce Manager, Y su panel
de Fluxo, sin relación entre sí) generaba duplicados en ambos sentidos:

- **Pull:** cada ítem de WhatsApp que no matcheaba por retailer_id se
  creaba como producto NUEVO en el panel (categoría "Importado de
  WhatsApp"), aunque el panel ya tuviera ese mismo producto cargado.
- **Push:** cada producto del panel se mandaba a Meta con su propio
  UUID como retailer_id (que Meta nunca había visto), creando un ítem
  NUEVO en el catálogo de WhatsApp al lado del que la empresa ya tenía.

## El fix: reconciliación por nombre

Antes de tratar algo como "no existe del otro lado", se intenta un
matching por nombre (normalizado: sin tildes, minúsculas, espacios
repetidos colapsados) contra lo que quedó sin matchear por retailer_id —
pero solo entre productos del panel que todavía están en su retailer_id
por default (nunca se vincularon explícitamente a un ítem externo). Un
match 1-a-1 sin ambigüedad se vincula solo: persiste el retailer_id real
en el producto del panel, y a partir de ahí ese producto se trata como
"ya existente" (se actualiza, no se crea) en cualquier sync futura,
panel→Meta o Meta→panel. Si hay más de un candidato con el mismo nombre
de cualquier lado, se deja sin vincular automáticamente y se reporta
como aviso (`vinculacion_ambigua` en la respuesta) — mejor pedir revisión
manual que adivinar y pisar el producto equivocado.

Como consecuencia, un producto que se vincula por nombre ya no necesita
tener foto local para poder actualizarse en `carga-inicial` ni en el
sync puntual (`sincronizarProductoConMeta`) — Meta solo exige imagen
para CREAR un ítem nuevo, no para actualizar uno que ya existe con su
propia foto.

## Cambios

- `lib/handlers/catalogo-meta.js`:
  - Nuevos helpers exportados `normalizarNombreProducto()` y
    `emparejarPorNombre()` (matching puro, testeado aislado).
  - `listarItemsCatalogoMeta(cred)`: paginación de Meta extraída a un
    helper propio, reusada por `importarCatalogoDeEmpresa` y por
    `handleCargaInicial` (antes esta última nunca consultaba qué ya
    existía en Meta).
  - `importarCatalogoDeEmpresa()`: nuevo bucket `vinculados` en el
    resultado, separado de `importados`/`actualizados`.
  - `handleCargaInicial()`: reconcilia por nombre contra el catálogo
    real de Meta antes de armar el batch a subir; si la consulta de
    reconciliación falla, sigue sin reconciliar (fail-soft) en vez de
    bloquear la carga inicial entera.
  - `sincronizarProductoConMeta()`: `allow_upsert` ya no depende solo de
    tener foto local — también es `true` si el producto ya está
    vinculado a un ítem real (`retailer_id !== id`).
- `lib/repos/catalogo-meta.js`: `listarProductosConRetailerId()` ahora
  también trae `nombre` (lo necesita el matching).
- `frontend/admin/js/catalogo-meta.js`: el resumen que ve el admin
  después de correr carga inicial o importar ahora también muestra
  cuántos productos se vincularon por nombre y cuántos nombres quedaron
  ambiguos sin resolver.
- Nuevo `tests/handlers/catalogo-meta-reconciliacion.test.js` (11 tests):
  helpers puros + integración de ambos sentidos (match limpio, ambiguo,
  fail-soft de la reconciliación, y que el comportamiento previo por
  retailer_id sigue intacto).

## Verificación

- Suite completa: 1982/1982 tests OK (138/138 archivos).
- `check-wiring:all` y `check:migrations`: sin hallazgos.

## Limitaciones que quedan (documentadas, no bugs)

- Un producto genuinamente nuevo (sin match en ningún lado) sigue
  necesitando foto para poder crearse en Meta — eso es un requisito de
  la API de Meta, no algo que se pueda evitar desde acá.
- El matching es textual (nombre normalizado), no semántico — nombres
  bastante distintos entre panel y WhatsApp para el mismo producto no
  van a auto-vincularse.
- Sigue pendiente, fuera del alcance de este fix: `config_id` de
  Facebook Login for Business sin completar — ver
  `ACCION_REQUERIDA_META_CATALOG_CONFIG_ID.md`. Hasta que eso se
  resuelva, nada de esto lo puede probar un usuario real todavía.
