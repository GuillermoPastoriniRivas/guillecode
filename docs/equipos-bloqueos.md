# Bloqueos del equipo y consultas al Lead

«Ver equipos que ocupan la carpeta» muestra el nombre, la tarea, el estado y la carpeta de cada ejecución que impide continuar, incluso si su chat está archivado. «Abrir equipo» selecciona esa ejecución exacta. Se puede detener una ejecución o todas las listadas; se conservan los cambios, conversaciones y evidencias. La selección completa se valida antes de actuar y no incluye equipos nuevos que aparezcan después del clic ni ejecuciones de otra carpeta. La carpeta se considera libre solo cuando las sesiones quedaron detenidas y reconciliadas; las detenciones en curso siguen figurando como tales. Una entrega completada con una sesión pendiente se conserva como completada al liberar esa sesión.

Los errores de carpeta ocupada identifican el equipo y la tarea en lenguaje humano, y abren este diagnóstico. El identificador técnico queda plegado. Capturas de interfaz con datos controlados:

![Equipos que ocupan la carpeta y acciones para abrirlos o detenerlos](evidencias/equipos-ocupan-carpeta.png)

![Equipos detenidos con historial conservado](evidencias/equipos-detenidos-con-historial.png)

Una respuesta `resume` puede incluir instrucciones para la propia tarea solicitante dentro de `resumeTasks`: se conservan y se normalizan a la continuación normal, sin crear otro intento ni repetir acciones. Las instrucciones idénticas repetidas para esa tarea se guardan una sola vez. Los errores de IDs, instrucciones vacías o intentos de reanudar otra tarea activa vuelven al Lead para corregir su decisión; no se aplican parcialmente ni se convierten directamente en pedidos al usuario.

Si el chat del Lead responde sin el formato esperado, hay hasta dos turnos automáticos para reformatear esa respuesta en la misma sesión. Esos turnos deshabilitan todas las herramientas, incluidas las de navegador y escritorio: corrigen la presentación sin repetir las acciones del pedido original.

La instalación de Windows comprueba el espacio disponible antes de reemplazar archivos y verifica después que el ejecutable OpenCode tenga todas sus secciones PE y pueda informar su versión. La app también detecta un ejecutable truncado antes de iniciarlo y explica cómo reparar la instalación, en lugar de mostrar el error de Windows 193 como un fallo de cuenta. El actualizador conserva el repositorio y la clave oficiales.

El encabezado muestra quién necesita ayuda y ofrece «Ver qué pasó y cómo ayudar». Cada tarjeta resume en tres líneas: «Tenía» (hasta dos tareas propias y cuántas más), «Me frena» (tarea y causa) y «Para seguir» (ayuda concreta). No atribuye al Lead las tareas de otros integrantes. La explicación completa queda plegada en «Ver detalles»; «Ampliar diagnóstico» abre una vista más ancha, útil cuando el panel de chat es angosto. Las esperas dependientes quedan plegadas detrás del problema principal. El campo de mensaje mantiene una altura mínima, y leer un diagnóstico no fuerza el desplazamiento al último mensaje.

La compilación local combina la base oficial 0.14.13 con estos cambios. Si el instalador incluye `plugins.guillecodeBuild.revision` en su configuración de compilación, «Actualizaciones» muestra esa revisión aparte de la versión oficial. El aviso de estar al día se refiere expresamente a las publicaciones oficiales. El repositorio y la clave de firma del actualizador siguen siendo los originales.

`app.exe --build-info` devuelve la versión y la revisión de esa misma configuración embebida, sin abrir ventanas, iniciar el motor ni modificar el perfil. Permite comprobar la identidad del ejecutable instalado además de comparar su hash con el artefacto compilado.

Un fallo al revisar un pedido de coordinación se atribuye al Lead y abre su sesión de coordinación, mientras el especialista figura esperando sus instrucciones. Cuotas y problemas de cuenta indican revisar el acceso o cambiar el modelo; no prometen que reintentar restablece el saldo. Los permisos y preguntas identifican al agente y llevan a su sesión. Las tareas independientes pueden continuar.

Mientras el Lead responde, se pueden enviar consultas de estado como «qué falló», «quién está bloqueado» o «cómo va». Se contestan desde el registro guardado, sin inferencia adicional, sin cancelar la sesión pendiente ni iniciar otro trabajo. Las instrucciones nuevas conservan la exclusión de mensajes en curso para no duplicar acciones. Los errores técnicos antiguos del chat se convierten a texto humano y no exponen cabeceras del proveedor.

Un fallo técnico de coordinación sin una necesidad real de cuenta, permiso o una decisión imprescindible se devuelve al Lead para corregir su respuesta; no se convierte directamente en una solicitud al usuario. Las decisiones de alcance incluyen `userRequest: {kind: "decision", question: "pregunta concreta"}`. Cada problema técnico tiene hasta tres intervenciones de recuperación, con un máximo total de nueve por tarea: resolver un problema y encontrar otro diferente no consume automáticamente el mismo límite. Se mantienen las comprobaciones, las sesiones y los controles de acceso.

Si el cierre no aprueba la entrega y tampoco asigna tareas para lo pendiente, el Lead debe corregir ese cierre y delegar las comprobaciones o correcciones técnicas. El QA manual del usuario se pide después de la entrega comprobada. La prueba nativa de ayuda incluye un especialista bloqueado, una escalada técnica indebida al usuario, una prueba declarada sin evidencia y un cierre prematuro; el equipo los resuelve conservando la misma sesión y sin repetir escrituras ni comandos.

Antes de comenzar, el Lead reúne las preguntas imprescindibles sobre el resultado en un solo mensaje. No pregunta cuántos agentes contratar ni pide confirmar decisiones técnicas rutinarias. Si devuelve `questions` no vacías, la app guarda las preguntas como conversación y no crea una ejecución, incluso si el modelo también devuelve `action: "work"`. La referencia al pedido original queda persistida: al contestar, el plan recibe las palabras originales del usuario, las preguntas y sus respuestas; no solo la última contestación. No se arrastran aclaraciones de una ejecución anterior a un pedido independiente. Un pedido claro comienza directamente, sin una confirmación adicional.

Durante la ejecución los especialistas piden ayuda al Lead y el equipo sigue hasta implementar y comprobar la entrega. Las instrucciones de planificación y coordinación reservan las consultas intermedias para un permiso/acceso real o una decisión imprescindible imprevista sin alternativa segura, explicando por qué no se pudo prever al principio. Esto no elimina los permisos del motor ni garantiza que un proveedor externo esté disponible. El usuario revisa al final y puede aprobar con «trabajo completado» o pedir mejoras.

Si falla la coordinación del propio Lead, el scheduler confirma primero la detención de esa sesión de lectura y vuelve a poner el pedido en revisión automática. El Lead recibe la causa y debe cambiar de estrategia: aislar el paso mínimo, revisar el contrato o delegar una tarea de ayuda. El especialista conserva su sesión, archivos, criterios e intentos; no vuelve a ejecutar sus efectos por este fallo. El encabezado indica que el Lead está buscando otra salida, sin pedir «Reconciliar y reintentar» durante esa recuperación. Hay hasta dos recuperaciones de coordinación por pedido, además de las correcciones locales de respuesta y con el límite total de sesiones existente; el presupuesto se conserva al reiniciar. Una sesión cuya detención no pudo confirmarse, un permiso o acceso real y una decisión externa explícita no se reanudan a ciegas.

La prueba nativa fuerza tres respuestas inválidas seguidas del Lead, agota las correcciones locales y verifica la recuperación automática, la continuación del mismo trabajador y la finalización del Frontend independiente. La prueba de interfaz reproduce el fallo registrado y su paso a recuperación sin acciones del usuario. Estas capturas corresponden a datos controlados de esa prueba:

![Fallo de coordinación registrado antes de recuperar](evidencias/lead-antes-recuperacion.png)

![Lead recuperando al agente sin pedir ayuda al usuario](evidencias/lead-recuperacion-automatica.png)

Si el motor deja una respuesta intermedia inactiva durante 90 segundos sin resultado final, se informa el problema conservando la sesión y sus efectos. Estar ejecutando una herramienta o esperando un permiso restablece ese reloj: no se deduce un bloqueo por el solo paso del tiempo mientras el motor declara trabajo activo. El cierre sigue requiriendo todas las comprobaciones y el QA manual del usuario después de la entrega técnica.

La validación incluye pruebas de atribución del bloqueo y recomendaciones, consultas locales durante un mensaje pendiente, disposición del panel a 1000 × 650, diagnóstico ampliado, recuperación de la misma sesión y conservación de los efectos tras reiniciar. Las pruebas nativas usan OpenCode y Tauri reales con inferencia determinista local; no prueban disponibilidad de cuentas de producción.

![Resumen breve del bloqueo con detalles plegados](evidencias/equipos-bloqueo-breve.png)

![Diagnóstico ampliado del equipo](evidencias/equipos-diagnostico-ampliado.png)

Capturas reales de la interfaz con datos de prueba controlados: Lead detenido por límite de cuenta y especialista esperando instrucciones. No corresponden a una sesión privada ni acreditan disponibilidad de un proveedor de producción.


## Lectura, edición y recuperación del navegador

El chat permite ampliar y restaurar la conversación conservando el borrador. Los pedidos largos quedan plegados y el Lead muestra sus tres frases en una tarjeta con más separación y tamaño de lectura. Los detalles técnicos permanecen plegados. En pantallas bajas se reduce el espacio de los controles para conservar un área de lectura útil.

Los permisos de escritura se calculan desde la base real informada por OpenCode, también sin Git y al abrir una subcarpeta de un repositorio. Cada especialista conserva únicamente sus rutas asignadas; al reanudar una sesión se actualiza ese mismo alcance. Se conservan las restricciones sobre archivos sensibles, Git, otras carpetas y comandos de shell. Las solicitudes de permisos muestran la ruta o el comando que informó el motor; no se atribuye un fallo de edición a la cuenta de IA.

Una respuesta del plan envuelta en texto o con varios bloques JSON se devuelve hasta dos veces al Lead para corregir su formato, en la misma sesión y con todas las herramientas deshabilitadas. No se descarta inmediatamente el reparto de especialistas ni se repiten acciones de observación.

Si falta la ventana del equipo o se cerró, los trabajadores y el Lead del chat pueden recuperarla mediante `browser_list_pages`: la app crea una sola ventana nueva exclusiva del equipo, también ante pedidos simultáneos. No adopta una ventana personal ni reproduce clics, formularios o acciones de la página perdida. El agente debe volver a navegar y observar antes de actuar. Planificación y revisiones de solo lectura no crean ventanas. Se respetan la pausa del usuario, el control apagado y los permisos de conexión de Chrome.

Las pruebas nativas verifican escritura sin permisos manuales de edición en una carpeta sin Git, reparación de un plan mal formateado antes de ejecutar tres especialistas, continuación de una sesión con permisos actualizados y recuperación de Chrome real con persistencia tras reiniciar. La inferencia del runner es determinista local; esas pruebas no equivalen a una entrega con el proveedor de producción.


## Solucionador, Supervisor y análisis del objetivo

Ante un pedido de ayuda se crea una sesión real del **Solucionador**, que investiga archivos, contratos y fuentes web con herramientas de lectura. Envía hechos y un siguiente paso al Lead antes de que este decida cómo continuar. La investigación se conserva por pedido y no se repite en cada corrección del mismo mensaje. No escribe código ni cambia permisos. Las dudas técnicas no se trasladan al usuario; las decisiones rutinarias se resuelven con una suposición explícita dentro del alcance. Los accesos, credenciales o decisiones imprescindibles sin alternativa segura conservan sus controles.

El **Supervisor** revisa cada entrega, busca incompatibilidades con los contratos de los demás y reporta los faltantes. El Lead conserva la responsabilidad de asignar correcciones y reanudar las sesiones. La supervisión puede observar entregas independientes en paralelo y no reserva rutas de escritura de los trabajadores.

Antes del cierre, el Supervisor contrasta otra vez el objetivo inicial completo con los archivos, resultados y pruebas observadas. Produce una lista de requisitos `met`, `missing` o `unverified`, con la evidencia o la explicación de su ausencia. No basta marcar tareas completas ni aprobar revisiones individuales: la app impide aprobar el cierre si esa comparación no confirma todos los requisitos. Los faltantes vuelven al Lead para asignar correcciones y se realiza una nueva comparación después. La revisión manual del usuario viene después de la entrega comprobada.

Las sesiones, modelos usados e informes quedan registrados en Actividad y en las evidencias; las sesiones de apoyo también quedan agrupadas dentro del equipo en el historial normal. Resultados muestra un resumen del contraste objetivo/resultado y deja plegada la lista de comprobaciones. Una sesión de apoyo pendiente mantiene ocupada su carpeta hasta reconciliarse; cancelar conserva sus informes y cambios previos.


Capturas reales de la interfaz con datos controlados de las pruebas (no acreditan una sesión de proveedor de producción):

![Chat con pedidos largos plegados y respuestas con más espacio](evidencias/equipo-chat-legible.png)

![Conversación ampliada conservando el borrador](evidencias/equipo-chat-ampliado.png)

![Supervisor comparando requisitos originales y comprobaciones](evidencias/supervisor-objetivo-y-resultado.png)
