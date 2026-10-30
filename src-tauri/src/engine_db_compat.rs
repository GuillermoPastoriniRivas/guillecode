//! Keeps the bundled OpenCode 1.x server able to start against a database
//! whose `workspace` table was created by OpenCode 2.x. The migration is
//! intentionally additive: it restores the legacy columns and empty support
//! tables removed by 2.x, and leaves every existing row and credential alone.

use rusqlite::{backup::Backup, Connection, OpenFlags, TransactionBehavior};
use std::path::{Path, PathBuf};
use std::time::Duration;

const WORKSPACE_COLUMNS: [(&str, &str); 7] = [
    ("type", "TEXT NOT NULL DEFAULT 'local'"),
    ("name", "TEXT NOT NULL DEFAULT ''"),
    ("branch", "TEXT"),
    ("directory", "TEXT"),
    ("extra", "TEXT"),
    ("project_id", "TEXT NOT NULL DEFAULT ''"),
    ("time_used", "INTEGER NOT NULL DEFAULT 0"),
];

const SESSION_INPUT_INDEXES: [&str; 3] = [
    "session_input_session_pending_delivery_seq_idx",
    "session_input_session_admitted_seq_idx",
    "session_input_session_promoted_seq_idx",
];

pub(crate) fn prepare_legacy_engine_database() -> Result<(), String> {
    let Some(path) = crate::usage::opencode_data().map(|dir| dir.join("opencode.db")) else {
        return Ok(());
    };
    if !path.is_file() {
        return Ok(());
    }
    prepare_database_at(&path).map(|_| ())
}

fn prepare_database_at(path: &Path) -> Result<bool, String> {
    let mut conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("no se pudo abrir opencode.db: {e}"))?;
    conn.busy_timeout(Duration::from_secs(20))
        .map_err(|e| format!("no se pudo esperar a opencode.db: {e}"))?;

    let workspace_columns = table_columns(&conn, "workspace")?;
    if !workspace_columns.contains("provider") || !workspace_columns.contains("binding") {
        return Ok(false);
    }

    if !table_exists(&conn, "session")? {
        return Err("la base usa el esquema OpenCode 2.x pero no contiene las sesiones V1 que Flufy necesita; no se modificó".into());
    }
    validate_existing_legacy_table(&conn, "data_migration", &["name", "time_completed"])?;
    validate_existing_legacy_table(
        &conn,
        "session_context_epoch",
        &["session_id", "baseline", "snapshot", "baseline_seq"],
    )?;
    validate_existing_legacy_table(
        &conn,
        "session_input",
        &[
            "id",
            "session_id",
            "prompt",
            "delivery",
            "admitted_seq",
            "promoted_seq",
            "time_created",
        ],
    )?;

    let has_missing_workspace_columns = WORKSPACE_COLUMNS
        .iter()
        .any(|(name, _)| !workspace_columns.contains(*name));
    let mut has_missing_tables = false;
    for table in ["data_migration", "session_context_epoch", "session_input"] {
        has_missing_tables |= !table_exists(&conn, table)?;
    }
    let mut has_missing_indexes = false;
    for index in SESSION_INPUT_INDEXES {
        has_missing_indexes |= !index_exists(&conn, index)?;
    }
    if !has_missing_workspace_columns && !has_missing_tables && !has_missing_indexes {
        return Ok(false);
    }

    let backup_path = create_backup(&conn, path)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| {
            format!(
                "no se pudo iniciar la migración (copia previa: {}): {e}",
                backup_path.display()
            )
        })?;
    let workspace_columns =
        table_columns(&tx, "workspace").map_err(|e| with_backup(e, &backup_path))?;
    if !workspace_columns.contains("provider") || !workspace_columns.contains("binding") {
        return Err(with_backup(
            "el esquema de workspace cambió durante la preparación; no se modificó la base".into(),
            &backup_path,
        ));
    }
    for (name, definition) in WORKSPACE_COLUMNS {
        if !workspace_columns.contains(name) {
            tx.execute_batch(&format!(
                "ALTER TABLE workspace ADD COLUMN {name} {definition}"
            ))
            .map_err(|e| {
                with_backup(
                    format!("no se pudo restaurar workspace.{name}: {e}"),
                    &backup_path,
                )
            })?;
        }
    }

    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS data_migration (
            name TEXT PRIMARY KEY,
            time_completed INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS session_context_epoch (
            session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
            baseline TEXT NOT NULL,
            snapshot TEXT NOT NULL,
            baseline_seq INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS session_input (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
            prompt TEXT NOT NULL,
            delivery TEXT NOT NULL,
            admitted_seq INTEGER NOT NULL,
            promoted_seq INTEGER,
            time_created INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS session_input_session_pending_delivery_seq_idx
            ON session_input(session_id, promoted_seq, delivery, admitted_seq);
         CREATE UNIQUE INDEX IF NOT EXISTS session_input_session_admitted_seq_idx
            ON session_input(session_id, admitted_seq);
         CREATE UNIQUE INDEX IF NOT EXISTS session_input_session_promoted_seq_idx
            ON session_input(session_id, promoted_seq);",
    )
    .map_err(|e| {
        with_backup(
            format!("no se pudieron restaurar las tablas auxiliares de OpenCode: {e}"),
            &backup_path,
        )
    })?;

    for (table, required) in [
        ("data_migration", &["name", "time_completed"][..]),
        (
            "session_context_epoch",
            &["session_id", "baseline", "snapshot", "baseline_seq"][..],
        ),
        (
            "session_input",
            &[
                "id",
                "session_id",
                "prompt",
                "delivery",
                "admitted_seq",
                "promoted_seq",
                "time_created",
            ][..],
        ),
    ] {
        let columns = table_columns(&tx, table).map_err(|e| with_backup(e, &backup_path))?;
        if required.iter().any(|column| !columns.contains(*column)) {
            return Err(with_backup(format!("la tabla {table} no tiene el esquema compatible esperado; se revirtió la transacción"), &backup_path));
        }
    }
    for index in SESSION_INPUT_INDEXES {
        if !index_exists(&tx, index).map_err(|e| with_backup(e, &backup_path))? {
            return Err(with_backup(
                format!("no se creó el índice requerido {index}; se revirtió la transacción"),
                &backup_path,
            ));
        }
    }

    tx.commit().map_err(|e| {
        with_backup(
            format!("no se pudo confirmar la migración: {e}"),
            &backup_path,
        )
    })?;

    log::info!(
        "OpenCode: se restauró de forma aditiva el esquema V1 necesario para compatibilidad con la base existente; copia previa: {}",
        backup_path.display()
    );
    Ok(true)
}

fn table_columns(
    conn: &Connection,
    table: &str,
) -> Result<std::collections::HashSet<String>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| format!("no se pudo inspeccionar la tabla {table}: {e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("no se pudo leer el esquema de {table}: {e}"))?;
    rows.collect::<Result<std::collections::HashSet<_>, _>>()
        .map_err(|e| format!("no se pudo leer el esquema de {table}: {e}"))
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |row| row.get(0),
    )
    .map_err(|e| format!("no se pudo comprobar la tabla {table}: {e}"))
}

fn index_exists(conn: &Connection, index: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1)",
        [index],
        |row| row.get(0),
    )
    .map_err(|e| format!("no se pudo comprobar el índice {index}: {e}"))
}

fn validate_existing_legacy_table(
    conn: &Connection,
    table: &str,
    required: &[&str],
) -> Result<(), String> {
    if !table_exists(conn, table)? {
        return Ok(());
    }
    let columns = table_columns(conn, table)?;
    if required.iter().any(|column| !columns.contains(*column)) {
        return Err(format!("la tabla existente {table} no tiene el esquema compatible esperado; no se modificó la base"));
    }
    Ok(())
}

fn with_backup(message: String, backup_path: &Path) -> String {
    format!("{message} (copia previa: {})", backup_path.display())
}

fn create_backup(source: &Connection, db_path: &Path) -> Result<PathBuf, String> {
    let parent = db_path
        .parent()
        .ok_or_else(|| "opencode.db no tiene una carpeta contenedora".to_string())?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let backup_path = parent.join(format!("opencode.db.flufy-pre-migration-{id}.sqlite"));
    let partial_path = parent.join(format!("opencode.db.flufy-pre-migration-{id}.partial"));

    let result = (|| {
        let mut destination = Connection::open(&partial_path)
            .map_err(|e| format!("no se pudo crear la copia previa: {e}"))?;
        {
            let backup = Backup::new(source, &mut destination)
                .map_err(|e| format!("no se pudo iniciar la copia previa: {e}"))?;
            backup
                .run_to_completion(256, Duration::from_millis(2), None)
                .map_err(|e| format!("no se pudo completar la copia previa: {e}"))?;
        }
        drop(destination);
        std::fs::rename(&partial_path, &backup_path)
            .map_err(|e| format!("no se pudo guardar la copia previa: {e}"))?;
        Ok(backup_path.clone())
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&partial_path);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn fixture() -> (PathBuf, PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("flufy-opencode-compat-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("opencode.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE workspace (id TEXT PRIMARY KEY, provider TEXT NOT NULL, binding TEXT NOT NULL, created_at INTEGER, last_used_at INTEGER);
             CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, title TEXT);
             CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
             INSERT INTO workspace VALUES ('ws-1','local','C:/repo',1,2);
             INSERT INTO session VALUES ('ses-1','project-1','Chat conservado');
             INSERT INTO message VALUES ('msg-1','ses-1','contenido conservado');",
        )
        .unwrap();
        drop(conn);
        (dir, path)
    }

    #[test]
    fn adds_only_the_missing_legacy_column_and_keeps_rows_with_a_restorable_backup() {
        let (dir, path) = fixture();
        assert!(prepare_database_at(&path).unwrap());

        let conn = Connection::open(&path).unwrap();
        let columns = table_columns(&conn, "workspace").unwrap();
        for column in [
            "type",
            "name",
            "branch",
            "directory",
            "extra",
            "project_id",
            "time_used",
        ] {
            assert!(columns.contains(column));
        }
        assert_eq!(
            conn.query_row(
                "SELECT provider, binding FROM workspace WHERE id='ws-1'",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            )
            .unwrap(),
            ("local".to_string(), "C:/repo".to_string())
        );
        assert_eq!(
            conn.query_row("SELECT title FROM session WHERE id='ses-1'", [], |r| r
                .get::<_, String>(
                0
            ))
            .unwrap(),
            "Chat conservado"
        );
        assert_eq!(
            conn.query_row("SELECT data FROM message WHERE id='msg-1'", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "contenido conservado"
        );
        for table in ["data_migration", "session_context_epoch", "session_input"] {
            assert!(table_exists(&conn, table).unwrap());
        }
        for index in SESSION_INPUT_INDEXES {
            assert!(index_exists(&conn, index).unwrap());
        }

        let backup_path = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|candidate| candidate.extension().is_some_and(|ext| ext == "sqlite"))
            .expect("copia previa");
        let backup = Connection::open(backup_path).unwrap();
        assert_eq!(
            backup
                .query_row("SELECT count(*) FROM workspace", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            backup
                .query_row("SELECT count(*) FROM message", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(backup);
        drop(conn);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn does_not_back_up_or_mutate_databases_without_the_v2_workspace_shape() {
        let (dir, path) = fixture();
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "DROP TABLE workspace;
             CREATE TABLE workspace (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL DEFAULT 'local',
                name TEXT NOT NULL DEFAULT '',
                branch TEXT,
                directory TEXT,
                extra TEXT,
                project_id TEXT NOT NULL DEFAULT '',
                time_used INTEGER NOT NULL DEFAULT 0
             );",
        )
        .unwrap();
        drop(conn);

        assert!(!prepare_database_at(&path).unwrap());
        assert!(std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| entry
                .path()
                .extension()
                .map(|ext| ext != "sqlite")
                .unwrap_or(true)));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn copies_are_consistent_when_the_database_uses_wal() {
        let (dir, path) = fixture();
        let source = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
        let backup_path = create_backup(&source, &path).unwrap();
        let backup =
            Connection::open_with_flags(&backup_path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(
            backup
                .query_row(
                    "SELECT title FROM session WHERE id=?1",
                    params!["ses-1"],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "Chat conservado"
        );
        drop(backup);
        drop(source);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
