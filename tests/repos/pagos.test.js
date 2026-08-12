// tests/repos/pagos.test.js
//
// Hueco identificado en PLAN_OFFLINE_ETAPA6_TESTING_PILOTO_ROLLOUT.md,
// sección 0: `esPedidoPilotoWhatsApp` (lib/repos/pagos.js) no tenía
// ningún test pese a ser el único guard que evita que el link de pago
// público (checkout.html sin login) se pueda usar con cualquier UUID de
// pedido adivinado — no es un detalle de UX, es el control de seguridad
// completo de ese endpoint (ver nota grande en
// crearPreferenciaPublicaHandler, lib/handlers/pagos.js).

import { describe, it, expect } from 'vitest';
import { esPedidoPilotoWhatsApp } from '../../lib/repos/pagos.js';

describe('esPedidoPilotoWhatsApp', () => {
  it('autoriza un pedido generado por el piloto automático de WhatsApp', () => {
    expect(esPedidoPilotoWhatsApp({ generado_automatico: true })).toBe(true);
  });

  it('NO autoriza un pedido cargado a mano (generado_automatico ausente)', () => {
    expect(esPedidoPilotoWhatsApp({})).toBe(false);
  });

  it('NO autoriza un pedido con generado_automatico: false explícito', () => {
    expect(esPedidoPilotoWhatsApp({ generado_automatico: false })).toBe(false);
  });

  it('NO autoriza si generado_automatico es un truthy que no es exactamente true (ej. string "true")', () => {
    // Regresión concreta: la comparación es `=== true`, no un chequeo
    // truthy genérico — si en algún momento se relaja a `if (pedido.generado_automatico)`
    // un valor tipo "true" (string, ej. viniendo de un query param mal
    // tipado en algún otro camino) pasaría a autorizar por error.
    expect(esPedidoPilotoWhatsApp({ generado_automatico: 'true' })).toBe(false);
  });

  it('NO usa `canal` como señal (se probó y se descartó — tiene DEFAULT "web")', () => {
    // Ver comentario en lib/repos/pedidos.js#obtenerPedidoParaPagoPublico:
    // canal nunca discrimina nada antes de la confirmación del pedido.
    expect(esPedidoPilotoWhatsApp({ canal: 'whatsapp', generado_automatico: undefined })).toBe(false);
  });

  it('NO usa `origen` como señal (la columna no existe en la DB — bug de v655 corregido en v657)', () => {
    expect(esPedidoPilotoWhatsApp({ origen: 'piloto_automatico' })).toBe(false);
  });
});
