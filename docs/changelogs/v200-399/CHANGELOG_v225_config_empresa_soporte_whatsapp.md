# CHANGELOG v225 — Datos de la empresa + Soporte (WhatsApp)

## Contexto

Continuación de la sesión anterior (exploración de alcance ya confirmada con
Cristian): agregar al workspace **Configuración** una sección de datos de la
empresa editables, y un canal de soporte directo por WhatsApp con MF Web
Solutions, visible para todos los usuarios admin de todas las empresas
cliente.

## Agregado

- **`/admin/empresa-config`** (`frontend/admin/empresa-config.html`): página
  para editar nombre/razón social, CUIT, domicilio, teléfono y email de la
  empresa, más el logo (reutiliza el flujo existente de `/api/empresa/logo`).
  Restringida a roles `dueno`/`admin`.
- **`/admin/soporte`** (`frontend/admin/soporte.html`): página con los
  canales de contacto (WhatsApp y email), horario de atención y clasificación
  de urgencia — contenido tomado de `docs/SOPORTE.md`.
- **Botón flotante de WhatsApp** (`frontend/shared/whatsapp-widget.{css,js}`):
  se inyecta desde `nav.js` en las ~40 pantallas admin, igual que el
  asistente de ayuda existente (`chat-widget.js`). Es un link directo a
  `wa.me` con el número de Cristian hardcodeado (decisión confirmada: más
  simple, requiere redeploy para cambiarlo). No depende de sesión activa.
  Se posiciona a la izquierda del botón de ayuda en desktop y apilado arriba
  en mobile (<480px), respetando el offset de la barra inferior fija
  (<768px) que ya usa `chat-widget.css`.
- **`GET/PUT /api/empresa/datos`** (`lib/handlers/empresa.js`): nuevo
  sub-servicio en el dispatcher existente (`_svc=datos`). Valida rol
  (`dueno`/`admin`), formato de CUIT (11 dígitos) y de email antes de
  actualizar `empresas`. Reutiliza el patrón de autenticación por Bearer
  token + service role ya usado en `logo`/`icon`.
- **`nav-data.js`**: nuevas secciones "Datos de la empresa" y "Soporte"
  dentro del workspace `config` existente (no se creó un workspace nuevo:
  ya existía uno con auditoría, migración, notificaciones y suscripciones
  SaaS).
- **`vercel.json`**: rewrites limpias para `/admin/empresa-config`,
  `/admin/soporte` y `/api/empresa/datos` (sin agregar funciones serverless
  nuevas — todo pasa por el dispatcher único `api/index.js`).

## Verificado antes de implementar

- RLS de `empresas` ya permite `UPDATE` de la propia fila a `dueno`/`admin`
  (`empresas_update`), y `SELECT` de la propia fila a cualquier usuario de
  esa empresa (`empresas_select`). El endpoint server-side agrega
  validación de formato que la RLS no cubre (CUIT, email).

## Pendiente / a decidir

- El logo aún no se usa en comprobantes impresos (solo panel).
- Si el volumen de soporte crece (>~10 clientes), `docs/SOPORTE.md` ya
  sugiere migrar a un chat en la app (Crisp/Intercom) — no implementado acá.

## Fix post-testing

- **`PUT /api/empresa/datos`**: `empresas.cuit` tiene constraint `UNIQUE`
  (verificado en la base). Se agregó manejo específico del código de error
  `23505` (violación de unicidad) devolviendo `409` con mensaje claro
  ("Ese CUIT ya está registrado por otra empresa") en vez de exponer el
  error crudo de Postgres.
- Verificado en la base: no hay triggers `UPDATE`/`BEFORE UPDATE` sobre
  `empresas` que pudieran interferir (solo triggers `INSERT`), y `domicilio`/
  `telefono`/`email` son nullable, así que limpiar esos campos no rompe
  restricciones NOT NULL.
