# OptiCore listo para GitHub Pages

Sube el contenido de esta carpeta a tu repositorio.

La raíz del repo debe verse así:

```text
index.html
app.js
styles.css
firebase-config.js
.nojekyll
firebase/
```

En GitHub Pages usa:

```text
Source: Deploy from a branch
Branch: main
Folder: /root
```

Firebase se usa solo para:

- Authentication
- Cloud Firestore

No uses Realtime Database para esta app.

Las reglas de Firestore están en:

```text
firebase/firestore.rules
```

## Cambiar correo de un usuario

El correo de acceso vive en Firebase Authentication. En esta versión sin backend no se cambia desde editar usuario.

Para corregir un correo:

1. Crea un usuario nuevo desde Admin con el correo correcto.
2. Cambia el usuario anterior a `Inactivo`.
3. El usuario nuevo inicia sesión con su nueva contraseña temporal.

## Eliminar usuarios

Desde Admin puedes eliminar el acceso interno de un usuario. Eso borra su documento de `users` en Firestore y ya no podrá entrar al sistema.

Si también quieres borrar su cuenta de Firebase Authentication, hazlo manualmente en Firebase Console > Authentication > Users.

## Respaldos y exportaciones

Desde Admin puedes descargar:

- Respaldo completo en JSON.
- Pacientes en CSV.
- Ventas en CSV.

Los CSV se pueden abrir en Excel o Google Sheets.

## Mejoras operativas incluidas

- App instalable en celular como PWA desde GitHub Pages.
- Optimizacion movil global para Inicio, Agenda, Expedientes, Consulta, Laboratorio, Inventario, Compras, Caja POS, Reportes y Admin.
- Tablas de Admin convertidas en tarjetas en celular, modales tipo panel inferior y acciones reorganizadas para pantallas pequenas.
- Agenda con aviso rapido por WhatsApp cuando el paciente tiene telefono.
- Tarjetas de pacientes con acciones directas para ver, citar, consultar y editar.
- Expediente con edad, proxima cita y ultima compra.
- Recordatorio anual automatico para revision y renovacion de lentes al guardar consulta.
- El recordatorio anual incluye recomendacion segun datos de salud como diabetes, hipertension, cirugia o enfermedad ocular.
- Exportacion CSV de ordenes de laboratorio.
- Validacion para evitar consultas vacias sin receta, diagnostico ni nota clinica.
- Inicio con accesos rapidos para cita, paciente, consulta, recordatorio, notificaciones y caja si eres admin.
- Panel de prioridad con citas de hoy, seguimientos vencidos, laboratorio por entregar y stock bajo.
- Expediente con botones de llamada, WhatsApp, correo, metricas y linea de tiempo del paciente.
- Agenda con botones para dia anterior, hoy y dia siguiente.
- Aviso de posible choque de citas antes de guardar.
- Aviso de posible expediente duplicado por telefono, correo o nombre.
- Permisos internos aplicados tambien en navegacion, accesos rapidos y modales.
- Guardas de seguridad tambien en acciones, cambios de estatus y formularios.
- Panel de salud de datos en Admin para revisar duplicados, telefonos incompletos, entregas vencidas y saldos.
- Validaciones extra para usuarios, citas, recordatorios y ordenes de laboratorio.
- Manejo de conexion online/offline y errores globales visibles.
- En Caja POS puedes sumar/restar cantidades y quitar productos del carrito.
- Caja POS valida productos activos y stock antes de cobrar.
- Reportes muestra ventas recientes y permite imprimir recibos.
- Laboratorio maneja total, anticipo, saldo pendiente, armazon/modelo y laboratorio externo.
- Laboratorio permite liquidar una orden con un toque.
- En Inventario puedes ajustar stock con botones de + y -.
- En Inicio puedes marcar seguimientos como hechos o eliminarlos.
- Las citas se pueden editar o eliminar desde Agenda.
- Desde Consulta puedes crear automaticamente una orden de laboratorio.
- En Laboratorio puedes editar, cambiar estatus o eliminar ordenes.
