//! Routing is admission, never credential recovery or a replay of an active session.
use super::domain::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

pub const CATEGORIES: &[&str] = &["quick", "deep", "visual", "code", "review", "local"];
fn parallel_default() -> usize {
    2
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutingConfig {
    pub enabled: bool,
    pub routes: Vec<CategoryRoute>,
    pub pinned_agents: Vec<String>,
    pub max_workers_per_provider: usize,
}
impl Default for RoutingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            routes: vec![],
            pinned_agents: vec![],
            max_workers_per_provider: parallel_default(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CategoryRoute {
    pub category: String,
    pub candidates: Vec<ModelCandidate>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelCandidate {
    pub runtime_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub capability_scope: String,
    pub variant: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableModel {
    #[serde(flatten)]
    pub candidate: ModelCandidate,
    pub name: String,
    pub tools: Option<bool>,
    pub vision: Option<bool>,
    pub reasoning: Option<bool>,
    pub variants: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteConsideration {
    pub candidate: ModelCandidate,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingReceipt {
    pub category: String,
    pub policy: String,
    pub selected: ModelCandidate,
    pub considered: Vec<RouteConsideration>,
    pub decided_at: i64,
    pub cost_usd: Option<f64>,
    pub remaining_quota: Option<u64>,
}

pub fn validate(config: &RoutingConfig) -> Result<(), String> {
    if !(1..=16).contains(&config.max_workers_per_provider)
        || config.routes.len() > CATEGORIES.len()
        || config.pinned_agents.len() > 100
    {
        return Err(
            "Ruteo inválido: hasta seis categorías y entre 1 y 16 trabajadores por proveedor"
                .into(),
        );
    }
    let mut categories = HashSet::new();
    for route in &config.routes {
        if !CATEGORIES.contains(&route.category.as_str())
            || !categories.insert(&route.category)
            || route.candidates.is_empty()
            || route.candidates.len() > 3
        {
            return Err(
                "Cada categoría necesita entre 1 y 3 candidatos y no puede repetirse".into(),
            );
        }
        let mut identities = HashSet::new();
        for c in &route.candidates {
            if c.runtime_id != "opencode"
                || c.capability_scope != format!("provider:{}", c.provider_id)
                || [&c.provider_id, &c.model_id].iter().any(|s| {
                    s.trim().is_empty() || s.len() > 240 || s.chars().any(char::is_control)
                })
                || !identities.insert((&c.provider_id, &c.model_id, &c.variant))
            {
                return Err("El candidato debe pertenecer al runtime OpenCode y a un scope de proveedor válido, sin duplicados".into());
            }
        }
    }
    Ok(())
}

pub fn catalog(value: &Value) -> Vec<AvailableModel> {
    let connected: HashSet<_> = crate::accounts::available_models(value)
        .into_iter()
        .collect();
    let mut result = vec![];
    for provider in value["providers"].as_array().into_iter().flatten() {
        let Some(provider_id) = provider["id"].as_str() else {
            continue;
        };
        for model in provider["models"]
            .as_object()
            .into_iter()
            .flat_map(|o| o.values())
        {
            let Some(model_id) = model["id"].as_str() else {
                continue;
            };
            if !connected.contains(&(provider_id.into(), model_id.into())) {
                continue;
            }
            result.push(AvailableModel {
                candidate: ModelCandidate {
                    runtime_id: "opencode".into(),
                    provider_id: provider_id.into(),
                    model_id: model_id.into(),
                    capability_scope: format!("provider:{provider_id}"),
                    variant: None,
                },
                name: model["name"].as_str().unwrap_or(model_id).into(),
                tools: model["capabilities"]["toolcall"].as_bool(),
                vision: model["capabilities"]["input"]["image"].as_bool(),
                reasoning: model["capabilities"]["reasoning"].as_bool(),
                variants: model["variants"]
                    .as_object()
                    .map(|v| v.keys().cloned().collect())
                    .unwrap_or_default(),
            });
        }
    }
    result.sort_by(|a, b| {
        (&a.candidate.provider_id, &a.candidate.model_id)
            .cmp(&(&b.candidate.provider_id, &b.candidate.model_id))
    });
    result
}

pub fn category(task: Option<&Task>, employee: &Employee) -> String {
    if let Some(category) = task
        .and_then(|t| t.contract.category.as_ref())
        .filter(|c| CATEGORIES.contains(&c.as_str()))
    {
        return category.clone();
    }
    let role = employee.role.to_lowercase();
    if role.contains("review") || role.contains("supervisor") || role == "qa" {
        return "review".into();
    }
    if task.is_some_and(|t| t.contract.risk.as_deref() == Some("high")) {
        return "deep".into();
    }
    if role.contains("frontend") {
        return "visual".into();
    }
    "code".into()
}

#[derive(Debug)]
pub enum RouteError {
    Capacity,
    Unavailable(String),
}

pub fn select(
    config: &RoutingConfig,
    models: &[AvailableModel],
    employee: &Employee,
    category: &str,
    vision: bool,
    occupied: &[String],
) -> Result<(Employee, RoutingReceipt), RouteError> {
    validate(config).map_err(RouteError::Unavailable)?;
    let manual = ModelCandidate {
        runtime_id: "opencode".into(),
        provider_id: employee.model.provider_id.clone(),
        model_id: employee.model.model_id.clone(),
        capability_scope: format!("provider:{}", employee.model.provider_id),
        variant: employee.variant.clone(),
    };
    let pinned = !config.enabled || config.pinned_agents.contains(&employee.id);
    let explicit = config.routes.iter().find(|r| r.category == category);
    let candidates = if pinned {
        vec![manual.clone()]
    } else if let Some(route) = explicit {
        route.candidates.clone()
    } else {
        // Default automation stays inside the already selected provider/account
        // scope. Cross-provider fallback requires an explicit configured chain.
        let mut options: Vec<_> = models
            .iter()
            .filter(|m| m.candidate.provider_id == employee.model.provider_id)
            .collect();
        options.sort_by_key(|m| {
            (
                if category == "quick" {
                    m.reasoning != Some(false)
                } else if ["deep", "review"].contains(&category) {
                    m.reasoning != Some(true)
                } else {
                    false
                },
                m.candidate.model_id != employee.model.model_id,
                m.candidate.model_id.clone(),
            )
        });
        options
            .into_iter()
            .map(|m| {
                let mut c = m.candidate.clone();
                if c.model_id == employee.model.model_id {
                    c.variant = employee.variant.clone();
                }
                c
            })
            .collect()
    };
    let mut considered = vec![];
    let mut capacity = false;
    for candidate in candidates {
        let model = models.iter().find(|m| {
            m.candidate.provider_id == candidate.provider_id
                && m.candidate.model_id == candidate.model_id
        });
        let reason = if let Some(model) = model {
            if candidate
                .variant
                .as_ref()
                .is_some_and(|v| !model.variants.contains(v))
            {
                Some("variant_unavailable")
            } else if !pinned && model.tools != Some(true) {
                Some("tools_unavailable_or_unknown")
            } else if (vision
                && (if pinned {
                    model.vision == Some(false)
                } else {
                    model.vision != Some(true)
                }))
                || (!pinned && category == "visual" && model.vision != Some(true))
            {
                Some("vision_unavailable_or_unknown")
            } else if !pinned && category == "deep" && model.reasoning != Some(true) {
                Some("reasoning_unavailable_or_unknown")
            } else if !pinned && category == "local" && !candidate.provider_id.starts_with("ollama")
            {
                Some("local_runtime_unavailable")
            } else if occupied
                .iter()
                .filter(|p| *p == &candidate.provider_id)
                .count()
                >= config.max_workers_per_provider
            {
                capacity = true;
                Some("worker_capacity")
            } else {
                None
            }
        } else {
            Some("not_connected_or_unavailable")
        };
        if let Some(reason) = reason {
            considered.push(RouteConsideration {
                candidate,
                reason: reason.into(),
            });
            continue;
        }
        let mut selected = employee.clone();
        selected.model = ModelRef {
            provider_id: candidate.provider_id.clone(),
            model_id: candidate.model_id.clone(),
        };
        selected.variant = candidate.variant.clone();
        let receipt = RoutingReceipt {
            category: category.into(),
            policy: if pinned {
                "manual"
            } else if explicit.is_some() {
                "configured_chain"
            } else {
                "automatic_same_scope"
            }
            .into(),
            selected: candidate,
            considered,
            decided_at: now(),
            cost_usd: None,
            remaining_quota: None,
        };
        return Ok((selected, receipt));
    }
    if capacity {
        Err(RouteError::Capacity)
    } else {
        Err(RouteError::Unavailable(format!("No hay un modelo habilitado con las capacidades requeridas para {category}; revisá la ruta o fijá un modelo manual")))
    }
}
