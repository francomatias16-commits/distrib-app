# v991 — "Mi suscripción" refleja la landing + fix de drift en cache-busting

Continuación de la auditoría general (barrido de 84 HTML/488 JS/422
migraciones/465 changelogs). Cierra el punto 4 (que había quedado a medio
terminar: la constante `FEATURES_PLAN_LANDING` estaba definida pero sin
usar en el render) y resuelve el punto 6 (cache-busting).

## Punto 4 — "Mi suscripción" no reflejaba lo que vende la landing

**Archivo:** `frontend/admin/saas-billing.html`

- `cargarPlanesTenant()` ya no arma `limites` a partir de
  `max_usuarios/max_clientes/max_pedidos_mes` (3 líneas genéricas que no
  se correspondían con lo que el cliente vio al elegir plan). Ahora itera
  `FEATURES_PLAN_LANDING[p.tier]` — las 12 filas (Pedidos, Stock,
  Productos, POS, Puntos de venta, Etiquetas de precio, Facturación,
  Clientes, WhatsApp/Reparto, Asistente IA, Reportes, Alertas) copiadas
  tal cual de `frontend/landing/bundle-part1.js` — y renderiza cada fila
  como `<div class="plan-tarjeta__feat">`, aplicando `.is-muted` cuando el
  valor es exactamente "No incluido" (mismo criterio visual que la tabla
  de precios de la landing).
- `Usuarios` se conserva como dato real de la base (`p.max_usuarios`),
  pero se movió a una línea aparte al final (`.plan-tarjeta__feat-extra`,
  separada con un borde punteado) en vez de mezclarse con las
  funcionalidades de la landing — es información real y útil pero no es
  parte de lo que la landing promete, así que no debía competir en el
  mismo nivel visual.
- Se sacó `max_clientes`/`max_pedidos_mes` del `select()` de
  `planes_limites`: ya no se usan en ningún lado de esta pantalla.
- CSS nuevo: `.plan-tarjeta__feat`, `.plan-tarjeta__feat.is-muted`,
  `.plan-tarjeta__feat-extra` — reutiliza los tokens de color ya
  definidos en la página (`--color-border`, `--color-text`,
  `--color-text-light`) en vez de hardcodear grises nuevos.

## Punto 6 — Cache-busting inconsistente

**Hallazgo real (no solo estético):** el barrido inicial señaló que
convivían `?v=1`, `?v=229` (contadores manuales), `?v=1786751950483`
(epoch ms) y `?v=20260818` (fechas) en el mismo `<head>`. Antes de tocar
nada, medí el impacto real en las 57 páginas de `frontend/admin/*.html`:

- 97 assets únicos referenciados con `?v=`.
- De esos, **8 tenían valores de versión *distintos* entre páginas que
  cargan el mismo archivo** — eso sí es un bug, no solo inconsistencia de
  formato: dos páginas que comparten `base-layout.css` pero piden
  `?v=196` y `?v=227` respectivamente pueden terminar renderizando estilos
  distintos entre sí según qué versión tenga cada navegador en caché.
  Assets afectados: `skeletons.css`, `base-layout.css`,
  `reskin-patch.css`, `reskin-patch-v2-shadcn.css`, `compras.css`,
  `stock-overview.css`, `clientes.css`, `login.css`.
- La mezcla de *formato* (int chico vs. epoch-ms vs. fecha) entre
  distintos assets, en cambio, no es un bug: cada asset lleva su propio
  contador manual independiente y consistente consigo mismo en todas las
  páginas — normalizar el formato global es un cambio cosmético de mucho
  mayor superficie (toca decenas de referencias sin corregir ningún
  comportamiento real) y quedó fuera de este punto.

**Fix aplicado (script puntual, no versionado en el repo — se corrió una
vez sobre `frontend/admin/*.html`):** para cada uno de los 8 assets
drifteados, se tomó el valor más alto ya presente (asumiendo que el
contador manual más alto es el más reciente) y se reescribieron *todas*
las referencias a ese asset en las 57 páginas para que usen ese mismo
valor. 201 referencias corregidas en total. Verificado post-fix: 0 assets
con versiones distintas entre páginas.

| Asset | Versión aplicada | Valores previos |
|---|---|---|
| `/shared/skeletons.css` | 228 | 197, 228 |
| `/frontend/admin/css/base-layout.css` | 227 | 196, 197, 227 |
| `/shared/reskin-patch.css` | 227 | 197, 227 |
| `/shared/reskin-patch-v2-shadcn.css` | 227 | 197, 227 |
| `/frontend/admin/css/compras.css` | 198 | 197, 198 |
| `/frontend/admin/css/stock-overview.css` | 3 | 2, 3 |
| `/frontend/admin/css/clientes.css` | 200 | 199, 200 |
| `/frontend/admin/css/login.css` | 201 | 197, 200, 201 |

## Fuera de alcance de este changelog

- Punto 5 (deuda de nomenclatura `basico/pro/enterprise` vs.
  `Básico/Premium/Platinum` en RPCs, comentarios y mails) — no fue pedido
  en esta tanda, queda pendiente.
- El otro ítem de "Consistencia técnica" (colores hardcodeados vs.
  tokens, 49/57 páginas) — no fue el punto 6 que se pidió resolver;
  queda igual de pendiente que antes.

## Verificación

- `node -c` sobre el bloque `<script>` de `saas-billing.html`: sin
  errores de sintaxis.
- Re-chequeo automático post-fix confirmó 0 assets con versiones
  divergentes entre páginas de `frontend/admin`.
- Pendiente (no verificable en este entorno): probar `saas-billing.html`
  contra datos reales de `planes_limites` para confirmar que el layout de
  la tarjeta no rompe con las descripciones más largas de Premium/Platinum.
