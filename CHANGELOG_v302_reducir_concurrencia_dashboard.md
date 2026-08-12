# v302 — Reducir la ráfaga de requests concurrentes del dashboard

**Fecha:** 2026-07-12

## Por qué v300 y v301 no cambiaban nada

Confirmado con los logs: incluso con el timeout de 8s agregado en v301
dentro de `autenticar()`, el timeout observado en producción seguía siendo
de **60 segundos exactos**, no 8. Eso solo tiene una explicación: el código
de `admin.js` nunca llegaba a ejecutarse — la request se quedaba en cola
*antes* de entrar al handler. Ningún fix a nivel de código adentro del
handler puede arreglar algo que nunca llega a correr.

## Diagnóstico final

El dashboard (`dashboard-optimizado.js` + `dashboard-ejecutivo.js`)
dispara **hasta 12 requests en paralelo** apenas carga la página — todas
contra `/api/admin/*`, que es una sola función serverless consolidada
(`api/index.js`, por el límite de funciones de Vercel Hobby). Bajo esa
ráfaga, algunas quedan haciendo cola del lado de la plataforma hasta que
Vercel las mata a los 60s, sin que el código llegue a ejecutar ni una
línea — consistente con que ningún timeout interno cambiara el resultado.

No tengo forma de confirmar el límite exacto de concurrencia de tu plan
desde acá (no es algo que se vea por SQL ni por los logs de runtime), así
que esto es la explicación más consistente con toda la evidencia reunida,
no una certeza 100% confirmada. Si después de este fix el problema
persiste, el siguiente paso sería mirar la pestaña de Observability/Usage
en el dashboard de Vercel (gráfico de invocaciones/concurrencia) o abrir un
ticket a soporte de Vercel con los `request_id` de los timeouts.

## Fix

- `frontend/admin/js/dashboard-optimizado.js`: se agrega
  `ejecutarConLimite(tareas, limite)`, que corre las 10 cargas iniciales
  con un máximo de **3 en simultáneo** en vez de las 10 juntas (reemplaza
  el `Promise.allSettled` que las disparaba todas de una).
- `frontend/admin/js/dashboard-ejecutivo.js`: las 2 cargas propias
  (`cargarPanelEjecutivo`, `cargarComparativaMensual`) pasan de dispararse
  en paralelo a ejecutarse en secuencia.

Pico de concurrencia contra `/api/admin/*` en la carga inicial: de ~12
simultáneas a ~4. La UX cambia un poco — los widgets van a ir apareciendo
de a poco en vez de todos juntos — pero es la diferencia entre eso y que no
cargue nada.

## Verificación

- `node --check` OK en ambos archivos.
- No se tocó ningún endpoint de backend en este fix — es puramente cuántas
  requests dispara el frontend y en qué orden.

## Pendiente después de deployar esto

Recargar el dashboard varias veces seguidas (5-6 veces, simulando el uso
real) y confirmar que no vuelve a aparecer el 504. Si con esto se resuelve,
confirma la hipótesis de concurrencia. Si persiste incluso con solo 3-4
requests simultáneas, hay que descartar la hipótesis de concurrencia y
mirar directamente con soporte de Vercel qué está pasando con esas
invocaciones que nunca arrancan.
