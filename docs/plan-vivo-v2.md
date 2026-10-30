# Plan Vivo V2 — contratos, ruteo y tablero

Base integrada: `fluws-labs/flufy` `main`, `eba1f55` (0.17.0), mediante el merge
`82973cf`. Rama de trabajo: `codex/plan-vivo-v2`. La rama
`codex/backup-before-plan-v2-20261030` conserva la base local anterior.

Esta implementación incluye preflight, DAG versionado, mutaciones de pendientes,
tablero de escritorio/PWA, ruteo OpenCode y comparación de admisión A/B/C.
Los límites de evaluación de modelos y las fases posteriores se detallan abajo.

## Usar y desactivar

En el chat del equipo, abrir **Configuración → Plan Vivo V2** y activar la opción.
El flag `team.planV2.enabled` comienza en `false`. Se copia al crear el run:
activar o desactivar la preferencia no cambia ejecuciones históricas ni activas.
El chat normal conserva su comportamiento.

La opción **Revisar plan antes de iniciar** guarda el contrato en `plan_ready`.
Los trabajadores esperan **Iniciar plan validado**. Esta espera sobrevive al
reinicio. El inicio vuelve a comprobar el inventario y el digest vigente.

Las ejecuciones V2 abren **Tablero** por defecto. Hay agrupaciones por estado y
por agente, filtros, vista compacta, árbol, dependencias y revisiones. Abrir una
tarjeta muestra criterios, scope, modelo de cada intento, comandos y sesiones.
**Escribir al Lead** vuelve al chat, conservando su borrador.

Arrastrar una tarjeta pendiente sobre otra la prioriza; sobre otra fila de
agente propone reasignación. Ambas acciones tienen alternativa mediante teclado
en el detalle. No se permite arrastrar una tarjeta a una verificación aprobada.
No hay movimiento optimista: se espera el commit nativo y el snapshot.

Para dejar de usar V2, desactivar el flag para objetivos nuevos. Las ejecuciones
V2 existentes deben terminarse o cancelarse con los controles habituales.
Desactivar el flag no revierte código ni degrada el formato de SQLite.

## Contratos y compatibilidad

| Área | Comportamiento implementado |
| --- | --- |
| Descubrimiento | Inventario nativo de lectura, hashes, scripts con archivo de origen, Git/dirty state, límites y ausencia de secretos conocidos. No crea Git ni ejecuta scripts. |
| Plan inválido | Dos reparaciones como máximo; `planning_blocked`, errores tipados y cero trabajadores. Se eliminó el fallback genérico también del planner anterior. |
| Preflight | Validación determinista más revisión independiente de cobertura por el Supervisor antes de despachar. La revisión de un plan no acredita ejecución de tests. |
| Alcance | Scopes relativos, propietario con herramientas habilitadas, DAG, cobertura de requisitos, criterios observables, verificación prevista y fanout justificado. Scopes compartidos pueden serializarse por dependencias. |
| Versionado | Revisión inicial y revisiones append-only con actor, motivo, operación, digest SHA256, padre y recibo. |
| Commit | Estado y revisión se escriben en la misma transacción de `teams.sqlite`; `team://changed` se emite después del commit. |
| Concurrencia | `expectedRevision` y `expectedDigest`; revalidación bajo el lock de admisión. El intento y su reserva son durables antes de crear/enviar la sesión. |
| Pendientes | Añadir, corregir, dividir, reasignar, priorizar, modificar dependencias y cancelar. Nunca se reciclan IDs ni se cambia una tarea que ya tiene intentos. |
| Grupos | No ejecutables; heredan criterios y cobertura a sus hijas, con scopes contenidos y profundidad máxima de tres. El scheduler deriva su finalización. |
| Chat con Lead | Una indicación nueva se convierte en patch o CONTINUE validado. Agregar requisitos exige una indicación durable como procedencia. Mientras se revisa, se frena nuevo dispatch y cierre; las tareas activas conservan su contrato. |
| Verificación | El trabajador debe satisfacer las comprobaciones preestablecidas, además de justificar sus propios checks con comandos/observaciones reales y revisión. |
| Recuperación | Se conservan las sesiones e intentos existentes; no se repiten prompts ciegamente. El registro local evita duplicar schedulers. |
| Tablero | Proyección de `Run/Task/Attempt/Review`; sin estado Kanban mutable separado, sin sesiones o actividad inventadas. Un completado sin evidencia sigue en Verificando. |
| Reconexión | Snapshot durable, secuencia creciente por run y descarte de snapshots atrasados. Los conflictos refrescan la interfaz. |
| QA | El cierre comprobado conserva la aceptación manual existente. Arrastrar no aprueba QA. |
| Uso | Costo/tokens ausentes son `null`, no cero. Los importes visibles provienen de metadata de OpenCode. |

El esquema SQLite pasa a **3**. Se leen versiones 1 y 2 con defaults; antes de
migrarlas se conserva el documento exacto en `team_store_migration_backup` dentro
de la misma base. Una versión futura desconocida se rechaza preservando el
original. Un binario anterior puede rechazar esquema 3: el rollback de datos
requiere exportación/restauración deliberada, nunca sustituir una base WAL viva.

IPC de escritorio: `team_chats_planner`, `preview_plan_patch`, `apply_plan_patch`.
Preview y apply comparten la misma simulación. Los errores de preview no mutan
estado. Repetir el mismo `operationId` devuelve el recibo previo; usarlo para otro
contenido se rechaza. El actor se fija en Rust, no en el payload del cliente.
El endpoint antiguo de reasignación no puede saltar el protocolo V2.

## Verificación reproducible

La suite existente se amplió; no se introdujo otro scheduler ni otro motor.
Los harnesses nativos usan OpenCode real, Tauri y SQLite reales con inferencia
determinista servida por loopback, sin cuentas pagas ni repositorios del usuario.

```powershell
npm test
cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=2
npm run build
npm run build:pwa
npm run lint
npx playwright test tests/e2e/teams.spec.ts --workers=1
node tests/teams-engine.mjs --plan-v2
node tests/teams-engine.mjs --invalid-plan-v2
node tests/teams-restart.mjs --plan-v2
```

Fixtures nuevos: veinte propuestas inválidas distintas, scopes anidados y
secuenciales, fanout por antichain, cien conflictos de revisión, conservación de
intentos activos, división sin ampliar scope, procedencia de requisitos, rollback
de una escritura SQLite fallida e idempotencia tras releer la base. La interfaz
prueba sesiones reales representadas por snapshot, falso completado, reload,
arrastre, teclado, conflicto entre ventanas y viewport móvil con movimiento
reducido. El harness de reinicio termina procesos reales, verifica un solo efecto
y comprueba que revisión y digest se conservan.

El baseline JavaScript recién integrado de 0.17.0 pasó sus 90 tests antes de los
cambios. Los resultados de esta entrega se registran en
`docs/validacion-plan-vivo-v2.md`; no confundir fixtures deterministas con un
benchmark de calidad de modelos.

## Ruteo automático y PWA

En Configuración del equipo → Ruteo automático de modelos se habilita el selector
para próximos objetivos V2. Las categorías son quick, deep, visual, code, review
y local. Cada una admite un principal y dos alternativas. Sólo aparecen modelos
conectados al catálogo OpenCode existente y capacidades observadas. Sin cadena
explícita, la selección permanece en el proveedor asignado. Se puede fijar el
modelo manual por integrante, incluidas sus variantes. No se inventan cuentas,
precios, cuotas ni latencias.

El selector actúa antes de crear sesiones de trabajadores y agentes de apoyo;
el Lead conserva su selección manual para planificación y coordinación. Las
herramientas, skills y writePaths autorizados se conservan. Un modelo ausente,
variante no disponible o capacidades insuficientes puede dar paso al siguiente
candidato configurado antes del dispatch. Una sesión ya creada conserva su
modelo: fallas de credenciales/cuota o transporte pasan por la recuperación
existente, sin probar cuentas alternas tras efectos. La decisión y los motivos
de descarte quedan en el intento/informe de apoyo; se muestran en el detalle del
tablero. El límite de trabajadores por proveedor es por ejecución y no incluye
las llamadas de supervisión; la espera no abre una sesión ni envía prompts.

La PWA incluye «Equipos y tablero» con lista de ejecuciones, las cuatro vistas
compartidas, controles de ejecución, edición de pendientes mediante PlanPatch,
mensajes al Lead, sesiones y evidencias registradas. Usa el mismo Hub autenticado
con token y Tailscale/loopback, sin otro puerto ni API pública. Las capturas PNG
se contrastan con el hash guardado; los textos usan el lector sanitizado existente.
No expone instrucciones privadas, baselines o la ubicación de evidencias.

Después de cada commit durable, Rust invalida el tablero por el stream Hub
existente. El móvil agrupa invalidaciones, consulta snapshots con secuencia,
descarta respuestas viejas y vuelve a consultar al reconectar. También hay
polling visible cada cinco segundos. Al perder conexión se conserva sólo el
último snapshot en memoria con acciones bloqueadas; al revocar acceso se retira
el snapshot. Un conflicto refresca el plan sin reenviar operaciones. Los cambios
remotos usan el validador nativo y actor user; no aceptan estados de tareas como
instrucciones. Chats archivados permanecen de sólo lectura.

## Benchmarks comparativos

`npm run benchmark:plan-v2` genera una comparación A/B/C de admisión y ruteo con
treinta escenarios versionados, baseline original fijado por commit y SHA-256,
mismas propuestas finales y permisos. El resultado observado admite los 10
contratos válidos en los tres brazos; de los 20 inválidos A admite 20 (9 sustituidos
por fallback genérico), B y C admiten 0. En el catálogo de estrés, sólo C encuentra
una alternativa compatible para los 10 válidos. El catálogo de estrés excluye
deliberadamente el modelo asignado: no estima frecuencia real de desconexiones.

Estos números no miden implementaciones completas, calidad de modelos, primera
propuesta, cuota ni ahorro. El importador `benchmark:plan-v2:results` compara
exportaciones reales con veredictos independientes ligados por hash, comprueba
controles A/B y B/C y mantiene desconocidas las métricas sin evidencia. No lanza
inferencia paga. El formato, comandos y límites están en
[`benchmarks/plan-v2/README.md`](../benchmarks/plan-v2/README.md).

## Límites y fases posteriores

- El inventario se limita a profundidad 5, 500 archivos, 128 KB por archivo y
  aproximadamente 8 MB por repositorio. El reporte señala recortes; el Lead debe
  leer lo pertinente. Los hashes no acreditan comportamiento.
- La cobertura semántica requiere juicio del Supervisor; no es una prueba formal
  de que el lenguaje natural fue interpretado correctamente.
- Se reutilizan permisos de OpenCode y propiedad de archivos. Una shell
  autorizada no es un sandbox de sistema operativo por `writePaths`. No se
  afirma aislamiento de procesos ni de efectos externos; worktrees y aislamiento
  reforzado siguen siendo una fase separada.
- La vista Dependencias representa relaciones; todavía no es un lienzo DAG
  navegable con análisis visual de camino crítico.
- OpenCode sólo expone una conexión por ID de proveedor en el catálogo actual.
  capabilityScope identifica ese alcance; no promete varias cuentas del mismo
  proveedor. Ollama y runtimes adicionales no están disponibles en esta conexión;
  la categoría local no inventa un adaptador ni un modelo seleccionable.
- Las comparaciones de treinta implementaciones reales con inferencia pareada,
  intervenciones observadas, usabilidad y herramientas externas siguen requiriendo
  ejecuciones y evaluación independientes. No hay resultados de superioridad ni
  reducción de costos/intervenciones publicados.
- Activación por defecto, distribución firmada y QA final del usuario requieren
  completar sus gates. Esta entrega no publica ni instala nada.
