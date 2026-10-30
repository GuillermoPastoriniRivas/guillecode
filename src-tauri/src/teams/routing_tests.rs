use super::{
    domain::{Employee, ModelRef},
    routing::*,
};
use serde_json::json;
fn model(provider: &str, id: &str) -> AvailableModel {
    AvailableModel {
        candidate: ModelCandidate {
            runtime_id: "opencode".into(),
            provider_id: provider.into(),
            model_id: id.into(),
            capability_scope: format!("provider:{provider}"),
            variant: None,
        },
        name: id.into(),
        tools: Some(true),
        vision: Some(true),
        reasoning: Some(true),
        variants: vec!["high".into()],
    }
}
fn employee() -> Employee {
    let mut a = super::domain::tests::team().members[0].clone();
    a.model = ModelRef {
        provider_id: "openai".into(),
        model_id: "assigned".into(),
    };
    a
}
#[test]
fn auto_stays_in_enabled_scope_and_preserves_permissions() {
    let a = employee();
    let config = RoutingConfig {
        enabled: true,
        ..Default::default()
    };
    let models = vec![
        model("opencode-go", "foreign"),
        model("openai", "compatible"),
    ];
    let (selected, receipt) = select(&config, &models, &a, "code", false, &[]).unwrap();
    assert_eq!(selected.model.model_id, "compatible");
    assert_eq!(selected.tools, a.tools);
    assert_eq!(selected.instructions, a.instructions);
    assert_eq!(selected.skill_refs.len(), a.skill_refs.len());
    assert_eq!(receipt.selected.capability_scope, "provider:openai");
    assert_eq!(receipt.policy, "automatic_same_scope");
    assert_eq!(receipt.cost_usd, None);
    assert_eq!(receipt.remaining_quota, None);
}
#[test]
fn explicit_chain_records_unavailable_then_compatible_and_capacity_fallback() {
    let a = employee();
    let models = vec![
        model("openai", "assigned"),
        model("opencode-go", "alternative"),
    ];
    let config = RoutingConfig {
        enabled: true,
        max_workers_per_provider: 1,
        routes: vec![CategoryRoute {
            category: "deep".into(),
            candidates: vec![
                model("openai", "missing").candidate,
                models[0].candidate.clone(),
                models[1].candidate.clone(),
            ],
        }],
        ..Default::default()
    };
    let (selected, receipt) =
        select(&config, &models, &a, "deep", false, &["openai".into()]).unwrap();
    assert_eq!(selected.model.provider_id, "opencode-go");
    assert_eq!(receipt.considered[0].reason, "not_connected_or_unavailable");
    assert_eq!(receipt.considered[1].reason, "worker_capacity");
    assert!(matches!(
        select(
            &config,
            &models,
            &a,
            "deep",
            false,
            &["openai".into(), "opencode-go".into()]
        ),
        Err(RouteError::Capacity)
    ));
}
#[test]
fn manual_pin_retains_model_and_variant_while_unknown_capabilities_block_auto() {
    let mut a = employee();
    a.variant = Some("high".into());
    let mut m = model("openai", "assigned");
    m.tools = None;
    m.vision = None;
    m.reasoning = None;
    let mut config = RoutingConfig {
        enabled: true,
        ..Default::default()
    };
    assert!(matches!(
        select(&config, &[m.clone()], &a, "visual", true, &[]),
        Err(RouteError::Unavailable(_))
    ));
    config.pinned_agents.push(a.id.clone());
    let (selected, receipt) = select(&config, &[m.clone()], &a, "visual", true, &[]).unwrap();
    assert_eq!(selected.variant, a.variant);
    assert_eq!(receipt.policy, "manual");
    m.vision = Some(false);
    assert!(select(&config, &[m], &a, "visual", true, &[]).is_err());
}
#[test]
fn validates_routes_categories_variants_and_unsupported_local_runtime() {
    let a = employee();
    let models = vec![model("openai", "assigned")];
    let mut config = RoutingConfig {
        enabled: true,
        ..Default::default()
    };
    assert!(select(&config, &models, &a, "local", false, &[]).is_err());
    config.routes.push(CategoryRoute {
        category: "invented".into(),
        candidates: vec![models[0].candidate.clone()],
    });
    assert!(validate(&config).is_err());
    config.routes[0].category = "code".into();
    config.routes[0].candidates[0].capability_scope = "provider:another-account".into();
    assert!(validate(&config).is_err());
    config.routes[0].candidates[0] = models[0].candidate.clone();
    config.routes[0].candidates[0].variant = Some("missing".into());
    assert!(select(&config, &models, &a, "code", false, &[]).is_err());
}
#[test]
fn catalog_uses_only_connected_models_and_never_exports_credentials() {
    let catalog = catalog(
        &json!({"providers":[{"id":"openai","source":"api","options":{"apiKey":"SECRET"},"models":{"a":{"id":"a","name":"Model","capabilities":{"toolcall":true,"reasoning":true,"input":{"image":false}},"variants":{"high":{}}}}},{"id":"opencode","source":"custom","options":{"apiKey":"public"},"models":{"public":{"id":"public"}}},{"id":"unknown","source":"api","options":{"apiKey":"OTHER_SECRET"},"models":{"x":{"id":"x"}}}]}),
    );
    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0].tools, Some(true));
    assert_eq!(catalog[0].vision, Some(false));
    assert!(!serde_json::to_string(&catalog).unwrap().contains("SECRET"));
}
