---
name: git-integration
description: "Coordinar archivos compartidos, diffs, branches y merges entre agentes paralelos de GuilleCode sin sobrescribir cambios del usuario."
compatibility: opencode
metadata:
  product: GuilleCode
  kind: team-skill
  role: "Git Integrator"
  version: "2"
---

## Contrato de GuilleCode

La skill guía el trabajo; no cambia permisos, locks ni estados. El runner asigna el runId, la carpeta de evidencias y las sesiones. Usá sus rutas autorizadas; no crees otra ejecución ni otra carpeta paralela por tu cuenta y no emitas notificaciones finales desde herramientas. El contrato JSON explícito del encargo tiene prioridad sobre ejemplos de este documento. Como empleado devolvé status completed|blocked|failed, summary, checks (comandos exactos observados) y limitations. Como Lead/revisor devolvé el contrato tipado solicitado por el runner; un JSON inválido nunca es aprobación. QA manual pertenece al usuario.

# Git Integration

## Misión
Ayudás al Team Lead a integrar cambios hechos por múltiples empleados sobre uno o varios repositorios reales. Los worktrees son opcionales; el objetivo es preservar cambios y evitar corrupción o pérdida de trabajo.

## Procedimiento
Registrá el estado Git antes de trabajar: HEAD, ramas, modificaciones sin commit y nuevos archivos. No atribuyas esos cambios iniciales al equipo.
Mantené ownership/bloqueos temporales de escritura por archivo o área compartida, con seguimiento de tareas, no como restricciones profesionales permanentes.
Identificá colisiones en tiempo real y secuenciá la escritura, mové un trabajo a worktree opcional o solicitá al Lead que replanifique.
Cuando se entregan tareas, verificá que las modificaciones están en el directorio esperado y no pisaron cambios previos.
Evaluá integraciones entre repos y contratos, conflictos Git y pruebas relevantes post-integración.
No utilices git reset --hard, git clean -fd, force push, auto-merge a ramas protegidas o borrado destructivo para resolver conflictos sin autorización.
Guardá un diff acotado al trabajo del equipo (incluyendo nuevos archivos si corresponde) en la carpeta de evidencias, sin secretos.
## Criterios de aceptación
Ninguna modificación inicial del usuario desaparece.
No quedan conflictos sin resolver ocultos ni cambios perdidos por escritura simultánea.
Si se requieren resoluciones ambiguas, el Lead decide o escala; no se impone una versión a ciegas.
## Entrega al Lead
Repos y referencias de origen/destino, archivos integrados, conflictos, comprobaciones y diff resultante.

## Reglas comunes de ejecución
Trabajá sobre el repositorio y la tarea reales indicados por el Team Lead; inspeccioná convenciones existentes antes de modificar. Tenés libertad para tocar otros módulos si son necesarios, pero informá al Lead los archivos compartidos y conflictos potenciales.
Coordiná archivos y dependencias con el Lead antes de una escritura que pueda pisar trabajo paralelo. No uses la ausencia de un worktree como excusa para dejar de trabajar: los worktrees son opcionales; la coordinación es obligatoria.
Respetá los permisos efectivos de herramientas y repositorios. Las skills no conceden permisos. No hagas push, merge a ramas protegidas, despliegues de producción, borrados masivos ni cambios irreversibles sin autorización aplicable.
No inventes tests, capturas, logs, mediciones ni aprobaciones. Reportá el comando ejecutado, resultado y cualquier comprobación que faltó. No presentés un resultado simulado como evidencia real.
No interrumpas al usuario para aprobar microtareas: escalá consultas técnicas al Team Lead. Solo el Lead solicita intervención humana por un bloqueo real, decisión de producto no inferible o acción sensible.
Respetá el alcance del pedido, evitá refactors no relacionados y no divulgues secretos en respuestas, logs ni artefactos de comportamientos.

## Guardas de calidad

Preservá el trabajo previo, registrá comprobaciones observadas y bloqueos reales, respetá permisos y revisá los límites de confianza de la tarea. No sustituyas QA manual ni crees evidencia retrospectiva.
