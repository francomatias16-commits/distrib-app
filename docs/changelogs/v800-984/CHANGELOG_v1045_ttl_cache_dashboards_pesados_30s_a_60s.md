# v1045 — TTL del caché de dashboards pesados: 30s → 60s (2026-08-31)

## Por qué

Corriendo `npm run loadtest` (v1044) contra `fluxoapp.com.ar` con 30
conexiones concurrentes, `/api/admin/kpis` fue el más lento de los 9
endpoints por lejos: p99 de **4785ms**, entre 2 y 6 veces más que el
resto (783ms–2364ms), muy cerca del umbral interno de alerta del
script (5000ms) — aunque bien dentro del límite real de Vercel (60s).

## Causa

`calcularKpisDashboard()` dispara 2 tandas de RPCs por request (1 +
3 en paralelo: kpis base, ventas por canal, compras a proveedor,
gastos generales) — más trabajo por request que los otros 8 endpoints,
que hacen 1 sola query. Tiene un caché de 30s (`cacheado()`,
`lib/cache.js`), pero es **en memoria por instancia de lambda**, no
distribuido. Bajo tráfico real (usuarios entrando de a poco) eso
alcanza — la misma instancia "warm" sirve varias requests seguidas
desde caché. Pero una ráfaga de 30 conexiones simultáneas (como la del
loadtest) hace que Vercel levante varias instancias en paralelo, cada
una con su caché vacío: buena parte de esas 30 conexiones termina
recalculando las 4 RPCs al mismo tiempo, compitiendo por conexiones a
Postgres — de ahí el p99 disparado.

## Fix

Se subió `KPIS_CACHE_TTL_MS` de 30.000 a 60.000ms en
`lib/handlers/admin.js`. Esta constante la comparten 4 handlers, todos
con el mismo patrón (varios RPCs en paralelo por request, sin
distinguirlos por su costo individual):

- `handleKPIs` (`/api/admin/kpis`) — 4 RPCs
- `handleResumenArranque` (`/api/admin/resumen-arranque`) — 4 RPCs
- `handleDashboardEjecutivo` (`/api/admin/dashboard-ejecutivo`) — 5 RPCs
- `handleComparativaMensual` (`/api/admin/comparativa-mensual`) — 1 RPC pesada

Los cuatro quedan con el doble de margen ante una ráfaga fría, sin
perder frescura real para un dashboard: un cambio (venta/pedido nuevo)
sigue reflejándose dentro de 1 minuto.

## Qué NO resuelve

Esto no arregla el problema de fondo — el caché sigue siendo por
instancia, no compartido. Una ráfaga lo suficientemente grande (o
sostenida más allá del TTL) va a volver a golpear a los cuatro
handlers en paralelo igual que antes, solo que con menos frecuencia.
Si el piloto de caché en memoria (Etapa 3, `PLAN_ROBUSTEZ_ESCALABILIDAD_
PROFESIONAL_2026.md`) necesita más que esto, el paso siguiente ya está
identificado en el plan: caché compartido entre instancias
(Redis/Upstash).

## Pendiente

Ninguno bloqueante. Sugerido: correr `npm run loadtest` contra un
preview después de este cambio para confirmar que el p99 de `kpis`
baja de forma medible (no es 100% determinístico — depende de cuántas
instancias de lambda levante Vercel para esa ráfaga puntual).
