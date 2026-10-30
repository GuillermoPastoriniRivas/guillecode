# Validación local de Plan Vivo V2

Fecha: 30/10/2026 (America/Montevideo). Base Flufy 0.17.0 `eba1f55`, integrada
en `82973cf`, rama `codex/plan-vivo-v2`.

## Resultados observados

| Comprobación | Resultado |
| --- | --- |
| Baseline JavaScript de Flufy 0.17.0, antes de los cambios | 90 aprobadas |
| `npm test` después de los cambios | 97 aprobadas |
| `cargo test --manifest-path src-tauri/Cargo.toml --release --lib --features desktop-e2e -- --test-threads=2` | 184 aprobadas, 9 ignoradas, 0 fallos; los harnesses opt-in relevantes se ejecutaron por separado |
| `cargo check --tests --lib --features desktop-e2e` | Correcto |
| `npm run build` | Correcto: TypeScript y Vite |
| `npm run build:pwa` | Correcto |
| `npm run lint` | Exit 0; conserva avisos preexistentes |
| Playwright Teams + PWA Teams + PWA Live | 41 aprobadas en una ejecución conjunta; 32 Teams, 5 PWA Teams y 4 PWA Live |
| `npx playwright test tests/e2e/pwa-teams.spec.ts --workers=1` | 5 aprobadas: cambios/controles/evidencia, resincro, conflictos, falta de token y revocación |
| `npx playwright test tests/e2e/pwa-live.spec.ts --workers=1` | 4 aprobadas; conserva conversación móvil y eventos |
| `node tests/teams-engine.mjs --plan-v2` | Correcto, integración Tauri/OpenCode/SQLite real con inferencia loopback |
| `node tests/teams-engine.mjs --plan-v2 --no-git` | Correcto; la carpeta sigue sin `.git` |
| `node tests/teams-engine.mjs --invalid-plan-v2` | 20 planes inválidos, 40 reparaciones, 0 trabajadores despachados |
| `node tests/teams-restart.mjs --plan-v2` | Correcto: procesos de app y motor terminados realmente; mismas sesiones/intentos, revisión y digest conservados, un solo efecto por escenario |
| `node tests/teams-engine.mjs --plan-v2 --routing` | Correcto: candidato ausente descartado, modelos reales del fixture seleccionados, recibos durables y herramientas ejecutadas por OpenCode real |
| `node tests/teams-engine.mjs --plan-v2 --routing --no-git` | Correcto: 43,58 s de ejecución nativa; carpeta sin Git conservada |
| `node tests/teams-restart.mjs --plan-v2 --routing` | Correcto: tras terminar app y motor, conserva también el recibo exacto de ruteo y registra un solo efecto |
| `npm run benchmark:plan-v2` | 30 escenarios A/B/C medidos; ver tabla y alcance abajo |
| `cargo build --manifest-path src-tauri/Cargo.toml --release --bin app` | Build Windows correcto: `src-tauri/target/release/app.exe` |
| `npx tauri build --no-bundle --ci` | Producción Windows correcta, con builds actuales de escritorio y PWA; sin generar instalador |

La integración V2 también rechaza una propuesta determinísticamente válida a la
que el Supervisor detecta falta de cobertura: queda `planning_blocked`, sin tareas
ejecutables ni revisión inicial. El caso válido pasa por el gate de revisión del
plan, preview sin mutación, apply idempotente, una indicación nueva del usuario
convertida en Plan v3, trabajadores paralelos, checks preestablecidos y cierre
sin conceder QA humano.

La recuperación real recorrió `prepare → busy → resume → reopen` y
`prepare_engine → resume_engine`. El reporte del harness conserva
`planRevision`, `planDigest`, sesión, cantidad de intentos y número de efectos:
`test-results/recovery/report.json`.

La batería de interfaz cubre también los flujos previos de chat normal,
conversación con Lead, imágenes, navegador, equipos, modelos, historial y QA.
Los casos nuevos verifican ausencia de verde sin evidencia, tarjetas únicas tras
notificaciones duplicadas/snapshots, reload, priorización con teclado, arrastre
validado, conflicto con otra revisión y viewport de 390×844 con movimiento
reducido. Los mocks de IPC son exclusivos de tests; producción deriva el tablero
del estado nativo persistido.

## Evidencia visual revisada

Capturas generadas y examinadas durante Playwright:

- `test-results/playwright/teams-Plan-Vivo-las-tarjet-932fa--y-reconstruyen-el-snapshot/plan-vivo-por-agente.png`
- `test-results/playwright/teams-Plan-Vivo-móvil-y-mo-b88f6--y-los-criterios-accesibles/plan-vivo-movil-bloqueado.png`

La inspección visual detectó una colisión del nombre CSS `todo` con el chat
normal. Se corrigió usando clases `is-*`, y el test comprueba que las tarjetas no
colapsan horizontalmente. También se despejó el compositor del tablero para
conservar superficie útil sin perder el acceso al Lead.

## Alcance de esta validación

Los tests nativos usan el binario real de OpenCode fijado por el proyecto,
repositorios/carpetas desechables, sesiones reales y transacciones SQLite reales.
La inferencia es determinista y local: esto verifica el protocolo y sus efectos,
**no** mide calidad general de modelos, costos de cuentas o superioridad frente
a CodeAF/Oh My Hermes. No se usaron cuentas pagas.

El ruteo automático y el tablero PWA están implementados. Los flags experimentales
permanecen OFF por defecto. La aceptación manual de producto, distribución firmada
y comparación de calidad de treinta implementaciones completas siguen pendientes.
Ver `docs/plan-vivo-v2.md` para contratos, uso, compatibilidad, rollback y límites.

Binario local generado: `D:/APK/guillecode/src-tauri/target/release/app.exe`.
SHA256 del build de producción sin bundle: `8ff337f75aebc15e636cb88745adfdce3e02a66313cd6ecf02ad8aa1cdab005f`.
No se publicó una release firmada ni se instaló sobre la aplicación del usuario.

### Instalador local

Se generó también `src-tauri/target/release/bundle/nsis/flufy_0.17.0_x64-setup.exe`
(53.006.762 bytes) con `tauri build --bundles nsis --no-sign --ci` y un override
local de `bundle.createUpdaterArtifacts=false`. La configuración oficial del
updater y sus claves públicas permanecen intactas. Este paquete local no tiene
firma digital ni se publicó en GitHub Releases.

SHA256 del instalador: `9f0cf3867c4dbfd58921d919ac28f5914762159a9da16517a6716bade1848504`.
SHA256 del ejecutable preparado por NSIS: `13ff3daea7d72c025814915dca103ef03d21bbc0dcef7142893ed4e000ca581f`.
Para instalar manualmente, cerrar Flufy también desde la bandeja y ejecutar el
setup. Después se habilita Plan Vivo V2 y el ruteo desde Configuración del equipo.

## Hub autenticado y ruteo

El harness nativo envía solicitudes HTTP reales al handler Hub en loopback con
un puerto efímero y token aislado. Comprueba 401 sin token, 400 por run de otro
chat, rechazo de status suministrado por el cliente y de rutas de evidencia no
registradas, 409 por revisión vieja, aplicación de un patch válido, recibo idéntico
al repetirlo, 401 después de rotar el token y 403 al apagar acceso remoto.
Esas pruebas usan Tauri y SQLite reales; los tests PWA simulan solamente la red.

El catálogo exportado contiene capacidades/modelos habilitados, nunca claves.
Cinco tests nuevos cubren alcance del proveedor, conservación de permisos,
alternativas explícitas, capacidad, selección manual/variante y capacidades
desconocidas. El harness de recuperación conserva el recibo completo, incluidas
identidad del modelo y marca de decisión, entre fases y después de ambos reinicios.

Captura móvil local: `test-results/pwa-plan-vivo.png`. La UI comparte componente y
estilos del tablero con escritorio, permite teclado, agrupa eventos y consulta
snapshots. Se verifica que un estado completed sin recibo de revisión y comandos
observados permanece Verificando. Un conflicto entre ventanas actualiza la
revisión sin volver a enviar la operación; una revocación retira el snapshot.

## Comparación A/B/C ejecutada

Baseline: `eba1f55758792f972014987da17af8ab891ed16c`.
Corpus SHA-256: `8476c03f0ae7559085707a07963672519bfe1d7d2b93f3ccfa522bd4332a0e19`.

| Métrica observada | A: admisión 0.17.0 | B: V2/manual | C: V2/ruteo |
| --- | ---: | ---: | ---: |
| Contratos válidos admitidos / 10 | 10 | 10 | 10 |
| Contratos inválidos admitidos / 20 | 20 | 0 | 0 |
| Sustituciones genéricas / 30 | 9 | 0 | 0 |
| Válidos con alternativa compatible seleccionada / 10 | 0 | 0 | 10 |

La comparación mide la frontera de admisión tras reparaciones y el selector
anterior a una sesión. El catálogo de estrés excluye deliberadamente el modelo
asignado. No mide frecuencia real de fallas ni ejecuta treinta implementaciones.
Objetivo verificado, costo e intervención quedan null en este reporte; las
duraciones JSON son tiempo local de validación, no latencia de inferencia.
Los reportes están en `test-results/benchmarks/plan-v2.json` y `plan-v2.md`.

Se implementó además un importador de ejecuciones exportadas y veredictos
independientes vinculados por SHA-256. Rechaza controles A/B no pareados, cambios
de objetivo y veredictos correspondientes a otra ejecución. Los tests prueban que
una narración de completado no alcanza, que pérdida de requisitos, tests fallidos
o efectos duplicados impiden éxito y que datos ausentes permanecen desconocidos.
El formato está en `benchmarks/plan-v2/README.md`. No se midieron CodeAF/Oh My Hermes.
