# v294 — Flag de envíos salientes por empresa (reemplaza el interruptor global de v291)

## Problema
`WA_NOTIF_SALIENTES_HABILITADAS` (v291) es un interruptor global: prender
los envíos con costo para una empresa los prendía para todas al mismo
tiempo. Con varias empresas conectando su propio WhatsApp, cada una va a
tener su propio momento de "ya definimos el costo, dale prendé los avisos".

## Fix
- **Migración 274**: nueva columna `empresa_whatsapp.envios_habilitados`
  (boolean, default `false` — fail-safe, mismo criterio que el interruptor
  global anterior).
- **`resolverCredencialesWhatsapp`**: ahora devuelve también
  `enviosHabilitados`, resuelto así:
  - Empresa con número propio conectado (fila en `empresa_whatsapp`) → usa
    **su** columna individual.
  - Empresa que todavía está en el número compartido de prueba (sin fila
    propia) → sigue rigiéndose por `WA_NOTIF_SALIENTES_HABILITADAS`, el
    interruptor global de siempre. No se rompe nada para las empresas que
    no pasaron por Embedded Signup.
- **`whatsappHandler`**: el corte que antes miraba
  `process.env.WA_NOTIF_SALIENTES_HABILITADAS` ahora mira
  `enviosHabilitados` (ya resuelto por empresa o por fallback global,
  según corresponda).

## Cómo se activa hoy (sin UI todavía)
Por SQL, empresa por empresa, cuando ya cerraste el tema costos con ese
cliente puntual:

```sql
UPDATE public.empresa_whatsapp
SET envios_habilitados = true
WHERE empresa_id = '<uuid-de-la-empresa>';
```

**Ojo con el caché**: `resolverCredencialesWhatsapp` cachea el resultado
en memoria hasta 60 segundos por empresa — el cambio puede tardar hasta
un minuto en reflejarse.

## Pendiente (fuera de esta vuelta)
No armé todavía un toggle en el panel admin para esto — lo dejé por SQL
directo, que es lo mismo que ya venías haciendo para otras credenciales.
Si sumás más empresas y se vuelve incómodo hacerlo a mano, avisame y
armamos una pantalla simple (probablemente al lado de
`whatsapp-onboarding.html`, con acceso solo para vos/superadmin — un
dueño de empresa no debería poder auto-habilitarse el costo).

## Archivos
- `lib/handlers/notif.js` — verificado con `node --check`.
- `supabase/migrations/274_whatsapp_envios_habilitados_por_empresa.sql`
