# Distribución integrada — v862 + v863

Este paquete es la versión completa y actualizada del proyecto, resultado
de integrar sobre la distribución base v862 el fix v863:

- **Base**: `distrib_v862_fix_motivo_not_defined_anular_factura.zip`
  (proyecto completo, incluye el fix de `motivo is not defined` al anular
  factura, changelog v862 y todo el historial previo).
- **Aplicado encima**: `distrib_v863_fix_mapa_seguimiento_en_vivo.zip`
  (fix de mapa en blanco al entrar directo al tab "Seguimiento en vivo"
  en `frontend/admin/js/rutas.js`).

## Archivos actualizados en esta integración
- `frontend/admin/js/rutas.js` → reemplazado por la versión v863 (incluye
  la función `refrescarTamanioMapa()` y sus dos puntos de invocación).
  Verificado con `diff` que el cambio es puramente aditivo sobre la base
  v862, sin pérdida de ningún fix anterior.

## Verificación
- `node --check frontend/admin/js/rutas.js` → OK.
- No hubo conflictos: v863 solo tocaba este archivo, ya presente en la
  base v862 con contenido idéntico salvo por el fix agregado.
