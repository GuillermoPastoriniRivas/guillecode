# Validación de GuilleCode 0.14.1

Fecha: 17/10/2026. Windows x64; repositorio `D:\APK\guillecode`.

| Comprobación | Resultado observado |
| --- | --- |
| JS (`npm test`) | 48 aprobadas, 0 fallos |
| UI (`npm run test:e2e`) | 68 aprobadas, 0 fallos |
| Rust, release + desktop-e2e | 95 aprobadas, 7 ignoradas, 0 fallos; integraciones opt-in ejecutadas por separado |
| TypeScript / lint | Sin errores; advertencias previas de lint conservadas |
| Integración nativa de equipos | Aprobada: OpenCode, Tauri, SQLite, herramientas, archivos, revisión y capturas reales |
| Recuperación | Seis fases aprobadas: terminación real de app y motor, sesión/intento conservados y efecto exactamente una vez |
| Descarga nativa Tauri | Error HTTP y firma inválida rechazados; firma válida verificada y bytes conservados al consultar otra vez |
| Actualización NSIS | 0.14.1 → 0.14.2 aislada: silenciosa, relanzamiento automático, conversación/preferencias conservadas, motor huérfano cerrado sin cerrar el de otra instalación |
| Instalación real del usuario | 0.14.1 instalada; NSIS exit 0; huella canónica coincide y clave pública propia verificada |
| Perfil real del usuario | Snapshots de chats e IDs de equipos iguales al respaldo; catálogo de 13 skills, versión 2 |

El catálogo incluye las 13 skills del documento aportado, adaptadas a los contratos del runner. Los tests cubren frontmatter, guardas de frontend/backend, versiones, perfiles combinables y conservación de instrucciones/modelos/skills personalizadas. La migración nativa es idempotente y conserva snapshots históricos. El Lead usa sus skills durante planificación, revisión y cierre.

La integración nativa usa el motor distribuido y herramientas reales con inferencia determinista local. La página capturada lee los archivos escritos por el equipo; las imágenes cambian desde módulos ausentes a `version 2`. Se verifica el rechazo de una imagen alterada, el bloqueo por captura obligatoria ausente y la recuperación de la captura final sin repetir trabajadores. El índice Git y cambios previos del fixture se conservan.

La recuperación termina procesos reales de Windows; no reinicia Windows. Reabre el mismo perfil del motor y mantiene sessionId/attempt, entrega durable y cambios previos. Las pruebas ignoradas no se cuentan como aprobadas. El estado de entrega sigue siendo pendiente de QA manual del usuario.

Playwright escribe en `test-results/playwright/`, separado de las capturas nativas y reportes de reinicio, para no borrarlos al empezar otra suite. Logs y evidencias locales de prueba están ignorados por Git. No se publica ningún perfil, credencial ni base del usuario.

Se repitieron las cuatro pruebas de Equipos IA cargando los PNG de la integración nativa: todas aprobadas. Evidencias conservadas: `test-results/native-team-evidence/before.png`, `after.png`, `observations.json`; comparador en `test-results/playwright/teams-comparador-muestra-a-3d354--la-ausencia-de-una-captura/`; reporte durable en `test-results/recovery/report.json`.

La validación de repositorios rechaza una carpeta sin Git antes de crear ejecución o evidencias. El test confirma que no inicializa Git ni modifica el archivo previo del usuario. En esta PC se observó que `E:\equipo` carecía de repositorio; no se inicializó automáticamente.

Para el canal propio se conserva `com.guillecode.desktop`, se cambia el endpoint a `Kaitach/guillecode` y se usa una clave privada propia fuera del repositorio. La protección nativa sigue rechazando una compilación productiva apuntada al endpoint original. El paquete de skills contiene solo archivos públicos del catálogo.

El ensayo completo por CDP no pudo conectarse al puerto de WebView2 de la app instalada, aun con flags explícitos; no se cuenta como aprobado. La ventana de prueba sí se observó iniciada. Se ejecutaron en su lugar dos verificaciones independientes reales: comandos de descarga del updater desde Tauri y reemplazo/relanzamiento con NSIS. `npm run test:upgrade:native` reproduce ambas y el workflow de preparación las exige antes de compilar la release productiva. Los instaladores QA quedan excluidos de los assets de release.

Huella canónica de la compilación final para instalar/publicar: `4cb7794f11735a3810b7cf250d4a05ed7f333657186d2c35e19540149bd1bd2d`. Se normaliza únicamente el marcador UNK/NSS que Tauri modifica al empaquetar; cualquier otra diferencia cambia la huella.
