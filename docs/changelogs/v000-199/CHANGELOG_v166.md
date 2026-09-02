# v166 — Fix crítico en wizard de migración

## Bug corregido (punto 1 de la auditoría)
`lib/handlers/migracion.js`: al **actualizar** clientes o productos existentes,
si una columna del archivo venía vacía o no se mapeaba, el handler pisaba el
campo existente con `0` / `null` en vez de dejarlo intacto. Esto borraba datos
reales (límite de crédito, saldo de cuenta corriente, precio) con solo subir
un archivo de actualización parcial (ej.: un Excel con solo `cuit, telefono`).

### Fix aplicado
- Nueva función `presente(valor)` que distingue "columna no mapeada / vacía"
  de "vino con un valor real".
- En `ejecutarMigracionClientes` y `ejecutarMigracionProductos`, el payload de
  **UPDATE** ahora solo incluye los campos que efectivamente vinieron con
  valor en la fila — nunca pisa con default.
- El payload de **INSERT** (fila nueva) sigue aplicando defaults (`0`/`null`)
  donde corresponde, ya que un registro nuevo no puede quedar con campos
  numéricos indefinidos.
- Mismo criterio aplicado a `precios_items` y `stock`: solo se tocan si la
  columna de precio/stock vino con valor en esa fila.

### Pendiente (no incluido en este fix, según auditoría completa)
- Importación de stock no crea movimiento en `lotes` / `movimientos_stock`
  (bypassa tracking FEFO).
- `mapearSesion` y `confirmarSesion` siguen actualizando fila por fila (sin
  batching) — riesgo de timeout serverless en archivos grandes.
- Sin reintento selectivo de filas fallidas tras un `confirmar` parcial.
- Cobertura de campos limitada (sin categoría/proveedor/zona/lista múltiple).

Ver auditoría completa en la conversación para detalle y priorización.
