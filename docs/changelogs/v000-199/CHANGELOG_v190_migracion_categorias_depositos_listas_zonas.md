# v190 — Punto 7 del plan de migraciones (P1) / Gap crítico 3

Categorías, depósitos, listas de precios y zonas pasan a ser **entidades
propias** del wizard de migración, con sus atributos reales, en vez de
autocrearse solo con nombre como efecto colateral de migrar
clientes/productos.

## Motivación

Hoy, si un cliente migra desde otro sistema que tenía depósitos con
dirección/responsable, o listas de precios, esos atributos se perdían: el
wizard solo autocreaba el registro con el nombre (vía
`migracion_resolver_categoria/deposito/lista_precio/zona`) al migrar
productos/clientes. Ese autocreate sigue existiendo tal cual (no se tocó),
pero ahora además se puede migrar cada una como archivo propio con todos
sus campos.

## Cambios de base (`173_migracion_maestros_categoria_deposito_lista_zona.sql`)

- `depositos` gana columnas **`direccion`** y **`responsable`** (no
  existían — antes el depósito se autocreaba solo con nombre).
- `migracion_sesiones_entidad_check` ahora acepta `categorias`,
  `depositos`, `listas_precios`, `zonas`.
- Función nueva `migracion_parsear_dias_reparto(texto)`: convierte texto
  libre ("lunes, Miércoles y viernes") al `TEXT[]` canónico que ya usa
  `zonas.dias_reparto` (lunes/martes/miercoles/jueves/viernes/sabado/domingo,
  sin tilde, minúscula — mismo formato del seed 003).
- RPC nueva `migracion_confirmar_maestro_lote(sesion, empresa, entidad,
  usuario, lote_size)`: **una sola función parametrizada** para las 4
  entidades (en vez de 4 casi idénticas), mismo patrón de lote resumible
  que `migracion_confirmar_proveedores_lote`.
  - `es_principal` (depósitos) y `es_default` (listas) solo se aplican si
    la fila lo pide **y** la empresa todavía no tiene uno marcado — nunca
    pisa un principal/default ya elegido a mano.

## Cambios de código (`lib/handlers/migracion.js`)

- 4 entradas nuevas en `CAMPOS`: `categorias` (nombre*, descripcion, orden),
  `depositos` (nombre*, direccion, responsable, es_principal),
  `listas_precios` (nombre*, es_default), `zonas` (nombre*, dias_reparto).
- `validarFilaMaestro`: único requisito real es `nombre`.
- `mapearSesionMaestro`: función genérica (dedupe por nombre normalizado,
  igual criterio que los resolvers ya existentes) que reemplaza tener que
  escribir 4 `mapearSesionX` casi idénticas — se engancha en el dispatcher
  de `mapearSesion` para las 4 entidades.
- `confirmarSesion`: nueva rama que llama a `migracion_confirmar_maestro_lote`
  pasando `sesion.entidad` como parámetro.

## Cambios de frontend (`frontend/admin/js/migracion.js`)

- Etiquetas de campos nuevas (`orden`, `direccion`, `responsable`,
  `es_principal`, `es_default`, `dias_reparto`) para el mapeo de columnas y
  la plantilla descargable.
- Títulos del paso "subir archivo" para las 4 entidades.
- Se agregan al checklist guiado (`ORDEN_GUIADO`), **antes** de clientes —
  no es obligatorio migrarlas primero (el autocreate por nombre sigue
  funcionando), pero tiene sentido cargarlas antes si se quieren sus
  atributos completos.

## Lo que NO se tocó

- El autocreate por nombre (`migracion_resolver_*`) sigue exactamente
  igual — sigue siendo el camino cuando el cliente NO migra estas 4
  entidades como archivo propio.
- No hay entidad separada para "reglas de descuento por volumen" en listas
  de precios — el schema actual de `listas_precios` no tiene esa
  funcionalidad todavía (sería un cambio de producto más grande, fuera del
  alcance de este punto del plan).

## Pendiente / siguiente

Falta probar el flujo end-to-end por la interfaz real (subir un Excel de
depósitos con dirección/responsable, confirmar, verificar que
`es_principal` respeta la regla de "solo uno por empresa"). No se pudo
simular desde acá por ser 100% client-side el parseo del archivo — mismo
gap que ya quedaba anotado para las otras entidades del wizard.

Con esto queda cerrado el punto 7 del plan (`P1`). Siguiente en la lista:
punto 8 (validación de dígito verificador de CUIT) o punto 9 (plantillas
de exportación + mapeos guardables), a definir con Ruben.
