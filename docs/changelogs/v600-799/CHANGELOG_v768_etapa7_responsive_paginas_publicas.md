# v768 — Etapa 7: páginas públicas (cierre del plan de auditoría responsive)

Continuación de `PLAN_AUDITORIA_RESPONSIVE_SISTEMA.md`. Última etapa: landing,
registro, legales, saas-billing y las pantallas de login/reset públicas.

## Alcance revisado (14 páginas)
- `frontend/index.html` (landing)
- `frontend/registro.html`
- `frontend/completar-registro.html`
- `frontend/privacidad.html`
- `frontend/terminos.html`
- `frontend/eliminacion-datos.html`
- `frontend/admin/saas-billing.html` (+ `admin/css/saas-billing-gentelella.css`)
- `frontend/admin/login.html` (+ `admin/css/login.css`)
- `frontend/cliente/login.html`
- `frontend/chofer/login.html`
- `frontend/admin/restablecer-password.html`
- `frontend/chofer/restablecer-password.html`
- `frontend/admin/sin-permiso.html`
- `frontend/admin/suspendida.html`

## Hallazgo encontrado y corregido

**`chofer/login.html` y `chofer/restablecer-password.html` no tenían el ajuste
de padding para pantallas angostas (≤480px)** que sí tienen `admin/login.html`
(breakpoint 480px) y `cliente/login.html` (breakpoint 420px). Sin el ajuste,
la card quedaba con `padding: 4.25rem 2.75rem 2.25rem` (88px de padding
horizontal) también en celulares chicos, dejando menos espacio útil para el
formulario que en las otras dos pantallas de login del sistema.

Fix aplicado en ambos archivos (mismo criterio que `admin/login.css`):
```css
@media (max-width: 480px) {
  .login-card { max-width: 400px; padding: 3.25rem 1.75rem 1.5rem; border-radius: 22px; }
  .login-header .icon { width: 88px; height: 88px; top: -44px; }
  .login-header .icon svg { width: 40px; height: 40px; }
  .login-header h1 { font-size: 1.55rem; }
}
```

## Verificado sin cambios (ya cubierto)
- **`index.html`**: todos los grids del landing (`.hero`, `.split`, `.mock-*`,
  `.inv-head/.inv-row`, `.social-row` en registro) usan `fr`/`minmax`/`auto-fit`
  o colapsan a `1fr` en los breakpoints 1180/900/860/640px ya definidos. Sin
  anchos fijos en px que puedan generar overflow horizontal.
- **`registro.html`**: `.row-2` y `.social-row` ya colapsan a 1 columna en
  `@media (max-width:700px)`.
- **`terminos.html`**: la tabla de planes usa `width:100%` sin `white-space:nowrap`
  — el texto envuelve en mobile en vez de desbordar; no hay wrapper con
  `overflow-x` porque no lo necesita.
- **`admin/saas-billing.html`**: `saas-billing-gentelella.css` tiene 0
  `@media` (estaba en la lista del pre-escaneo) pero es solo reskin de color;
  toda la estructura vive en el `<style>` inline de la página, que ya usa
  `grid-template-columns:repeat(auto-fit,minmax(160px,1fr))` para las tarjetas
  de plan, `overflow-x:auto` en las 4 tablas, y `flex-wrap:wrap` en el strip
  de KPIs.
- **`admin/sin-permiso.html`**: reutiliza `.login-card` de `login.css`, que ya
  tiene el breakpoint de 480px correcto.
- **`admin/suspendida.html`**: tiene su propio `@media (max-width:480px)`
  correcto.
- **`privacidad.html` / `eliminacion-datos.html` / `completar-registro.html`**:
  páginas de texto/formulario simple, sin grids ni tablas, `max-width` fluido
  con `padding` lateral — sin hallazgos.

## Cierre del plan
Con esta etapa se completan las 7 etapas de `PLAN_AUDITORIA_RESPONSIVE_SISTEMA.md`
sobre las 78 páginas / 88 hojas de estilo del sistema. Total de hallazgos reales
de responsive corregidos en las etapas 1-7: pendiente de consolidar en un cierre
único si se quiere un resumen ejecutivo — avisar si lo querés armar.
