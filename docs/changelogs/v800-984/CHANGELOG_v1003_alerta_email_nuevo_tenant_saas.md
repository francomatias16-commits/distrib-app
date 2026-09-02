# v1003 — Aviso por email cuando se registra una empresa nueva (sin entrar a Supabase)

## Qué hace
Cada vez que se inserta una fila nueva en `empresas` (alta de tenant, ya sea
por registro público o por vos manualmente), un trigger de la base te manda
automáticamente un email con nombre, CUIT, email y fecha de la empresa nueva.

## Cómo funciona (reutiliza infraestructura ya existente, no agrega secretos)
1. Trigger `trg_saas_avisar_nuevo_tenant` (AFTER INSERT en `empresas`,
   migración 548) llama vía `pg_net` a
   `POST /api/index?_mod=saas-alertas`, usando el MISMO secreto que ya usan
   `trigger_push_nuevo_pedido` / `trigger_push_stock_critico`
   (`public.get_push_secret()` → header `x-push-secret`).
2. Nuevo handler `lib/handlers/saas-alertas.js` (registrado en `api/index.js`)
   valida ese secreto igual que `pushInternoHandler` (falla cerrado con 503
   si `INTERNAL_PUSH_SECRET` no está configurada) y envía el email con
   `enviarEmail()` de `lib/email.js` — el mismo módulo que ya usan las
   confirmaciones de pedido.
3. Un error de red o de email nunca frena el alta del tenant (está en un
   `BEGIN...EXCEPTION WHEN OTHERS` dentro del trigger).

## Único paso pendiente de tu lado
Agregar en Vercel (Project Settings → Environment Variables):
```
SAAS_ALERTA_EMAIL = tu-email@ejemplo.com
```
Sin esa variable, el endpoint devuelve 503 y no manda nada (no rompe el
alta del tenant, solo no llega el aviso). `INTERNAL_PUSH_SECRET`,
`RESEND_API_KEY` y `EMAIL_FROM` ya existen — no hace falta tocarlos.

## Archivos
- Nuevo: `lib/handlers/saas-alertas.js`
- Modificado: `api/index.js` (registro del módulo `saas-alertas`)
- Aplicado en Supabase (proyecto jgiquzjwoedmzwqgzubr): migración
  `548_aviso_email_nuevo_tenant_saas` (función + trigger)

## No incluido
Aviso por WhatsApp — la infraestructura de WhatsApp saliente que tiene el
proyecto es una cola (`outbox`) pensada para conversaciones con clientes,
no para un aviso puntual a vos. Si lo querés igual, es un desarrollo aparte.
