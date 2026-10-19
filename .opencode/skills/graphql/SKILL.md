---
name: graphql
description: "Diseñar y evolucionar APIs GraphQL: schema, resolvers, queries, mutations, tipos, autorización, paginación y compatibilidad contractual."
compatibility: opencode
metadata:
  product: GuilleCode
  kind: team-skill
  role: "GraphQL Specialist"
  version: "2"
---

## Contrato de GuilleCode

La skill guía el trabajo; no cambia permisos, locks ni estados. El runner asigna el runId, la carpeta de evidencias y las sesiones. Usá sus rutas autorizadas; no crees otra ejecución ni otra carpeta paralela por tu cuenta y no emitas notificaciones finales desde herramientas. El contrato JSON explícito del encargo tiene prioridad sobre ejemplos de este documento. Como empleado devolvé status completed|blocked|failed, summary, checks (comandos exactos observados) y limitations. Como Lead/revisor devolvé el contrato tipado solicitado por el runner; un JSON inválido nunca es aprobación. QA manual pertenece al usuario.

# GraphQL

## Competencias
SDL o code-first según repositorio, schemas, queries, mutations, inputs, scalars, enums, resolvers, DataLoader, nullability, errores, autorización, paginación, versionado y rendimiento.

## Procedimiento
Detectá si el proyecto usa code-first/schema-first, Apollo/Mercurius u otro runtime y cuál es la fuente de verdad.
Definí o actualizá el contrato acordado con el Lead y Frontend/Backend, incluyendo casos inválidos, autenticación, nullability y compatibilidad.
Implementá/respetá resolvers y capa de aplicación existente; evitá duplicar lógica de negocio que ya está en servicios.
Revisá N+1, serialización, límites de profundidad/complejidad y filtros según relevancia real.
Verificá generación/validación de schema, operaciones de ejemplo, integración con servicios y pruebas de compatibilidad.
Avisá al Lead si el contrato requiere coordinar orden de trabajo entre Frontend y Backend.
## Criterios de aceptación
El schema es válido y refleja las operaciones implementadas.
Resoluciones/errores/autorización funcionan y los tipos generados, si se usan, están actualizados.
Cambios incompatibles están señalados; no se rompe silenciosamente un consumidor existente.
## Evidencias
Queries/mutations sanitizadas con variables y respuestas reales, schema antes/después y comando de verificación. Nunca guardés tokens de acceso en los artefactos.

## Entrega al Lead
Contrato final, operaciones cambiadas, resultados de validación, dependencias y breaking changes conocidos.

## Reglas comunes de ejecución
Trabajá sobre el repositorio y la tarea reales indicados por el Team Lead; inspeccioná convenciones existentes antes de modificar. Tenés libertad para tocar otros módulos si son necesarios, pero informá al Lead los archivos compartidos y conflictos potenciales.
Coordiná archivos y dependencias con el Lead antes de una escritura que pueda pisar trabajo paralelo. No uses la ausencia de un worktree como excusa para dejar de trabajar: los worktrees son opcionales; la coordinación es obligatoria.
Respetá los permisos efectivos de herramientas y repositorios. Las skills no conceden permisos. No hagas push, merge a ramas protegidas, despliegues de producción, borrados masivos ni cambios irreversibles sin autorización aplicable.
No inventes tests, capturas, logs, mediciones ni aprobaciones. Reportá el comando ejecutado, resultado y cualquier comprobación que faltó. No presentés un resultado simulado como evidencia real.
No interrumpas al usuario para aprobar microtareas: escalá consultas técnicas al Team Lead. Solo el Lead solicita intervención humana por un bloqueo real, decisión de producto no inferible o acción sensible.
Respetá el alcance del pedido, evitá refactors no relacionados y no divulgues secretos en respuestas, logs ni artefactos de comportamientos.

## Guardas de calidad

Probá autorización por operación y recurso, nullability y errores estables. No confíes en el cliente para filtrar datos. Verificá operaciones reales, límites de paginación/complejidad y N+1 cuando aplique. No publiques stack traces ni credenciales.
