// lib/eventos-listeners/cliente_en_riesgo_fuga.js
// Fase 2 de PLAN_CLIENTES_EN_FUGA.md: listener del evento
// `cliente_en_riesgo_fuga`, emitido desde handleFugaCron
// (lib/handlers/notif.js), que a su vez usa fn_clientes_en_fuga (Fase 1,
// migraciones 590/591/592) para detectar el patrón roto.
//
// Acá vive la recuperación "graduada por tamaño de cliente" que pedía el
// plan — tres caminos según el payload (motivo_probable + valor_anual_estimado):
//
//   1. motivo_probable = 'posible_freno_por_deuda'
//      → el cliente no se está yendo a la competencia, está frenado por
//        plata. Fase 4 del plan: nunca una oferta acá — tarea para el
//        vendedor (o dueño/admin si no tiene) que dice "cobrar", no
//        "ofrecer descuento".
//   2. motivo_probable = 'posible_fuga_a_competencia' y
//      valor_anual_estimado >= umbral de "cliente grande"
//      → tarea para el vendedor: "merece una llamada, no un WhatsApp
//        automático" (2.2 del plan).
//   3. motivo_probable = 'posible_fuga_a_competencia' y cliente chico/mediano
//      → WhatsApp automático con los puntos de fidelización como gancho
//        (2.1 del plan), vía enviarRecuperacionFuga.
//
// Mismo criterio que cliente_en_mora.js: el payload del evento es liviano
// (ids + valores ya calculados por fn_clientes_en_fuga), pero los datos de
// contacto (teléfono) se resuelven de nuevo contra `clientes` acá, no se
// confía en lo que viajó en el payload.

import { enviarRecuperacionFuga } from '../handlers/notif.js';
import {
  resolverClienteParaFuga,
  resolverUmbralClienteGrande,
  crearTareaFuga,
} from '../repos/clientes-fuga.js';

function formatoMonto(n) {
  return Math.round(n || 0).toLocaleString('es-AR');
}

async function resolverCliente(clienteId) {
  const { data, error } = await resolverClienteParaFuga(clienteId);
  if (error || !data) {
    throw new Error(`No se pudo resolver el cliente ${clienteId} para el evento cliente_en_riesgo_fuga: ${error?.message || 'no encontrado'}`);
  }
  return data;
}

async function listenerRecuperacionFuga(payload, evento) {
  const cliente = await resolverCliente(payload.cliente_id);
  // evento.empresa_id es la fuente de verdad (fila real de eventos_negocio),
  // no cliente.empresa_id — mismo criterio que cliente_en_mora.js.
  const empresaId = evento.empresa_id;
  const vendedorId = payload.vendedor_id_default || cliente.vendedor_id_default || null;
  const diasAtraso = payload.dias_atraso;
  const valorAnual = payload.valor_anual_estimado || 0;
  const producto = payload.producto_principal || 'su producto habitual';

  // ── Camino 1: freno por deuda, no por competencia (Fase 4) ───────────
  // Nunca se automatiza una oferta acá, sea cual sea el tamaño del
  // cliente — la jugada correcta es cobrar, no regalar margen.
  if (payload.motivo_probable === 'posible_freno_por_deuda') {
    await crearTareaFuga({
      empresa_id: empresaId,
      usuario_id: vendedorId,
      cliente_id: cliente.id,
      titulo: `Cobrar a ${cliente.razon_social} — dejó de pedir por una deuda pendiente`,
      descripcion: `Hace ${diasAtraso} días que no pide ${producto}. Antes de ofrecerle algo, hay que resolver el saldo pendiente — no es fuga a la competencia, es un freno por plata.`,
    });
    return;
  }

  // ── Camino 2: cliente grande → tarea para el vendedor, no automático ──
  const umbral = await resolverUmbralClienteGrande(empresaId);
  if (valorAnual >= umbral) {
    await crearTareaFuga({
      empresa_id: empresaId,
      usuario_id: vendedorId,
      cliente_id: cliente.id,
      titulo: `Llamar a ${cliente.razon_social} — hace ${diasAtraso} días sin pedir`,
      descripcion: `Representa ~$${formatoMonto(valorAnual)}/año. Solía pedir ${producto} y rompió su ritmo habitual. Un cliente de este valor merece una llamada, no un WhatsApp automático.`,
    });
    return;
  }

  // ── Camino 3: cliente chico/mediano → WhatsApp automático ────────────
  if (!cliente.telefono) {
    throw new Error(`Cliente ${cliente.id} sin teléfono — no se puede enviar la recuperación automática (y no califica para tarea de vendedor)`);
  }

  const resultado = await enviarRecuperacionFuga({
    clienteId: cliente.id,
    empresaId,
    telefono: cliente.telefono,
    razonSocial: cliente.razon_social,
    productoPrincipal: producto,
  });

  if (!resultado.ok) {
    throw new Error(resultado.motivo || 'enviarRecuperacionFuga falló sin motivo');
  }
}
listenerRecuperacionFuga.listenerNombre = 'recuperacionClienteEnFuga';

export const listenersClienteEnRiesgoFuga = [listenerRecuperacionFuga];
