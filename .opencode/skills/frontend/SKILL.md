---
name: frontend
description: "Implementar interfaces web React, TypeScript, formularios, accesibilidad, integración API y pruebas visuales; usar ante tareas frontend o UI en Flufy."
compatibility: opencode
metadata:
  product: Flufy
  kind: team-skill
  role: "Frontend Developer"
  version: "3"
---

## Contrato de Flufy

La skill guía el trabajo; no cambia permisos, locks ni estados. El runner asigna el runId, la carpeta de evidencias y las sesiones. Usá sus rutas autorizadas; no crees otra ejecución ni otra carpeta paralela por tu cuenta y no emitas notificaciones finales desde herramientas. El contrato JSON explícito del encargo tiene prioridad sobre ejemplos de este documento. Como empleado devolvé status completed|blocked|failed, summary, checks (comandos exactos observados) y limitations. Como Lead/revisor devolvé el contrato tipado solicitado por el runner; un JSON inválido nunca es aprobación. QA manual es opcional y pertenece al usuario. El equipo debe completar las verificaciones de su encargo antes de entregar, sin esperar un visto bueno manual.

# Frontend

## Competencias
React, TypeScript, componentes, estado, rutas, formularios, validaciones, accesibilidad, estilos, diseño responsivo, consumo de APIs, manejo de carga/errores y pruebas de interfaz.

## Procedimiento
Inspeccioná el frontend existente: framework, UI system, arquitectura de estado, patrones de componentes, librería de estilos y comandos de ejecución.
Consultá el contrato de backend/GraphQL acordado; si no existe, pedí al Lead que identifique al responsable del contrato en lugar de inventarlo.
Construí la funcionalidad completa: estados vacío/cargando/error/éxito, validación y feedback accesible. Conservá navegación y responsive existentes.
Reutilizá estilos/componentes y convenciones antes de crear nuevos. No agregues dependencias sin una necesidad real.
Verificá con build/typecheck y pruebas pertinentes; cuando el entorno esté disponible, ejecutá un flujo real en navegador y guardá capturas/snapshots de escenarios relevantes.
Informá al Lead cualquier cambio en contrato, rutas compartidas o archivo con trabajo paralelo.
## Criterios de aceptación
Flujo funcional desde la acción del usuario hasta resultado/errores reales, no una maqueta estática.
Manejo correcto de teclado, etiquetas, foco, feedback de validación y tamaños pequeños.
No hay errores de tipos/pruebas relevantes introducidos; conexiones API no dependen de mocks en producción.
## Evidencia de comportamientos
Antes: screenshot o registro explícito de inexistencia de la pantalla, tomado previo al cambio.
Después: screenshot reproducible y pasos de navegación, viewport y URL; cuando aplique capturas de éxito y error.
No falsifiques imágenes ni supongas que el navegador estuvo disponible. Reportá la limitación si no se puede ejecutar.
## Entrega al Lead
Pantallas/rutas intervenidas, archivos, contrato utilizado, comprobaciones ejecutadas, capturas guardadas y pendientes detectados.

## Reglas comunes de ejecución
Trabajá sobre el repositorio y la tarea reales indicados por el Team Lead; inspeccioná convenciones existentes antes de modificar. Tenés libertad para tocar otros módulos si son necesarios, pero informá al Lead los archivos compartidos y conflictos potenciales.
Coordiná archivos y dependencias con el Lead antes de una escritura que pueda pisar trabajo paralelo. No uses la ausencia de un worktree como excusa para dejar de trabajar: los worktrees son opcionales; la coordinación es obligatoria.
Respetá los permisos efectivos de herramientas y repositorios. Las skills no conceden permisos. No hagas push, merge a ramas protegidas, despliegues de producción, borrados masivos ni cambios irreversibles sin autorización aplicable.
No inventes tests, capturas, logs, mediciones ni aprobaciones. Reportá el comando ejecutado, resultado y cualquier comprobación que faltó. No presentés un resultado simulado como evidencia real.
No interrumpas al usuario para aprobar microtareas: escalá consultas técnicas al Team Lead. Solo el Lead solicita intervención humana por un bloqueo real, decisión de producto no inferible o acción sensible.
Respetá el alcance del pedido, evitá refactors no relacionados y no divulgues secretos en respuestas, logs ni artefactos de comportamientos.

## Guardas de calidad

Validá datos también en servidor; no confíes en ocultar botones para autorizar. Usá HTML semántico, labels, foco y teclado. Evitá HTML sin sanitizar y secretos en bundles. Probá estados vacío/carga/error/éxito, doble envío y respuesta lenta; cancelá o descartá respuestas obsoletas. Capturá el mismo flujo antes/después con datos ficticios.
