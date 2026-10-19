# Validación 0.14.3 — trabajo simultáneo y coordinación

El Lead prepara un plan breve con propiedad de escritura. Frontend, Backend y la preparación de QA pueden avanzar juntos dentro de la misma carpeta. Solo los archivos compartidos y las dependencias necesarias esperan. El equipo predeterminado admite tres tareas simultáneas y una por integrante.

Si Frontend necesita una entrega de Backend, puede enviar un pedido al Lead. El Lead recibe el estado actual, inspecciona archivos mediante herramientas de lectura y deja una respuesta visible en Actividad. Puede esperar el trabajo asignado o añadir una tarea faltante. La continuación reutiliza la sesión y el intento del solicitante, con contexto y herramientas previas; no reinicia el objetivo.

La edición nativa está limitada a `writePaths`; el shell conserva los permisos independientes de OpenCode. Las tareas sin alcance explícito mantienen la exclusión de carpeta completa. Los datos antiguos se deserializan con valores por defecto y conservan sus snapshots.

## Pruebas reproducibles

- `npm test`, `npm run lint`, `npm run build`, `npm run build:pwa`.
- `npx playwright test tests/e2e/teams.spec.ts tests/e2e/session-recovery.spec.ts`: 21 pruebas aprobadas, incluido el pedido Frontend → Lead, la respuesta, el estado de Backend y las protecciones de permisos.
- `cargo test --manifest-path src-tauri/Cargo.toml --release --locked --lib --features desktop-e2e`: 110 aprobadas y 7 omitidas por requerir sus harnesses o interacción de escritorio. Valida alcances, locks, capacidad, ciclos y migración durable. También comprueba tareas nuevas del Lead, rechazo de reemplazos de tareas activas y la carrera en que una entrega termina durante la revisión. Los harnesses de equipos y reinicio se ejecutaron aparte.
- `node tests/teams-engine.mjs` y `--no-git`: motor OpenCode real y scheduler Rust real, con inferencia determinista de loopback. Una barrera exige que ambos trabajadores empiecen dentro de la misma carpeta antes de responder; la prueba falla si se serializan. El Lead inspecciona Backend activo, espera y vuelve a revisar su entrega antes de reanudar Frontend. Se conservan comprobaciones observadas, revisión con corrección, capturas antes/después, recuperación de captura obligatoria y cambios previos.
- `node tests/teams-restart.mjs --no-git`: terminación forzada de aplicación y motor, continuación en la misma sesión/intento y efecto aplicado una sola vez.
- `node tests/teams-restart.mjs --coordination --no-git`: dos trabajadores activos, un pedido en espera persistido y terminación real del proceso. Al reabrir se comprueba que el motor ocupado impide una repetición; después se resuelve el mismo pedido y se continúa la misma sesión de Frontend. El efecto de Backend aparece una sola vez y se conserva el archivo previo del usuario. Informe local en `test-results/coordination-recovery-no-git/report.json`.

Estas pruebas usan perfiles y proyectos descartables, sin cuentas reales ni consumo de tokens. Las capturas del proyecto se obtienen mediante CDP real; la imagen de la interfaz usa datos E2E controlados. Queda pendiente el QA manual del usuario con su proveedor y proyecto.

## Capturas guardadas

- [Proyecto antes](evidencias/0.14.3-proyecto-antes.png) y [después](evidencias/0.14.3-proyecto-despues.png): imágenes CDP del proyecto que los trabajadores modificaron realmente.
- [Pedido y respuesta del Lead](evidencias/0.14.3-coordinacion.png): interfaz real renderizada con datos controlados de E2E.
