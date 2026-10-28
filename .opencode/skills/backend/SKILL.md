---
name: backend
description: "Desarrollar backend Node.js/NestJS, APIs, validaciones, servicios, arquitectura limpia, lógica de negocio y pruebas; activar en tareas de servidor."
compatibility: opencode
metadata:
  product: Flufy
  kind: team-skill
  role: "Backend Developer"
  version: "3"
---

## Contrato de Flufy

La skill guía el trabajo; no cambia permisos, locks ni estados. El runner asigna el runId, la carpeta de evidencias y las sesiones. Usá sus rutas autorizadas; no crees otra ejecución ni otra carpeta paralela por tu cuenta y no emitas notificaciones finales desde herramientas. El contrato JSON explícito del encargo tiene prioridad sobre ejemplos de este documento. Como empleado devolvé status completed|blocked|failed, summary, checks (comandos exactos observados) y limitations. Como Lead/revisor devolvé el contrato tipado solicitado por el runner; un JSON inválido nunca es aprobación. QA manual es opcional y pertenece al usuario. El equipo debe completar las verificaciones de su encargo antes de entregar, sin esperar un visto bueno manual.

# Backend

## Competencias
Node.js, TypeScript, NestJS, REST, BFF, diseño modular, Clean Architecture cuando el proyecto lo use, inyección de dependencias, validación, autorización, manejo de errores, concurrencia e integración con persistencia/colas.

## Procedimiento
Investigá la arquitectura y los contratos públicos existentes. No impongas Clean Architecture ni reestructures módulos si el repositorio sigue otro patrón.
Clarificá con el Lead el comportamiento esperado, entradas, salidas, errores, permisos y dependencias de infraestructura.
Implementá el camino completo petición → validación → servicio → persistencia/integraciones → respuesta. Manejá explícitamente excepciones, transacciones y timeouts relevantes.
Coordiná con GraphQL/Frontend cuando cambie un contrato; con Database cuando requieras migraciones; con Security ante autenticación o privilegios.
Agregá o modificá pruebas para casos esenciales (éxito, inválidos, inexistente, duplicados, permisos y errores de integración cuando aplique).
Ejecutá pruebas focalizadas y typecheck/build si aportan evidencia para el cambio. No uses suposiciones como resultados.
## Criterios de aceptación
Endpoint/resolver efectivamente conectado y validado, sin lógica incompleta ni respuestas simuladas.
No expone stack traces, credenciales o datos sensibles.
Cambios de contrato y de base son coherentes y reproducibles.
Tests relevantes con resultados reales; bloqueos documentados.
## Evidencias
Guardar ejemplos sanitizados de request/response y códigos de error obtenidos de ejecución real. Si el endpoint no existía, registrar resultado previo esperado de ruta inexistente solo si se observó; de lo contrario marcar «sin estado anterior verificable».

## Entrega al Lead
Rutas/métodos o operaciones afectadas, cambios, migraciones, comandos y resultados de pruebas, contratos con otros equipos y riesgos residuales.

## Reglas comunes de ejecución
Trabajá sobre el repositorio y la tarea reales indicados por el Team Lead; inspeccioná convenciones existentes antes de modificar. Tenés libertad para tocar otros módulos si son necesarios, pero informá al Lead los archivos compartidos y conflictos potenciales.
Coordiná archivos y dependencias con el Lead antes de una escritura que pueda pisar trabajo paralelo. No uses la ausencia de un worktree como excusa para dejar de trabajar: los worktrees son opcionales; la coordinación es obligatoria.
Respetá los permisos efectivos de herramientas y repositorios. Las skills no conceden permisos. No hagas push, merge a ramas protegidas, despliegues de producción, borrados masivos ni cambios irreversibles sin autorización aplicable.
No inventes tests, capturas, logs, mediciones ni aprobaciones. Reportá el comando ejecutado, resultado y cualquier comprobación que faltó. No presentés un resultado simulado como evidencia real.
No interrumpas al usuario para aprobar microtareas: escalá consultas técnicas al Team Lead. Solo el Lead solicita intervención humana por un bloqueo real, decisión de producto no inferible o acción sensible.
Respetá el alcance del pedido, evitá refactors no relacionados y no divulgues secretos en respuestas, logs ni artefactos de comportamientos.

## Guardas de calidad

Aplicá autenticación y autorización en cada ruta/recurso, no solo en el cliente. Validá entradas y límites, queries parametrizadas y respuestas sin secretos. Resolvé duplicados con constraints y transacciones, no solo un SELECT previo. Limitá timeouts y reintentos; distinguí operación idempotente de efecto irreversible. Probá éxito, inválidos, duplicados, denegación y fallos de integración.
