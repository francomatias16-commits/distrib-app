// tests/handlers/pagos-procesar-evento-mp.test.js
//
// procesarEventoMP(body) es la lógica de negocio extraída de manejarWebhook
// (ver CHANGELOG_motor_webhooks_integraciones.md, "reproceso automático de
// Mercado Pago completado") — separada a propósito para que
// handleWebhooksReprocesarCron (lib/handlers/notif.js) pueda reprocesar
// eventos guardados sin depender de req/res ni de una firma HMAC nueva.
//
// Este archivo NO reprueba toda la lógica de negocio de pagos (eso ya
// estaba cubierto indirectamente antes de la extracción); cubre el
// contrato puntual que sí es nuevo: que la función toma `body` (no `req`)
// y devuelve `{ status, body }` (no llama a `res` directamente) — la
// verificación mecánica de que la extracción no cambió el comportamiento
// de las ramas sin credenciales/datos, que no requieren red ni DB real.

import { describe, it, expect } from 'vitest';
import { procesarEventoMP } from '../../lib/handlers/pagos.js';

describe('procesarEventoMP — contrato de retorno (sin req/res)', () => {
  it('topic "order" sin order_id: devuelve {status, body} sin tocar ningún repo', async () => {
    const resultado = await procesarEventoMP({ type: 'order', data: {}, action: 'created' });
    expect(resultado).toEqual({ status: 200, body: { received: true, order_id: null } });
  });

  it('topic "order" sin user_id: responde 200 con el order_id, sin poder resolver la empresa', async () => {
    const resultado = await procesarEventoMP({ type: 'order', data: { id: 'ORD-1' } });
    expect(resultado).toEqual({ status: 200, body: { received: true, order_id: 'ORD-1' } });
  });

  it('topic "payment" sin user_id en la notificación: no puede resolver la empresa', async () => {
    const resultado = await procesarEventoMP({ type: 'payment', data: { id: 555 } });
    expect(resultado).toEqual({
      status: 200,
      body: { received: true, error: 'user_id ausente en la notificación' },
    });
  });

  it('un topic desconocido no lanza y responde recibido (no rompe el reproceso del cron)', async () => {
    const resultado = await procesarEventoMP({ type: 'merchant_order', data: { id: 'algo' } });
    expect(resultado).toEqual({ status: 200, body: { received: true } });
  });
});
