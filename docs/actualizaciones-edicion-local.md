# Actualizaciones desde el repositorio original

El botón **Actualizaciones** consulta exclusivamente `https://github.com/GuillermoPastoriniRivas/guillecode/releases/latest/download/latest.json` y verifica la firma con la clave pública oficial. No hay un endpoint alternativo. La app rechaza manifiestos firmados con otra clave y las validaciones de release rechazan otro repositorio, claves distintas o endpoints adicionales.

Los workflows de release solo corren en `GuillermoPastoriniRivas/guillecode`. Los cambios de esta edición se integran allí mediante PR y las versiones se preparan y firman con los secretos de ese repositorio. Nunca se publican actualizaciones en `Kaitach/guillecode`.

Una actualización reemplaza ejecutables y recursos, no fusiona código. El identificador de la app se mantiene para conservar el perfil, equipos, conversaciones, cuentas y adjuntos. Las instalaciones viejas que todavía consultan el fork deben instalar manualmente esta compilación puente; sus binarios no cambian de canal por sí solos. Las releases anteriores de Kaitach son históricas y esta app ya no las consulta.

Antes de instalar, la app respalda sus bases de datos y archivos de perfil localmente. Después del reinicio hay que comprobar el motor, los perfiles, los chats y los adjuntos. El updater bloquea la instalación mientras haya una ejecución de equipo pendiente.

Las skills son plantillas de instrucciones; no otorgan permisos ni sustituyen el respaldo. Una plantilla nueva o modificada se aplica a chats nuevos.

La compilación puente 0.14.7 instalada en esta PC consulta el servidor original. Al verificarla, su última release era 0.14.5; por tanto, no había una versión superior que descargar todavía.

El historial y las pruebas del Modo Equipos IA están en [validación de Equipos IA](equipos-ia-validacion.md).

La 0.14.2 simplifica Equipos IA como conversación, agrega el equipo predeterminado Lead/QA/Backend/Frontend y recupera automáticamente planes vacíos o inválidos. La validación actual se registra en [validacion-0.14.2.md](validacion-0.14.2.md). Las pruebas controladas no sustituyen el QA manual del usuario.

La 0.14.3 permite trabajos simultáneos dentro de la misma carpeta con archivos asignados, pedidos entre agentes revisados por el Lead y continuación durable de la misma sesión. Ver [validacion-0.14.3.md](validacion-0.14.3.md).

La 0.14.4 explica en lenguaje claro los errores guardados como JSON, las cuotas y modelos del proveedor, las carpetas sin Git y las comprobaciones que no se pudieron confirmar. Los mensajes indican la causa conocida y el paso para continuar. Ver [validacion-0.14.4.md](validacion-0.14.4.md).
