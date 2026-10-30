//! Paired, deterministic admission benchmark. No model-quality or price claims.
use super::{capture, domain::*, evidence, plan_v2, routing};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[allow(dead_code)]
mod legacy {
    use super::super::domain::{AgentProposal, Attempt, CaptureTarget, Run, Team};
    use super::evidence;
    use serde::{Deserialize, Serialize};
    use std::collections::HashSet;
    fn pending() -> String {
        "pending".into()
    }
    include!("../../../benchmarks/plan-v2/baseline.rs");
    pub fn admit(text: &str, run: &Run) -> (usize, bool) {
        let (p, fallback) = usable_plan(text, run);
        (p.tasks.len(), fallback.is_some())
    }
}
// The old assignment validator consumes the old task shape. Adapt its DTO only;
// the pinned admission/fallback functions above are unmodified source excerpts.
mod staffing {
    use super::*;
    pub fn validate_assignments(
        agents: &[AgentProposal],
        tasks: &[legacy::Task],
    ) -> Result<(), String> {
        let tasks: Vec<Task> = tasks
            .iter()
            .map(|t| serde_json::from_value(serde_json::to_value(t).unwrap()).unwrap())
            .collect();
        super::super::staffing::validate_assignments(agents, &tasks)
    }
    pub fn with_agents(
        team: &Team,
        agents: &[AgentProposal],
        skills: &[Skill],
    ) -> Result<Team, String> {
        super::super::staffing::with_agents(team, agents, skills)
    }
}

#[test]
#[ignore = "Run npm run benchmark:plan-v2 to write a paired report"]
fn compare_planners() {
    let corpus_text = include_str!("../../../benchmarks/plan-v2/corpus.json");
    let corpus: Value = serde_json::from_str(corpus_text).unwrap();
    let provenance: Value =
        serde_json::from_str(include_str!("../../../benchmarks/plan-v2/baseline.json")).unwrap();
    let mut team = super::domain::tests::team();
    team.project_root = "D:/benchmark/repo".into();
    team.allowed_repositories = vec![team.project_root.clone()];
    team.members[0].tools = vec!["read".into(), "write".into(), "bash".into()];
    team.members[0].model = ModelRef {
        provider_id: "openai".into(),
        model_id: "assigned".into(),
    };
    let candidate = |id: &str| routing::ModelCandidate {
        runtime_id: "opencode".into(),
        provider_id: "openai".into(),
        model_id: id.into(),
        capability_scope: "provider:openai".into(),
        variant: None,
    };
    let models = vec![routing::AvailableModel {
        candidate: candidate("compatible"),
        name: "Deterministic fixture".into(),
        tools: Some(true),
        vision: Some(true),
        reasoning: Some(true),
        variants: vec![],
    }];
    let mut rows = vec![];
    for case in corpus["cases"].as_array().unwrap() {
        let mut run:Run=serde_json::from_value(json!({"id":"benchmark","goal":case["goal"],"team":team,"skills":[],"status":"planning","startedAt":1,"tasks":[],"summary":"","evidenceDir":"","artifacts":[],"baseline":[],"notified":false})).unwrap();
        run.plan_v2.enabled = true;
        let text = case["proposal"].as_str().unwrap();
        let expected = case["expectedValid"].as_bool().unwrap();
        let a_started = std::time::Instant::now();
        let (a_tasks, fallback) = legacy::admit(text, &run);
        let a_nanos = a_started.elapsed().as_nanos();
        let b_started = std::time::Instant::now();
        let b = plan_v2::parse_proposal(text, &run);
        let b_nanos = b_started.elapsed().as_nanos();
        assert_eq!(b.is_ok(), expected, "case {}: {:?}", case["id"], b.err());
        let category = case["routeCategory"].as_str().unwrap();
        let config = routing::RoutingConfig {
            enabled: true,
            routes: vec![routing::CategoryRoute {
                category: category.into(),
                candidates: vec![candidate("assigned"), candidate("compatible")],
            }],
            ..Default::default()
        };
        let c_started = std::time::Instant::now();
        let c = plan_v2::parse_proposal(text, &run);
        let route = c.as_ref().ok().map(|_| {
            routing::select(&config, &models, &team.members[0], category, false, &[])
                .unwrap()
                .1
        });
        let c_nanos = c_started.elapsed().as_nanos();
        rows.push(json!({"caseId":case["id"],"expectedValid":expected,"a":{"admitted":a_tasks>0,"genericFallback":fallback,"durationNanos":a_nanos,"assignedModelAvailable":false},
            "b":{"admitted":b.is_ok(),"genericFallback":false,"durationNanos":b_nanos,"assignedModelAvailable":false},
            "c":{"admitted":c.is_ok(),"genericFallback":false,"durationNanos":c_nanos,"route":route},"objectiveVerified":null,"costUsd":null,"humanInterventions":null}));
    }
    assert_eq!(rows.len(), 30);
    let report = json!({"schemaVersion":1,"scope":"deterministic-admission-and-routing","baseline":provenance,"corpusSha256":format!("{:x}",Sha256::digest(corpus_text.as_bytes())),"generatedAt":now(),
        "controls":{"sameCorpus":true,"sameTaskPermissions":true,"sameRoutingCatalog":true,"inference":"not sampled","runtime":"OpenCode DTOs; no sessions opened","prices":"unknown"},"cases":rows});
    let path = std::env::var("FLUFY_BENCHMARK_REPORT")
        .unwrap_or_else(|_| "../test-results/benchmarks/plan-v2.json".into());
    std::fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).unwrap();
    std::fs::write(&path, serde_json::to_string_pretty(&report).unwrap()).unwrap();
    println!("Paired 30-case admission/routing report: {path}");
}
