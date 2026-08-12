// lib/repos/busqueda.js
// Acceso a datos de la búsqueda global del header admin (REQ-09). Migrado
// desde lib/handlers/busqueda.js — mismo criterio que los demás repos: acá
// solo queda I/O contra Supabase. El escapado del filtro .or() y el resto
// del armado de query (like, empresa_id) se resuelven en el handler antes
// de llamar a estas funciones — acá solo se ejecuta la consulta.
//
// La búsqueda de productos ya vivía en repos/productos.js (buscarProductos)
// desde Fase 7, no se duplica acá.

import { db } from './_db.js';

export async function buscarClientes(empresa_id, like) {
  const { data, error } = await db
    .from('clientes')
    .select('id, razon_social, nombre_fantasia, cuit')
    .eq('empresa_id', empresa_id)
    .or(`razon_social.ilike.${like},nombre_fantasia.ilike.${like},cuit.ilike.${like}`)
    .limit(5);
  if (error) throw new Error(`[BusquedaRepo.buscarClientes] ${error.message}`);
  return data || [];
}

export async function buscarPedidosPorIdParcial(empresa_id, q) {
  const { data, error } = await db
    .from('pedidos')
    .select('id, estado, total, created_at, clientes(razon_social, nombre_fantasia)')
    .eq('empresa_id', empresa_id)
    .ilike('id', `%${q}%`)
    .limit(3);
  if (error) throw new Error(`[BusquedaRepo.buscarPedidos] ${error.message}`);
  return data || [];
}

export async function buscarPresupuestos(empresa_id, like) {
  const { data, error } = await db
    .from('presupuestos')
    .select('id, numero, estado, total, clientes(razon_social, nombre_fantasia)')
    .eq('empresa_id', empresa_id)
    .ilike('numero', like)
    .limit(3);
  if (error) throw new Error(`[BusquedaRepo.buscarPresupuestos] ${error.message}`);
  return data || [];
}

export async function buscarFacturas(empresa_id, like) {
  const { data, error } = await db
    .from('facturas')
    .select('id, tipo, numero, total, estado, clientes(razon_social, nombre_fantasia)')
    .eq('empresa_id', empresa_id)
    .or(`numero.ilike.${like},clientes.razon_social.ilike.${like}`)
    .limit(3);
  if (error) throw new Error(`[BusquedaRepo.buscarFacturas] ${error.message}`);
  return data || [];
}

export async function buscarCheques(empresa_id, like) {
  const { data, error } = await db
    .from('cheques')
    .select('id, numero, monto, estado, vencimiento, clientes(razon_social, nombre_fantasia)')
    .eq('empresa_id', empresa_id)
    .or(`numero.ilike.${like},clientes.razon_social.ilike.${like}`)
    .limit(3);
  if (error) throw new Error(`[BusquedaRepo.buscarCheques] ${error.message}`);
  return data || [];
}
