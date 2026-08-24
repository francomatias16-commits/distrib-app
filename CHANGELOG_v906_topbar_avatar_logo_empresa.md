# v906 — Avatar de iniciales en topbar reemplazado por logo de empresa

## Contexto

El menú lateral (`nav.js` / `auth.js`, ver v744) ya mostraba el logo de la
empresa en `#sidebar-logo` y `#topbar-logo`, con fallback a una inicial
cuando no había `logo_url` cargado. El chip de usuario de la topbar
(`#topbar-avatar-ini`, círculo con iniciales tipo "MT" delante del nombre
— ej. Marina Torres), en cambio, seguía mostrando siempre iniciales sin
importar si la empresa tenía logo, en las 44 pantallas que cargan
`frontend/shared/topbar-widgets.js` (dashboard, devoluciones, cheques,
cobranzas, notas, etc.).

## Cambio

- `frontend/shared/topbar-widgets.js` — `mejorarChipUsuario()`:
  - Ahora lee `window.authCtx.perfil.empresas.logo_url` (mismo dato que ya
    usa `auth.js` para pintar el logo del sidebar/topbar-logo).
  - Si hay `logo_url`, inserta un `<img>` dentro de `#topbar-avatar-ini` en
    vez de las iniciales.
  - Si la imagen falla al cargar (`onerror`), cae automáticamente a las
    iniciales — mismo patrón defensivo que `pintarLogoEn()` en `auth.js`.
  - Si no hay `logo_url`, se mantiene el comportamiento anterior
    (iniciales calculadas a partir del nombre).
  - Se extrajo el cálculo de iniciales a un helper (`_inicialesDe`) para
    reusarlo tanto en el caso "sin logo" como en el fallback por error de
    carga de imagen.
- `frontend/shared/adminlte-components.css` — `.topbar-avatar-ini`:
  - `overflow: hidden` para recortar el logo al círculo.
  - Regla nueva `.topbar-avatar-ini img` (`object-fit: cover`, 100%x100%).
- Cache-busting: `topbar-widgets.js?v1` → `?v2` en las 44 páginas que lo
  cargan, para que el navegador no sirva la versión vieja desde caché.

## No afectado

- El fallback "sin conexión" (`_fallbackUsuarioSiAuthFalla`, ícono "!" en
  rojo) no se tocó — sigue siendo iniciales de error, no tiene sentido
  mostrar el logo cuando no se pudo verificar la sesión.
- `#topbar-logo` / `#sidebar-logo` (menú) no se modificaron, ya tenían
  esta lógica desde v744.
