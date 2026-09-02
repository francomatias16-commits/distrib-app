# v293 — Cifrado del access_token en empresa_whatsapp

## Problema
`empresa_whatsapp.access_token` (migración 272, Embedded Signup) se
guardaba en texto plano. Quedó anotado como pendiente en el comentario
original de esa migración.

## Fix
Se reutilizó el mismo helper que ya usás para Mercado Pago y los
certificados ARCA (`lib/crypto-secrets.js`, AES-256-GCM, clave
`ARCA_SECRETS_KEY` — **no hace falta ninguna variable de entorno nueva**,
es la misma que ya tenés cargada en Vercel):

- `whatsappEmbeddedSignupHandler`: el `access_token` se cifra con `cifrar()`
  antes del `upsert` a `empresa_whatsapp`.
- `resolverCredencialesWhatsapp`: el `access_token` se descifra con
  `descifrar()` al leerlo, antes de usarlo para llamar a la API de
  WhatsApp Cloud (mandar mensajes, registrar número, etc.).

Compatibilidad hacia atrás automática (misma lógica que ya usa
`crypto-secrets.js` para Mercado Pago): si el valor guardado no tiene el
prefijo `v1:`, se trata como texto plano legado y se sigue usando tal
cual. El token que ya tenías conectado de prueba va a quedar cifrado solo
cuando esa empresa reconecte su WhatsApp — no hace falta ninguna acción
manual sobre datos existentes.

## Migración
`273_whatsapp_access_token_cifrado.sql` — solo actualiza el `COMMENT` de
la columna para dejar registrado el cambio en el esquema (mismo criterio
que la migración 133 de Mercado Pago). No modifica datos ni requiere downtime.

## Archivos
- `lib/handlers/notif.js` — cifrado/descifrado agregado. Verificado con
  `node --check`.
- `supabase/migrations/273_whatsapp_access_token_cifrado.sql`
