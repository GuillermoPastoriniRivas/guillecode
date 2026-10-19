# Validación 0.14.4

Versión publicada: [GuilleCode 0.14.4](https://github.com/Kaitach/guillecode/releases/tag/v0.14.4). Código del instalador: `817d78ee9b430785d02b0ae0475d382d09629c8c`.

La interfaz presenta el protocolo interno de Equipos IA como planes, resultados, pedidos al Lead y revisiones legibles. Los textos largos se dividen en párrafos; las instrucciones internas quedan plegadas. También funciona con respuestas históricas y mientras llega una respuesta por partes. El contenido original se conserva para el runner. El JSON solicitado en chats normales sigue visible. Una aprobación sin criterios confirmados no se presenta como válida.

Los errores del proveedor, de Git opcional, del plan y de las comprobaciones se explican en español, sin mostrar encabezados ni credenciales. Se retiró del chat el bloque de tokens y costo de la ejecución. Las comprobaciones observadas mediante PowerShell son válidas: bash es el nombre de la herramienta del motor, y no exige instalar Bash o WSL.

## Pruebas aprobadas

- Unitarias: 55.
- Interfaz completa en Actions: 74. Incluye historial, streaming parcial, recarga, errores, conversaciones normales, equipos y comparador de evidencias. La selección local de equipos y recuperación pasó 23 pruebas.
- Rust: 112 correctas, 0 fallidas, 4 ignoradas.
- Integración: motor OpenCode real y scheduler Rust con inferencia determinista local; ejecución simultánea, carpetas con y sin Git, recuperación de efectos y coordinación tras reiniciar.
- Descarga nativa firmada: rechaza fallos HTTP y firmas inválidas; verifica el instalador válido y conserva los bytes descargados entre consultas.
- NSIS real: reemplaza la instalación, libera su motor huérfano, conserva otro motor y mantiene la conversación y las preferencias.

[Preparación completa en verde](https://github.com/Kaitach/guillecode/actions/runs/39188549307). [Publicación en verde](https://github.com/Kaitach/guillecode/actions/runs/39192336303).

## Prueba real en la PC

Desde la interfaz se creó un equipo de Lead, QA, Backend y Frontend en una carpeta vacía sin Git. Los tres trabajos independientes comenzaron con una diferencia de 40 ms. Las cuatro tareas terminaron; QA ejecutó dos veces la integración HTTP con salida 0, comprobando JSON, CORS, HTML, CSS, JavaScript y respuestas 404.

En un navegador real se comprobaron los dos saludos, el error legible al detener únicamente el backend propio y la recuperación mediante el botón de reintento al reiniciarlo. Se probaron también los puertos ocupados: ambos servidores y QA rechazaron el conflicto con salida 1 y un motivo claro, conservando los procesos existentes.

La misma revisión del Lead que antes mostraba JSON se abrió tras actualizar y después de reiniciar el proceso: presentó texto legible. Se compararon los documentos de equipos y los IDs y contenidos de mensajes y herramientas con el backup privado: quedaron idénticos, sin repetir tareas. Hay capturas reales anteriores, posteriores y de la página recuperada; permanecen locales para no publicar contenido del perfil.

Se descargó el instalador generado por Actions, se verificaron su SHA256 y su firma Minisign con la clave pública configurada y se instaló en la PC. El hash canónico del ejecutable instalado coincide con release-info.json. Se conservó el perfil y se verificó la integridad SQLite. El canal público latest.json responde sin autenticación con la versión y firma correctas. El paquete exportado contiene 13 skills válidas.

## Alcance de la prueba de actualización

En el runner elevado, RunAsUser delega a Explorer y no hereda el entorno aislado de QA, aunque exista el shell. El harness verifica reemplazo y conservación y arranca explícitamente la app con ese entorno: el informe de Actions declara automaticRelaunchTested=false. En el escritorio local no elevado se exigió y pasó además el relanzamiento automático con /R. El informe se publica como artefacto sin credenciales ni contenido de conversaciones.

La cobertura combina descarga nativa firmada y reemplazo NSIS; no acredita una prueba automatizada del clic del botón Actualizar. La aceptación final del proyecto de ejemplo sigue disponible para el usuario en GuilleCode.

El instalador compara rutas reales de Windows para reconocer también alias y rutas abreviadas. La regresión de limpieza verifica que se cierre únicamente el motor de esa instalación y que un bloqueo ajeno impida continuar. Referencia: [RunAsUser de Tauri](https://github.com/tauri-apps/nsis-tauri-utils/blob/dev/crates/nsis-process/src/lib.rs).
