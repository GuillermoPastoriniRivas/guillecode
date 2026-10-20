# Navegador, apps e historial en Equipos IA

El Lead puede consultar la web y usar las herramientas de navegador y escritorio
del chat normal. Los especialistas también las reciben al ejecutar sus tareas.
La planificación y las revisiones conservan acceso de observación, sin clics,
escrituras de interfaz, shell ni edición de archivos.

Para usar Chrome, activá el control de la PC y las herramientas de navegador en
la configuración existente de GuilleCode. En el chat del equipo, **Elegir
navegador** asigna una ventana al equipo completo. Cada agente trabaja en su
propia pestaña. Las sesiones se relacionan con esa ventana desde el registro
nativo del equipo; el modelo no puede elegir otra conversación como identidad.
La asignación persiste al reabrir y también se aplica a sesiones recuperadas.
El apagado, la pausa y los bloqueos de apps siguen siendo efectivos.

Las consultas directas al Lead pueden usar herramientas y responder sin crear
un plan. La edición del proyecto sigue pasando por el scheduler y las reglas de
propiedad de archivos. **Ver actividad y permisos del Lead** permite inspeccionar
esas herramientas, incluso si todavía no existe una ejecución. **Detener pedido
del Lead** aborta su sesión y conserva la actividad para revisar efectos ya
aplicados antes de reintentar.

Los intentos guardan las observaciones terminadas de web, navegador y escritorio.
Se muestran plegadas en Actividad. Una tarea puramente de interfaz o investigación,
sin archivos esperados ni herramientas de edición o shell, puede verificarse con
esas observaciones sin inventar comandos. El Lead debe comprobar los criterios;
una llamada exitosa por sí sola no aprueba una entrega. Los cambios de código
siguen requiriendo las comprobaciones observadas habituales.

## Historial normal

El historial indica qué carpeta se está mostrando. **Todas las carpetas** consulta
el índice persistido del motor, incluidas las conversaciones de proyectos que ya
no están en Recientes. Conserva el directorio de cada sesión al abrirla y no mueve,
borra ni duplica mensajes. Seleccionar desde el historial la misma conversación
normal que estaba abierta antes del equipo vuelve a mostrarla correctamente.

## Validación

- Pruebas nativas de permisos, observaciones y relación entre sesiones/ventana,
  incluida su persistencia y recuperación.
- Motor OpenCode real con inferencia determinista local: herramientas MCP de
  navegador con identidad autenticada y sesiones de equipo bajo permisos propios.
- Harness nativo: el Lead ejecuta una herramienta, espera el resultado y responde;
  después elige y ejecuta tres especialistas en paralelo, conservando archivos
  previos en una carpeta sin Git. No usa cuentas ni tokens de pago.
- E2E del selector de navegador, reapertura, historial entre carpetas, retorno al
  chat normal y detención del Lead con conservación de su sesión.
- La suite adicional de la burbuja conserva una inestabilidad previa del cursor
  de streaming: pasó al reintentar. Las pruebas nuevas de este cambio pasaron
  directamente.
