# Distrib — v984

Sistema de gestión de distribución (pedidos, stock, facturación ARCA, POS,
logística, portal de proveedores/clientes/choferes, asistente por voz).

## Estructura del repo

```
api/              Serverless Functions de Vercel (rutas HTTP)
lib/              Lógica de negocio (handlers/) y acceso a datos (repos/)
frontend/         Paneles admin, cliente, proveedor, chofer + landing
supabase/         Migraciones SQL y Edge Functions
tests/            Unitarios, integración, E2E (Playwright)
scripts/          Scripts de mantenimiento y carga
docs/             Toda la documentación del proyecto — ver docs/README.md
attached_assets/  Assets sueltos de referencia
```

La raíz solo contiene configuración (`package.json`, `vercel.json`,
`server.js`, configs de test) y `replit.md` (requerido en raíz por Replit).
Todo lo demás — changelogs, auditorías, planes, reportes — vive en
[`docs/`](docs/README.md).

## Documentación

Empezar por [`docs/README.md`](docs/README.md). Puntos clave:

- **Estado real del sistema, verificado (no solo lo que dicen las auditorías):**
  [`docs/changelogs/reconciliados/`](docs/changelogs/reconciliados/)
- **Arquitectura y deuda de escalabilidad:**
  [`docs/tecnico/ARQUITECTURA_ACTUAL.md`](docs/tecnico/ARQUITECTURA_ACTUAL.md)
- **Historial completo de cambios (452 entradas indexadas):**
  [`docs/changelogs/INDEX.md`](docs/changelogs/INDEX.md)
