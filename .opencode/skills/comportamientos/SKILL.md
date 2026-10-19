---
name: comportamientos
description: "Capturar evidencias de comportamiento antes y después de una implementación: screenshots reales, APIs, pruebas, logs sanitizados y manifiesto final de GuilleCode."
compatibility: opencode
metadata:
  product: GuilleCode
  kind: team-skill
  role: "Evidence Collector"
  version: "2"
---

## Contrato de GuilleCode

La skill guía el trabajo; no cambia permisos, locks ni estados. El runner asigna el runId, la carpeta de evidencias y las sesiones. Usá sus rutas autorizadas; no crees otra ejecución ni otra carpeta paralela por tu cuenta y no emitas notificaciones finales desde herramientas. El contrato JSON explícito del encargo tiene prioridad sobre ejemplos de este documento. Como empleado devolvé status completed|blocked|failed, summary, checks (comandos exactos observados) y limitations. Como Lead/revisor devolvé el contrato tipado solicitado por el runner; un JSON inválido nunca es aprobación. QA manual pertenece al usuario.

# Comportamientos

## Propósito
Construís un historial verificable de qué cambió, cómo se comportaba antes y cómo se comporta después, sin reemplazar el QA manual final del usuario. La evidencia debe corresponder a ejecuciones y archivos reales.

## Inicio de una ejecución
Recibí runId y evidenceDir del runner. No generes otros IDs ni intentes escribir fuera del repositorio autorizado; el collector nativo administra la carpeta de evidencias.
Antes de editar, capturar información disponible: HEAD/ramas, cambios preexistentes, rutas y contratos, comportamiento ejecutable y capturas donde existan. Nunca inventar un «antes» retrospectivo.
Reportá al Lead los escenarios observados antes de editar para incorporarlos a antes/estado-inicial.md; donde no haya evidencia registrar el motivo (feature_not_existing, environment_unavailable, capture_failed, etc.).
## Después de la implementación
Repetir los mismos escenarios bajo condiciones comparables cuando sea posible.
Para UI usá los flujos de captura configurados en el run: el collector guarda PNGs reales, URL/ruta, viewport, pasos y estado. No habilites herramientas de navegador fuera de tus permisos. No se requiere captura cuando no hay UI.
Para REST/GraphQL guardar request/response sanitizados, códigos y resultado esperado/actual. No incluir tokens, cookies, contraseñas ni datos personales.
Para Docker/CI/IaC registrar comandos y salidas verificadas, estado de servicios y limitaciones. Un archivo de configuración creado no demuestra un despliegue.
Guardar resultados de pruebas reales con comando, exit code, fecha, escenario y estado passed|failed|blocked|not_run.
Entregá al Lead resultados observados para que el collector nativo genere resumen.md, cambios/cambios.diff, manifest.json y resultado.json con rutas relativas existentes.
## Estructura sugerida
<evidenceDir>/
  resumen.md
  antes/estado-inicial.md
  despues/estado-final.md
  capturas/
  pruebas/
  cambios/cambios.diff
  resultado.json
## Contrato de evidencias

Usá el esquema real del runner: resultado.json contiene runId, teamId, goal, leadStatus, manualQaStatus, finishedAt, summary, tasks, checks, limitations, observations, artifacts y usage. La entrega técnica queda awaiting_manual_qa en la base y manualQaStatus pending en el reporte. manifest.json lista artifacts con rutas relativas, capturedAt, source y status; no introduzcas otro esquema incompatible. El collector nativo valida rutas y existencia y genera estos archivos; reportá evidencias observadas en la sesión para que las incorpore.

## Reglas de calidad
Nunca reportar un path inexistente o capturas generadas artificialmente como observación real.
Si algo no se pudo ejecutar, mostrar motivo, no ocultarlo ni inventar éxito.
Separar entrega técnica (awaiting_manual_qa) de QA manual (qa_approved), reservado al usuario.
Al corregir tras feedback del usuario, agregar una nueva versión/ejecución referenciada: no sobreescribir la evidencia histórica.
## Entrega al Lead
Ruta de la carpeta, manifiesto validado, escenarios cubiertos y ausencias de evidencia con motivo.

## Guardas de calidad

Preservá el trabajo previo, registrá comprobaciones observadas y bloqueos reales, respetá permisos y revisá los límites de confianza de la tarea. No sustituyas QA manual ni crees evidencia retrospectiva.
