ALTER TABLE facturas
ADD COLUMN vencimiento DATE,
ADD COLUMN total_cobrado NUMERIC(12,2) DEFAULT 0;

ALTER TYPE estado_factura ADD VALUE 'parcial';
