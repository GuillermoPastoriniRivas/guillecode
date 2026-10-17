# Validación de Equipos IA

Fecha: 17/10/2026. Repositorio de trabajo: `D:\APK\guillecode`.

## Resultados observados

| Comprobación | Resultado |
| --- | --- |
| `npm test` | 39 pruebas pasaron; 0 fallos; incluye captura real con navegador |
| `npm run test:e2e -- --workers=2` | 60 pruebas pasaron; 0 fallos |
| E2E finales de equipos usando los PNG de la integración nativa | 3 pruebas pasaron; 0 fallos; comparación, ampliación, ausencia y entregas anteriores |
| `cargo test --manifest-path src-tauri/Cargo.toml --release --lib` | 91 pruebas pasaron; 3 ignoradas; 0 fallos |
| Pruebas nativas de equipos incluidas en la suite anterior | 15 pruebas pasaron |
| `npm run test:teams` | 1 integración real OpenCode + Tauri pasó; 99,62 segundos de ejecución |
| `npm run test:teams:recovery` | 6 fases en procesos separados pasaron; app y motor terminados forzosamente |
| `npx tsc -b` | Sin errores |
| `npm run lint` | Sin errores; conserva advertencias de archivos existentes |
| `npm run build` | Build de producción correcto |
| `npx tauri build --no-bundle` | Frontend, PWA y aplicación Windows compilados |
| `git diff --check` | Sin errores de whitespace |

La suite E2E completa incluye las últimas funciones de captura, comparador y presupuesto. Después se ampliaron los casos del comparador para usar los PNG producidos por la integración nativa y comparar entregas anteriores; los tres casos de equipos se repitieron y pasaron. La integración nativa verificó también que una preferencia global de autoaprobación no habilita automáticamente los permisos sensibles de una sesión de equipo, y que un chat normal conserva su preferencia.

La integración usa **el motor incluido y el scheduler Rust reales**, archivos y comandos reales, un Tauri aislado y SQLite. Las decisiones de IA provienen de inferencia determinista local: no se usaron cuentas ni tokens reales. Se verificaron:

- Plan válido con Lead y dos empleados que usan modelos explícitos distintos.
- Ejecución y serialización de tareas sobre un repo real descartable.
- Devolución de una tarea con `changes_requested`, segundo intento y aprobación del Lead.
- Cierre global del objetivo y archivos de evidencia existentes con manifest JSON legible.
- Estado `awaiting_manual_qa`, marca durable de aviso y aprobación manual independiente.
- Conservación del archivo del usuario y de su índice Git previamente staged.
- Modelo retirado: bloqueo sin crear sesión de trabajador; reasignación explícita y continuación de la misma tarea, manteniendo intentos anteriores.
- Veredicto de revisión inválido: `review_error`, ejecución bloqueada y ausencia de aviso de finalización; cancelación posterior.
- Recuperación de un checkpoint activo a blocked sin reenviar automáticamente prompts.
- Chrome aislado capturó PNGs de 1280×800 antes de los trabajadores y después de sus cambios. La página local lee los archivos realmente escritos por las herramientas; cambió de «todavía ausente» a «version 2».
- El lector nativo devolvió la imagen registrada y rechazó el mismo PNG tras alterar sus bytes; luego se restauró el original.
- El presupuesto de tokens bloqueó la planificación antes de crear tareas o trabajadores, conservó uso informado por el motor y no notificó «Terminamos».
- Un ajuste explícito del presupuesto quedó auditado; la ejecución continuó sin cambiar el snapshot del chat.
- Un flujo obligatorio no disponible bloqueó la entrega aun con tareas completadas. Al volver a estar disponible, el reintento obtuvo la captura final sin crear más intentos de trabajadores ni reemplazar la ausencia inicial.

La recuperación se probó con terminación real del proceso Windows, no solo modificando un checkpoint:

1. Se terminó Tauri durante un comando que ya había escrito un efecto y seguía esperando.
2. Se abrió otra instancia: el motor todavía ocupado rechazó el reintento.
3. El comando terminó y una nueva instancia recuperó el mismo sessionId/attempt; no hubo otro prompt de implementación.
4. Otra apertura mantuvo la entrega y la marca de aviso, sin replay.
5. Se inició otra ejecución, se terminó Tauri y se terminó también el motor; el harness detuvo la herramienta de espera de su fixture si sobrevivía separada.
6. El motor reabrió su mismo perfil y Tauri continuó en la sesión original: verificó el efecto existente, sin duplicarlo, y entregó con un único intento.

Los dos archivos de efecto contienen exactamente una línea. El archivo previo del usuario se conserva. El reporte durable de la prueba está en `test-results/recovery/report.json`. No se reinició Windows. Las pruebas ignoradas existentes no se cuentan como aprobadas.

## Artefactos locales de esta validación

Ejecutable generado (sin instalar): `src-tauri/target/release/app.exe`, 30.719.488 bytes. SHA-256: `840611C68921AE916B87886F3C9E9982F52D986DED88334F2554FA26BB4ED7B2`. La compilación final terminó correctamente después de la corrección del visor para evidencias expiradas. El motor está junto al ejecutable como `opencode.exe`. No se generó ni se probó un instalador nuevo.

Logs locales, ignorados por Git:

- `tests-js-continuacion.log`
- `e2e-continuacion.log`
- `ui-evidencias-reales.log`
- `native-all-continuacion.log`
- `engine-continuacion.log`
- `recovery-continuacion.log`
- `lint-continuacion.log`
- `desktop-build-continuacion.log`

Capturas CDP reales producidas por el runner nativo, inspeccionadas visualmente:

- `test-results/native-team-evidence/before.png`
- `test-results/native-team-evidence/after.png`
- `test-results/native-team-evidence/observations.json` (HTTP, dimensiones, texto observado, fuente, timestamp y SHA-256).

Capturas de la UI del comparador usando esas imágenes, con IPC simulado:

- `test-results/ui-evidence/teams-comparador-muestra-a-3d354--la-ausencia-de-una-captura/comparador-lado-a-lado.png`
- `test-results/ui-evidence/teams-comparador-muestra-a-3d354--la-ausencia-de-una-captura/comparador-deslizador.png`

Reproducir estas últimas después de `npm run test:teams`:

```powershell
$env:GUILLE_TEAM_VISUAL_EVIDENCE_DIR = "$PWD/test-results/native-team-evidence"
npx playwright test tests/e2e/teams.spec.ts --workers=1 --output=test-results/ui-evidence
```

El directorio separado evita que Playwright borre los PNG del runner al iniciar. Las imágenes muestran un proyecto de prueba que refleja archivos reales; no son capturas de un módulo de usuarios NestJS/GraphQL desarrollado por modelos de producción. Los perfiles y repositorios temporales se eliminan al finalizar sin tocar las cuentas del usuario. Una carpeta temporal de una ejecución anterior quedó conservada porque la política automática rechazó su borrado; su herramienta de espera terminó por la señal normal del propio fixture.

## Inventario de cambios

Nuevos módulos nativos:

- `src-tauri/src/teams/domain.rs`
- `src-tauri/src/teams/mod.rs`
- `src-tauri/src/teams/runner.rs`
- `src-tauri/src/teams/evidence.rs`
- `src-tauri/src/teams/integration.rs`
- `src-tauri/src/teams/capture.rs` y `capture.mjs`
- `src-tauri/src/teams/retention.rs`
- `src-tauri/src/teams/restart_tests.rs`

Integración nativa: `src-tauri/src/lib.rs`, `approvals.rs`, `updates.rs` y `agent_policy.js`.

Nuevos módulos frontend:

- `src/team/types.ts` y `src/team/session-index.ts`
- `src/state/teams.ts`
- `src/views/TeamsView.tsx`
- `src/editor/TeamEditor.tsx`
- `src/agent/TeamChat.tsx`
- `src/styles/teams.css`
- `src/team/EvidenceSettings.tsx`, `EvidenceComparison.tsx` y `RunBudget.tsx`
- `src/lib/reviewResult.ts`

Integración frontend: `AgentPanel.tsx`, `SessionTabs.tsx`, `EditorArea.tsx`, `Workbench.tsx`, `Chrome.tsx`, `AgentsView.tsx`, `commands/builtin.ts`, `state/layout.ts`, `state/editors.ts`, `state/approvals.ts`, `lib/ai.ts` y `main.tsx`.

Pruebas y documentación: `tests/teams-engine.mjs`, `tests/teams-restart.mjs`, `tests/team-capture.test.ts`, `tests/e2e/teams.spec.ts`, `tests/review-result.test.ts`, `tests/agent-policy.test.ts`, `tests/e2e/session-archive.spec.ts`, `package.json`, `README.md` y los documentos de esta carpeta.

## Alcance aún pendiente

Ver [validaciones manuales y límites](equipos-ia.md#validaciones-manuales-y-límites). Capturas, comparador, presupuestos, retención y reinicios de app/motor están implementados y probados. Sigue pendiente la historia concreta NestJS + GraphQL + React con cuentas/modelos de producción, reiniciar Windows durante una tarea y verificar manualmente las notificaciones Windows/push. No se instaló la aplicación compilada sobre el perfil del usuario. Esas verificaciones no se presentan como realizadas.
