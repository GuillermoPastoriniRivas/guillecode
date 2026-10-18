# Modo Equipos IA — implementación y verificación

Implementación integrada con ejecución nativa, captura real, comparación visual y recuperación de sesiones. No se usan servicios de orquestación externos ni se reemplaza OpenCode. La aceptación con modelos de producción y la comprobación manual de avisos del sistema se distinguen de las pruebas automatizadas al final.

## Uso

1. Abrir el proyecto en la aplicación de escritorio, con cuentas de IA conectadas.
2. Entrar a **Equipos IA** desde la barra lateral y pulsar **Crear equipo**.
3. Configurar el Lead obligatorio y los especialistas. Cada uno tiene nombre, rol, proveedor/modelo, variante, skills versionadas, instrucciones, herramientas y concurrencia. La propuesta asistida por IA es un borrador; no se guarda ni se ejecuta sin pulsar Guardar.
4. Revisar las carpetas autorizadas. Se proponen las del workspace activo. Git es opcional y nunca se inicializa automáticamente.
5. Pulsar **Guardar y abrir Team Chat**, o usar **+ → Nuevo chat de equipo** y seleccionar la plantilla. **Chat normal** y el atajo de nueva sesión siguen disponibles.
6. Escribir el objetivo y pulsar **Enviar** o Enter (Shift+Enter agrega una línea). Tareas muestra responsables, propiedad de escritura y estados; Actividad permite abrir sesiones reales, resolver permisos y ver pedidos entre agentes, respuestas del Lead, comandos y revisiones.
7. Al terminar, Resultados / Comportamientos muestra el resumen, las evidencias, el diff y la carpeta. El comparador ofrece lado a lado, deslizador y ampliación; permite comparar contra el resultado de una entrega anterior del mismo chat. El estado es **Pendiente de QA manual**. El usuario puede aprobar QA o enviar un defecto por el mismo composer: se crea otra ejecución y otra carpeta, conservando las anteriores.

En el editor del equipo, **Agregar flujo visual** configura URL local, viewport, selector de espera, elementos privados y pasos de clic/completar/esperar. Se usa Chrome o Edge instalado y Node disponible en PATH, con un perfil temporal sin las cookies del usuario. Iniciá el servidor de desarrollo del proyecto; el capturador no lo arranca. Si no se configuran flujos, el Lead puede proponer URLs locales observadas en el proyecto. **Exigir captura final para entregar** bloquea el cierre si no se obtiene la imagen. Cuando el servidor vuelva a estar disponible, Reconciliar y reintentar captura de nuevo sin repetir las tareas completadas. Una ausencia inicial se conserva como ausencia; nunca se sustituye por una captura posterior.

Los límites de duración, USD, tokens y retención son opcionales. El gasto se toma de los metadatos reales del motor; un proveedor puede no informar costo. Se comprueba cada dos segundos y antes de nuevas llamadas: no es una garantía bancaria de gasto exacto y una llamada en curso puede excederlo antes del siguiente reporte. El tiempo cuenta pausas y cierres desde el inicio original. Actividad muestra el uso acumulado. Una ejecución bloqueada y sin sesiones pendientes permite ajustar sus límites, conservando un registro de antes/después y el uso ya consumido.

**Pausar nuevas tareas** deja terminar los intentos en curso. **Cancelar ejecución** aborta sesiones y confirma su inactividad; conserva los cambios ya aplicados. Nunca hace reset ni rollback automático. Ante un bloqueo se puede inspeccionar sesiones, cambiar modelos y pulsar **Reconciliar y reintentar**. Si una sesión continúa activa, la reconciliación pide inspeccionarla o cancelar primero.

## Arquitectura y decisiones

- `src-tauri/src/teams/domain.rs`: DTOs versionados, catálogo inicial de diez skills, validación de equipos, modelos referenciados, rutas y DAG. Los nombres no se usan como claves.
- `src-tauri/src/teams/mod.rs`: comandos IPC, SQLite, transacciones y checkpoints; esquema 2, con migración del esquema 1 mediante valores por defecto sin perder snapshots ni historia. Un esquema futuro desconocido o un documento ilegible genera error y conserva el original. No hay datos de ejecuciones en localStorage: solo se guardan allí preferencias de pestañas.
- `src-tauri/src/teams/runner.rs`: scheduler y WorkerRunner en threads nativos, independientes del montaje de React. Usa `Opencode`, `ensure_server`, proveedores conectados y las APIs reales de sesiones, mensajes, estado y abort. Cada intento fija empleado/modelo/variante/directorio/sesión antes de enviar el prompt.
- El Lead produce un plan tipado. El código valida IDs, responsables, repositorios, dependencias y ausencia de ciclos antes de ejecutarlo. Solo se inyectan las skills seleccionadas en sus versiones fijadas.
- Se limita la concurrencia por equipo y empleado. Desde 0.14.3, tareas de la misma carpeta avanzan simultáneamente si sus `writePaths` no se superponen. El Lead asigna archivos relativos o directorios terminados en `/`, sin comodines ni `..`; las herramientas de edición del motor solo reciben permisos sobre ese alcance. Un archivo compartido espera su turno. Tareas antiguas sin `writePaths` conservan la reserva de carpeta completa. El shell conserva sus permisos de OpenCode y no constituye un sandbox de archivos: no recibe autorización general para escribir fuera del alcance. Otra ejecución no entra en carpetas reservadas por un equipo activo o con sesiones sin confirmar.
- `coordination.rs`: un trabajador devuelve `waiting_dependency` con un pedido concreto para el Lead. Su sesión queda inactiva y cede capacidad mientras los demás continúan. El Lead lee estados y archivos, responde con un contrato disponible, espera una entrega o crea una tarea adicional para su responsable. Solo sus dependencias validadas afectan la ejecución; se rechazan esperas circulares. Al completarse una entrega se vuelve a consultar al Lead y se continúa la misma sesión/intento. Actividad conserva el pedido y todas las respuestas, con acceso a cada sesión de coordinación.
- El trabajador usa una sesión normal con herramientas, no `oneShot`. Planificación, revisión individual y cierre usan sesiones de solo lectura. Los empleados no crean subagentes ocultos fuera del registro del scheduler.
- El resultado del trabajador necesita JSON válido y comprobaciones coincidentes con herramientas `bash` realmente completadas, con exit code 0. La aprobación individual exige un veredicto válido del Lead. Los errores de comprobación o pedidos de cambios generan feedback y reintentos limitados. Un JSON inválido de revisión produce `review_error` y bloqueo.
- El Lead realiza además un cierre global con el objetivo, entregas, comandos y diff. Puede añadir tareas de corrección/integración con DAG validado, dentro del límite configurado. Solo tras aprobar ese cierre y persistir los archivos se alcanza `awaiting_manual_qa`.
- La política general de chats se mantiene. Las sesiones del runner incluyen un marcador de política específico que evita inyectar la prohibición genérica de delegar.
- Los controles de ejecución se serializan para evitar que dos clics en Reintentar lancen dos schedulers. Los checkpoints de despacho comprueban de nuevo el estado para respetar una pausa o cancelación concurrente.
- `capture.rs` y `capture.mjs`: captura CDP con navegador instalado, sin nuevas dependencias. El Lead recibe observaciones de URL, HTTP, texto visible, pasos y dimensiones para el cierre. Los píxeles no se presentan como una revisión visual del modelo.
- `retention.rs`: limpieza diaria y al iniciar, únicamente sobre carpetas de ejecuciones propias y con retención explícita; conserva las pendientes de QA. Rechaza rutas externas y redirecciones por enlaces/junctions.

## Persistencia y evidencias

Datos locales bajo la carpeta de aplicación de Tauri (en Windows, normalmente `%APPDATA%/com.guillecode.desktop/`):

```text
teams.sqlite                 # equipos, todas las versiones de skills, chats y ejecuciones
teams.sqlite-wal             # journal SQLite, cuando corresponda
comportamientos/<runId>/
  antes/estado-inicial.md
  antes/repositorios.json
  antes/<captureId>.png       # solo si la captura realmente existió
  despues/estado-final.md
  despues/<captureId>.png
  capturas/<captureId>.json   # origen, HTTP, pasos, viewport, huella o motivo de ausencia
  pruebas/pruebas.json
  cambios/archivos.json
  cambios/cambios.diff
  revisiones/<attemptId>.json
  revisiones/cierre-<id>.json
  revisiones/configuracion.json
  resumen.md
  resultado.json
  manifest.json
```

La carpeta queda fuera del repositorio; no se cambia `.gitignore`. Se comprueba la existencia de los archivos capturados antes de entregarlos y de abrirlos. El lector rechaza traversal y enlaces que escapen de la carpeta de evidencia. Las capturas imposibles se registran como `unavailable`, con motivo, sin crear imágenes vacías. Cada PNG tiene identificador inmutable y huella SHA-256; el visor comprueba nuevamente la huella y rechaza archivos alterados. Las revisiones visuales posteriores se agregan sin sobrescribir la línea base.

El navegador admite solo destinos HTTP(S) de loopback sin credenciales en la URL y bloquea solicitudes de recursos a hosts externos. No usa el perfil normal. Oculta inputs, textarea, contenido editable, elementos `data-private`/`data-sensitive`, selectores configurados y patrones comunes de email/credenciales antes de capturar; el flujo no admite completar contraseñas ni archivos. Una captura pesa como máximo 5 MB y el viewport está limitado a 2560×1600. Usá datos de prueba y configurá máscaras para datos particulares del producto: texto dibujado en canvas o imágenes no puede redactarse mediante el DOM. Un flujo con acciones se ejecuta de verdad, por lo que debe apuntar a un entorno local de prueba.

La retención está desactivada por defecto. Con un plazo explícito, solo expiran evidencias de ejecuciones aprobadas por el usuario, canceladas o fallidas después del plazo desde su finalización. Se conserva el historial SQLite y se muestra la expiración en el visor. Archivar un chat no borra su evidencia ni equivale a aprobar QA.

La línea base compara **contenido inicial contra final**. En una raíz Git registra branch/HEAD y estado staged, unstaged y untracked; un índice temporal crea árboles sin modificar el índice real. En carpetas sin Git guarda una instantánea durable con huella SHA-256 y límites declarados. Omite credenciales conocidas, dependencias, salidas de build y reglas `.gitignore`/`.ignore`, y no sigue enlaces o junctions. Los cambios previos del usuario no se presentan por defecto como trabajo del equipo y nunca se crea `.git`.

Los archivos de credenciales conocidos se excluyen de snapshots. Los logs, comandos, reportes y diffs se sanitizan; los JSON se sanitizan conservando su estructura. El texto se limita a 512.000 caracteres y cada escritura de evidencia a 2 MB de entrada. Esta redacción conservadora puede omitir líneas de código que mencionen secretos aunque no contengan credenciales. No es un detector infalible de cualquier dato sensible.

## Permisos y recuperación

El runner usa reglas reales de OpenCode con denegación por defecto, herramientas enumeradas por el motor y acceso externo al directorio denegado. No habilita herramientas MCP de terminal, PC, navegador, self, rutinas ni delegación a través de prompts. Planificador y revisores tienen únicamente read/glob/grep. Las herramientas edit/write/apply_patch del trabajador se limitan a las configuradas.

Los comandos exactos habituales de verificación (`npm test`, `npm run build`, `npm run lint`, `cargo test`, entre otros enumerados en `session_permissions`) pueden ejecutarse de forma autónoma. Otros comandos, argumentos y acciones sensibles pasan por el permiso de shell de OpenCode. La aprobación automática global se conserva para chats normales y no contesta automáticamente esos permisos de equipos. Aprobar shell concede la capacidad real del comando autorizado; este modo no es una sandbox del sistema operativo. Las reglas de archivos no pueden inspeccionar lo que hace internamente un script del proyecto. Las escrituras en `.git` mediante herramientas de edición se deniegan. La instalación de actualizaciones se bloquea si hay un equipo activo o sesiones pendientes.

Cada sesión tiene un límite de 45 minutos, además del presupuesto opcional de la ejecución. Después de reiniciar, una ejecución que estaba activa pasa a blocked; no se reenvían prompts automáticamente. La reanudación explícita consulta sesiones, estados y mensajes del motor. Una sesión aún activa conserva su reserva y rechaza el reintento. Un trabajador interrumpido recupera el mismo intento y la misma sesión: si ya produjo una respuesta final válida, se ingiere y se revisa sin otra orden de implementación; si quedó parcial, recibe una continuación con su telemetría para verificar efectos y completar solo lo pendiente. Un plan ya terminado también se recupera. Las tareas completadas se conservan, y un fallo exclusivo de captura no vuelve a ejecutar sus comandos. No se relanzan procesos nativos a partir de un supuesto de que no llegaron a ejecutarse. Si no se confirma una detención, no se libera su reserva de repositorio.

Las notificaciones locales y push usan los mecanismos existentes. El estado y `notified` se confirman en SQLite **antes** de emitir la notificación final. Esto evita avisos repetidos tras reinicio, pero un cierre justo después del commit puede omitir ese aviso; la entrega sigue accesible en el historial. Las notificaciones de test se sustituyen por eventos internos para no generar alertas reales durante las pruebas.

## Pruebas

Comandos reproducibles:

```powershell
npm test
npm run test:e2e -- --workers=2
cargo test --manifest-path src-tauri/Cargo.toml --release --lib teams::
npm run test:teams
npm run test:teams:recovery
npm run build
npm run lint
```

`test:teams` levanta el OpenCode incluido con un perfil temporal vacío y un proveedor de inferencia determinista en loopback. Ejecuta el scheduler Rust dentro de un Tauri aislado, tanto con Git como en una carpeta que nunca contiene `.git`. No consume tokens de cuentas reales. Las escrituras de archivos, herramientas, comandos, permisos del motor, SQLite, veredictos y archivos de evidencia son reales; las decisiones de IA son respuestas controladas de prueba.

El escenario comprueba modelos distintos, devolución de una tarea para corregirla, índice Git previo intacto, entrega pendiente de QA y aprobación manual. También prueba modelo desconectado, reasignación del mismo intento lógico, rechazo de un veredicto inválido, PNGs reales antes/después sobre los archivos modificados, detección de imagen alterada, presupuesto y recuperación de captura obligatoria sin repetir trabajadores. Los tests unitarios cubren DAG, concurrencia, variantes ausentes, registros de herramientas, redacción, traversal, migración, retención y límites.

`test:teams:recovery` inicia procesos Tauri separados y los termina forzosamente mientras un comando ya aplicó un efecto. Si el motor conserva la sesión ocupada comprueba que impide replay; si la deja inactiva, comprueba que la continuación verifica el efecto existente. También valida que una respuesta final se recupera sin otro prompt de implementación, que la entrega persiste al reabrir y que reiniciar el motor permite continuar en la sesión original sin duplicar el efecto. Las carpetas y perfiles son temporales. El harness detiene su herramienta de espera identificada si sobrevive separada del árbol del motor.

Los E2E de UI usan IPC simulado y cubren creación, modelos/skills, recarga, chat normal, objetivo, pausa, resultados, ampliación/deslizador, ausencia visual y feedback con historia conservada. Esas imágenes de interfaz no se confunden con las capturas CDP de la integración nativa.

Los resultados concretos de la ejecución de desarrollo se registran en `docs/equipos-ia-validacion.md`.

## Validaciones manuales y límites

- **Historia de aceptación NestJS + GraphQL + React con cuentas/modelos de producción.** Sigue sin ejecutarse ese caso concreto contra cuentas reales. La integración usa proveedores controlados y herramientas reales; no demuestra la calidad de planificación de un modelo de producción ni un módulo de usuarios de otro proyecto.
- **Permisos de shell más finos.** Comandos fuera de la lista exacta aún pueden pedir autorización; no se eluden para cumplir autonomía aparente.
- **Ediciones simultáneas externas al scheduler.** Los locks coordinan los equipos de esta app, no un editor, chat normal u otro proceso que escriba por fuera. El diff puede incluir esas ediciones y no puede atribuirlas automáticamente. Se recomienda no editar el mismo repo desde otro agente mientras un equipo escribe.
- **Reinicio completo de Windows.** Se mataron y reabrieron procesos reales de app y motor, pero no se reinició el sistema operativo durante las pruebas. Un programa que se desprende del árbol del motor puede sobrevivir a su cierre; verificar su estado sigue siendo parte de la reconciliación de una tarea parcial.
- **Verificación manual de avisos Windows/push con el usuario y apertura directa del Team Chat desde una notificación.** El historial local permite localizar la entrega por equipo. El push usa el inicio de la app móvil, cuyo visor de equipos todavía no está implementado.
- No se ejecuta trabajo con la app y su motor cerrados. Con la ventana oculta, el scheduler nativo continúa mientras el proceso siga vivo.

Las capturas, el comparador, los presupuestos, la retención y la recuperación de procesos están implementados. Las comprobaciones manuales anteriores se mantienen explícitas y no se presentan como realizadas.
