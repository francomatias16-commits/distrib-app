---
slug: usuarios-y-roles
categoria: administracion
roles: [dueno, admin]
---

# Usuarios y roles del sistema

## Roles disponibles

- **Dueño**: acceso total, incluida la configuración de facturación y del plan SaaS.
- **Admin**: gestión operativa completa (clientes, pedidos, stock, facturación, usuarios).
- **Vendedor**: carga y gestión de pedidos, presupuestos y clientes.
- **Depositero**: gestión de stock, recepción de mercadería, movimientos de depósito.
- **Chofer**: acceso a rutas asignadas y confirmación de entregas.
- **Contador**: acceso a facturación, cobros y reportes financieros.
- **Cliente**: acceso limitado a su propio historial, pedidos y estado de cuenta.

## Permisos especiales

Cada empresa puede tener un **PIN de supervisor**, usado para autorizar operaciones sensibles (por ejemplo, un descuento que supera cierto umbral) sin necesidad de que un supervisor inicie sesión completa — alcanza con que ingrese su PIN al momento de la operación.

También se puede configurar, por usuario, un **umbral de descuento** a partir del cual una venta necesita esa autorización de supervisor.

## Cómo dar de alta un usuario nuevo

Desde **Configuración → Usuarios** (solo visible para dueño y admin), con el botón "Nuevo usuario". Hace falta nombre, email y una contraseña inicial de al menos 8 caracteres — esa contraseña hay que pasársela a la persona por fuera del sistema, todavía no se envía por email automáticamente. Solo el dueño puede crear otro usuario con rol admin; un admin puede crear vendedor, depositero, chofer y contador. El alta de usuarios cuenta contra el límite de usuarios del plan contratado (no cuentan los clientes con acceso al portal, que se gestionan aparte desde Clientes).

## Preguntas frecuentes

**¿Un usuario puede tener más de un rol?**
No, cada usuario tiene un único rol asignado, que determina qué partes del sistema puede ver y operar.

**¿Cómo doy de baja a un usuario que ya no trabaja en la empresa?**
Desde Configuración → Usuarios, con el botón "Desactivar" en su fila. Se lo marca como inactivo — no se borra, para conservar el historial de las operaciones que hizo. No se puede desactivar al propio usuario logueado ni dejar a la empresa sin ningún dueño activo.

**¿El rol "cliente" es el mismo que un cliente normal de la base de clientes?**
Sí, está vinculado: un usuario con rol cliente tiene asociado su registro en la tabla de clientes, para que solo pueda ver su propia información.
