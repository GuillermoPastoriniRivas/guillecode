//! Versioned planning contracts. Models propose; only this domain admits work.
use super::{domain::*, evidence};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanV2Config {
    pub enabled: bool,
    pub review_before_start: bool,
    pub routing: super::routing::RoutingConfig,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TaskContract {
    pub category: Option<String>,
    pub verification_plan: Vec<VerificationStep>,
    pub requirement_ids: Vec<String>,
    pub priority: i32,
    pub parent_task_id: Option<String>,
    pub task_kind: Option<String>,
    pub risk: Option<String>,
    pub correction_for_task_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerificationStep {
    pub kind: String,
    pub command: Option<String>,
    pub expected: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Requirement {
    pub id: String,
    pub description: String,
    pub limitation: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PlanContract {
    pub requirements: Vec<Requirement>,
    pub why_parallel: String,
    pub why_not_single_unit: String,
    pub independent_scopes: Vec<String>,
    pub expected_evidence: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedFile {
    pub path: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedScript {
    pub source: String,
    pub name: String,
    pub command: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryReport {
    pub repo_root: String,
    pub base_revision: Option<String>,
    pub dirty_state_summary: String,
    pub observed_files: Vec<ObservedFile>,
    pub observed_scripts: Vec<ObservedScript>,
    pub assumptions: Vec<String>,
    pub unknowns: Vec<String>,
    pub constraints: Vec<String>,
    pub risks: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub digest: String,
    pub captured_at: i64,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PlanErrorCode {
    InvalidTaskShape,
    DuplicateTaskId,
    MissingOwner,
    InvalidRepository,
    UnknownDependency,
    Cycle,
    OverlappingWriteScope,
    UnjustifiedFanout,
    EmptyAcceptance,
    UntestableAcceptance,
    PermissionEscalation,
    MissingCoverage,
    StaleBaseline,
    TooManyTasks,
    RevisionConflict,
    ActiveTask,
    InvalidOperation,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanIssue {
    pub code: PlanErrorCode,
    pub task_ids: Vec<String>,
    pub message: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReceipt {
    pub valid: bool,
    pub issues: Vec<PlanIssue>,
    pub validated_at: i64,
}

impl ValidationReceipt {
    fn reject(&mut self, code: PlanErrorCode, task_ids: Vec<String>, message: impl Into<String>) {
        self.issues.push(PlanIssue {
            code,
            task_ids,
            message: message.into(),
        });
        self.valid = false;
    }
    pub fn message(&self) -> String {
        serde_json::to_string(&self.issues).unwrap_or_else(|_| "Plan inválido".into())
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PlanV2State {
    pub enabled: bool,
    pub review_before_start: bool,
    pub stage: String,
    pub discovery: Vec<DiscoveryReport>,
    pub validation: Option<ValidationReceipt>,
    pub rejected_proposals: Vec<Value>,
    pub contract: PlanContract,
    pub revision_number: u64,
    pub digest: String,
    pub revisions: Vec<PlanRevision>,
    pub sequence: u64,
    pub pending_change: bool,
}

fn digest(value: &impl Serialize) -> String {
    // Canonical object ordering, independent of serde_json's preserve_order feature.
    fn canonical(v: Value) -> Value {
        match v {
            Value::Object(o) => {
                let sorted: BTreeMap<_, _> =
                    o.into_iter().map(|(k, v)| (k, canonical(v))).collect();
                json!(sorted)
            }
            Value::Array(a) => Value::Array(a.into_iter().map(canonical).collect()),
            v => v,
        }
    }
    format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&canonical(
                serde_json::to_value(value).expect("serializable domain")
            ))
            .expect("canonical domain")
        )
    )
}

/// Native, bounded, read-only discovery. Never invokes a model or repository script.
pub(super) fn discover(r: &Run) -> Result<Vec<DiscoveryReport>, String> {
    let mut reports = vec![];
    for repo in &r.team.allowed_repositories {
        let root = std::path::Path::new(repo);
        let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
        let mut files = vec![];
        let mut scripts = vec![];
        let mut truncated = false;
        let walker = ignore::WalkBuilder::new(root)
            .max_depth(Some(5))
            .hidden(false)
            .sort_by_file_path(|a, b| a.cmp(b))
            .follow_links(false)
            .filter_entry(|entry| {
                let name = entry.file_name().to_string_lossy();
                (!name.starts_with('.') || [".github", ".opencode"].contains(&name.as_ref()))
                    && !["node_modules", "target", "dist", "dist-pwa", "vendor"]
                        .contains(&name.as_ref())
            })
            .build();
        let mut total_bytes = 0usize;
        for entry in walker {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if evidence::sensitive_path(&relative) {
                continue;
            }
            if files.len() >= 500 || total_bytes >= 8_000_000 {
                truncated = true;
                break;
            }
            // Also exclude junctions escaping the authorized root.
            if !entry
                .path()
                .canonicalize()
                .is_ok_and(|p| p.starts_with(&canonical_root))
            {
                continue;
            }
            let size = entry.metadata().map_err(|e| e.to_string())?.len();
            if size > 128_000 {
                truncated = true;
                continue;
            }
            let bytes = std::fs::read(entry.path()).map_err(|e| e.to_string())?;
            total_bytes += bytes.len();
            files.push(ObservedFile {
                path: relative.clone(),
                sha256: format!("{:x}", Sha256::digest(&bytes)),
            });
            if entry.file_name() == "package.json" {
                if let Ok(package) = serde_json::from_slice::<Value>(&bytes) {
                    if let Some(found) = package["scripts"].as_object() {
                        for (name, command) in found {
                            if let Some(command) = command.as_str() {
                                let safe = evidence::sanitize(command);
                                if safe == command && name.len() <= 80 && command.len() <= 2000 {
                                    scripts.push(ObservedScript {
                                        source: relative.clone(),
                                        name: name.clone(),
                                        command: safe,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        scripts.sort_by(|a, b| (&a.source, &a.name).cmp(&(&b.source, &b.name)));
        let base_revision = evidence::git(repo, &["rev-parse", "HEAD"], None).ok();
        let dirty_state_summary =
            evidence::git(repo, &["status", "--short", "--untracked-files=all"], None)
                .map(|s| evidence::sanitize(&s))
                .unwrap_or_else(|_| "Git no disponible; snapshot de archivos conservado".into());
        let report_digest =
            digest(&json!({"files":files,"head":base_revision,"dirty":dirty_state_summary}));
        reports.push(DiscoveryReport {
            repo_root: repo.clone(),
            base_revision,
            dirty_state_summary,
            observed_files: files,
            observed_scripts: scripts,
            assumptions: vec![],
            unknowns: vec!["El inventario no acredita comportamiento ni ejecución de pruebas".into()],
            constraints: vec!["Conservar cambios previos y permisos; no leer secretos".into()],
            risks: if truncated { vec!["Inventario parcial por límites de profundidad/tamaño; el Lead debe leer los archivos pertinentes".into()] } else { vec![] },
            evidence_refs: vec![format!("native:file-inventory:{}", repo),format!("native:git-status:{}",repo)],
            digest: report_digest,
            captured_at: now(), truncated,
        });
    }
    Ok(reports)
}

fn reaches(tasks: &[Task], from: &str, target: &str, seen: &mut HashSet<String>) -> bool {
    if !seen.insert(from.into()) {
        return false;
    }
    tasks.iter().find(|t| t.id == from).is_some_and(|t| {
        t.dependencies
            .iter()
            .any(|d| d == target || reaches(tasks, d, target, seen))
    })
}

fn ordered(tasks: &[Task], a: &Task, b: &Task) -> bool {
    reaches(tasks, &a.id, &b.id, &mut HashSet::new())
        || reaches(tasks, &b.id, &a.id, &mut HashSet::new())
}

fn width(all_tasks: &[Task]) -> usize {
    // Dilworth: maximum antichain = vertices - maximum matching of reachability.
    fn augment(
        i: usize,
        edges: &[Vec<usize>],
        seen: &mut HashSet<usize>,
        matched: &mut [Option<usize>],
    ) -> bool {
        for &j in &edges[i] {
            if !seen.insert(j) {
                continue;
            }
            if matched[j].is_none() || augment(matched[j].unwrap(), edges, seen, matched) {
                matched[j] = Some(i);
                return true;
            }
        }
        false
    }
    let tasks: Vec<_> = all_tasks
        .iter()
        .filter(|t| t.status != "cancelled" && t.contract.task_kind.as_deref() != Some("group"))
        .collect();
    let edges: Vec<Vec<_>> = tasks
        .iter()
        .map(|a| {
            tasks
                .iter()
                .enumerate()
                .filter_map(|(j, b)| {
                    reaches(all_tasks, &a.id, &b.id, &mut HashSet::new()).then_some(j)
                })
                .collect()
        })
        .collect();
    let mut matched = vec![None; tasks.len()];
    let count = (0..tasks.len())
        .filter(|&i| augment(i, &edges, &mut HashSet::new(), &mut matched))
        .count();
    tasks.len() - count
}

pub(super) fn validate(plan: &Plan, team: &Team, strict: bool) -> ValidationReceipt {
    use PlanErrorCode::*;
    let mut out = ValidationReceipt {
        valid: true,
        validated_at: now(),
        issues: vec![],
    };
    if plan.tasks.is_empty() || plan.tasks.len() > 100 {
        out.reject(
            TooManyTasks,
            vec![],
            "El plan debe contener entre 1 y 100 tareas",
        );
        return out;
    }
    if let Err(e) = super::capture::validate_targets(&plan.evidence_targets) {
        out.reject(InvalidTaskShape, vec![], e);
    }
    let mut ids = HashSet::new();
    for task in &plan.tasks {
        let one = || vec![task.id.clone()];
        if task.id.trim().is_empty() || task.id.len() > 80 || !ids.insert(&task.id) {
            out.reject(
                DuplicateTaskId,
                one(),
                "El ID debe ser único, estable y no vacío",
            );
        }
        if task.title.trim().is_empty() || task.objective.trim().is_empty() {
            out.reject(InvalidTaskShape, one(), "Faltan título u objetivo");
        }
        if !team.members.iter().any(|a| a.id == task.assigned_agent_id) {
            out.reject(
                MissingOwner,
                one(),
                "El responsable debe pertenecer al equipo autorizado",
            );
        }
        if !team
            .allowed_repositories
            .iter()
            .any(|p| same_path(p, &task.repository))
        {
            out.reject(InvalidRepository, one(), "La carpeta no está autorizada");
        }
        if task
            .expected_files
            .iter()
            .chain(&task.write_paths)
            .any(|p| !valid_write_path(p))
        {
            out.reject(
                InvalidTaskShape,
                one(),
                "Los archivos y writePaths deben ser relativos y no contener escapes ni comodines",
            );
        }
        if task
            .dependencies
            .iter()
            .any(|d| !plan.tasks.iter().any(|t| &t.id == d))
        {
            out.reject(UnknownDependency, one(), "La dependencia no existe");
        }
        if task.acceptance_criteria.is_empty()
            || task.acceptance_criteria.iter().any(|c| c.trim().is_empty())
        {
            out.reject(
                EmptyAcceptance,
                one(),
                "Faltan criterios de aceptación comprobables",
            );
        }
        if reaches(&plan.tasks, &task.id, &task.id, &mut HashSet::new()) {
            out.reject(Cycle, one(), "Las dependencias contienen un ciclo");
        }
        if !strict
            || task.status == "cancelled"
            || task.contract.task_kind.as_deref() == Some("group")
        {
            continue;
        }
        if task.contract.category.as_ref().is_some_and(|c| !super::routing::CATEGORIES.contains(&c.as_str())) {
            out.reject(InvalidTaskShape,one(),"category debe ser quick, deep, visual, code, review o local");
        }
        if let Some(owner) = team.members.iter().find(|a| a.id == task.assigned_agent_id) {
            if (!task.expected_files.is_empty()
                && !owner
                    .tools
                    .iter()
                    .any(|t| ["write", "edit", "apply_patch", "bash"].contains(&t.as_str())))
                || (task
                    .contract
                    .verification_plan
                    .iter()
                    .any(|v| v.kind == "command")
                    && !owner.tools.iter().any(|t| t == "bash"))
            {
                out.reject(PermissionEscalation,one(),"El responsable no tiene herramientas autorizadas para implementar o ejecutar las comprobaciones; elegí otro integrante sin ampliar permisos");
            }
        }
        if ![None, Some("atomic")].contains(&task.contract.task_kind.as_deref()) {
            out.reject(InvalidTaskShape, one(), "taskKind debe ser atomic o group");
        }
        if ![Some("low"), Some("medium"), Some("high")].contains(&task.contract.risk.as_deref()) {
            out.reject(
                InvalidTaskShape,
                one(),
                "Clasificá risk como low, medium o high",
            );
        }
        if task.contract.verification_plan.is_empty()
            || task.contract.verification_plan.iter().any(|v| {
                v.expected.trim().len() < 8
                    || !["command", "observation"].contains(&v.kind.as_str())
                    || (v.kind == "command"
                        && v.command.as_ref().is_none_or(|c| c.trim().is_empty()))
                    || (v.kind == "observation" && !task.expected_files.is_empty())
            })
        {
            out.reject(UntestableAcceptance,one(),"Cada tarea necesita verificationPlan: command con comando pertinente o observation sin archivos, y expected observable");
        }
        if task.acceptance_criteria.iter().any(|s| {
            s.trim().len() < 12
                || ["listo", "funciona", "comprobar", "check", "done", "ok"]
                    .contains(&s.trim().to_lowercase().as_str())
        }) {
            out.reject(
                UntestableAcceptance,
                one(),
                "Describí un resultado observable en cada criterio, no solo 'funciona' o 'listo'",
            );
        }
        for file in &task.expected_files {
            if !task.write_paths.is_empty()
                && !task.write_paths.iter().any(|p| {
                    let (p, f) = (
                        p.replace('\\', "/").to_lowercase(),
                        file.replace('\\', "/").to_lowercase(),
                    );
                    p == f || p.ends_with('/') && f.starts_with(&p)
                })
            {
                out.reject(
                    OverlappingWriteScope,
                    one(),
                    "Un archivo esperado queda fuera de writePaths",
                );
            }
        }
        if task.contract.requirement_ids.is_empty()
            || task
                .contract
                .requirement_ids
                .iter()
                .any(|id| !plan.contract.requirements.iter().any(|r| &r.id == id))
        {
            out.reject(
                MissingCoverage,
                one(),
                "Vinculá la tarea con IDs de requirements existentes",
            );
        }
    }
    if strict {
        for (i, a) in plan.tasks.iter().enumerate() {
            for b in plan.tasks.iter().skip(i + 1) {
                if [a, b].iter().any(|t| {
                    t.status == "cancelled" || t.contract.task_kind.as_deref() == Some("group")
                }) {
                    continue;
                }
                if task_conflict(a, b) && !ordered(&plan.tasks, a, b) {
                    out.reject(OverlappingWriteScope,vec![a.id.clone(),b.id.clone()],"Alcances compartidos requieren una dependencia que impida escrituras simultáneas");
                }
            }
        }
        if width(&plan.tasks) > 4
            && (plan.contract.why_parallel.trim().len() < 20
                || plan.contract.why_not_single_unit.trim().len() < 20
                || plan.contract.independent_scopes.len() < 5
                || plan.contract.expected_evidence.len() < 5)
        {
            out.reject(UnjustifiedFanout,vec![],"Más de cuatro tareas simultáneamente listas requieren whyParallel, whyNotSingleUnit, independentScopes y expectedEvidence");
        }
        let mut requirement_ids = HashSet::new();
        if plan.contract.requirements.is_empty() {
            out.reject(
                MissingCoverage,
                vec![],
                "Enumerá los requisitos originales en requirements",
            );
        }
        for requirement in &plan.contract.requirements {
            if requirement.id.trim().is_empty()
                || requirement.description.trim().len() < 8
                || !requirement_ids.insert(&requirement.id)
                || (!plan.tasks.iter().any(|t| {
                    t.status != "cancelled" && t.contract.requirement_ids.contains(&requirement.id)
                }) && requirement
                    .limitation
                    .as_ref()
                    .is_none_or(|l| l.trim().len() < 12))
            {
                out.reject(
                    MissingCoverage,
                    vec![],
                    format!(
                        "Requisito {} sin entregable verificable ni limitación explícita",
                        requirement.id
                    ),
                );
            }
        }
    }
    out
}

pub(super) fn parse_proposal(text: &str, run: &Run) -> Result<Plan, ValidationReceipt> {
    let fail = |code, reason: String| {
        let mut r = ValidationReceipt {
            valid: true,
            validated_at: now(),
            issues: vec![],
        };
        r.reject(code, vec![], evidence::sanitize(&reason));
        r
    };
    let value: Value = parse_json(text).map_err(|e| fail(PlanErrorCode::InvalidTaskShape, e))?;
    if run.plan_v2.enabled {
        fn escalation(v: &Value) -> bool {
            match v {
                Value::Object(o) => o.iter().any(|(k, v)| {
                    [
                        "tools",
                        "permissions",
                        "allowedRepositories",
                        "model",
                        "modelID",
                        "providerID",
                        "runtime",
                    ]
                    .contains(&k.as_str())
                        || escalation(v)
                }),
                Value::Array(a) => a.iter().any(escalation),
                _ => false,
            }
        }
        if escalation(&value) {
            return Err(fail(
                PlanErrorCode::PermissionEscalation,
                "Un plan no puede conceder herramientas, carpetas ni modelos".into(),
            ));
        }
    }
    let plan: Plan = serde_json::from_value(value)
        .map_err(|e| fail(PlanErrorCode::InvalidTaskShape, e.to_string()))?;
    super::staffing::validate_assignments(&plan.agents, &plan.tasks)
        .map_err(|e| fail(PlanErrorCode::MissingOwner, e))?;
    let team = super::staffing::with_agents(&run.team, &plan.agents, &run.skills)
        .map_err(|e| fail(PlanErrorCode::PermissionEscalation, e))?;
    let receipt = validate(&plan, &team, run.plan_v2.enabled);
    if !receipt.valid {
        return Err(receipt);
    }
    if run.plan_v2.enabled && !run.plan_v2.discovery.is_empty() {
        let script_command =
            regex::Regex::new(r"^(?:npm|pnpm) (?:run )?([a-zA-Z0-9:_-]+)$").unwrap();
        for task in &plan.tasks {
            for step in &task.contract.verification_plan {
                if let Some(captures) = step
                    .command
                    .as_deref()
                    .and_then(|command| script_command.captures(command.trim()))
                {
                    let name = captures.get(1).unwrap().as_str();
                    if !run
                        .plan_v2
                        .discovery
                        .iter()
                        .filter(|d| same_path(&d.repo_root, &task.repository))
                        .flat_map(|d| &d.observed_scripts)
                        .any(|s| s.source == "package.json" && s.name == name)
                    {
                        return Err(fail(PlanErrorCode::UntestableAcceptance,format!("La tarea {} propone un script {name} que no fue observado en package.json de su carpeta",task.id)));
                    }
                }
            }
        }
    }
    if plan.tasks.iter().any(|t| {
        t.status != "pending"
            || !t.attempts.is_empty()
            || t.contract.parent_task_id.is_some()
            || t.contract.task_kind.as_deref() == Some("group")
    }) {
        return Err(fail(
            PlanErrorCode::InvalidTaskShape,
            "La propuesta inicial solo admite tareas nuevas pendientes, sin intentos ni grupos"
                .into(),
        ));
    }
    Ok(plan)
}

pub(super) const CONTRACT_PROMPT: &str = r#"
PLAN VIVO V2. Discovery ya terminó: usá el inventario observado y leé solo lo pertinente.
El trabajo simple necesita UNA tarea; separá 2–4 entregables solo con responsabilidad y evidencia independientes.
Enumerá requirements:[{id:"R1",description:"requisito original completo",limitation:null}]. Cubrí todos los requisitos, también restricciones del usuario; registrá una limitación concreta si no es posible cumplir alguno.
Cada tarea necesita requirementIds:["R1"], risk:"low|medium|high", priority:0 y verificationPlan:[{kind:"command",command:"comando pertinente observado",expected:"resultado observable, p.ej. exitCode=0 y casos negativos aprobados"}].
No inventes npm test: consultá observedScripts y los archivos. Para navegación sin archivos usá kind:"observation",command:null y expected con el estado final comprobable.
Cada criterio explica un comportamiento observable, no "funciona". writePaths debe incluir los archivos esperados. Si dos tareas escriben el mismo alcance, serializalas con dependencies.
Más de cuatro tareas potencialmente listas en paralelo requieren whyParallel, whyNotSingleUnit, independentScopes y expectedEvidence; justificá el beneficio real.
No incluyas herramientas, permisos, runtime, modelos, estados completados ni intentos en el plan. No cambies el objetivo ni lo sustituyas por una tarea genérica para esquivar errores.
"#;

// Revisions store the immutable planning contract, excluding mutable runtime evidence.
fn task_document(task: &Task) -> Value {
    json!({"id":task.id,"title":task.title,"objective":task.objective,"assignedAgentId":task.assigned_agent_id,
        "repository":task.repository,"dependencies":task.dependencies,"expectedFiles":task.expected_files,
        "writePaths":task.write_paths,"acceptanceCriteria":task.acceptance_criteria,"contract":task.contract,
        "cancelled":task.status == "cancelled"})
}

pub(super) fn plan_digest(run: &Run) -> String {
    digest(
        &json!({"tasks":run.tasks.iter().map(task_document).collect::<Vec<_>>(),"contract":run.plan_v2.contract,
        "captureTargets":run.capture_targets}),
    )
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRevision {
    pub id: String,
    pub run_id: String,
    pub number: u64,
    pub parent_revision_id: Option<String>,
    pub operation_id: String,
    pub base_digest: String,
    pub resulting_digest: String,
    pub created_at: i64,
    pub actor: String,
    pub reason: String,
    pub operations: Vec<Value>,
    pub validation: ValidationReceipt,
}

pub(super) fn freeze(
    run: &mut Run,
    operation_id: &str,
    actor: &str,
    reason: &str,
    operations: Vec<Value>,
    validation: ValidationReceipt,
) -> PlanRevision {
    let resulting_digest = plan_digest(run);
    let revision = PlanRevision {
        id: id(),
        run_id: run.id.clone(),
        number: run.plan_v2.revision_number + 1,
        parent_revision_id: run.plan_v2.revisions.last().map(|r| r.id.clone()),
        operation_id: operation_id.into(),
        base_digest: run.plan_v2.digest.clone(),
        resulting_digest: resulting_digest.clone(),
        created_at: now(),
        actor: actor.into(),
        reason: evidence::sanitize(reason),
        operations,
        validation,
    };
    run.plan_v2.revision_number = revision.number;
    run.plan_v2.digest = resulting_digest;
    run.plan_v2.revisions.push(revision.clone());
    revision
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDraft {
    pub category: Option<String>,
    pub id: String,
    pub title: String,
    pub objective: String,
    pub assigned_agent_id: String,
    pub repository: String,
    pub dependencies: Vec<String>,
    pub expected_files: Vec<String>,
    pub write_paths: Vec<String>,
    pub acceptance_criteria: Vec<String>,
    pub verification_plan: Vec<VerificationStep>,
    pub requirement_ids: Vec<String>,
    pub risk: String,
    #[serde(default)]
    pub priority: i32,
}

impl TaskDraft {
    fn task(&self) -> Task {
        Task {
            id: self.id.clone(),
            title: self.title.clone(),
            objective: self.objective.clone(),
            assigned_agent_id: self.assigned_agent_id.clone(),
            repository: self.repository.clone(),
            dependencies: self.dependencies.clone(),
            expected_files: self.expected_files.clone(),
            write_paths: self.write_paths.clone(),
            acceptance_criteria: self.acceptance_criteria.clone(),
            status: "pending".into(),
            attempts: vec![],
            error: None,
            contract: TaskContract {
                category: self.category.clone(),
                verification_plan: self.verification_plan.clone(),
                requirement_ids: self.requirement_ids.clone(),
                risk: Some(self.risk.clone()),
                priority: self.priority,
                ..Default::default()
            },
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "SCREAMING_SNAKE_CASE",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PlanOperation {
    AddRequirement {
        requirement: Requirement,
        guidance_index: usize,
    },
    AddTask {
        task: TaskDraft,
    },
    AddCorrection {
        for_task_id: String,
        task: TaskDraft,
    },
    SplitPendingTask {
        task_id: String,
        children: Vec<TaskDraft>,
    },
    ReassignPending {
        task_id: String,
        agent_id: String,
    },
    ReprioritizePending {
        task_id: String,
        priority: i32,
    },
    UpdatePendingDependencies {
        task_id: String,
        dependencies: Vec<String>,
    },
    CancelPending {
        task_id: String,
        reason: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanPatch {
    pub operation_id: String,
    pub run_id: String,
    pub expected_revision: u64,
    pub expected_digest: String,
    pub reason: String,
    pub operations: Vec<PlanOperation>,
}

fn pending_task<'a>(run: &'a mut Run, id: &str) -> Result<&'a mut Task, String> {
    let task = run
        .tasks
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or("INVALID_OPERATION: tarea inexistente")?;
    if task.status != "pending"
        || !task.attempts.is_empty()
        || task.contract.task_kind.as_deref() == Some("group")
    {
        return Err("ACTIVE_TASK: solo se modifican tareas pendientes sin intentos ni sesiones; el historial se conserva".into());
    }
    Ok(task)
}

pub(super) fn simulate_patch(
    run: &Run,
    patch: &PlanPatch,
    actor: &str,
) -> Result<(Run, PlanRevision), String> {
    simulate_patch_policy(run, patch, actor, actor != "user")
}

fn simulate_patch_policy(
    run: &Run,
    patch: &PlanPatch,
    actor: &str,
    automatic: bool,
) -> Result<(Run, PlanRevision), String> {
    if !run.plan_v2.enabled || run.plan_v2.revision_number == 0 {
        return Err("INVALID_OPERATION: Plan Vivo V2 no está activo para esta ejecución".into());
    }
    if patch.run_id != run.id
        || patch.operation_id.trim().is_empty()
        || patch.operation_id.len() > 160
    {
        return Err("INVALID_OPERATION: IDs inválidos".into());
    }
    if let Some(existing) = run
        .plan_v2
        .revisions
        .iter()
        .find(|r| r.operation_id == patch.operation_id)
    {
        let operations: Vec<_> = patch
            .operations
            .iter()
            .map(|op| serde_json::to_value(op).unwrap())
            .collect();
        if existing.operations != operations || existing.reason != evidence::sanitize(&patch.reason)
        {
            return Err("INVALID_OPERATION: operationId ya se usó para otro contenido".into());
        }
        return Ok((run.clone(), existing.clone()));
    }
    if !["running", "paused", "blocked", "plan_ready"].contains(&run.status.as_str()) {
        return Err("INVALID_OPERATION: ejecución cerrada o sin plan validado".into());
    }
    if patch.expected_revision != run.plan_v2.revision_number
        || patch.expected_digest != run.plan_v2.digest
        || plan_digest(run) != run.plan_v2.digest
    {
        return Err(
            "REVISION_CONFLICT: el plan cambió; actualizá el snapshot y recalculá la propuesta"
                .into(),
        );
    }
    if patch.reason.trim().len() < 8
        || patch.reason.len() > 2000
        || patch.operations.is_empty()
        || patch.operations.len() > 12
    {
        return Err(
            "INVALID_OPERATION: se necesita un motivo explícito y entre 1 y 12 operaciones".into(),
        );
    }
    if automatic
        && (run
            .plan_v2
            .revisions
            .iter()
            .filter(|r| r.actor != "user")
            .count()
            >= 20
            || run
                .plan_v2
                .revisions
                .last()
                .is_some_and(|r| r.number > 1 && now() - r.created_at < 10_000))
    {
        return Err(
            "INVALID_OPERATION: límite o enfriamiento de revisiones automáticas alcanzado".into(),
        );
    }
    let mut next = run.clone();
    let mut added = 0usize;
    for operation in &patch.operations {
        match operation {
            PlanOperation::AddRequirement {
                requirement,
                guidance_index,
            } => {
                if *guidance_index >= run.guidance.len()
                    || requirement.id.trim().is_empty()
                    || next
                        .plan_v2
                        .contract
                        .requirements
                        .iter()
                        .any(|r| r.id == requirement.id)
                {
                    return Err("INVALID_OPERATION: el requisito nuevo necesita una indicación real del usuario y un ID nuevo".into());
                }
                next.plan_v2.contract.requirements.push(requirement.clone());
            }
            PlanOperation::AddTask { task } => {
                next.tasks.push(task.task());
                added += 1;
            }
            PlanOperation::AddCorrection { for_task_id, task } => {
                if !next
                    .tasks
                    .iter()
                    .any(|t| &t.id == for_task_id && t.status != "cancelled")
                    || !task.dependencies.contains(for_task_id)
                {
                    return Err(
                        "INVALID_OPERATION: la corrección debe depender de una tarea existente"
                            .into(),
                    );
                }
                let mut task = task.task();
                task.contract.correction_for_task_id = Some(for_task_id.clone());
                next.tasks.push(task);
                added += 1;
            }
            PlanOperation::ReassignPending { task_id, agent_id } => {
                if !run.team.members.iter().any(|a| &a.id == agent_id) {
                    return Err("MISSING_OWNER: integrante inexistente".into());
                }
                pending_task(&mut next, task_id)?.assigned_agent_id = agent_id.clone();
            }
            PlanOperation::ReprioritizePending { task_id, priority } => {
                pending_task(&mut next, task_id)?.contract.priority = *priority;
            }
            PlanOperation::UpdatePendingDependencies {
                task_id,
                dependencies,
            } => {
                pending_task(&mut next, task_id)?.dependencies = dependencies.clone();
            }
            PlanOperation::CancelPending { task_id, reason } => {
                if reason.trim().len() < 8 {
                    return Err("INVALID_OPERATION: falta el motivo de cancelación".into());
                }
                let task = pending_task(&mut next, task_id)?;
                task.status = "cancelled".into();
                task.error = Some(evidence::sanitize(reason));
            }
            PlanOperation::SplitPendingTask { task_id, children } => {
                if !(2..=6).contains(&children.len()) {
                    return Err(
                        "INVALID_OPERATION: dividir requiere entre 2 y 6 entregables".into(),
                    );
                }
                let parent = pending_task(&mut next, task_id)?.clone();
                if parent.acceptance_criteria.iter().any(|criterion| {
                    !children
                        .iter()
                        .any(|c| c.acceptance_criteria.contains(criterion))
                }) || parent
                    .contract
                    .requirement_ids
                    .iter()
                    .any(|id| !children.iter().any(|c| c.requirement_ids.contains(id)))
                {
                    return Err("MISSING_COVERAGE: las hijas deben preservar todos los criterios y requisitos de la tarea original".into());
                }
                let mut depth = 1;
                let mut ancestor = parent.contract.parent_task_id.clone();
                while let Some(id) = ancestor {
                    depth += 1;
                    ancestor = next
                        .tasks
                        .iter()
                        .find(|t| t.id == id)
                        .and_then(|t| t.contract.parent_task_id.clone());
                    if depth >= 3 {
                        return Err(
                            "INVALID_OPERATION: profundidad máxima de grupos alcanzada".into()
                        );
                    }
                }
                for child in children {
                    if !same_path(&child.repository, &parent.repository)
                        || child.write_paths.is_empty() && !parent.write_paths.is_empty()
                        || child.write_paths.iter().any(|p| {
                            !parent.write_paths.is_empty()
                                && !parent.write_paths.iter().any(|scope| {
                                    let (scope, p) = (
                                        scope.replace('\\', "/").to_lowercase(),
                                        p.replace('\\', "/").to_lowercase(),
                                    );
                                    scope == p || scope.ends_with('/') && p.starts_with(&scope)
                                })
                        })
                    {
                        return Err("PERMISSION_ESCALATION: una hija no puede ampliar el alcance de la tarea original".into());
                    }
                    let mut task = child.task();
                    task.contract.parent_task_id = Some(task_id.clone());
                    for dep in &parent.dependencies {
                        if !task.dependencies.contains(dep) {
                            task.dependencies.push(dep.clone());
                        }
                    }
                    next.tasks.push(task);
                    added += 1;
                }
                let group = next.tasks.iter_mut().find(|t| &t.id == task_id).unwrap();
                group.contract.task_kind = Some("group".into());
                group.dependencies = children.iter().map(|c| c.id.clone()).collect();
                group.write_paths.clear();
                group.expected_files.clear();
            }
        }
    }
    if added > 6 {
        return Err("TOO_MANY_TASKS: máximo seis tareas nuevas por revisión".into());
    }
    // A patch cannot erase accepted requirements or strand dependents on a cancellation.
    for task in next.tasks.iter().filter(|t| t.status != "cancelled") {
        if task.dependencies.iter().any(|id| {
            next.tasks
                .iter()
                .any(|t| &t.id == id && t.status == "cancelled")
        }) {
            return Err("UNKNOWN_DEPENDENCY: una tarea vigente depende de otra cancelada".into());
        }
    }
    let plan = Plan {
        contract: next.plan_v2.contract.clone(),
        agents: vec![],
        tasks: next.tasks.clone(),
        evidence_targets: next.capture_targets.clone(),
    };
    let receipt = validate(&plan, &next.team, true);
    if !receipt.valid {
        return Err(receipt.message());
    }
    let operations = patch
        .operations
        .iter()
        .map(|op| serde_json::to_value(op).unwrap())
        .collect();
    let revision = freeze(
        &mut next,
        &patch.operation_id,
        actor,
        &patch.reason,
        operations,
        receipt,
    );
    Ok((next, revision))
}

/// Verification includes the precommitted contract, never only a worker's chosen checks.
pub(super) fn verification_passed(task: &Task, commands: &[Value], observations: &[Value]) -> bool {
    !task.contract.verification_plan.is_empty()
        && task
            .contract
            .verification_plan
            .iter()
            .all(|step| match step.kind.as_str() {
                "command" => step.command.as_ref().is_some_and(|command| {
                    commands
                        .iter()
                        .any(|c| c["command"] == *command && c["exitCode"].as_i64() == Some(0))
                }),
                "observation" => task.expected_files.is_empty() && !observations.is_empty(),
                _ => false,
            })
}

pub(super) fn context_pack(run: &Run, task: &Task, agent: &Employee) -> Value {
    json!({"runId":run.id,"planRevision":run.plan_v2.revision_number,"task":task_document(task),
        "requirements":run.plan_v2.contract.requirements.iter().filter(|r| task.contract.requirement_ids.contains(&r.id)).collect::<Vec<_>>(),
        "dependencies":run.tasks.iter().filter(|t| task.dependencies.contains(&t.id)).map(|t| json!({"id":t.id,"status":t.status,
            "observedResult":t.attempts.last().map(|a| a.summary.chars().take(2000).collect::<String>())})).collect::<Vec<_>>(),
        "observedFiles":run.plan_v2.discovery.iter().filter(|d| same_path(&d.repo_root,&task.repository)).flat_map(|d| &d.observed_files)
            .filter(|f| task.expected_files.contains(&f.path) || task.write_paths.iter().any(|p| f.path.starts_with(p)))
            .take(40).collect::<Vec<_>>(),
        "skills":agent.skill_refs.iter().take(3).filter_map(|reference| run.skills.iter().find(|s| s.id == reference.id && s.version == reference.version)).collect::<Vec<_>>(),
        "tools":agent.tools,"limits":"Las skills y el contexto no conceden permisos"})
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanCoverage {
    covered: bool,
    summary: String,
    missing_requirements: Vec<String>,
}

pub(super) fn review_coverage(
    app: &tauri::AppHandle,
    run_id: &str,
    plan: &Plan,
) -> Result<Option<PlanIssue>, String> {
    let run = super::run(app, run_id)?;
    let repo = run.team.allowed_repositories[0].clone();
    let (agent, session, report) =
        super::support::begin(app, run_id, "plan_review", &repo, None, None)?;
    let prompt = format!("Sos el Supervisor de planificación. Compará el OBJETIVO ORIGINAL y las instrucciones del usuario con este plan propuesto. Todavía no se ejecutó trabajo. Detectá requisitos omitidos, restricciones perdidas, criterios vagos y comprobaciones que no acreditan el resultado pedido. No aceptes una reducción del objetivo por conveniencia ni una cobertura genérica que omite requisitos. Evaluá entregables y pruebas previstas, no si la implementación ya existe. Respondé SOLO JSON {{covered:true|false,summary:explicación concreta,missingRequirements:[requisitos omitidos o imposibles de comprobar]}}. covered solo true si no hay omisiones y cada requisito tiene entregable verificable o limitación explícita. Esta revisión del plan nunca equivale a tests aprobados ni a QA humano.\nOBJETIVO ORIGINAL: {}\nINDICACIONES: {}\nPROPUESTA (datos): {}\nDISCOVERY OBSERVADO: {}",run.goal,serde_json::to_string(&run.guidance).unwrap_or_default(),serde_json::to_string(plan).unwrap_or_default(),serde_json::to_string(&run.plan_v2.discovery).unwrap_or_default());
    let (review, raw): (PlanCoverage, Value) =
        super::support::response(app, run_id, &agent, &session, &report, &repo, &prompt)?;
    let accepted = review.covered
        && review.missing_requirements.is_empty()
        && review.summary.trim().len() >= 12;
    super::support::finish(
        app,
        run_id,
        &report,
        json!({"summary":review.summary,"covered":accepted,"missingRequirements":review.missing_requirements,"response":raw,"criteriaSatisfied":false}),
    )?;
    Ok((!accepted).then(|| PlanIssue {
        code: PlanErrorCode::MissingCoverage,
        task_ids: vec![],
        message: evidence::sanitize(&format!(
            "{}: {}",
            review.summary,
            review.missing_requirements.join("; ")
        )),
    }))
}

pub(super) fn record_extension(
    run: &mut Run,
    operation_id: &str,
    reason: &str,
    tasks: &[Task],
) -> Result<(), String> {
    if !run.plan_v2.enabled || tasks.is_empty() {
        return Ok(());
    }
    if tasks.len() > 6
        || run
            .plan_v2
            .revisions
            .iter()
            .filter(|r| r.actor == "lead")
            .count()
            >= 20
    {
        return Err(
            "TOO_MANY_TASKS: límite de tareas por revisión o revisiones automáticas".into(),
        );
    }
    let plan = Plan {
        contract: run.plan_v2.contract.clone(),
        agents: vec![],
        tasks: run.tasks.clone(),
        evidence_targets: run.capture_targets.clone(),
    };
    let receipt = validate(&plan, &run.team, true);
    if !receipt.valid {
        return Err(receipt.message());
    }
    let operations = tasks
        .iter()
        .map(|t| json!({"type":"ADD_TASK","task":t}))
        .collect();
    freeze(run, operation_id, "lead", reason, operations, receipt);
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GuidanceDecision {
    action: String,
    summary: String,
    patch: Option<PlanPatch>,
}

/// Translate a new user instruction into the same transactional patch protocol
/// as board intents. Unversioned guidance never expands an active worker's job.
pub(super) fn apply_guidance(app: &tauri::AppHandle, run_id: &str) -> Result<String, String> {
    use super::{run, runner, support, update_run};
    let current = run(app, run_id)?;
    let repo = current.team.allowed_repositories[0].clone();
    let (agent, session, report) = support::begin(app, run_id, "plan_change", &repo, None, None)?;
    let client = runner::client(app, &repo)?;
    let result = (|| {
        let mut rejection = String::new();
        for attempt in 0..3 {
            let current = run(app, run_id)?;
            let prompt = format!("Sos el Lead del Plan Vivo V2. El usuario envió una indicación nueva. Conservá las sesiones, criterios y evidencia de todas las tareas activas o terminadas. Decidí CONTINUE solo para una consulta/indicación que no cambia ningún entregable; PLAN_PATCH cuando exige trabajo nuevo o cambiar pendientes. No implementes desde esta sesión de lectura. Respondé un único JSON {{action:CONTINUE|PLAN_PATCH,summary:explicación concreta,patch:null|PlanPatch}}. PlanPatch debe incluir operationId nuevo, runId, expectedRevision, expectedDigest,reason,operations. Usá ADD_TASK, ADD_CORRECTION, SPLIT_PENDING_TASK, REASSIGN_PENDING, REPRIORITIZE_PENDING, UPDATE_PENDING_DEPENDENCIES o CANCEL_PENDING. Un requisito nuevo requiere ADD_REQUIREMENT con requirement={{id:nuevo,description:requisito,limitation:null}} y guidanceIndex apuntando a su indicación real, junto con las tareas y verificationPlan que lo cubren. No amplíes permisos, carpetas ni herramientas.\nOBJETIVO ORIGINAL: {}\nINDICACIONES DEL USUARIO (índices desde 0): {}\nPLAN VIGENTE: {}\nREQUISITOS ACORDADOS: {}\nTAREAS: {}\n{}\nERROR ANTERIOR A CORREGIR: {}",current.goal,serde_json::to_string(&current.guidance).unwrap_or_default(),json!({"runId":current.id,"expectedRevision":current.plan_v2.revision_number,"expectedDigest":current.plan_v2.digest}),serde_json::to_string(&current.plan_v2.contract.requirements).unwrap_or_default(),serde_json::to_string(&current.tasks).unwrap_or_default(),CONTRACT_PROMPT,rejection);
            let messages = if attempt == 0 {
                runner::execute(app, run_id, &client, &session, &agent, &prompt, true)?
            } else {
                runner::format_response(app, run_id, &client, &session, &agent, &prompt)?
            };
            let decision = parse_json::<GuidanceDecision>(&runner::final_text(&messages));
            let applied = decision.and_then(|decision| {
                if decision.summary.trim().len() < 8 {
                    return Err("Falta explicar el cambio".into());
                }
                match (decision.action.as_str(), decision.patch) {
                    ("CONTINUE", None) => update_run(app, run_id, |r| {
                        if !["running", "paused", "blocked", "plan_ready"]
                            .contains(&r.status.as_str())
                        {
                            return Err("La ejecución ya no admite cambios".into());
                        }
                        r.plan_v2.pending_change = false;
                        Ok(decision.summary.clone())
                    }),
                    ("PLAN_PATCH", Some(patch)) => update_run(app, run_id, |r| {
                        // This is a new explicit user instruction, not a timer
                        // or recursive correction. Preserve the Lead actor in
                        // the audit without imposing an automatic cooldown.
                        let (mut next, _) = simulate_patch_policy(r, &patch, "lead", false)?;
                        next.plan_v2.pending_change = false;
                        *r = next;
                        Ok(decision.summary.clone())
                    }),
                    _ => Err(
                        "Acción o patch inválido; un cambio requiere el contrato completo".into(),
                    ),
                }
            });
            match applied {
                Ok(summary) => return Ok(summary),
                Err(error) => rejection = evidence::sanitize(&error),
            }
        }
        Err(format!(
            "No se pudo validar el cambio de plan después de dos reparaciones: {rejection}"
        ))
    })();
    match result {
        Ok(summary) => {
            support::finish(
                app,
                run_id,
                &report,
                json!({"summary":summary,"criteriaSatisfied":false}),
            )?;
            Ok(summary)
        }
        Err(error) => {
            let stopped = runner::stop(app, &client, &session).is_ok();
            support::failed(app, run_id, &report, &error, stopped)?;
            update_run(app, run_id, |r| {
                if r.status != "cancelling" && r.status != "cancelled" {
                    r.status = "blocked".into();
                    r.error = Some(evidence::sanitize(&error));
                }
                // Keep the pending marker: explicit retry first reconciles and
                // re-proposes this instruction instead of dropping its scope.
                Ok(())
            })?;
            Err(error)
        }
    }
}
