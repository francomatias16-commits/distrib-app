-- 086_bucket_comprobantes.sql
-- Bucket de Storage para los PDFs de comprobantes ARCA (lib/arca/comprobante-pdf.js).
-- Lectura pública (el cliente descarga el PDF por URL directa), escritura solo service_role.

insert into storage.buckets (id, name, public)
values ('comprobantes', 'comprobantes', true)
on conflict (id) do nothing;

drop policy if exists "Lectura pública comprobantes" on storage.objects;
create policy "Lectura pública comprobantes"
on storage.objects for select
using (bucket_id = 'comprobantes');

drop policy if exists "Upload service_role comprobantes" on storage.objects;
create policy "Upload service_role comprobantes"
on storage.objects for insert
with check (bucket_id = 'comprobantes' and auth.role() = 'service_role');

drop policy if exists "Update service_role comprobantes" on storage.objects;
create policy "Update service_role comprobantes"
on storage.objects for update
using (bucket_id = 'comprobantes' and auth.role() = 'service_role');
