export function renderRuntimePy(): string {
  return `import base64
import copy
import hashlib
import json
import math
import pickle
import re
from pathlib import Path
from typing import Any
from sqlalchemy import select
from .db import deployment_rollouts, embedding_profiles as embedding_profiles_table, engine, model_versions


BASE_DIR = Path(__file__).resolve().parent
PACKAGE_DIR = BASE_DIR.parent
METADATA_DIR = BASE_DIR / "metadata"
ARTIFACTS_DIR = PACKAGE_DIR / ".mlops" / "artifacts"


def load_json(name: str) -> dict[str, Any]:
    return json.loads((METADATA_DIR / name).read_text(encoding="utf-8"))


def load_optional_json(name: str) -> dict[str, Any] | None:
    path = METADATA_DIR / name
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


project = load_json("project.json")
pipeline = load_json("pipeline.flow.json")
runtime_manifest = load_json("runtime.manifest.json")
latest_training_result = load_optional_json("latest-training-result.json")
PREDICTION_CACHE: dict[str, dict[str, Any]] = {}
PREDICTION_CACHE_MAX_ITEMS = 512


def model_catalog() -> list[dict[str, Any]]:
    models = []
    trained_models = trained_model_lookup()
    stored_models = stored_model_lookup()
    active_id = operational_active_model_id()
    seen_model_ids = set()
    for node in pipeline.get("nodes", []):
        if node.get("type") == "model":
            trained = trained_models.get(node["id"], {})
            stored = stored_models.get(node["id"], {})
            seen_model_ids.add(node["id"])
            models.append({
                "id": node["id"],
                "label": node.get("label", node["id"]),
                "algorithm": stored.get("algorithm") or node.get("algorithm") or node.get("framework") or "custom",
                "role": node.get("modelRole", "candidate"),
                "status": "active" if node["id"] == active_id else stored.get("status") or "candidate",
                "metrics": stored.get("metrics") or trained.get("metrics") or synthetic_model_metrics(node["id"]),
                "artifact_uri": stored.get("artifact_uri") or trained.get("artifactUri"),
                "training_run_id": latest_training_result.get("runId") if trained and latest_training_result else None,
                "training_rows": trained.get("trainingRows"),
                "validation_rows": trained.get("validationRows"),
            })
    for model_id, stored in stored_models.items():
        if model_id in seen_model_ids:
            continue
        models.append({
            "id": model_id,
            "label": model_id,
            "algorithm": stored.get("algorithm") or "registered",
            "role": "registered",
            "status": "active" if model_id == active_id or stored.get("is_active") else stored.get("status") or "registered",
            "metrics": stored.get("metrics") or synthetic_model_metrics(model_id),
            "artifact_uri": stored.get("artifact_uri"),
            "training_run_id": None,
            "training_rows": None,
            "validation_rows": None,
        })
    if not models:
        models.append({
            "id": "deterministic_baseline",
            "label": "Deterministic baseline",
            "algorithm": "hash_baseline",
            "role": "active",
            "status": "active",
            "metrics": synthetic_model_metrics("deterministic_baseline"),
        })
    return models


def trained_model_lookup() -> dict[str, dict[str, Any]]:
    if not latest_training_result:
        return {}
    lookup: dict[str, dict[str, Any]] = {}
    for model in latest_training_result.get("leaderboard", []):
        if isinstance(model, dict) and model.get("modelId"):
            lookup[str(model["modelId"])] = model
    return lookup


def stored_model_lookup() -> dict[str, dict[str, Any]]:
    try:
        with engine.connect() as connection:
            rows = connection.execute(select(model_versions)).mappings().fetchall()
        return {
            str(row["id"]): {
                "id": row["id"],
                "status": row["status"],
                "algorithm": row["algorithm"],
                "metrics": row["metrics"] or {},
                "artifact_uri": row["artifact_uri"],
                "is_active": bool(row["is_active"]),
            }
            for row in rows
        }
    except Exception:
        return {}


def resolve_artifact_uri(artifact_uri: str | None) -> Path | None:
    if not artifact_uri:
        return None
    normalized = artifact_uri.replace("\\\\", "/").lstrip("/")
    if normalized.startswith("../") or "/../" in normalized:
        return None
    if normalized.startswith("artifacts/"):
        normalized = normalized.removeprefix("artifacts/")
    candidate = (ARTIFACTS_DIR / normalized).resolve()
    artifacts_root = ARTIFACTS_DIR.resolve()
    if candidate != artifacts_root and artifacts_root not in candidate.parents:
        return None
    return candidate


def load_model_artifact(model: dict[str, Any]) -> dict[str, Any] | None:
    artifact_path = resolve_artifact_uri(model.get("artifact_uri"))
    if not artifact_path or not artifact_path.exists():
        return None
    try:
        artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    return artifact if isinstance(artifact, dict) else None


def active_model() -> dict[str, Any]:
    models = model_catalog()
    active_id = operational_active_model_id()
    for model in models:
        if model["id"] == active_id or model["status"] == "active":
            return model
    return models[0]


def model_by_id(model_id: str | None) -> dict[str, Any] | None:
    if not model_id:
        return None
    return next((model for model in model_catalog() if model["id"] == model_id), None)


def operational_active_model_id() -> str:
    try:
        with engine.connect() as connection:
            row = connection.execute(select(model_versions.c.id).where(model_versions.c.is_active == True).limit(1)).scalar_one_or_none()
        return str(row or runtime_manifest["activeModelId"])
    except Exception:
        return runtime_manifest["activeModelId"]


def active_rollout() -> dict[str, Any] | None:
    try:
        with engine.connect() as connection:
            row = connection.execute(
                select(deployment_rollouts)
                .where(deployment_rollouts.c.status == "active")
                .order_by(deployment_rollouts.c.created_at.desc())
                .limit(1)
            ).mappings().first()
        return dict(row) if row else None
    except Exception:
        return None


def synthetic_model_metrics(model_id: str) -> dict[str, float]:
    digest = int(hashlib.sha256(model_id.encode("utf-8")).hexdigest()[:8], 16)
    problem_type = project["problem"]["type"]
    if problem_type == "regression":
        return {"rmse": round(12.0 + digest % 200 / 100, 4), "mae": round(8.0 + digest % 120 / 100, 4), "r2": round(0.72 + digest % 20 / 100, 4)}
    return {"accuracy": round(0.78 + digest % 12 / 100, 4), "f1_macro": round(0.74 + digest % 14 / 100, 4), "f1_weighted": round(0.76 + digest % 12 / 100, 4)}


def model_metrics() -> dict[str, Any]:
    models = model_catalog()
    return {
        "primary_metric": project["metrics"]["primary"],
        "secondary_metrics": project["metrics"].get("secondary", []),
        "latest_training_run_id": latest_training_result.get("runId") if latest_training_result else None,
        "best_model_id": latest_training_result.get("bestModelId") if latest_training_result else None,
        "models": models,
    }


def model_card() -> dict[str, Any]:
    return {
        "project": {"id": project["id"], "name": project["name"], "version": project["version"]},
        **project.get("modelCard", {}),
        "active_model": active_model(),
    }


def predict_payload(payload: dict[str, Any]) -> dict[str, Any]:
    active = active_model()
    rollout = active_rollout()
    if not rollout:
        cached = prediction_cache_get(payload, active)
        if cached:
            return cached
    if rollout and rollout.get("kind") == "canary":
        candidate = model_by_id(str(rollout.get("candidate_model_id") or ""))
        traffic_percent = float(rollout.get("traffic_percent") or 0.0)
        if candidate and rollout_bucket(payload) < traffic_percent:
            output = predict_with_model(payload, candidate)
            output["deployment"] = {"mode": "canary", "rollout_id": rollout["id"], "routed_to": "candidate", "traffic_percent": traffic_percent, "active_model_id": active["id"], "candidate_model_id": candidate["id"]}
            return output
        output = predict_with_model(payload, active)
        output["deployment"] = {"mode": "canary", "rollout_id": rollout["id"], "routed_to": "active", "traffic_percent": traffic_percent, "active_model_id": active["id"], "candidate_model_id": rollout.get("candidate_model_id")}
        return output
    output = predict_with_model(payload, active)
    if rollout and rollout.get("kind") == "shadow":
        candidate = model_by_id(str(rollout.get("candidate_model_id") or ""))
        if candidate:
            shadow_output = predict_with_model(payload, candidate)
            output["deployment"] = {"mode": "shadow", "rollout_id": rollout["id"], "routed_to": "active", "active_model_id": active["id"], "candidate_model_id": candidate["id"]}
            output["shadow_prediction"] = compact_shadow_prediction(shadow_output)
    if not rollout:
        return prediction_cache_put(payload, active, output)
    return output


def prediction_cache_get(payload: dict[str, Any], model: dict[str, Any]) -> dict[str, Any] | None:
    key = prediction_cache_key(payload, model)
    cached = PREDICTION_CACHE.get(key)
    if not cached:
        return None
    output = copy.deepcopy(cached)
    output["cache"] = {"hit": True, "key": key, "strategy": "in_memory_versioned_payload_cache"}
    return output


def prediction_cache_put(payload: dict[str, Any], model: dict[str, Any], output: dict[str, Any]) -> dict[str, Any]:
    key = prediction_cache_key(payload, model)
    stored = copy.deepcopy(output)
    stored.pop("cache", None)
    PREDICTION_CACHE[key] = stored
    while len(PREDICTION_CACHE) > PREDICTION_CACHE_MAX_ITEMS:
        PREDICTION_CACHE.pop(next(iter(PREDICTION_CACHE)))
    response = copy.deepcopy(output)
    response["cache"] = {"hit": False, "key": key, "strategy": "in_memory_versioned_payload_cache"}
    return response


def prediction_cache_key(payload: dict[str, Any], model: dict[str, Any]) -> str:
    raw = json.dumps(
        {
            "payload": payload,
            "projectHash": runtime_manifest.get("projectHash"),
            "pipelineHash": runtime_manifest.get("pipelineHash"),
            "modelVersionId": model.get("id"),
            "legalPolicy": legal_cache_policy_key(),
        },
        sort_keys=True,
        ensure_ascii=False,
        default=str,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def legal_cache_policy_key() -> dict[str, Any]:
    legal = legal_domain()
    if not legal:
        return {}
    embedding_profile = active_legal_embedding_profile(legal) or {}
    return {
        "decisionPolicy": legal_decision_policy(legal).get("version"),
        "embeddingProfileId": embedding_profile.get("id"),
        "embeddingModelVersion": embedding_profile.get("modelVersion"),
        "preprocessingVersion": embedding_profile.get("preprocessingVersion"),
        "chunkingVersion": embedding_profile.get("chunkingVersion"),
        "llmPromptTemplateVersion": (legal.get("llm") or {}).get("promptTemplateVersion") if isinstance(legal.get("llm"), dict) else None,
    }


def predict_with_model(payload: dict[str, Any], model: dict[str, Any]) -> dict[str, Any]:
    problem = project["problem"]
    trace = [{"node_id": node["id"], "type": node["type"], "status": "completed"} for node in pipeline.get("nodes", [])]
    artifact = load_model_artifact(model)
    artifact_prediction = predict_from_artifact(artifact, payload, problem, trace, model) if artifact else None
    if artifact_prediction:
        return enrich_prediction_output(artifact_prediction, payload, trace)

    return enrich_prediction_output(synthetic_predict_payload(payload, model, problem, trace), payload, trace)


def rollout_bucket(payload: dict[str, Any]) -> float:
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    digest = int(hashlib.sha256(raw.encode("utf-8")).hexdigest()[:8], 16)
    return float(digest % 10000) / 100.0


def compact_shadow_prediction(output: dict[str, Any]) -> dict[str, Any]:
    return {
        "model_version_id": output.get("model_version_id"),
        "prediction": output.get("prediction"),
        "confidence": output.get("confidence"),
        "inference_source": output.get("inference_source"),
    }


def enrich_prediction_output(output: dict[str, Any], payload: dict[str, Any], trace: list[dict[str, Any]]) -> dict[str, Any]:
    legal = legal_domain()
    if not legal or project["problem"].get("type") == "regression":
        return output

    explanation = legal_explanation(payload, output, legal)
    trace.append({
        "node_id": "legal_decision_policy",
        "type": "domain_policy",
        "status": explanation["review"]["status"],
        "details": {
            "policy_version": explanation["decisionPolicy"]["version"],
            "review_reasons": explanation["review"]["reasons"],
            "final_score": explanation["scores"]["finalScore"],
        },
    })
    output["explanation"] = explanation
    output["review"] = explanation["review"]
    output["decision"] = explanation["decision"]
    output["top_candidates"] = explanation["topCandidates"]
    output["embedding_profile"] = explanation["embeddingProfile"]
    return output


def legal_domain() -> dict[str, Any] | None:
    domain = project.get("domain", {})
    if not isinstance(domain, dict) or domain.get("kind") != "legal_classification":
        return None
    legal = domain.get("legal")
    return legal if isinstance(legal, dict) else None


def legal_explanation(payload: dict[str, Any], output: dict[str, Any], legal: dict[str, Any]) -> dict[str, Any]:
    prediction = str(output.get("prediction") or "")
    categories = legal_categories_by_code(legal)
    category = legal_category_payload(categories.get(prediction), prediction)
    probabilities = output.get("probabilities") if isinstance(output.get("probabilities"), dict) else {}
    candidates = legal_top_candidates(probabilities, prediction, categories)
    classifier_probability = as_float(output.get("confidence"))
    if classifier_probability is None and candidates:
        classifier_probability = as_float(candidates[0].get("probability"))
    semantic_similarity = semantic_similarity_from_payload(payload)
    workflow = legal_workflow_result(payload, prediction, legal)
    policy = legal_decision_policy(legal)
    final_score = legal_final_score(classifier_probability, semantic_similarity, workflow["ruleScore"], policy)
    margin = legal_top_margin(candidates)
    review = legal_review_decision(classifier_probability, margin, workflow, category, legal)
    llm = legal_llm_decision(review, legal)
    decision = {
        "status": review["status"],
        "categoryCode": prediction,
        "categoryName": category.get("name"),
        "confidence": classifier_probability,
        "finalScore": final_score,
        "humanReviewRequired": review["humanReviewRequired"],
        "llmReviewRecommended": llm["recommended"],
    }
    rationale = legal_rationale(category, classifier_probability, semantic_similarity, workflow, final_score, review, llm)
    return {
        "kind": "legal_classification",
        "category": category,
        "decision": decision,
        "scores": {
            "classifierProbability": classifier_probability,
            "semanticSimilarity": semantic_similarity,
            "workflowRuleScore": workflow["ruleScore"],
            "finalScore": final_score,
            "topMargin": margin,
        },
        "topCandidates": candidates,
        "workflow": workflow,
        "decisionPolicy": policy,
        "embeddingProfile": active_legal_embedding_profile(legal),
        "llm": llm,
        "review": review,
        "rationale": rationale,
    }


def legal_categories_by_code(legal: dict[str, Any]) -> dict[str, dict[str, Any]]:
    categories = legal.get("categories", [])
    if not isinstance(categories, list):
        return {}
    return {
        str(category.get("code")): category
        for category in categories
        if isinstance(category, dict) and category.get("code")
    }


def legal_category_payload(category: dict[str, Any] | None, code: str) -> dict[str, Any]:
    source = category or {}
    return {
        "code": code,
        "name": source.get("name") or code,
        "description": source.get("description"),
        "target": source.get("target"),
        "critical": bool(source.get("critical", False)),
        "requiresHumanReview": bool(source.get("requiresHumanReview", False)),
        "workflowStepCodes": list(source.get("workflowStepCodes") or []),
    }


def legal_top_candidates(probabilities: Any, prediction: str, categories: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: dict[str, float] = {}
    if isinstance(probabilities, dict):
        for label, value in probabilities.items():
            numeric = as_float(value)
            if numeric is not None:
                normalized[str(label)] = numeric
    classes = [str(item) for item in project["problem"].get("classes") or []]
    for label in classes:
        normalized.setdefault(label, 0.0)
    if prediction and prediction not in normalized:
        normalized[prediction] = 1.0 if not probabilities else 0.0
    items = sorted(normalized.items(), key=lambda item: item[1], reverse=True)
    return [
        {
            "code": label,
            "name": (categories.get(label) or {}).get("name") or label,
            "probability": round(float(probability), 6),
            "critical": bool((categories.get(label) or {}).get("critical", False)),
            "requiresHumanReview": bool((categories.get(label) or {}).get("requiresHumanReview", False)),
        }
        for label, probability in items[:5]
    ]


def legal_top_margin(candidates: list[dict[str, Any]]) -> float | None:
    if len(candidates) < 2:
        return None
    left = as_float(candidates[0].get("probability")) or 0.0
    right = as_float(candidates[1].get("probability")) or 0.0
    return round(max(0.0, left - right), 6)


def legal_workflow_result(payload: dict[str, Any], prediction: str, legal: dict[str, Any]) -> dict[str, Any]:
    workflow_field = str(legal.get("workflowContextField") or "workflow_step_atual")
    current_step = payload.get(workflow_field)
    current_step = str(current_step) if current_step is not None and str(current_step).strip() else None
    categories = legal_categories_by_code(legal)
    category = categories.get(prediction) or {}
    allowed_steps = [str(item) for item in category.get("workflowStepCodes", [])]
    workflow_steps = legal_workflow_steps_by_code(legal)
    active_transitions = legal_active_transitions(legal)
    transitions_from_current = [
        transition
        for transition in active_transitions
        if current_step and transition.get("from") == current_step
    ]
    review_transitions_to_allowed = [
        transition
        for transition in transitions_from_current
        if transition.get("to") in allowed_steps and transition.get("severity") == "review"
    ]
    blocked_rules: list[str] = []
    if current_step is None:
        status = "unknown"
        allowed = None
        rule_score = 0.5
    elif current_step in allowed_steps:
        status = "accepted"
        allowed = True
        rule_score = 1.0
    elif review_transitions_to_allowed:
        status = "review"
        allowed = False
        rule_score = 0.75
        blocked_rules.append("workflow_requires_transition_confirmation")
    else:
        status = "blocked"
        allowed = False
        rule_score = 0.0
        blocked_rules.append(f"category_{prediction}_not_allowed_from_{current_step}")
    return {
        "contextField": workflow_field,
        "currentStep": current_step,
        "currentStepName": (workflow_steps.get(current_step or "") or {}).get("name"),
        "allowedSteps": allowed_steps,
        "allowedStepNames": [(workflow_steps.get(step) or {}).get("name") or step for step in allowed_steps],
        "allowed": allowed,
        "status": status,
        "ruleScore": rule_score,
        "blockedRules": blocked_rules,
        "availableTransitions": [
            {
                "from": transition.get("from"),
                "to": transition.get("to"),
                "severity": transition.get("severity"),
                "condition": transition.get("condition"),
            }
            for transition in transitions_from_current
        ],
    }


def legal_workflow_steps_by_code(legal: dict[str, Any]) -> dict[str, dict[str, Any]]:
    steps = legal.get("workflowSteps", [])
    if not isinstance(steps, list):
        return {}
    return {
        str(step.get("code")): step
        for step in steps
        if isinstance(step, dict) and step.get("code")
    }


def legal_active_transitions(legal: dict[str, Any]) -> list[dict[str, Any]]:
    transitions = legal.get("workflowTransitions", [])
    if not isinstance(transitions, list):
        return []
    return [
        transition
        for transition in transitions
        if isinstance(transition, dict) and transition.get("active", True)
    ]


def legal_decision_policy(legal: dict[str, Any]) -> dict[str, Any]:
    policy = legal.get("decisionPolicy") if isinstance(legal.get("decisionPolicy"), dict) else {}
    weights = policy.get("weights") if isinstance(policy.get("weights"), dict) else {}
    return {
        "version": policy.get("version") or "legal-decision-policy-v1",
        "lowConfidenceThreshold": as_float(policy.get("lowConfidenceThreshold")) if as_float(policy.get("lowConfidenceThreshold")) is not None else 0.62,
        "topMarginThreshold": as_float(policy.get("topMarginThreshold")) if as_float(policy.get("topMarginThreshold")) is not None else 0.08,
        "weights": {
            "classifierProbability": as_float(weights.get("classifierProbability")) if as_float(weights.get("classifierProbability")) is not None else 0.55,
            "semanticSimilarity": as_float(weights.get("semanticSimilarity")) if as_float(weights.get("semanticSimilarity")) is not None else 0.30,
            "workflowRules": as_float(weights.get("workflowRules")) if as_float(weights.get("workflowRules")) is not None else 0.15,
            "llmReview": as_float(weights.get("llmReview")) if as_float(weights.get("llmReview")) is not None else 0.0,
        },
    }


def legal_final_score(classifier_probability: float | None, semantic_similarity: float | None, workflow_rule_score: float, policy: dict[str, Any]) -> float | None:
    weights = policy.get("weights", {})
    weighted_values: list[tuple[float, float]] = []
    if classifier_probability is not None:
        weighted_values.append((classifier_probability, float(weights.get("classifierProbability", 0.55))))
    if semantic_similarity is not None:
        weighted_values.append((semantic_similarity, float(weights.get("semanticSimilarity", 0.30))))
    weighted_values.append((workflow_rule_score, float(weights.get("workflowRules", 0.15))))
    total_weight = sum(weight for _value, weight in weighted_values if weight > 0)
    if total_weight <= 0:
        return classifier_probability
    return round(sum(value * weight for value, weight in weighted_values if weight > 0) / total_weight, 6)


def legal_review_decision(classifier_probability: float | None, top_margin: float | None, workflow: dict[str, Any], category: dict[str, Any], legal: dict[str, Any]) -> dict[str, Any]:
    policy = legal_decision_policy(legal)
    reasons: list[str] = []
    if classifier_probability is not None and classifier_probability < float(policy["lowConfidenceThreshold"]):
        reasons.append("low_confidence")
    if top_margin is not None and top_margin < float(policy["topMarginThreshold"]):
        reasons.append("top_margin_low")
    if workflow["status"] == "blocked":
        reasons.append("workflow_blocked")
    elif workflow["status"] in {"review", "unknown"}:
        reasons.append("workflow_requires_review")
    if category.get("critical"):
        reasons.append("critical_category")
    if category.get("requiresHumanReview"):
        reasons.append("category_requires_human_review")
    status = "blocked" if "workflow_blocked" in reasons else "review" if reasons else "accepted"
    return {
        "status": status,
        "humanReviewRequired": status != "accepted",
        "reasons": reasons,
        "lowConfidenceThreshold": policy["lowConfidenceThreshold"],
        "topMarginThreshold": policy["topMarginThreshold"],
    }


def legal_llm_decision(review: dict[str, Any], legal: dict[str, Any]) -> dict[str, Any]:
    llm = legal.get("llm") if isinstance(legal.get("llm"), dict) else {}
    trigger_policy = [str(item) for item in llm.get("triggerPolicy", [])] if isinstance(llm.get("triggerPolicy"), list) else []
    matching_triggers = [reason for reason in review.get("reasons", []) if reason in trigger_policy]
    enabled = bool(llm.get("enabled", False))
    return {
        "enabled": enabled,
        "recommended": enabled and bool(matching_triggers),
        "used": False,
        "reason": "llm_disabled_by_policy" if not enabled else "llm_not_invoked_in_local_runtime",
        "triggerPolicy": trigger_policy,
        "matchedTriggers": matching_triggers,
        "promptTemplateVersion": llm.get("promptTemplateVersion") or "legal-low-confidence-v1",
        "maskSensitiveData": bool(llm.get("maskSensitiveData", True)),
        "jsonResponseRequired": bool(llm.get("jsonResponseRequired", True)),
        "mustNotAutoApply": bool(llm.get("mustNotAutoApply", True)),
    }


def legal_rationale(
    category: dict[str, Any],
    classifier_probability: float | None,
    semantic_similarity: float | None,
    workflow: dict[str, Any],
    final_score: float | None,
    review: dict[str, Any],
    llm: dict[str, Any],
) -> list[str]:
    rationale = [
        f"Categoria {category.get('code')} ({category.get('name')}) foi escolhida pelo modelo ativo.",
        f"Probabilidade do classificador: {classifier_probability if classifier_probability is not None else 'n/d'}.",
        f"Score final híbrido: {final_score if final_score is not None else 'n/d'}.",
    ]
    if semantic_similarity is None:
        rationale.append("Similaridade semântica não foi recebida no payload; o score foi reponderado sem a camada vetorial.")
    else:
        rationale.append(f"Similaridade semântica recebida: {semantic_similarity}.")
    if workflow["status"] == "accepted":
        rationale.append("A categoria é compatível com a etapa atual do workflow.")
    elif workflow["status"] == "blocked":
        rationale.append("A categoria viola as regras de workflow configuradas para a etapa atual.")
    else:
        rationale.append("O workflow exige revisão ou não possui etapa atual suficiente para aprovação automática.")
    if review["humanReviewRequired"]:
        rationale.append(f"Revisão humana exigida por: {', '.join(review['reasons'])}.")
    if llm["recommended"]:
        rationale.append("LLM recomendado como quarta camada, mas sem autoaplicação da decisão.")
    return rationale


def active_legal_embedding_profile(legal: dict[str, Any]) -> dict[str, Any] | None:
    profiles = legal.get("embeddingProfiles", [])
    if not isinstance(profiles, list):
        return None
    active = next((profile for profile in profiles if isinstance(profile, dict) and profile.get("status") == "active"), None)
    fallback = next((profile for profile in profiles if isinstance(profile, dict)), None)
    profile = active or fallback
    if not profile:
        return None
    return {
        "id": profile.get("id"),
        "provider": profile.get("provider"),
        "modelName": profile.get("modelName"),
        "modelVersion": profile.get("modelVersion"),
        "modelDigest": profile.get("modelDigest"),
        "dimension": profile.get("dimension"),
        "normalization": profile.get("normalization"),
        "pooling": profile.get("pooling"),
        "preprocessingVersion": profile.get("preprocessingVersion"),
        "chunkingVersion": profile.get("chunkingVersion"),
        "similarityMetric": profile.get("similarityMetric"),
        "vectorCollections": profile.get("vectorCollections", {}),
        "status": profile.get("status"),
    }


def stored_embedding_profile_lookup() -> dict[str, dict[str, Any]]:
    try:
        with engine.connect() as connection:
            rows = connection.execute(select(embedding_profiles_table)).mappings().fetchall()
        return {
            str(row["id"]): {
                "id": row["id"],
                "provider": row["provider"],
                "modelName": row["model_name"],
                "modelVersion": row["model_version"],
                "modelDigest": row["model_digest"],
                "dimension": row["dimension"],
                "normalization": (row["metadata_json"] or {}).get("normalization") if isinstance(row["metadata_json"], dict) else None,
                "pooling": (row["metadata_json"] or {}).get("pooling") if isinstance(row["metadata_json"], dict) else None,
                "preprocessingVersion": row["preprocessing_version"],
                "chunkingVersion": row["chunking_version"],
                "similarityMetric": row["similarity_metric"],
                "vectorCollections": row["vector_collections"] or {},
                "status": row["status"],
                "source": "registry",
            }
            for row in rows
        }
    except Exception:
        return {}


def embedding_profiles() -> dict[str, Any]:
    legal = legal_domain()
    if not legal:
        return {"kind": "embedding_profiles", "activeProfileId": None, "profiles": []}
    stored_profiles = stored_embedding_profile_lookup()
    profiles = []
    seen_profile_ids = set()
    for profile in legal.get("embeddingProfiles", []):
        if isinstance(profile, dict):
            response = active_legal_embedding_profile({"embeddingProfiles": [profile]})
            if response and response.get("id") in stored_profiles:
                response = {**response, **stored_profiles[str(response["id"])], "source": "manifest+registry"}
            if response and response.get("id"):
                seen_profile_ids.add(str(response["id"]))
            profiles.append(response)
    for profile_id, stored in stored_profiles.items():
        if profile_id not in seen_profile_ids:
            profiles.append(stored)
    profiles = [profile for profile in profiles if profile]
    active = next((profile for profile in profiles if profile.get("status") == "active"), None) or active_legal_embedding_profile(legal)
    return {
        "kind": "embedding_profiles",
        "activeProfileId": active.get("id") if active else None,
        "profiles": profiles,
        "substitutionContract": {
            "stableInputs": ["textHash", "entityType", "entityId", "chunkId"],
            "versionedKeys": ["embeddingProfileId", "modelName", "modelVersion", "preprocessingVersion", "chunkingVersion"],
            "architectureInvariant": "Trocar o modelo de embeddings exige novo profile e reindexação, sem alterar o contrato de inferência.",
        },
    }


def embedding_search(query: str, collection: str | None = None, top_k: int = 5, profile_id: str | None = None) -> dict[str, Any]:
    legal = legal_domain()
    if not legal:
        return {"kind": "embedding_search", "status": "empty", "profileId": profile_id, "collection": collection, "results": []}
    profile_catalog = embedding_profiles()
    active = next((profile for profile in profile_catalog.get("profiles", []) if profile.get("id") == profile_catalog.get("activeProfileId")), None) or active_legal_embedding_profile(legal)
    effective_profile_id = profile_id or (active.get("id") if active else None)
    candidates = legal_embedding_search_candidates(legal, collection)
    scored = [
        {
            **candidate,
            "score": lexical_similarity(query, candidate.get("text", "")),
            "profileId": effective_profile_id,
        }
        for candidate in candidates
    ]
    scored = [item for item in scored if item["score"] > 0]
    scored.sort(key=lambda item: item["score"], reverse=True)
    return {
        "kind": "embedding_search",
        "status": "ok",
        "profileId": effective_profile_id,
        "collection": collection or "all",
        "topK": top_k,
        "metric": active.get("similarityMetric") if active else "cosine",
        "results": [
            {
                "entityType": item["entityType"],
                "entityId": item["entityId"],
                "label": item["label"],
                "score": round(float(item["score"]), 6),
                "metadata": item["metadata"],
            }
            for item in scored[: max(1, min(int(top_k or 5), 50))]
        ],
        "implementation": "deterministic_lexical_fallback",
        "message": "Busca local usa fallback lexical determinístico quando o banco vetorial externo não está conectado.",
    }


def legal_embedding_search_candidates(legal: dict[str, Any], collection: str | None) -> list[dict[str, Any]]:
    collection_filter = str(collection or "").strip()
    candidates: list[dict[str, Any]] = []
    if not collection_filter or collection_filter in {"categories", "legal_categories"}:
        for category in legal.get("categories", []):
            if isinstance(category, dict) and category.get("code"):
                candidates.append({
                    "entityType": "legal_category",
                    "entityId": str(category["code"]),
                    "label": category.get("name") or category["code"],
                    "text": " ".join(str(category.get(key) or "") for key in ("code", "name", "description", "target")),
                    "metadata": {"critical": bool(category.get("critical", False)), "workflowStepCodes": category.get("workflowStepCodes", [])},
                })
    if not collection_filter or collection_filter in {"workflowSteps", "workflow_steps", "legal_workflow_steps"}:
        for step in legal.get("workflowSteps", []):
            if isinstance(step, dict) and step.get("code"):
                candidates.append({
                    "entityType": "legal_workflow_step",
                    "entityId": str(step["code"]),
                    "label": step.get("name") or step["code"],
                    "text": " ".join(str(step.get(key) or "") for key in ("code", "name", "description", "rite", "stepType")),
                    "metadata": {"rite": step.get("rite"), "order": step.get("order")},
                })
    return candidates


def lexical_similarity(query: str, text: str) -> float:
    query_tokens = set(tokenize_text(query))
    text_tokens = set(tokenize_text(text))
    if not query_tokens or not text_tokens:
        return 0.0
    overlap = len(query_tokens & text_tokens)
    union = len(query_tokens | text_tokens)
    return overlap / max(1, union)


def tokenize_text(value: str) -> list[str]:
    return re.findall(r"[A-Za-zÀ-ÿ0-9_]+", str(value).lower())


def request_embedding_reindex(profile_id: str | None = None, requested_by: str | None = None, reason: str | None = None, confirm: bool = False) -> dict[str, Any]:
    if not confirm:
        return {
            "status": "requires_confirmation",
            "message": "Reindexação de embeddings exige confirm=true.",
            "profileId": profile_id,
        }
    profiles = embedding_profiles()
    active_profile_id = profiles.get("activeProfileId")
    effective_profile_id = profile_id or active_profile_id
    if not effective_profile_id:
        return {"status": "empty", "message": "Nenhum perfil de embedding configurado.", "profileId": None}
    job_raw = json.dumps({"profileId": effective_profile_id, "requestedBy": requested_by, "reason": reason, "projectHash": runtime_manifest.get("projectHash")}, sort_keys=True, ensure_ascii=False)
    job_id = "embedding-reindex-" + hashlib.sha256(job_raw.encode("utf-8")).hexdigest()[:12]
    return {
        "status": "queued",
        "jobId": job_id,
        "profileId": effective_profile_id,
        "requestedBy": requested_by,
        "reason": reason,
        "mode": "external_worker_required",
        "message": "Runtime registrou a intenção; a geração vetorial pesada deve ser executada por worker dedicado.",
    }


def semantic_similarity_from_payload(payload: dict[str, Any]) -> float | None:
    for key in ("semanticSimilarity", "semantic_similarity", "semantic_score", "score_semantico"):
        value = as_float(payload.get(key))
        if value is not None:
            return value
    return None


def as_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(numeric) or math.isinf(numeric):
        return None
    return round(numeric, 6)


def evaluate_records(records: list[dict[str, Any]], labels: list[Any] | None = None) -> dict[str, Any]:
    return evaluate_model_records(active_model(), records, labels)


def evaluate_model_records(model: dict[str, Any], records: list[dict[str, Any]], labels: list[Any] | None = None) -> dict[str, Any]:
    problem = project["problem"]
    target = problem.get("target")
    prepared: list[tuple[dict[str, Any], Any]] = []
    labels = labels or []
    if labels and len(labels) != len(records):
        return {
            "status": "error",
            "message": "labels deve ter o mesmo tamanho de records.",
            "record_count": len(records),
            "label_count": len(labels),
            "model_version_id": model["id"],
            "primary_metric": project["metrics"]["primary"],
            "metrics": {},
            "sample": [],
        }
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            continue
        actual = labels[index] if labels else record.get(target)
        if actual is None or str(actual).strip() == "":
            continue
        prepared.append((record, actual))

    outputs = [predict_with_model(record, model) for record, _actual in prepared]
    predictions = [output.get("prediction") for output in outputs]
    actuals = [actual for _record, actual in prepared]
    if problem["type"] == "regression":
        numeric_pairs = [
            (float(actual), float(prediction))
            for actual, prediction in zip(actuals, predictions)
            if is_number_like(actual) and is_number_like(prediction)
        ]
        metrics = regression_metrics([actual for actual, _prediction in numeric_pairs], [prediction for _actual, prediction in numeric_pairs])
    else:
        actual_labels = [str(actual) for actual in actuals]
        predicted_labels = [str(prediction) for prediction in predictions]
        known_labels = sorted(set(problem.get("classes") or []) | set(actual_labels) | set(predicted_labels))
        probability_rows = [
            output.get("probabilities") if isinstance(output.get("probabilities"), dict) else {}
            for output in outputs
        ]
        metrics = {
            **classification_metrics(actual_labels, predicted_labels, known_labels, probability_rows),
            **classification_operational_metrics(outputs),
        }

    return {
        "status": "ok",
        "model_version_id": model["id"],
        "record_count": len(records),
        "label_count": len(prepared),
        "primary_metric": project["metrics"]["primary"],
        "metrics": metrics,
        "sample": [
            {
                "actual": actuals[index],
                "prediction": predictions[index],
                "input": mask_payload_without_target(prepared[index][0]),
                "inference_source": outputs[index].get("inference_source"),
            }
            for index in range(min(10, len(prepared)))
        ],
    }


def backtest_records(
    records: list[dict[str, Any]],
    labels: list[Any] | None = None,
    model_ids: list[str] | None = None,
    baseline_model_id: str | None = None,
    neutral_band: float = 0.0,
) -> dict[str, Any]:
    catalog = model_catalog()
    selected_ids = set(model_ids or [])
    selected_models = [model for model in catalog if not selected_ids or model["id"] in selected_ids]
    if not selected_models:
        selected_models = [active_model()]

    baseline = next((model for model in selected_models if model["id"] == baseline_model_id), None)
    if baseline is None:
        baseline = next((model for model in selected_models if model["id"] == active_model()["id"]), selected_models[0])
    if baseline["id"] not in {model["id"] for model in selected_models}:
        selected_models = [baseline, *selected_models]

    evaluations = [evaluate_model_records(model, records, labels) for model in selected_models]
    by_model = {item["model_version_id"]: item for item in evaluations}
    primary_metric = project["metrics"]["primary"]
    baseline_result = by_model.get(baseline["id"], evaluations[0])
    baseline_value = numeric_metric_value(baseline_result.get("metrics", {}), primary_metric)
    minimize = metric_should_minimize(primary_metric)
    evidence = [
        model_comparison_evidence(model, by_model.get(model["id"], {}), baseline["id"], baseline_value, primary_metric, minimize, neutral_band)
        for model in selected_models
    ]
    candidate_evidence = [item for item in evidence if item["model_id"] != baseline["id"]]
    failed = [item for item in candidate_evidence if item["status"] == "fail"]
    passed = [item for item in candidate_evidence if item["status"] == "pass"]
    recommendation = "reject" if failed else "approve" if passed else "review"
    return {
        "status": "ok",
        "kind": "backtest_result",
        "baseline_model_id": baseline["id"],
        "candidate_model_ids": [model["id"] for model in selected_models if model["id"] != baseline["id"]],
        "record_count": len(records),
        "label_count": max((item.get("label_count", 0) for item in evaluations), default=0),
        "primary_metric": primary_metric,
        "direction": "minimize" if minimize else "maximize",
        "recommendation": recommendation,
        "metrics": {
            "baseline_model_id": baseline["id"],
            "primary_metric": primary_metric,
            "models": {model_id: result.get("metrics", {}) for model_id, result in by_model.items()},
        },
        "models": evaluations,
        "evidence": evidence,
    }


def numeric_metric_value(metrics: dict[str, Any], metric_name: str) -> float | None:
    value = metrics.get(metric_name)
    if is_number_like(value):
        return float(value)
    return None


def metric_should_minimize(metric_name: str) -> bool:
    return metric_name in {"rmse", "mae", "log_loss", "latency_p95_ms", "error_rate", "drift_score"}


def model_comparison_evidence(
    model: dict[str, Any],
    result: dict[str, Any],
    baseline_model_id: str,
    baseline_value: float | None,
    primary_metric: str,
    minimize: bool,
    neutral_band: float,
) -> dict[str, Any]:
    value = numeric_metric_value(result.get("metrics", {}), primary_metric)
    if model["id"] == baseline_model_id:
        return {
            "model_id": model["id"],
            "label": model.get("label", model["id"]),
            "metric": primary_metric,
            "value": value,
            "baseline_value": baseline_value,
            "delta": 0.0,
            "status": "neutral",
            "color": "neutral",
            "reason": "Modelo usado como baseline do backtest.",
        }
    if value is None or baseline_value is None:
        return {
            "model_id": model["id"],
            "label": model.get("label", model["id"]),
            "metric": primary_metric,
            "value": value,
            "baseline_value": baseline_value,
            "delta": None,
            "status": "neutral",
            "color": "neutral",
            "reason": "Métrica primária indisponível para comparação objetiva.",
        }
    delta = baseline_value - value if minimize else value - baseline_value
    if abs(delta) <= float(neutral_band or 0):
        status, color, reason = "neutral", "neutral", "Variação dentro do threshold neutro."
    elif delta > 0:
        status, color, reason = "pass", "green", "Candidato melhor que o baseline na métrica primária."
    else:
        status, color, reason = "fail", "red", "Candidato pior que o baseline na métrica primária."
    return {
        "model_id": model["id"],
        "label": model.get("label", model["id"]),
        "metric": primary_metric,
        "value": value,
        "baseline_value": baseline_value,
        "delta": round(delta, 6),
        "status": status,
        "color": color,
        "reason": reason,
    }


def calculate_drift(
    reference_records: list[dict[str, Any]],
    current_records: list[dict[str, Any]],
    feature_keys: list[str] | None = None,
    warning_threshold: float = 0.2,
    alert_threshold: float = 0.5,
) -> dict[str, Any]:
    reference = [record for record in reference_records if isinstance(record, dict)]
    current = [record for record in current_records if isinstance(record, dict)]
    features = feature_keys or infer_drift_features(reference, current)
    feature_results = [drift_for_feature(feature, reference, current) for feature in features]
    feature_results = [item for item in feature_results if item is not None]
    drift_score = max([item["score"] for item in feature_results], default=0.0)
    status = "alert" if drift_score >= alert_threshold else "warning" if drift_score >= warning_threshold else "ok"
    color = "red" if status == "alert" else "neutral" if status == "warning" else "green"
    return {
        "status": status,
        "color": color,
        "drift_score": round(float(drift_score), 6),
        "reference_count": len(reference),
        "current_count": len(current),
        "feature_count": len(feature_results),
        "thresholds": {"warning": warning_threshold, "alert": alert_threshold},
        "features": feature_results,
        "message": "Drift básico calculado por diferença estatística simples entre referência e amostra atual.",
    }


def infer_drift_features(reference: list[dict[str, Any]], current: list[dict[str, Any]]) -> list[str]:
    sensitive_fields = set(project.get("sensitiveFields", []))
    target = project["problem"].get("target")
    keys: set[str] = set()
    for record in reference + current:
        keys.update(str(key) for key in record.keys())
    return sorted(key for key in keys if key != target and key not in sensitive_fields)


def drift_for_feature(feature: str, reference: list[dict[str, Any]], current: list[dict[str, Any]]) -> dict[str, Any] | None:
    reference_values = [record.get(feature) for record in reference if record.get(feature) is not None and record.get(feature) != ""]
    current_values = [record.get(feature) for record in current if record.get(feature) is not None and record.get(feature) != ""]
    if not reference_values or not current_values:
        return None
    if numeric_coverage(reference_values) >= 0.8 and numeric_coverage(current_values) >= 0.8:
        score, details = numeric_drift_score(reference_values, current_values)
        kind = "numeric"
        method = "numeric_mean_shift"
    else:
        score, details = categorical_drift_score(reference_values, current_values)
        kind = "categorical"
        method = "categorical_distribution_shift"
    status = "alert" if score >= 0.5 else "warning" if score >= 0.2 else "ok"
    return {
        "feature": feature,
        "kind": kind,
        "method": method,
        "score": round(float(score), 6),
        "status": status,
        **details,
    }


def numeric_coverage(values: list[Any]) -> float:
    return sum(1 for value in values if is_number_like(value)) / max(1, len(values))


def numeric_drift_score(reference_values: list[Any], current_values: list[Any]) -> tuple[float, dict[str, Any]]:
    reference = [float(value) for value in reference_values if is_number_like(value)]
    current = [float(value) for value in current_values if is_number_like(value)]
    if not reference or not current:
        return 0.0, {}
    reference_mean = sum(reference) / len(reference)
    current_mean = sum(current) / len(current)
    reference_variance = sum((value - reference_mean) ** 2 for value in reference) / max(1, len(reference))
    reference_std = math.sqrt(reference_variance)
    if reference_std <= 1e-9:
        score = 0.0 if abs(current_mean - reference_mean) <= 1e-9 else 1.0
    else:
        score = min(1.0, abs(current_mean - reference_mean) / (3 * reference_std))
    return score, {
        "reference_mean": round(reference_mean, 6),
        "current_mean": round(current_mean, 6),
        "reference_std": round(reference_std, 6),
    }


def categorical_drift_score(reference_values: list[Any], current_values: list[Any]) -> tuple[float, dict[str, Any]]:
    reference_counts = value_counts(reference_values)
    current_counts = value_counts(current_values)
    labels = sorted(set(reference_counts) | set(current_counts))
    reference_total = sum(reference_counts.values()) or 1
    current_total = sum(current_counts.values()) or 1
    score = sum(abs(reference_counts.get(label, 0) / reference_total - current_counts.get(label, 0) / current_total) for label in labels) / 2
    return score, {
        "reference_top": top_distribution(reference_counts, reference_total),
        "current_top": top_distribution(current_counts, current_total),
    }


def value_counts(values: list[Any]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for value in values:
        key = str(value)
        counts[key] = counts.get(key, 0) + 1
    return counts


def top_distribution(counts: dict[str, int], total: int) -> list[dict[str, Any]]:
    return [
        {"value": value, "share": round(count / max(1, total), 6)}
        for value, count in sorted(counts.items(), key=lambda item: item[1], reverse=True)[:5]
    ]


def predict_from_artifact(
    artifact: dict[str, Any] | None,
    payload: dict[str, Any],
    problem: dict[str, Any],
    trace: list[dict[str, Any]],
    model: dict[str, Any],
) -> dict[str, Any] | None:
    if not artifact:
        return None
    artifact_type = artifact.get("type")
    if artifact_type == "sklearn_text_classifier":
        estimator = load_pickle_estimator(artifact)
        if estimator is None:
            return None
        text = text_from_payload(payload)
        try:
            prediction = str(estimator.predict([text])[0])
            probabilities = sklearn_probabilities(estimator, [text])
        except Exception:
            return None
        confidence = probabilities.get(prediction)
        return {
            "prediction": prediction,
            "model_version_id": model["id"],
            "confidence": round(float(confidence), 6) if confidence is not None else None,
            "probabilities": probabilities,
            "trace": trace,
            "inference_source": "artifact",
        }
    if artifact_type == "sklearn_regressor":
        estimator = load_pickle_estimator(artifact)
        if estimator is None:
            return None
        try:
            prediction = float(estimator.predict([feature_dict_from_payload(payload)])[0])
        except Exception:
            return None
        return {
            "prediction": round(prediction, 6),
            "model_version_id": model["id"],
            "confidence": None,
            "trace": trace,
            "inference_source": "artifact",
        }
    if artifact_type == "sentence_transformers_text_classifier":
        estimator = load_pickle_estimator(artifact)
        if estimator is None:
            return None
        try:
            matrix = sentence_transformer_matrix(artifact, [payload])
            prediction = str(estimator.predict(matrix)[0])
            probabilities = class_probabilities(estimator, matrix, artifact_classes(artifact))
        except Exception:
            return None
        confidence = probabilities.get(prediction)
        return {
            "prediction": prediction,
            "model_version_id": model["id"],
            "confidence": round(float(confidence), 6) if confidence is not None else None,
            "probabilities": probabilities,
            "trace": trace,
            "inference_source": "artifact",
        }
    if artifact_type == "sentence_transformers_regressor":
        estimator = load_pickle_estimator(artifact)
        if estimator is None:
            return None
        try:
            matrix = sentence_transformer_matrix(artifact, [payload])
            prediction = float(estimator.predict(matrix)[0])
        except Exception:
            return None
        return {
            "prediction": round(prediction, 6),
            "model_version_id": model["id"],
            "confidence": None,
            "trace": trace,
            "inference_source": "artifact",
        }
    if artifact_type == "xgboost_text_classifier":
        estimator = load_pickle_estimator(artifact)
        vectorizer = load_pickle_value(artifact, "vectorizerBase64")
        classes = artifact_classes(artifact)
        if estimator is None or vectorizer is None or not classes:
            return None
        text = text_from_payload(payload)
        try:
            matrix = vectorizer.transform([text])
            encoded_prediction = estimator.predict(matrix)[0]
            prediction = class_from_encoded_prediction(encoded_prediction, classes)
            probabilities = class_probabilities(estimator, matrix, classes)
        except Exception:
            return None
        confidence = probabilities.get(prediction)
        return {
            "prediction": prediction,
            "model_version_id": model["id"],
            "confidence": round(float(confidence), 6) if confidence is not None else None,
            "probabilities": probabilities,
            "trace": trace,
            "inference_source": "artifact",
        }
    if artifact_type == "xgboost_regressor":
        estimator = load_pickle_estimator(artifact)
        vectorizer = load_pickle_value(artifact, "vectorizerBase64")
        if estimator is None or vectorizer is None:
            return None
        try:
            matrix = vectorizer.transform([feature_dict_from_payload(payload)])
            prediction = float(estimator.predict(matrix)[0])
        except Exception:
            return None
        return {
            "prediction": round(prediction, 6),
            "model_version_id": model["id"],
            "confidence": None,
            "trace": trace,
            "inference_source": "artifact",
        }
    if artifact_type == "standard_lib_text_naive_bayes":
        model_payload = artifact.get("model")
        if not isinstance(model_payload, dict):
            return None
        prediction, probabilities = predict_text_naive_bayes(model_payload, payload)
        confidence = probabilities.get(prediction)
        return {
            "prediction": prediction,
            "model_version_id": model["id"],
            "confidence": round(float(confidence), 6) if confidence is not None else None,
            "probabilities": probabilities,
            "trace": trace,
            "inference_source": "artifact",
        }
    if artifact_type == "mean_regressor":
        value = artifact.get("mean")
        if not isinstance(value, (int, float)):
            return None
        return {
            "prediction": round(float(value), 6),
            "model_version_id": model["id"],
            "confidence": None,
            "trace": trace,
            "inference_source": "artifact",
        }
    return None


def load_pickle_estimator(artifact: dict[str, Any]) -> Any | None:
    return load_pickle_value(artifact, "modelBase64")


def sentence_transformer_matrix(artifact: dict[str, Any], payloads: list[dict[str, Any]]) -> Any:
    model_name = str(artifact.get("embeddingModel") or "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
    model = load_sentence_transformer_model(model_name)
    texts = [text_from_payload(payload) for payload in payloads]
    return model.encode(
        texts,
        batch_size=32,
        show_progress_bar=False,
        convert_to_numpy=True,
        normalize_embeddings=bool(artifact.get("normalizeEmbeddings", True)),
    )


def load_sentence_transformer_model(model_name: str) -> Any:
    try:
        from sentence_transformers import SentenceTransformer
    except Exception as exc:
        raise RuntimeError("sentence-transformers não está instalado no runtime.") from exc
    return SentenceTransformer(model_name)


def load_pickle_value(artifact: dict[str, Any], key: str) -> Any | None:
    if artifact.get("format") != "pickle_base64":
        return None
    raw = artifact.get(key)
    if not isinstance(raw, str) or not raw:
        return None
    try:
        return pickle.loads(base64.b64decode(raw.encode("ascii")))
    except Exception:
        return None


def artifact_classes(artifact: dict[str, Any]) -> list[str]:
    classes = artifact.get("classes")
    if not isinstance(classes, list):
        return []
    return [str(item) for item in classes]


def class_from_encoded_prediction(value: Any, classes: list[str]) -> str:
    try:
        index = int(value)
    except (TypeError, ValueError):
        return str(value)
    if 0 <= index < len(classes):
        return classes[index]
    return str(value)


def class_probabilities(estimator: Any, inputs: Any, classes: list[str]) -> dict[str, float]:
    if not hasattr(estimator, "predict_proba"):
        return {}
    try:
        probabilities = estimator.predict_proba(inputs)[0]
    except Exception:
        return {}
    return {label: round(float(value), 6) for label, value in zip(classes, probabilities)}


def sklearn_probabilities(estimator: Any, inputs: list[Any]) -> dict[str, float]:
    if not hasattr(estimator, "predict_proba"):
        return {}
    try:
        probabilities = estimator.predict_proba(inputs)[0]
        classes = [str(item) for item in getattr(estimator, "classes_", [])]
    except Exception:
        return {}
    return {label: round(float(value), 6) for label, value in zip(classes, probabilities)}


def predict_text_naive_bayes(model_payload: dict[str, Any], payload: dict[str, Any]) -> tuple[str, dict[str, float]]:
    class_counts = {str(label): int(count) for label, count in model_payload.get("classCounts", {}).items()}
    token_counts = {
        str(label): {str(token): int(count) for token, count in counts.items()}
        for label, counts in model_payload.get("tokenCounts", {}).items()
        if isinstance(counts, dict)
    }
    total_tokens = {str(label): int(count) for label, count in model_payload.get("totalTokens", {}).items()}
    vocabulary = [str(item) for item in model_payload.get("vocabulary", [])]
    if not class_counts:
        classes = project["problem"].get("classes") or ["classe_a", "classe_b"]
        return str(classes[0]), {str(item): round(1 / len(classes), 6) for item in classes}

    vocab_size = max(1, len(vocabulary))
    total_rows = max(1, sum(class_counts.values()))
    tokens = tokenize_payload(payload)
    scores: dict[str, float] = {}
    for label, count in class_counts.items():
        score = math.log(count / total_rows)
        denominator = total_tokens.get(label, 0) + vocab_size
        for token in tokens:
            score += math.log((token_counts.get(label, {}).get(token, 0) + 1) / denominator)
        scores[label] = score
    prediction = max(scores.items(), key=lambda item: item[1])[0]
    return prediction, softmax_scores(scores)


def tokenize_payload(payload: dict[str, Any]) -> list[str]:
    return re.findall(r"[A-Za-zÀ-ÿ0-9_]+", text_from_payload(payload).lower())


def text_from_payload(payload: dict[str, Any]) -> str:
    sensitive_fields = set(project.get("sensitiveFields", []))
    target = project["problem"].get("target")
    return " ".join(
        str(value)
        for key, value in payload.items()
        if key != target and key not in sensitive_fields and value is not None
    )


def feature_dict_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    sensitive_fields = set(project.get("sensitiveFields", []))
    target = project["problem"].get("target")
    features: dict[str, Any] = {}
    for key, value in payload.items():
        if key == target or key in sensitive_fields or value is None or value == "":
            continue
        features[key] = parse_feature_value(value)
    return features


def mask_payload_without_target(payload: dict[str, Any]) -> dict[str, Any]:
    sensitive_fields = set(project.get("sensitiveFields", []))
    target = project["problem"].get("target")
    masked: dict[str, Any] = {}
    for key, value in payload.items():
        if key == target:
            continue
        masked[key] = "***" if key in sensitive_fields else value
    return masked


def is_number_like(value: Any) -> bool:
    try:
        float(value)
        return True
    except (TypeError, ValueError):
        return False


def classification_metrics(actuals: list[str], predictions: list[str], labels: list[str], probability_rows: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    total = max(1, len(actuals))
    accuracy = sum(1 for actual, prediction in zip(actuals, predictions) if actual == prediction) / total
    per_label: dict[str, dict[str, Any]] = {}
    f1_values = []
    weighted_sum = 0.0
    for label in labels:
        tp = sum(1 for actual, prediction in zip(actuals, predictions) if actual == label and prediction == label)
        fp = sum(1 for actual, prediction in zip(actuals, predictions) if actual != label and prediction == label)
        fn = sum(1 for actual, prediction in zip(actuals, predictions) if actual == label and prediction != label)
        support = sum(1 for actual in actuals if actual == label)
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        per_label[label] = {"precision": round(precision, 6), "recall": round(recall, 6), "f1": round(f1, 6), "support": support}
        if support:
            f1_values.append(f1)
            weighted_sum += f1 * support
    matrix = [[sum(1 for actual, prediction in zip(actuals, predictions) if actual == left and prediction == right) for right in labels] for left in labels]
    probabilities = normalize_probability_rows(probability_rows or [], labels, predictions)
    return {
        "accuracy": round(accuracy, 6),
        "f1_macro": round(sum(f1_values) / len(f1_values), 6) if f1_values else 0.0,
        "f1_weighted": round(weighted_sum / total, 6),
        "precision_macro": round(sum(item["precision"] for item in per_label.values()) / max(1, len(per_label)), 6),
        "recall_macro": round(sum(item["recall"] for item in per_label.values()) / max(1, len(per_label)), 6),
        "top_3_accuracy": top_k_accuracy(actuals, probabilities, 3),
        "top_5_accuracy": top_k_accuracy(actuals, probabilities, 5),
        "brier_score": brier_score(actuals, probabilities, labels),
        "expected_calibration_error": expected_calibration_error(actuals, predictions, probabilities),
        "roc_auc_ovr": roc_auc_ovr(actuals, probabilities, labels),
        "pr_auc_macro": pr_auc_macro(actuals, probabilities, labels),
        "semantic_recall_at_5": top_k_accuracy(actuals, probabilities, 5),
        "labels": labels,
        "per_label": per_label,
        "confusion_matrix": matrix,
    }


def normalize_probability_rows(probability_rows: list[dict[str, Any]], labels: list[str], predictions: list[str]) -> list[dict[str, float]]:
    normalized_rows: list[dict[str, float]] = []
    for index, prediction in enumerate(predictions):
        source = probability_rows[index] if index < len(probability_rows) and isinstance(probability_rows[index], dict) else {}
        row: dict[str, float] = {}
        for label in labels:
            value = as_probability(source.get(label))
            row[label] = value if value is not None else 0.0
        if prediction and sum(row.values()) <= 0:
            row[prediction] = 1.0
        normalized_rows.append(row)
    return normalized_rows


def top_k_accuracy(actuals: list[str], probability_rows: list[dict[str, float]], k: int) -> float:
    if not actuals:
        return 0.0
    hits = 0
    for actual, probabilities in zip(actuals, probability_rows):
        top_labels = [label for label, _score in sorted(probabilities.items(), key=lambda item: item[1], reverse=True)[:k]]
        if actual in top_labels:
            hits += 1
    return round(hits / max(1, len(actuals)), 6)


def brier_score(actuals: list[str], probability_rows: list[dict[str, float]], labels: list[str]) -> float:
    if not actuals:
        return 0.0
    total = 0.0
    for actual, probabilities in zip(actuals, probability_rows):
        total += sum((float(probabilities.get(label, 0.0)) - (1.0 if actual == label else 0.0)) ** 2 for label in labels)
    return round(total / max(1, len(actuals)), 6)


def expected_calibration_error(actuals: list[str], predictions: list[str], probability_rows: list[dict[str, float]], bins: int = 10) -> float:
    if not actuals:
        return 0.0
    ece = 0.0
    total = len(actuals)
    for bucket in range(bins):
        lower = bucket / bins
        upper = (bucket + 1) / bins
        indexes = []
        for index, probabilities in enumerate(probability_rows):
            confidence = max(probabilities.values(), default=0.0)
            if (bucket == 0 and confidence >= lower and confidence <= upper) or (confidence > lower and confidence <= upper):
                indexes.append(index)
        if not indexes:
            continue
        accuracy = sum(1 for index in indexes if actuals[index] == predictions[index]) / len(indexes)
        confidence_mean = sum(max(probability_rows[index].values(), default=0.0) for index in indexes) / len(indexes)
        ece += (len(indexes) / total) * abs(accuracy - confidence_mean)
    return round(ece, 6)


def roc_auc_ovr(actuals: list[str], probability_rows: list[dict[str, float]], labels: list[str]) -> float | None:
    auc_values = []
    for label in labels:
        scores = [row.get(label, 0.0) for row in probability_rows]
        auc = binary_roc_auc([actual == label for actual in actuals], scores)
        if auc is not None:
            auc_values.append(auc)
    return round(sum(auc_values) / len(auc_values), 6) if auc_values else None


def binary_roc_auc(positives: list[bool], scores: list[float]) -> float | None:
    positive_scores = [score for is_positive, score in zip(positives, scores) if is_positive]
    negative_scores = [score for is_positive, score in zip(positives, scores) if not is_positive]
    if not positive_scores or not negative_scores:
        return None
    wins = 0.0
    for positive_score in positive_scores:
        for negative_score in negative_scores:
            if positive_score > negative_score:
                wins += 1.0
            elif positive_score == negative_score:
                wins += 0.5
    return wins / (len(positive_scores) * len(negative_scores))


def pr_auc_macro(actuals: list[str], probability_rows: list[dict[str, float]], labels: list[str]) -> float | None:
    values = []
    for label in labels:
        value = average_precision([actual == label for actual in actuals], [row.get(label, 0.0) for row in probability_rows])
        if value is not None:
            values.append(value)
    return round(sum(values) / len(values), 6) if values else None


def average_precision(positives: list[bool], scores: list[float]) -> float | None:
    total_positives = sum(1 for item in positives if item)
    if total_positives <= 0:
        return None
    ranked = sorted(zip(scores, positives), key=lambda item: item[0], reverse=True)
    hits = 0
    precision_sum = 0.0
    for index, (_score, is_positive) in enumerate(ranked, start=1):
        if is_positive:
            hits += 1
            precision_sum += hits / index
    return precision_sum / total_positives


def classification_operational_metrics(outputs: list[dict[str, Any]]) -> dict[str, float]:
    total = max(1, len(outputs))
    low_confidence = 0
    human_review = 0
    llm_review = 0
    workflow_blocked = 0
    for output in outputs:
        review = output.get("review", {}) if isinstance(output.get("review"), dict) else {}
        reasons = review.get("reasons", []) if isinstance(review.get("reasons"), list) else []
        if "low_confidence" in reasons:
            low_confidence += 1
        if bool(review.get("humanReviewRequired", False)):
            human_review += 1
        explanation = output.get("explanation", {}) if isinstance(output.get("explanation"), dict) else {}
        llm = explanation.get("llm", {}) if isinstance(explanation.get("llm"), dict) else {}
        if bool(output.get("decision", {}).get("llmReviewRecommended", False)) or bool(llm.get("recommended", False)):
            llm_review += 1
        workflow = explanation.get("workflow", {}) if isinstance(explanation.get("workflow"), dict) else {}
        if workflow.get("status") == "blocked" or "workflow_blocked" in reasons:
            workflow_blocked += 1
    return {
        "low_confidence_rate": round(low_confidence / total, 6),
        "human_review_rate": round(human_review / total, 6),
        "llm_review_rate": round(llm_review / total, 6),
        "invalid_workflow_transition_rate": round(workflow_blocked / total, 6),
    }


def as_probability(value: Any) -> float | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(numeric) or math.isinf(numeric):
        return None
    return max(0.0, min(1.0, round(numeric, 6)))


def regression_metrics(actuals: list[float], predictions: list[float]) -> dict[str, float]:
    total = max(1, len(actuals))
    if not actuals:
        return {"mae": 0.0, "rmse": 0.0, "r2": 0.0}
    errors = [prediction - actual for actual, prediction in zip(actuals, predictions)]
    mae = sum(abs(error) for error in errors) / total
    rmse = math.sqrt(sum(error * error for error in errors) / total)
    mean_actual = sum(actuals) / total
    ss_tot = sum((actual - mean_actual) ** 2 for actual in actuals)
    ss_res = sum(error * error for error in errors)
    r2 = 1 - ss_res / ss_tot if ss_tot else 0.0
    return {"mae": round(mae, 6), "rmse": round(rmse, 6), "r2": round(r2, 6)}


def parse_feature_value(value: Any) -> Any:
    if isinstance(value, (int, float, bool)):
        return value
    try:
        return float(str(value).replace(",", "."))
    except ValueError:
        return str(value)


def softmax_scores(scores: dict[str, float]) -> dict[str, float]:
    max_score = max(scores.values())
    exps = {label: math.exp(score - max_score) for label, score in scores.items()}
    total = sum(exps.values()) or 1.0
    return {label: round(value / total, 6) for label, value in exps.items()}


def synthetic_predict_payload(payload: dict[str, Any], model: dict[str, Any], problem: dict[str, Any], trace: list[dict[str, Any]]) -> dict[str, Any]:
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    digest = int(hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12], 16)
    if problem["type"] == "regression":
        value = round((digest % 100000) / 1000, 4)
        return {"prediction": value, "model_version_id": model["id"], "confidence": None, "trace": trace, "inference_source": "synthetic"}

    classes = problem.get("classes") or ["classe_a", "classe_b"]
    prediction = classes[digest % len(classes)]
    score = round(0.55 + (digest % 4500) / 10000, 4)
    remaining = round(max(0.0, 1.0 - score), 4)
    probabilities = {item: round(remaining / max(1, len(classes) - 1), 4) for item in classes}
    probabilities[prediction] = score
    return {"prediction": prediction, "model_version_id": model["id"], "confidence": score, "probabilities": probabilities, "trace": trace, "inference_source": "synthetic"}


def promotion_status() -> dict[str, Any]:
    policy = project.get("promotionPolicy", {})
    active = active_model()
    if latest_training_result:
        evidence = latest_training_result.get("promotionEvidence", [])
        failed_blockers = [
            item for item in evidence
            if isinstance(item, dict) and item.get("status") == "fail" and item.get("severity", "block") == "block"
        ]
        failed_reviews = [
            item for item in evidence
            if isinstance(item, dict) and item.get("status") == "fail" and item.get("severity", "block") != "block"
        ]
        return {
            "mode": policy.get("mode", "manual_approval"),
            "recommendation": "reject" if failed_blockers else "review" if failed_reviews else "approve",
            "applied": False,
            "active_model": active,
            "candidate_model_id": latest_training_result.get("bestModelId"),
            "latest_training_run_id": latest_training_result.get("runId"),
            "primary_metric": latest_training_result.get("primaryMetric") or project["metrics"]["primary"],
            "evidence": evidence,
        }
    metrics = active.get("metrics", {})
    evidence = []
    for rule in flatten_rules(policy.get("rules", [])):
        if rule.get("kind", "metric") != "metric":
            evidence.append({"ruleId": rule.get("id"), "label": rule.get("label"), "status": "neutral", "color": "neutral", "reason": "Regra Python exige execução em sandbox para evidência completa."})
            continue
        metric_name = rule.get("left", {}).get("metric")
        value = metrics.get(metric_name)
        expected = rule.get("value")
        operator = rule.get("operator")
        status, color, reason = evaluate_rule(metric_name, value, operator, expected, rule.get("neutralBand", 0))
        evidence.append({"ruleId": rule.get("id"), "label": rule.get("label"), "metric": metric_name, "value": value, "operator": operator, "expected": expected, "status": status, "color": color, "reason": reason, "severity": rule.get("severity", "block")})
    failed = [item for item in evidence if item["status"] == "fail" and item.get("severity") == "block"]
    return {
        "mode": policy.get("mode", "manual_approval"),
        "recommendation": "reject" if failed else "approve",
        "applied": False,
        "active_model": active,
        "evidence": evidence,
    }


def flatten_rules(rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
    flat = []
    for rule in rules:
        if rule.get("kind") == "group":
            flat.extend(flatten_rules(rule.get("rules", [])))
        else:
            flat.append(rule)
    return flat


def evaluate_rule(metric_name: str, value: Any, operator: str, expected: Any, neutral_band: float) -> tuple[str, str, str]:
    if value is None:
        return "neutral", "neutral", f"Métrica {metric_name} ainda não está disponível."
    try:
        numeric_value = float(value)
        numeric_expected = float(expected)
    except (TypeError, ValueError):
        passed = value == expected if operator == "eq" else value != expected
        return ("pass", "green", "Valor discreto atende a regra.") if passed else ("fail", "red", "Valor discreto viola a regra.")

    delta = numeric_value - numeric_expected
    if abs(delta) <= float(neutral_band or 0):
        return "neutral", "neutral", "Variação dentro do threshold neutro."
    if operator in {"gt", "gte"}:
        passed = numeric_value > numeric_expected if operator == "gt" else numeric_value >= numeric_expected
    elif operator in {"lt", "lte"}:
        passed = numeric_value < numeric_expected if operator == "lt" else numeric_value <= numeric_expected
    elif operator == "eq":
        passed = numeric_value == numeric_expected
    else:
        passed = delta >= 0
    return ("pass", "green", "Evidência melhor que o limiar.") if passed else ("fail", "red", "Evidência pior que o limiar.")
`;
}
