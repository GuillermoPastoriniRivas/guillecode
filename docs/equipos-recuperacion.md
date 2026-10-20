# Recuperación de equipos

Las consultas de estado, mensajes, permisos y catálogo del motor toleran tres fallos transitorios con esperas de 300, 900 y 1800 ms. Una caída persistente sigue requiriendo atención. Los errores de cuenta, saldo, autorización y solicitudes inválidas no generan reintentos de lectura.

Si se pierde la confirmación de un envío, el runner observa la misma sesión y espera una respuesta nueva. No vuelve a enviar el pedido aceptado. Las continuaciones distinguen las respuestas de su turno de las respuestas anteriores. Las llamadas de herramientas son pasos intermedios y no una respuesta final.

Un error de IA marcado como transitorio permite hasta dos reintentos si el motor está inactivo, la respuesta terminó y no hubo ninguna herramienta en ese turno. Esto incluye herramientas pendientes o fallidas: cualquiera de ellas impide repetir el pedido automáticamente. Los límites de cuenta, pago, autenticación, contexto y búfer no se recuperan repitiendo la misma solicitud. Las acciones inciertas siguen requiriendo inspección y continuación explícita.

Una tarea bloqueada conserva sus dependencias. El resto del trabajo independiente puede avanzar, respetando las carpetas, archivos y capacidad de cada integrante. Una sesión cuya detención no se confirmó conserva sus reservas. Al detener un intento fallido se guarda la telemetría que pueda leerse para informar la continuación.

La interfaz ofrece «Continuar lo pendiente», explica los problemas de cuenta y permite preguntar al Lead qué falló. Las consultas de estado pueden leer la sesión local guardada para explicar errores que versiones anteriores mostraron como genéricos, sin solicitar inferencia nueva. En particular, el rechazo de un modelo gratuito de Zen que solo admite OpenCode se explica como una restricción del proveedor, sin sugerir que repetir el envío la resuelve.

En Configuración se puede cambiar el modelo para los siguientes mensajes del chat, incluso si falló el primer pedido y todavía no hay una ejecución. Se bloquea el cambio mientras el Lead responde. Las ejecuciones y los intentos anteriores conservan su configuración. Los cambios de modelo de una ejecución bloqueada siguen usando el control específico de esa ejecución.

## Validación

- Pruebas unitarias de recuperación de lecturas, turnos nuevos, elegibilidad y límite de reintentos, reservas y conservación de modelos históricos.
- `node tests/teams-engine.mjs --auto --no-git --transport-faults`: Tauri y OpenCode reales con inferencia local determinista. El proxy devuelve tres errores 503 de estado y pierde una confirmación de conversación, planificación y trabajador después de que el motor acepte los pedidos. Comprueba que no se duplica ningún envío aceptado. Un segundo escenario, con una sola plaza, verifica que una tarea independiente acaba pese a otra bloqueada y que no se repite la tarea ya completada.
- Playwright comprueba controles legibles, explicación de límites de cuenta y cambio de modelo sin recrear el chat.
- La prueba de reinicio conserva la obligación de reconciliar las sesiones registradas antes de continuar operaciones con efectos.

Las pruebas de inferencia usan un servidor local determinista; no acreditan disponibilidad ni acceso de cuentas de proveedores externos.
