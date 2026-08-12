-- Migration: 116_fix_ordenes_compra_fk_proveedores
-- Problema: la tabla ordenes_compra tenía FK a empresas pero NO a proveedores.
-- Consecuencia: PostgREST no podía resolver el join implícito
--   .select('id, numero, ..., proveedores(razon_social)')
-- y devolvía HTTP 400, lo que el handler convertía en 500 hacia el cliente.
-- Esto hacía que la sección de Compras no cargara ninguna orden.

ALTER TABLE ordenes_compra
  ADD CONSTRAINT ordenes_compra_proveedor_id_fkey
  FOREIGN KEY (proveedor_id)
  REFERENCES proveedores(id)
  ON DELETE RESTRICT;
