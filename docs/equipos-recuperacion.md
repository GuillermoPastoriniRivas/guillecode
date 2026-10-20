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

## Avisos de bloqueo en el encabezado

La lista «Equipo elegido por el Lead» muestra el estado individual de cada integrante, si necesita ayuda y la causa o tarea actual. Antes del primer objetivo, el Lead aparece «Listo · Sin pedidos de ayuda · Esperando tu objetivo». Los permisos y preguntas se atribuyen por identificador de agente, incluso si varios integrantes tienen el mismo nombre. Esperar una dependencia no solicita ayuda humana; una revisión fallida corresponde al Lead.

Si dos o más tareas esperan unas a otras, el Lead se activa aunque ninguna dependencia haya terminado. La lista muestra «Destrabando equipo» mientras revisa el ciclo. Puede acordar un contrato y liberar esperas concretas con instrucciones para continuar la preparación, dejando la integración pendiente. Solo puede reanudar tareas suspendidas: conserva la misma sesión, archivos, dependencias del plan y criterios de aceptación; no toca tareas activas ni terminadas. Las decisiones de espera que crean un ciclo vuelven al Lead para hasta dos correcciones automáticas, registradas y limitadas incluso tras reiniciar. Si no logra separarlo, explica el bloqueo sin entrar en un bucle de reintentos.

`node tests/teams-engine.mjs --no-git --circular-wait` usa Tauri y OpenCode reales con inferencia local determinista. Hace que ambos trabajadores esperen mutuamente, rechaza una decisión circular deliberada del Lead y verifica la corrección automática, la continuación de las mismas sesiones sin repetir escrituras y las comprobaciones de ambas entregas. Las pruebas unitarias cubren ciclos persistidos, aislamiento de trabajo independiente, conservación de criterios y rechazo atómico de cambios inválidos.

El chat de equipo muestra arriba los integrantes bloqueados, la tarea, la causa legible y un acceso a su actividad. Esto funciona aunque el estado general siga en ejecución y otros agentes estén trabajando. Los permisos pendientes ofrecen «Ver permiso» y las preguntas «Responder al agente»; ambos abren la sesión correspondiente. Las solicitudes de otros chats se excluyen.

Las esperas explícitas de coordinación se muestran como «En espera», con el responsable de la entrega y el pedido al Lead. Las tareas pendientes normales no se presentan como fallos. Los avisos se recalculan con el estado guardado y las solicitudes del motor, y desaparecen al resolverse. Las cancelaciones y las tareas terminadas no conservan avisos antiguos. Si el Lead falla antes de planificar, el encabezado también muestra que necesita ayuda. La sección «Qué falta» del Lead refleja los bloqueos aunque no exista un error general de ejecución.

Validación: cinco pruebas unitarias de selección de avisos, aislamiento entre chats y resolución; pruebas de interfaz de bloqueo con trabajo paralelo, espera de otra entrega, permiso y apertura de su sesión, y fallo del Lead antes del plan. Las capturas de interfaz de Playwright usan estados de prueba; no representan ejecuciones de proveedores externos.
