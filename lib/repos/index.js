// lib/repos/index.js
// Barrel de la capa de repos — importá desde acá para no depender de rutas internas.
//
// USO RECOMENDADO en handlers:
//   import { ClienteRepo, ScoreRepo } from '../repos/index.js';
//   const cliente = await ClienteRepo.obtenerCliente(empresa_id, cliente_id);
//
// O destructuring directo si solo necesitás una función:
//   import { obtenerCliente } from '../repos/clientes.js';
//
// NOTA (auditoría v195): este barrel solo expone los repos realmente usados
// en producción (clientes, empresas, notif, scores). pedidos/facturas/
// productos/proveedores/usuarios se eliminaron: nunca se llamaban y tenían
// nombres de columna desalineados con el schema real — código muerto y con
// bugs latentes, no una capa lista para usar.
//
// WhatsappBotRepo (fase 7, paso 7, lote 4): bot conversacional de WhatsApp
// — repo separado de NotifRepo a propósito, ver cabecera de
// lib/repos/whatsapp-bot.js.

export * as ClienteRepo     from './clientes.js';
export * as NotifRepo       from './notif.js';
export * as EmpresaRepo     from './empresas.js';
export * as ScoreRepo       from './scores.js';
export * as WhatsappBotRepo from './whatsapp-bot.js';
export * as MigracionRepo   from './migracion.js';
export * as ProveedoresRepo from './proveedores.js';
export * as PortalProveedorRepo from './portal-proveedor.js';
export * as CCProveedoresRepo from './cc-proveedores.js';
export * as AutomatizacionRepo from './automatizacion.js';
export * as AuditRepo         from './audit.js';
export * as StockAutoRepo from './stock-auto.js';

// Re-exportar el cliente singleton por si algún módulo avanzado lo necesita
export { db } from './_db.js';
