// lib/whatsapp-pedido-tools.js
//
// Catálogo de herramientas (function calling) del asistente de pedidos por
// WhatsApp — Etapa 6, "WhatsApp Business API bidireccional".
//
// Mismo principio que lib/asistente-tools.js (el modelo NUNCA arma SQL, solo
// elige un nombre de una lista fija + parámetros primitivos; cada tool llama
// una RPC o query ya escrita a mano, scopeada por empresa/cliente resueltos
// ANTES de llamar al modelo, nunca por algo que el modelo decida). Se separa
// en su propio archivo (en vez de agregar entradas a TOOLS en
// asistente-tools.js) porque el contexto de ejecución es distinto: acá no
// hay un usuario logueado con rol — hay un cliente identificado por teléfono,
// y las acciones disponibles son mucho más acotadas (buscar catálogo, armar
// un borrador, pedir que un humano tome la conversación). El modelo JAMÁS
// puede crear el pedido en firme por acá — ver crearPedidoDesdeBorrador() en
// lib/handlers/notif.js, que solo se dispara con un "sí" explícito y
// determinístico del cliente, no por una tool que el modelo decida llamar.
//
// Uso desde lib/handlers/notif.js:
//   import { esquemaPedidoWhatsApp, ejecutarToolPedidoWhatsApp } from '../whatsapp-pedido-tools.js';
//   const tools = {
//     esquema: esquemaPedidoWhatsApp(),
//     ejecutar: (nombre, args) => ejecutarToolPedidoWhatsApp(nombre, { empresaId, conversacionId, args }),
//   };

import { db } from './repos/_db.js';
import { enviarPush } from './handlers/_push.js';
import { resolverPreciosClienteRpc } from './repos/whatsapp-bot.js';
import { obtenerProductosParaCotizarPedido } from './repos/productos.js';
import { calcularTotalesPedido } from './calc/pedido-totales.js';

const MAX_RESULTADOS_BUSQUEDA = 6;

async function obtenerBorrador(conversacionId) {
  const { data, error } = await db
    .from('whatsapp_conversaciones')
    .select('pedido_borrador')
    .eq('id', conversacionId)
    .single();
  if (error) throw new Error(`No se pudo leer el borrador: ${error.message}`);
  return data?.pedido_borrador || { items: [] };
}

async function guardarBorrador(conversacionId, borrador) {
  const { error } = await db
    .from('whatsapp_conversaciones')
    .update({ pedido_borrador: borrador, ultima_interaccion: new Date().toISOString() })
    .eq('id', conversacionId);
  if (error) throw new Error(`No se pudo guardar el borrador: ${error.message}`);
}

const TOOLS = [
  {
    name: 'buscar_productos',
    description:
      'Busca productos del catálogo de la empresa por nombre o parte del nombre, para poder ofrecerle al cliente las opciones disponibles y sus precios antes de agregarlas al pedido. Usar siempre antes de agregar_item, salvo que el cliente ya haya confirmado exactamente cuál producto quiere de una búsqueda anterior en esta misma conversación.',
    parameters: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Nombre o parte del nombre del producto, tal como lo escribió el cliente (ej: "coca 2L", "harina").' },
      },
      required: ['texto'],
    },
    async execute({ empresaId, clienteId, args }) {
      const { data, error } = await db
        .from('productos')
        .select('id, nombre, unidad, precio_base, stock:stock(cantidad, cantidad_reservada)')
        .eq('empresa_id', empresaId)
        .eq('activo', true)
        .ilike('nombre', `%${args.texto}%`)
        .limit(MAX_RESULTADOS_BUSQUEDA);
      if (error) throw new Error(`buscar_productos: ${error.message}`);

      // FIX: antes se devolvía siempre precio_base (lista general), que
      // puede no coincidir con lo que después cobra crearPedidoDesdeItemsWhatsapp
      // (que sí resuelve precio real por cliente vía resolver_precios_cliente —
      // listas especiales, reglas de precio, etc). Se resuelve acá el mismo
      // precio real ANTES de mostrárselo al cliente por chat, para que la
      // cotización que ve sea la misma que termina facturando. Si la RPC
      // falla o no devuelve precio para algún producto, se cae a precio_base
      // (mismo comportamiento que antes) en vez de bloquear la búsqueda.
      const productoIds = (data || []).map((p) => p.id);
      let precioMap = {};
      if (productoIds.length && clienteId) {
        const { data: preciosResueltos } = await resolverPreciosClienteRpc({
          cliente_id: clienteId, producto_ids: productoIds, empresa_id: empresaId,
        });
        precioMap = Object.fromEntries((preciosResueltos || []).map((p) => [p.producto_id, p.precio]));
      }

      return (data || []).map((p) => {
        const disponible = (p.stock || []).reduce(
          (acc, s) => acc + Math.max(0, (s.cantidad || 0) - (s.cantidad_reservada || 0)), 0
        );
        const precio = precioMap[p.id] ?? p.precio_base;
        return { producto_id: p.id, nombre: p.nombre, unidad: p.unidad, precio, disponible };
      });
    },
  },
  {
    name: 'agregar_item',
    description:
      'Agrega un producto (con cantidad) al borrador de pedido en curso, o suma cantidad si ya estaba agregado. Requiere haber encontrado el producto_id con buscar_productos primero — nunca inventar un producto_id.',
    parameters: {
      type: 'object',
      properties: {
        producto_id: { type: 'string', description: 'ID exacto devuelto por buscar_productos.' },
        nombre:      { type: 'string', description: 'Nombre del producto, para mostrarlo en el resumen sin tener que volver a buscarlo.' },
        cantidad:    { type: 'number', description: 'Cantidad pedida por el cliente.' },
        precio:      { type: 'number', description: 'Precio unitario devuelto por buscar_productos.' },
      },
      required: ['producto_id', 'nombre', 'cantidad', 'precio'],
    },
    async execute({ conversacionId, args }) {
      const borrador = await obtenerBorrador(conversacionId);
      const items = borrador.items || [];
      const existente = items.find((i) => i.producto_id === args.producto_id);
      if (existente) {
        existente.cantidad += Number(args.cantidad) || 0;
      } else {
        items.push({
          producto_id: args.producto_id,
          nombre: args.nombre,
          cantidad: Number(args.cantidad) || 0,
          precio: Number(args.precio) || 0,
        });
      }
      const nuevoBorrador = { ...borrador, items };
      await guardarBorrador(conversacionId, nuevoBorrador);
      return nuevoBorrador;
    },
  },
  {
    name: 'quitar_item',
    description: 'Quita un producto del borrador de pedido en curso (el cliente se arrepintió o pidió corregir).',
    parameters: {
      type: 'object',
      properties: {
        producto_id: { type: 'string', description: 'ID del producto a quitar, tal como aparece en el borrador actual.' },
      },
      required: ['producto_id'],
    },
    async execute({ conversacionId, args }) {
      const borrador = await obtenerBorrador(conversacionId);
      const items = (borrador.items || []).filter((i) => i.producto_id !== args.producto_id);
      const nuevoBorrador = { ...borrador, items };
      await guardarBorrador(conversacionId, nuevoBorrador);
      return nuevoBorrador;
    },
  },
  {
    name: 'proponer_confirmacion',
    description:
      'Cuando el cliente ya terminó de pedir todo lo que quería (dijo "eso es todo", "nada más", o similar), usar esta tool UNA sola vez para cerrar el armado y pasar el borrador a estado de confirmación. NO crea el pedido — solo lo deja listo para que el cliente confirme con un mensaje de "sí". No usar si el borrador está vacío.',
    parameters: { type: 'object', properties: {} },
    async execute({ empresaId, conversacionId }) {
      const borrador = await obtenerBorrador(conversacionId);
      if (!borrador.items?.length) {
        throw new Error('No se puede proponer confirmación con el borrador vacío');
      }

      // Mismo motivo que en buscar_productos: el modelo NUNCA debe sumar el
      // total a mano (puede errar la cuenta o el IVA) — acá se calcula server-
      // side con la misma función pura (calcularTotalesPedido) que usa
      // crearPedidoDesdeItemsWhatsapp al confirmar en firme, así el "total
      // aproximado" que el bot le muestra al cliente antes de pedir el "SÍ"
      // es, en los hechos, el total exacto que se va a facturar.
      const productoIds = borrador.items.map((i) => i.producto_id);
      const prodsData = await obtenerProductosParaCotizarPedido(empresaId, productoIds);
      const ivaMap = Object.fromEntries((prodsData || []).map((p) => [p.id, p.iva ?? 21]));

      const { subtotal, iva_total, total } = calcularTotalesPedido(borrador.items, {
        resolverPrecio: (item) => item.precio ?? 0,
        ivaMap,
      });

      const { error } = await db
        .from('whatsapp_conversaciones')
        .update({ estado: 'esperando_confirmacion', ultima_interaccion: new Date().toISOString() })
        .eq('id', conversacionId);
      if (error) throw new Error(`proponer_confirmacion: ${error.message}`);

      return {
        ...borrador,
        subtotal: Math.round(subtotal * 100) / 100,
        iva_total: Math.round(iva_total * 100) / 100,
        total,
      };
    },
  },
  {
    name: 'derivar_humano',
    description:
      'Deriva la conversación a un vendedor humano y deja de responder automáticamente. Usar cuando el cliente pide hablar con una persona, cuando el pedido es demasiado ambiguo para resolverlo por chat (ej: precios especiales, reclamos, algo fuera de un pedido simple), o después de 2-3 idas y vueltas sin lograr identificar qué quiere.',
    parameters: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Motivo breve de la derivación, para que el vendedor sepa por qué retomó la charla.' },
      },
      required: ['motivo'],
    },
    async execute({ conversacionId, args }) {
      const { error } = await db
        .from('whatsapp_conversaciones')
        .update({ estado: 'derivada_humano', motivo_derivacion: args.motivo, ultima_interaccion: new Date().toISOString() })
        .eq('id', conversacionId);
      if (error) throw new Error(`derivar_humano: ${error.message}`);

      // BUGFIX (Etapa 6, plan de pruebas — caso "Derivación manual pedida
      // por el cliente"): esta tool dejaba la conversación en
      // 'derivada_humano' pero nunca avisaba a nadie — a diferencia de
      // marcarDerivada() en lib/handlers/notif.js (usada para mensajes no
      // soportados y el corte por exceso de turnos), que sí manda push.
      // Un vendedor nunca se enteraba de que el propio cliente había
      // pedido hablar con una persona hasta que entraba a mirar el panel
      // de conversaciones a mano. Mismo criterio/mensaje que
      // marcarDerivada(): push a dueño/admin/vendedor de la empresa.
      try {
        const { data: conv } = await db
          .from('whatsapp_conversaciones')
          .select('empresa_id, telefono')
          .eq('id', conversacionId)
          .single();
        if (conv) {
          const { data: admins } = await db
            .from('usuarios').select('id').eq('empresa_id', conv.empresa_id).in('rol', ['dueno', 'admin', 'vendedor']);
          for (const admin of (admins || [])) {
            enviarPush(admin.id, 'WhatsApp derivado', `${args.motivo} (${conv.telefono})`, { tipo: 'whatsapp_derivado', link: '/admin/whatsapp-conversaciones' }).catch(() => {});
          }
        }
      } catch (e) {
        // El aviso es best-effort — un fallo acá no debe romper la
        // derivación en sí (ya quedó guardada arriba).
        console.error('[whatsapp-pedido-tools] derivar_humano: error avisando por push:', e.message);
      }

      return { ok: true };
    },
  },
];

// FIX (bug de wiring detectado 2026-08-03): notif.js llamaba a
// responderConFallback con `tools.esquema` (una lista plana única), pero el
// orquestador (lib/asistente-providers.js) busca `tools.esquemaGemini` /
// `tools.esquemaOpenAI` — dos formatos distintos, porque Gemini declara
// funciones como lista plana y Groq/OpenRouter (API "Chat Completions",
// formato OpenAI) las espera envueltas en { type:'function', function:{...} }.
// Con la clave equivocada, NINGÚN proveedor recibía nunca las tools (el
// chequeo `tools?.esquemaGemini?.length` daba undefined siempre), así que el
// bot respondía sin poder consultar catálogo/precios ni tocar el borrador —
// alucinaba un flujo de compra genérico en su lugar. Mismo patrón que ya usa
// lib/asistente-tools.js (esquemaParaGemini/esquemaParaOpenAI) para el
// asistente del admin.
function esquemaPedidoWhatsAppGemini() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

function esquemaPedidoWhatsAppOpenAI() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

async function ejecutarToolPedidoWhatsApp(nombre, { empresaId, clienteId, conversacionId, args }) {
  const tool = TOOLS.find((t) => t.name === nombre);
  if (!tool) throw new Error(`Tool desconocida: ${nombre}`);
  if (!empresaId || !conversacionId) throw new Error('Falta empresaId o conversacionId para ejecutar la tool');
  return tool.execute({ empresaId, clienteId, conversacionId, args: args || {} });
}

export {
  TOOLS,
  esquemaPedidoWhatsAppGemini,
  esquemaPedidoWhatsAppOpenAI,
  ejecutarToolPedidoWhatsApp,
};
