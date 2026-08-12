# v391 — Persistir foto_fuente para poder auditar el origen de cada imagen

## Motivación
No había forma de verificar, después del hecho, si una foto cargada por
auto-imagenes vino de un match real (barcode/Google Images) o del banco
genérico (Pexels) — el campo `fuente` solo existía en la respuesta JSON de
esa corrida puntual, nunca se guardaba en la tabla. Ante la duda de si
Google Images estaba realmente matcheando o si todo estaba cayendo a
Pexels, no había cómo confirmarlo sin volver a correr todo y mirar el
resumen en el momento.

## Solución
- Migración `agregar_foto_fuente_productos`: nueva columna
  `productos.foto_fuente` (text, nullable). Valores esperados:
  `openfoodfacts | openproductsfacts | google_images | pexels`. NULL si la
  foto no vino de auto-carga (subida manual) o si el producto no tiene foto.
- `lib/handlers/auto-imagenes.js`: el `update` que guarda `foto_url` ahora
  guarda también `foto_fuente: resultado.fuente`.
- `frontend/admin/js/productos.js`: `deshacerBusquedaImagenes()` ahora
  limpia `foto_fuente` junto con `foto_url` al deshacer una corrida.

## Limitación conocida
Los productos que ya tienen `foto_url` cargado de corridas **anteriores** a
esta migración van a tener `foto_fuente = NULL` — no hay forma de saber
retroactivamente de dónde vino esa foto específica. Es solo auditable hacia
adelante, desde esta versión en más.

## Cómo verificar de acá en adelante
```sql
select foto_fuente, count(*)
from productos
where empresa_id = '<empresa_id>' and foto_url is not null
group by foto_fuente
order by count(*) desc;
```
