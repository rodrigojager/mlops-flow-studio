export function renderRepositoryPy(): string {
  return `from datetime import datetime, timezone
from hashlib import sha256
from time import perf_counter
from typing import Any
from uuid import uuid4
from sqlalchemy import func, insert, select, text, update
from .db import ab_experiments, app_events, dataset_versions, deployment_rollouts, drift_runs, embedding_profiles, embedding_records, engine, evaluation_runs, legal_andamentos, legal_categories, legal_documents, legal_processes, legal_workflow_steps, legal_workflow_transitions, metric_snapshots, model_versions, prediction_feedback, prediction_rows, prediction_runs, promotion_decisions, retraining_requests, training_runs, vector_collections
from .settings import settings


def now() -> datetime:
    return datetime.now(timezone.utc)


def check_database() -> dict[str, Any]:
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))
    return {"ok": True, "backend": settings.database_url.split(":", 1)[0]}


def record_event(event_type: str, message: str, details: dict[str, Any] | None = None) -> None:
    with engine.begin() as connection:
        connection.execute(insert(app_events).values(event_type=event_type, message=message, details=details or {}, created_at=now()))


def seed_domain_metadata(project: dict[str, Any]) -> dict[str, Any]:
    legal = legal_domain_config(project)
    if not legal:
        return {"seeded": False, "kind": project.get("domain", {}).get("kind", "generic"), "reason": "dominio sem manifesto juridico"}

    created_at = now()
    inserted = {
        "legal_categories": 0,
        "legal_workflow_steps": 0,
        "legal_workflow_transitions": 0,
        "embedding_profiles": 0,
        "vector_collections": 0,
        "embedding_records": 0,
    }
    with engine.begin() as connection:
        for category in legal.get("categories", []):
            if not isinstance(category, dict) or not category.get("code"):
                continue
            code = str(category["code"])
            if connection.execute(select(legal_categories.c.code).where(legal_categories.c.code == code)).first():
                continue
            connection.execute(
                insert(legal_categories).values(
                    code=code,
                    name=category.get("name"),
                    target=category.get("target"),
                    critical=bool(category.get("critical", False)),
                    requires_human_review=bool(category.get("requiresHumanReview", False)),
                    workflow_step_codes=category.get("workflowStepCodes", []),
                    metadata_json={key: value for key, value in category.items() if key not in {"code", "name", "target", "critical", "requiresHumanReview", "workflowStepCodes"}},
                    created_at=created_at,
                )
            )
            inserted["legal_categories"] += 1

        for step in legal.get("workflowSteps", []):
            if not isinstance(step, dict) or not step.get("code"):
                continue
            code = str(step["code"])
            if connection.execute(select(legal_workflow_steps.c.code).where(legal_workflow_steps.c.code == code)).first():
                continue
            connection.execute(
                insert(legal_workflow_steps).values(
                    code=code,
                    name=step.get("name"),
                    rite=step.get("rite"),
                    order_index=step.get("order"),
                    step_type=step.get("stepType"),
                    requires_document=bool(step.get("requiresDocument", False)),
                    requires_human_review=bool(step.get("requiresHumanReview", False)),
                    sla_hours=step.get("slaHours"),
                    metadata_json={key: value for key, value in step.items() if key not in {"code", "name", "rite", "order", "stepType", "requiresDocument", "requiresHumanReview", "slaHours"}},
                    created_at=created_at,
                )
            )
            inserted["legal_workflow_steps"] += 1

        for transition in legal.get("workflowTransitions", []):
            if not isinstance(transition, dict) or not transition.get("from") or not transition.get("to"):
                continue
            transition_id = f"{transition.get('rite', 'default')}:{transition['from']}->{transition['to']}"
            if row_exists(connection, legal_workflow_transitions, transition_id):
                continue
            connection.execute(
                insert(legal_workflow_transitions).values(
                    id=transition_id,
                    from_step=str(transition["from"]),
                    to_step=str(transition["to"]),
                    rite=str(transition.get("rite") or "default"),
                    condition=transition.get("condition"),
                    severity=str(transition.get("severity") or "block"),
                    active=bool(transition.get("active", True)),
                    created_at=created_at,
                )
            )
            inserted["legal_workflow_transitions"] += 1

        for profile in legal.get("embeddingProfiles", []):
            if not isinstance(profile, dict) or not profile.get("id"):
                continue
            profile_id = str(profile["id"])
            if not row_exists(connection, embedding_profiles, profile_id):
                connection.execute(
                    insert(embedding_profiles).values(
                        id=profile_id,
                        provider=profile.get("provider"),
                        model_name=profile.get("modelName"),
                        model_version=profile.get("modelVersion"),
                        model_digest=profile.get("modelDigest"),
                        dimension=profile.get("dimension"),
                        similarity_metric=profile.get("similarityMetric"),
                        preprocessing_version=profile.get("preprocessingVersion"),
                        chunking_version=profile.get("chunkingVersion"),
                        status=profile.get("status"),
                        vector_collections=profile.get("vectorCollections", {}),
                        metadata_json={
                            "normalization": profile.get("normalization"),
                            "pooling": profile.get("pooling"),
                        },
                        created_at=created_at,
                    )
                )
                inserted["embedding_profiles"] += 1
            collections = profile.get("vectorCollections", {}) if isinstance(profile.get("vectorCollections"), dict) else {}
            for logical_name, collection_name in collections.items():
                collection_id = f"{profile_id}:{collection_name}"
                if not row_exists(connection, vector_collections, collection_id):
                    connection.execute(
                        insert(vector_collections).values(
                            id=collection_id,
                            profile_id=profile_id,
                            logical_name=str(logical_name),
                            collection_name=str(collection_name),
                            backend="external_vector_store_or_pgvector",
                            dimension=profile.get("dimension"),
                            similarity_metric=profile.get("similarityMetric"),
                            status=profile.get("status"),
                            metadata_json={"source": "domain_manifest"},
                            created_at=created_at,
                        )
                    )
                    inserted["vector_collections"] += 1
            inserted["embedding_records"] += seed_embedding_placeholders(connection, profile_id, collections, legal, created_at)

    return {"seeded": True, "kind": "legal_classification", **inserted}


def seed_embedding_placeholders(connection, profile_id: str, collections: dict[str, Any], legal: dict[str, Any], created_at: datetime) -> int:
    inserted = 0
    categories_collection = collections.get("categories")
    if categories_collection:
        for category in legal.get("categories", []):
            if not isinstance(category, dict) or not category.get("code"):
                continue
            record_id = f"{profile_id}:category:{category['code']}"
            if row_exists(connection, embedding_records, record_id):
                continue
            connection.execute(
                insert(embedding_records).values(
                    id=record_id,
                    profile_id=profile_id,
                    collection_name=str(categories_collection),
                    entity_type="legal_category",
                    entity_id=str(category["code"]),
                    chunk_id=None,
                    vector=None,
                    vector_hash=None,
                    metadata_json={"name": category.get("name"), "status": "placeholder_until_embedding_job"},
                    created_at=created_at,
                )
            )
            inserted += 1
    workflow_collection = collections.get("workflowSteps")
    if workflow_collection:
        for step in legal.get("workflowSteps", []):
            if not isinstance(step, dict) or not step.get("code"):
                continue
            record_id = f"{profile_id}:workflow_step:{step['code']}"
            if row_exists(connection, embedding_records, record_id):
                continue
            connection.execute(
                insert(embedding_records).values(
                    id=record_id,
                    profile_id=profile_id,
                    collection_name=str(workflow_collection),
                    entity_type="legal_workflow_step",
                    entity_id=str(step["code"]),
                    chunk_id=None,
                    vector=None,
                    vector_hash=None,
                    metadata_json={"name": step.get("name"), "status": "placeholder_until_embedding_job"},
                    created_at=created_at,
                )
            )
            inserted += 1
    return inserted


def legal_domain_config(project: dict[str, Any]) -> dict[str, Any] | None:
    domain = project.get("domain", {})
    if not isinstance(domain, dict) or domain.get("kind") != "legal_classification":
        return None
    legal = domain.get("legal")
    return legal if isinstance(legal, dict) else None


def domain_metadata_summary(project: dict[str, Any]) -> dict[str, Any]:
    legal = legal_domain_config(project)
    if not legal:
        return {"kind": project.get("domain", {}).get("kind", "generic"), "legal": None}
    with engine.connect() as connection:
        counts = {
            "categories": connection.execute(select(func.count()).select_from(legal_categories)).scalar_one(),
            "workflow_steps": connection.execute(select(func.count()).select_from(legal_workflow_steps)).scalar_one(),
            "workflow_transitions": connection.execute(select(func.count()).select_from(legal_workflow_transitions)).scalar_one(),
            "processes": connection.execute(select(func.count()).select_from(legal_processes)).scalar_one(),
            "documents": connection.execute(select(func.count()).select_from(legal_documents)).scalar_one(),
            "andamentos": connection.execute(select(func.count()).select_from(legal_andamentos)).scalar_one(),
            "embedding_profiles": connection.execute(select(func.count()).select_from(embedding_profiles)).scalar_one(),
            "vector_collections": connection.execute(select(func.count()).select_from(vector_collections)).scalar_one(),
            "embedding_records": connection.execute(select(func.count()).select_from(embedding_records)).scalar_one(),
        }
    return {
        "kind": "legal_classification",
        "processIdentifierField": legal.get("processIdentifierField"),
        "documentTextField": legal.get("documentTextField"),
        "categoryTargetField": legal.get("categoryTargetField"),
        "workflowContextField": legal.get("workflowContextField"),
        "decisionPolicy": legal.get("decisionPolicy", {}),
        "llm": legal.get("llm", {}),
        "counts": {key: int(value or 0) for key, value in counts.items()},
    }


def seed_training_metadata(training_result: dict[str, Any] | None, project: dict[str, Any], runtime_manifest: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(training_result, dict) or not training_result.get("runId"):
        return {"seeded": False, "reason": "latest_training_result ausente"}

    run_id = str(training_result["runId"])
    created_at = parse_timestamp(training_result.get("createdAt") or training_result.get("updatedAt"))
    leaderboard = [item for item in training_result.get("leaderboard", []) if isinstance(item, dict)]
    best = next((item for item in leaderboard if item.get("modelId") == training_result.get("bestModelId")), leaderboard[0] if leaderboard else {})
    active_model_id = str(runtime_manifest.get("activeModelId") or "")
    evidence = [item for item in training_result.get("promotionEvidence", []) if isinstance(item, dict)]
    decision = promotion_recommendation(evidence)
    inserted = {"dataset_versions": 0, "training_runs": 0, "model_versions": 0, "promotion_decisions": 0, "metric_snapshots": 0}

    with engine.begin() as connection:
        dataset_version = training_result.get("datasetVersion") if isinstance(training_result.get("datasetVersion"), dict) else {}
        dataset_version_id = str(dataset_version.get("datasetVersionId") or "")
        if dataset_version_id and not row_exists(connection, dataset_versions, dataset_version_id):
            connection.execute(
                insert(dataset_versions).values(
                    id=dataset_version_id,
                    layer="training",
                    uri=dataset_version.get("path") if isinstance(dataset_version.get("path"), str) else None,
                    schema_hash=dataset_version.get("schemaHash") if isinstance(dataset_version.get("schemaHash"), str) else None,
                    lineage={
                        "training_run_id": run_id,
                        "source_id": training_result.get("sourceId"),
                        "source_type": training_result.get("sourceType"),
                        "source_mode": training_result.get("sourceMode"),
                    },
                    quality={
                        "row_count": dataset_version.get("rowCount"),
                        "row_digest": dataset_version.get("rowDigest"),
                        "source_mode": dataset_version.get("sourceMode"),
                    },
                    created_at=created_at,
                )
            )
            inserted["dataset_versions"] += 1

        if not row_exists(connection, training_runs, run_id):
            connection.execute(
                insert(training_runs).values(
                    id=run_id,
                    status=str(training_result.get("status") or "ok"),
                    algorithm=str(best.get("trainedAlgorithm") or best.get("algorithm") or ""),
                    params={
                        "project_id": project.get("id"),
                        "source_id": training_result.get("sourceId"),
                        "source_type": training_result.get("sourceType"),
                        "source_mode": training_result.get("sourceMode"),
                        "problem_type": training_result.get("problemType") or project.get("problem", {}).get("type"),
                        "target": training_result.get("target") or project.get("problem", {}).get("target"),
                        "primary_metric": training_result.get("primaryMetric") or project.get("metrics", {}).get("primary"),
                        "best_model_id": training_result.get("bestModelId"),
                        "row_count": training_result.get("rowCount"),
                    },
                    metrics=best.get("metrics") if isinstance(best.get("metrics"), dict) else {},
                    artifacts=training_result.get("artifacts") if isinstance(training_result.get("artifacts"), list) else [],
                    started_at=created_at,
                    finished_at=created_at,
                )
            )
            inserted["training_runs"] += 1

        for model in leaderboard:
            model_id = str(model.get("modelId") or "")
            if not model_id or row_exists(connection, model_versions, model_id):
                continue
            is_active = model_id == active_model_id
            connection.execute(
                insert(model_versions).values(
                    id=model_id,
                    status="active" if is_active else str(model.get("role") or "candidate"),
                    algorithm=str(model.get("trainedAlgorithm") or model.get("algorithm") or ""),
                    metrics=model.get("metrics") if isinstance(model.get("metrics"), dict) else {},
                    artifact_uri=model.get("artifactUri") if isinstance(model.get("artifactUri"), str) else None,
                    is_active=is_active,
                    created_at=created_at,
                )
            )
            inserted["model_versions"] += 1

        promotion_id = f"{run_id}-promotion"
        if not row_exists(connection, promotion_decisions, promotion_id):
            connection.execute(
                insert(promotion_decisions).values(
                    id=promotion_id,
                    candidate_model_id=str(training_result.get("bestModelId") or ""),
                    decision=decision,
                    evidence=evidence,
                    approved_by=None,
                    created_at=created_at,
                )
            )
            inserted["promotion_decisions"] += 1

        snapshot_id = f"{run_id}-model-metrics"
        if not row_exists(connection, metric_snapshots, snapshot_id):
            connection.execute(
                insert(metric_snapshots).values(
                    id=snapshot_id,
                    scope="model_validation",
                    metrics={
                        "primary_metric": training_result.get("primaryMetric") or project.get("metrics", {}).get("primary"),
                        "best_model_id": training_result.get("bestModelId"),
                        "leaderboard": leaderboard,
                    },
                    created_at=created_at,
                )
            )
            inserted["metric_snapshots"] += 1

    return {"seeded": True, "run_id": run_id, **inserted}


def row_exists(connection, table, row_id: str) -> bool:
    return connection.execute(select(table.c.id).where(table.c.id == row_id)).first() is not None


def parse_timestamp(value: Any) -> datetime:
    if isinstance(value, str) and value:
        normalized = value.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(normalized)
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return now()


def promotion_recommendation(evidence: list[dict[str, Any]]) -> str:
    failed_blockers = [item for item in evidence if item.get("status") == "fail" and item.get("severity", "block") == "block"]
    failed_reviews = [item for item in evidence if item.get("status") == "fail" and item.get("severity", "block") != "block"]
    if failed_blockers:
        return "reject"
    if failed_reviews:
        return "review"
    return "approve"


def registered_model_version(model_id: str) -> dict[str, Any] | None:
    with engine.connect() as connection:
        row = connection.execute(select(model_versions).where(model_versions.c.id == model_id)).mappings().first()
    return serialize_model_version(row)


def register_model_version(
    model_id: str,
    algorithm: str | None,
    artifact_uri: str | None,
    metrics: dict[str, Any] | None,
    status: str | None,
    activate: bool,
    requested_by: str | None,
    confirm: bool,
) -> dict[str, Any]:
    if not confirm:
        raise ValueError("Registro de modelo exige confirm=true.")
    if not model_id or not model_id.strip():
        raise ValueError("model_id é obrigatório.")
    created_at = now()
    with engine.begin() as connection:
        if model_exists(connection, model_id):
            raise ValueError(f"Modelo {model_id} já existe no registry.")
        if activate:
            connection.execute(update(model_versions).values(is_active=False))
        connection.execute(
            insert(model_versions).values(
                id=model_id,
                status=status or ("active" if activate else "registered"),
                algorithm=algorithm or "external",
                metrics=metrics or {},
                artifact_uri=artifact_uri,
                is_active=activate,
                created_at=created_at,
            )
        )
        if activate:
            connection.execute(
                insert(promotion_decisions).values(
                    id=str(uuid4()),
                    candidate_model_id=model_id,
                    decision="approve",
                    evidence={"source": "model_registry_registration", "requested_by": requested_by, "activate": True},
                    approved_by=requested_by,
                    created_at=created_at,
                )
            )
        row = connection.execute(select(model_versions).where(model_versions.c.id == model_id)).mappings().first()
    record_event("model_registered", "Versão de modelo registrada", {"model_id": model_id, "activate": activate, "requested_by": requested_by})
    return {"status": "ok", "model": serialize_model_version(row)}


def promote_model_version(model_id: str, approved_by: str | None, evidence: dict[str, Any] | None, confirm: bool) -> dict[str, Any] | None:
    if not confirm:
        raise ValueError("Promoção de modelo exige confirm=true.")
    promoted_at = now()
    with engine.begin() as connection:
        row = connection.execute(select(model_versions).where(model_versions.c.id == model_id)).mappings().first()
        if row is None:
            return None
        connection.execute(update(model_versions).values(is_active=False))
        connection.execute(
            update(model_versions)
            .where(model_versions.c.id == model_id)
            .values(status="active", is_active=True)
        )
        decision_id = str(uuid4())
        connection.execute(
            insert(promotion_decisions).values(
                id=decision_id,
                candidate_model_id=model_id,
                decision="approve",
                evidence=evidence or {"source": "manual_registry_promotion"},
                approved_by=approved_by,
                created_at=promoted_at,
            )
        )
        updated = connection.execute(select(model_versions).where(model_versions.c.id == model_id)).mappings().first()
    record_event("model_promoted", "Versão de modelo promovida", {"model_id": model_id, "approved_by": approved_by})
    return {"status": "ok", "model": serialize_model_version(updated), "promotion_decision_id": decision_id}


def serialize_model_version(row: Any) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "id": row["id"],
        "status": row["status"],
        "algorithm": row["algorithm"],
        "metrics": row["metrics"] or {},
        "artifact_uri": row["artifact_uri"],
        "is_active": bool(row["is_active"]),
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


def register_embedding_profile(
    profile_id: str,
    provider: str | None,
    model_name: str | None,
    model_version: str | None,
    model_digest: str | None,
    dimension: int | None,
    similarity_metric: str | None,
    preprocessing_version: str | None,
    chunking_version: str | None,
    vector_collection_map: dict[str, Any] | None,
    metadata: dict[str, Any] | None,
    requested_by: str | None,
    confirm: bool,
) -> dict[str, Any]:
    if not confirm:
        raise ValueError("Registro de perfil de embedding exige confirm=true.")
    if not profile_id or not profile_id.strip():
        raise ValueError("profile_id é obrigatório.")
    created_at = now()
    collections = vector_collection_map or {}
    with engine.begin() as connection:
        if row_exists(connection, embedding_profiles, profile_id):
            raise ValueError(f"Perfil de embedding {profile_id} já existe.")
        connection.execute(
            insert(embedding_profiles).values(
                id=profile_id,
                provider=provider,
                model_name=model_name,
                model_version=model_version,
                model_digest=model_digest,
                dimension=dimension,
                similarity_metric=similarity_metric or "cosine",
                preprocessing_version=preprocessing_version,
                chunking_version=chunking_version,
                status="registered",
                vector_collections=collections,
                metadata_json=metadata or {},
                created_at=created_at,
            )
        )
        for logical_name, collection_name in collections.items():
            collection_id = f"{profile_id}:{collection_name}"
            if row_exists(connection, vector_collections, collection_id):
                continue
            connection.execute(
                insert(vector_collections).values(
                    id=collection_id,
                    profile_id=profile_id,
                    logical_name=str(logical_name),
                    collection_name=str(collection_name),
                    backend="external_vector_store_or_pgvector",
                    dimension=dimension,
                    similarity_metric=similarity_metric or "cosine",
                    status="registered",
                    metadata_json={"source": "embedding_profile_registry"},
                    created_at=created_at,
                )
            )
        row = connection.execute(select(embedding_profiles).where(embedding_profiles.c.id == profile_id)).mappings().first()
    record_event("embedding_profile_registered", "Perfil de embedding registrado", {"profile_id": profile_id, "requested_by": requested_by})
    return {"status": "ok", "profile": serialize_embedding_profile(row)}


def activate_embedding_profile(profile_id: str, requested_by: str | None, reason: str | None, confirm: bool) -> dict[str, Any] | None:
    if not confirm:
        raise ValueError("Ativação de perfil de embedding exige confirm=true.")
    activated_at = now()
    with engine.begin() as connection:
        row = connection.execute(select(embedding_profiles).where(embedding_profiles.c.id == profile_id)).mappings().first()
        if row is None:
            return None
        connection.execute(update(embedding_profiles).values(status="inactive"))
        connection.execute(update(vector_collections).values(status="inactive"))
        connection.execute(update(embedding_profiles).where(embedding_profiles.c.id == profile_id).values(status="active"))
        connection.execute(update(vector_collections).where(vector_collections.c.profile_id == profile_id).values(status="active"))
        updated = connection.execute(select(embedding_profiles).where(embedding_profiles.c.id == profile_id)).mappings().first()
    record_event("embedding_profile_activated", "Perfil de embedding ativado", {"profile_id": profile_id, "requested_by": requested_by, "reason": reason, "activated_at": activated_at.isoformat()})
    return {"status": "ok", "profile": serialize_embedding_profile(updated), "next_step": "reindex_embeddings_for_active_profile"}


def serialize_embedding_profile(row: Any) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "id": row["id"],
        "provider": row["provider"],
        "modelName": row["model_name"],
        "modelVersion": row["model_version"],
        "modelDigest": row["model_digest"],
        "dimension": row["dimension"],
        "similarityMetric": row["similarity_metric"],
        "preprocessingVersion": row["preprocessing_version"],
        "chunkingVersion": row["chunking_version"],
        "status": row["status"],
        "vectorCollections": row["vector_collections"] or {},
        "metadata": row["metadata_json"] or {},
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


def deployment_status(default_active_model_id: str) -> dict[str, Any]:
    with engine.connect() as connection:
        active_id = active_model_id_from_store(connection, default_active_model_id)
        latest = latest_deployment_rollout(connection)
        model_rows = connection.execute(select(model_versions)).mappings().fetchall()
    return {
        "status": "ok",
        "active_model_id": active_id,
        "mode": latest["kind"] if latest and latest["status"] == "active" else "active",
        "latest_rollout": serialize_deployment_rollout(latest) if latest else None,
        "models": [
            {
                "id": row["id"],
                "status": row["status"],
                "is_active": bool(row["is_active"]),
                "algorithm": row["algorithm"],
                "metrics": row["metrics"] or {},
            }
            for row in model_rows
        ],
    }


def start_shadow_deployment(default_active_model_id: str, model_id: str, requested_by: str | None, reason: str | None, confirm: bool) -> dict[str, Any]:
    return start_deployment_rollout("shadow", default_active_model_id, model_id, 0.0, requested_by, reason, confirm)


def start_canary_deployment(default_active_model_id: str, model_id: str, traffic_percent: float, requested_by: str | None, reason: str | None, confirm: bool) -> dict[str, Any]:
    if traffic_percent <= 0 or traffic_percent >= 100:
        raise ValueError("Canary exige traffic_percent maior que 0 e menor que 100.")
    return start_deployment_rollout("canary", default_active_model_id, model_id, traffic_percent, requested_by, reason, confirm)


def rollback_deployment(default_active_model_id: str, requested_by: str | None, reason: str | None, confirm: bool) -> dict[str, Any]:
    if not confirm:
        raise ValueError("Rollback exige confirm=true.")
    completed_at = now()
    with engine.begin() as connection:
        active_id = active_model_id_from_store(connection, default_active_model_id)
        latest = latest_deployment_rollout(connection)
        if latest and latest["status"] == "active":
            connection.execute(
                update(deployment_rollouts)
                .where(deployment_rollouts.c.id == latest["id"])
                .values(
                    status="rolled_back",
                    completed_at=completed_at,
                    details={**dict(latest["details"] or {}), "rollback": {"requested_by": requested_by, "reason": reason, "rolled_back_at": completed_at.isoformat()}},
                )
            )
        rollback_id = str(uuid4())
        connection.execute(
            insert(deployment_rollouts).values(
                id=rollback_id,
                kind="rollback",
                status="completed",
                active_model_id=active_id,
                candidate_model_id=latest["candidate_model_id"] if latest else None,
                traffic_percent=0.0,
                reason=reason,
                requested_by=requested_by,
                details={"rolled_back_rollout_id": latest["id"] if latest else None, "previous_mode": latest["kind"] if latest else "active"},
                created_at=completed_at,
                completed_at=completed_at,
            )
        )
        row = connection.execute(select(deployment_rollouts).where(deployment_rollouts.c.id == rollback_id)).mappings().first()
    record_event("deployment_rollback", "Rollback de deployment registrado", {"rollout_id": rollback_id, "rolled_back_rollout_id": latest["id"] if latest else None})
    return {"status": "ok", "rollout": serialize_deployment_rollout(row), "deployment": deployment_status(default_active_model_id)}


def start_deployment_rollout(kind: str, default_active_model_id: str, model_id: str, traffic_percent: float, requested_by: str | None, reason: str | None, confirm: bool) -> dict[str, Any]:
    if not confirm:
        raise ValueError("Rollout exige confirm=true.")
    created_at = now()
    with engine.begin() as connection:
        if not model_exists(connection, model_id):
            raise ValueError(f"Modelo {model_id} não existe no runtime.")
        active_id = active_model_id_from_store(connection, default_active_model_id)
        previous = latest_deployment_rollout(connection)
        if previous and previous["status"] == "active":
            connection.execute(
                update(deployment_rollouts)
                .where(deployment_rollouts.c.id == previous["id"])
                .values(status="superseded", completed_at=created_at)
            )
        rollout_id = str(uuid4())
        connection.execute(
            insert(deployment_rollouts).values(
                id=rollout_id,
                kind=kind,
                status="active",
                active_model_id=active_id,
                candidate_model_id=model_id,
                traffic_percent=traffic_percent,
                reason=reason,
                requested_by=requested_by,
                details={"previous_rollout_id": previous["id"] if previous else None},
                created_at=created_at,
                completed_at=None,
            )
        )
        row = connection.execute(select(deployment_rollouts).where(deployment_rollouts.c.id == rollout_id)).mappings().first()
    record_event(f"deployment_{kind}_started", f"Deployment {kind} iniciado", {"rollout_id": row["id"], "candidate_model_id": model_id, "traffic_percent": traffic_percent})
    return {"status": "ok", "rollout": serialize_deployment_rollout(row)}


def model_exists(connection, model_id: str) -> bool:
    return connection.execute(select(model_versions.c.id).where(model_versions.c.id == model_id)).first() is not None


def active_model_id_from_store(connection, default_active_model_id: str) -> str:
    row = connection.execute(select(model_versions.c.id).where(model_versions.c.is_active == True).limit(1)).scalar_one_or_none()
    return str(row or default_active_model_id or "")


def latest_deployment_rollout(connection):
    return connection.execute(select(deployment_rollouts).order_by(deployment_rollouts.c.created_at.desc()).limit(1)).mappings().first()


def serialize_deployment_rollout(row: Any) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "id": row["id"],
        "kind": row["kind"],
        "status": row["status"],
        "active_model_id": row["active_model_id"],
        "candidate_model_id": row["candidate_model_id"],
        "traffic_percent": row["traffic_percent"],
        "reason": row["reason"],
        "requested_by": row["requested_by"],
        "details": row["details"] or {},
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "completed_at": row["completed_at"].isoformat() if row["completed_at"] else None,
    }


def ab_testing_status(default_active_model_id: str) -> dict[str, Any]:
    with engine.connect() as connection:
        active_id = active_model_id_from_store(connection, default_active_model_id)
        latest = latest_ab_experiment(connection)
        active_count = connection.execute(select(func.count()).select_from(ab_experiments).where(ab_experiments.c.status == "active")).scalar_one()
        rows = connection.execute(select(ab_experiments).order_by(ab_experiments.c.created_at.desc()).limit(10)).mappings().fetchall()
    return {
        "status": "ok",
        "active_model_id": active_id,
        "active_count": int(active_count or 0),
        "latest_experiment": serialize_ab_experiment(latest),
        "experiments": [serialize_ab_experiment(row) for row in rows],
    }


def start_ab_test(
    default_active_model_id: str,
    candidate_model_id: str,
    baseline_model_id: str | None,
    traffic_split_percent: float,
    primary_metric: str | None,
    requested_by: str | None,
    reason: str | None,
    guardrails: dict[str, Any] | None,
    confirm: bool,
) -> dict[str, Any]:
    if not confirm:
        raise ValueError("Experimento A/B exige confirm=true.")
    if traffic_split_percent <= 0 or traffic_split_percent >= 100:
        raise ValueError("A/B exige traffic_split_percent maior que 0 e menor que 100.")
    created_at = now()
    with engine.begin() as connection:
        active_id = active_model_id_from_store(connection, default_active_model_id)
        baseline_id = baseline_model_id or active_id
        if not model_exists(connection, baseline_id):
            raise ValueError(f"Modelo baseline {baseline_id} não existe no runtime.")
        if not model_exists(connection, candidate_model_id):
            raise ValueError(f"Modelo candidato {candidate_model_id} não existe no runtime.")
        if baseline_id == candidate_model_id:
            raise ValueError("A/B exige modelos baseline e candidato diferentes.")
        previous = connection.execute(select(ab_experiments).where(ab_experiments.c.status == "active").order_by(ab_experiments.c.created_at.desc()).limit(1)).mappings().first()
        if previous:
            connection.execute(
                update(ab_experiments)
                .where(ab_experiments.c.id == previous["id"])
                .values(status="superseded", completed_at=created_at)
            )
        experiment_id = str(uuid4())
        details = {
            "traffic": {"baseline_percent": 100 - traffic_split_percent, "candidate_percent": traffic_split_percent},
            "guardrails": guardrails or {},
            "previous_experiment_id": previous["id"] if previous else None,
            "routing": "deterministic_hash_assignment_expected_at_gateway_or_runtime_adapter",
        }
        connection.execute(
            insert(ab_experiments).values(
                id=experiment_id,
                status="active",
                baseline_model_id=baseline_id,
                candidate_model_id=candidate_model_id,
                traffic_split_percent=traffic_split_percent,
                primary_metric=primary_metric or "primary",
                winner_model_id=None,
                reason=reason,
                requested_by=requested_by,
                details=details,
                created_at=created_at,
                completed_at=None,
            )
        )
        row = connection.execute(select(ab_experiments).where(ab_experiments.c.id == experiment_id)).mappings().first()
    record_event("ab_test_started", "Experimento A/B iniciado", {"experiment_id": experiment_id, "baseline_model_id": baseline_id, "candidate_model_id": candidate_model_id, "traffic_split_percent": traffic_split_percent})
    return {"status": "ok", "experiment": serialize_ab_experiment(row), "ab_testing": ab_testing_status(default_active_model_id)}


def complete_ab_test(
    experiment_id: str,
    winner_model_id: str | None,
    metrics: dict[str, Any] | None,
    completed_by: str | None,
    confirm: bool,
) -> dict[str, Any] | None:
    if not confirm:
        raise ValueError("Conclusão de A/B exige confirm=true.")
    completed_at = now()
    with engine.begin() as connection:
        row = connection.execute(select(ab_experiments).where(ab_experiments.c.id == experiment_id)).mappings().first()
        if row is None:
            return None
        if row["status"] == "completed":
            return {"status": "ok", "experiment": serialize_ab_experiment(row)}
        if row["status"] != "active":
            raise ValueError(f"Experimento em status {row['status']} não pode ser concluído.")
        allowed_winners = {row["baseline_model_id"], row["candidate_model_id"], "no_winner"}
        effective_winner = winner_model_id or "no_winner"
        if effective_winner not in allowed_winners:
            raise ValueError("winner_model_id precisa ser baseline, candidato ou no_winner.")
        details = dict(row["details"] or {})
        details["result"] = {
            "winner_model_id": effective_winner,
            "metrics": metrics or {},
            "completed_by": completed_by,
            "completed_at": completed_at.isoformat(),
        }
        connection.execute(
            update(ab_experiments)
            .where(ab_experiments.c.id == experiment_id)
            .values(status="completed", winner_model_id=effective_winner, details=details, completed_at=completed_at)
        )
        connection.execute(
            insert(metric_snapshots).values(
                id=f"{experiment_id}-metrics",
                scope="ab_test",
                metrics={"winner_model_id": effective_winner, "primary_metric": row["primary_metric"], "metrics": metrics or {}},
                created_at=completed_at,
            )
        )
        updated = connection.execute(select(ab_experiments).where(ab_experiments.c.id == experiment_id)).mappings().first()
    record_event("ab_test_completed", "Experimento A/B concluído", {"experiment_id": experiment_id, "winner_model_id": effective_winner})
    return {"status": "ok", "experiment": serialize_ab_experiment(updated)}


def latest_ab_experiment(connection):
    return connection.execute(select(ab_experiments).order_by(ab_experiments.c.created_at.desc()).limit(1)).mappings().first()


def serialize_ab_experiment(row: Any) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "id": row["id"],
        "status": row["status"],
        "baseline_model_id": row["baseline_model_id"],
        "candidate_model_id": row["candidate_model_id"],
        "traffic_split_percent": row["traffic_split_percent"],
        "primary_metric": row["primary_metric"],
        "winner_model_id": row["winner_model_id"],
        "reason": row["reason"],
        "requested_by": row["requested_by"],
        "details": row["details"] or {},
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "completed_at": row["completed_at"].isoformat() if row["completed_at"] else None,
    }


def mask_payload(payload: dict[str, Any], sensitive_fields: list[str]) -> dict[str, Any]:
    masked: dict[str, Any] = {}
    for key, value in payload.items():
        if key in sensitive_fields:
            masked[key] = "***"
        else:
            masked[key] = value
    return masked


def digest_payload(payload: dict[str, Any]) -> str:
    import json

    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    return sha256(raw.encode("utf-8")).hexdigest()


def record_prediction(payload: dict[str, Any], output: dict[str, Any], model_version_id: str, latency_ms: float, sensitive_fields: list[str], project: dict[str, Any] | None = None) -> str:
    run_id = str(uuid4())
    row_id = str(uuid4())
    created_at = now()
    input_masked = payload if settings.store_full_payload else mask_payload(payload, sensitive_fields)
    with engine.begin() as connection:
        connection.execute(insert(prediction_runs).values(id=run_id, model_version_id=model_version_id, status="success", latency_ms=latency_ms, created_at=created_at))
        connection.execute(insert(prediction_rows).values(id=row_id, run_id=run_id, model_version_id=model_version_id, input_digest=digest_payload(payload), input_masked=input_masked, output=output, latency_ms=latency_ms, created_at=created_at))
        if project:
            record_legal_prediction_context(connection, run_id, row_id, payload, output, project, created_at)
    return run_id


def record_legal_prediction_context(connection, run_id: str, row_id: str, payload: dict[str, Any], output: dict[str, Any], project: dict[str, Any], created_at: datetime) -> None:
    legal = legal_domain_config(project)
    if not legal:
        return
    process_field = str(legal.get("processIdentifierField") or "numero_unico")
    text_field = str(legal.get("documentTextField") or "texto")
    workflow_field = str(legal.get("workflowContextField") or "workflow_step_atual")
    process_identifier = payload.get(process_field) or f"prediction:{run_id}"
    process_id = sha256(str(process_identifier).encode("utf-8")).hexdigest()
    workflow_step = payload.get(workflow_field)
    workflow_step_code = str(workflow_step) if workflow_step is not None and str(workflow_step).strip() else None
    category_code = str(output.get("prediction")) if output.get("prediction") is not None else None
    if row_exists(connection, legal_processes, process_id):
        connection.execute(
            update(legal_processes)
            .where(legal_processes.c.id == process_id)
            .values(current_workflow_step=workflow_step_code, updated_at=created_at)
        )
    else:
        connection.execute(
            insert(legal_processes).values(
                id=process_id,
                process_identifier=str(process_identifier),
                current_workflow_step=workflow_step_code,
                metadata_json={"source": "prediction_runtime", "processIdentifierField": process_field},
                created_at=created_at,
                updated_at=created_at,
            )
        )
    document_text = payload.get(text_field)
    text_hash = sha256(str(document_text or "").encode("utf-8")).hexdigest() if document_text is not None else None
    connection.execute(
        insert(legal_documents).values(
            id=row_id,
            process_id=process_id,
            prediction_run_id=run_id,
            prediction_row_id=row_id,
            category_code=category_code,
            workflow_step_code=workflow_step_code,
            text_hash=text_hash,
            metadata_json={
                "documentTextField": text_field,
                "review": output.get("review", {}),
                "decision": output.get("decision", {}),
                "scores": output.get("explanation", {}).get("scores", {}),
            },
            created_at=created_at,
        )
    )
    andamento_id = f"{row_id}-andamento"
    connection.execute(
        insert(legal_andamentos).values(
            id=andamento_id,
            process_id=process_id,
            workflow_step_code=workflow_step_code,
            category_code=category_code,
            prediction_row_id=row_id,
            status=output.get("review", {}).get("status", "recorded"),
            details={
                "blockedRules": output.get("explanation", {}).get("workflow", {}).get("blockedRules", []),
                "humanReviewRequired": output.get("review", {}).get("humanReviewRequired", False),
                "llmReviewRecommended": output.get("decision", {}).get("llmReviewRecommended", False),
            },
            created_at=created_at,
        )
    )


def record_prediction_feedback(
    run_id: str,
    row_id: str | None,
    actual_label: Any,
    correct: bool | None,
    source: str,
    reviewer: str | None,
    comment: str | None,
) -> dict[str, Any] | None:
    with engine.begin() as connection:
        query = select(prediction_rows).where(prediction_rows.c.run_id == run_id)
        if row_id:
            query = query.where(prediction_rows.c.id == row_id)
        row = connection.execute(query.order_by(prediction_rows.c.created_at.desc()).limit(1)).mappings().first()
        if row is None:
            return None
        output = dict(row["output"] or {})
        predicted_value = output.get("prediction")
        effective_correct = bool(correct) if correct is not None else labels_match(actual_label, predicted_value)
        feedback_id = str(uuid4())
        created_at = now()
        connection.execute(
            insert(prediction_feedback).values(
                id=feedback_id,
                run_id=run_id,
                row_id=row["id"],
                model_version_id=row["model_version_id"],
                predicted_value=predicted_value,
                actual_label=actual_label,
                correct=effective_correct,
                source=source,
                reviewer=reviewer,
                comment=comment,
                created_at=created_at,
            )
        )
        connection.execute(
            insert(metric_snapshots).values(
                id=f"{feedback_id}-metrics",
                scope="feedback",
                metrics={
                    "run_id": run_id,
                    "row_id": row["id"],
                    "model_version_id": row["model_version_id"],
                    "predicted_value": predicted_value,
                    "actual_label": actual_label,
                    "correct": effective_correct,
                    "source": source,
                },
                created_at=created_at,
            )
        )
    return {
        "feedback_id": feedback_id,
        "run_id": run_id,
        "row_id": row["id"],
        "model_version_id": row["model_version_id"],
        "predicted_value": predicted_value,
        "actual_label": actual_label,
        "correct": effective_correct,
        "source": source,
        "created_at": created_at.isoformat(),
    }


def labels_match(actual_label: Any, predicted_value: Any) -> bool:
    if actual_label is None or predicted_value is None:
        return False
    try:
        return abs(float(actual_label) - float(predicted_value)) <= 1e-9
    except (TypeError, ValueError):
        pass
    return str(actual_label) == str(predicted_value)


def record_evaluation(result: dict[str, Any]) -> str:
    evaluation_id = str(uuid4())
    snapshot_id = f"{evaluation_id}-metrics"
    created_at = now()
    details = {
        "model_version_id": result.get("model_version_id"),
        "baseline_model_id": result.get("baseline_model_id"),
        "candidate_model_ids": result.get("candidate_model_ids", []),
        "record_count": result.get("record_count"),
        "label_count": result.get("label_count"),
        "primary_metric": result.get("primary_metric"),
        "sample": result.get("sample", []),
        "models": result.get("models", []),
        "evidence": result.get("evidence", []),
    }
    with engine.begin() as connection:
        connection.execute(
            insert(evaluation_runs).values(
                id=evaluation_id,
                status=str(result.get("status") or "ok"),
                metrics=result.get("metrics") if isinstance(result.get("metrics"), dict) else {},
                details=details,
                created_at=created_at,
            )
        )
        connection.execute(
            insert(metric_snapshots).values(
                id=snapshot_id,
                scope="evaluation",
                metrics={
                    "model_version_id": result.get("model_version_id"),
                    "primary_metric": result.get("primary_metric"),
                    "metrics": result.get("metrics") if isinstance(result.get("metrics"), dict) else {},
                },
                created_at=created_at,
            )
        )
    return evaluation_id


def record_drift(result: dict[str, Any]) -> str:
    drift_id = str(uuid4())
    snapshot_id = f"{drift_id}-metrics"
    created_at = now()
    details = {
        "reference_count": result.get("reference_count"),
        "current_count": result.get("current_count"),
        "feature_count": result.get("feature_count"),
        "features": result.get("features", []),
        "thresholds": result.get("thresholds", {}),
    }
    with engine.begin() as connection:
        connection.execute(
            insert(drift_runs).values(
                id=drift_id,
                status=str(result.get("status") or "ok"),
                score=float(result.get("drift_score") or 0.0),
                details=details,
                created_at=created_at,
            )
        )
        connection.execute(
            insert(metric_snapshots).values(
                id=snapshot_id,
                scope="drift",
                metrics={
                    "drift_score": float(result.get("drift_score") or 0.0),
                    "status": result.get("status"),
                    "features": result.get("features", []),
                },
                created_at=created_at,
            )
        )
    return drift_id


def latest_drift() -> dict[str, Any] | None:
    with engine.connect() as connection:
        row = connection.execute(select(drift_runs).order_by(drift_runs.c.created_at.desc()).limit(1)).mappings().first()
    return dict(row) if row else None


def feedback_summary(active_model_id: str | None = None) -> dict[str, Any]:
    with engine.connect() as connection:
        feedback_count = connection.execute(select(func.count()).select_from(prediction_feedback)).scalar_one()
        correct_count = connection.execute(select(func.count()).select_from(prediction_feedback).where(prediction_feedback.c.correct == True)).scalar_one()
        active_count = 0
        active_correct = 0
        if active_model_id:
            active_count = connection.execute(
                select(func.count()).select_from(prediction_feedback).where(prediction_feedback.c.model_version_id == active_model_id)
            ).scalar_one()
            active_correct = connection.execute(
                select(func.count()).select_from(prediction_feedback).where(prediction_feedback.c.model_version_id == active_model_id).where(prediction_feedback.c.correct == True)
            ).scalar_one()
        latest = connection.execute(select(prediction_feedback).order_by(prediction_feedback.c.created_at.desc()).limit(1)).mappings().first()
    latest_feedback = dict(latest) if latest else None
    if latest_feedback and latest_feedback.get("created_at") is not None:
        latest_feedback["created_at"] = latest_feedback["created_at"].isoformat()
    return {
        "feedback_count": int(feedback_count or 0),
        "correct_count": int(correct_count or 0),
        "feedback_accuracy": ratio(correct_count, feedback_count),
        "active_model_id": active_model_id,
        "active_model_feedback_count": int(active_count or 0),
        "active_model_correct_count": int(active_correct or 0),
        "active_model_feedback_accuracy": ratio(active_correct, active_count),
        "latest_feedback": latest_feedback,
    }


def ratio(numerator: Any, denominator: Any) -> float | None:
    denominator_value = int(denominator or 0)
    if denominator_value <= 0:
        return None
    return round(float(numerator or 0) / denominator_value, 6)


def create_retraining_request(
    trigger: str,
    reason: str,
    requested_by: str | None,
    min_feedback_count: int,
    policy: dict[str, Any] | None,
    active_model_id: str,
) -> dict[str, Any]:
    feedback = feedback_summary(active_model_id)
    feedback_count = int(feedback["feedback_count"] or 0)
    status = "pending_review" if feedback_count >= min_feedback_count else "blocked"
    request_id = str(uuid4())
    created_at = now()
    effective_policy = {
        "min_feedback_count": min_feedback_count,
        "source": "runtime_feedback",
        "requires_manual_approval": True,
        **(policy or {}),
    }
    details = {
        "feedback": feedback,
        "blocked_reason": None if status == "pending_review" else "feedback_count_below_minimum",
        "next_step": "approve_then_run_retraining_in_studio_worker",
    }
    with engine.begin() as connection:
        connection.execute(
            insert(retraining_requests).values(
                id=request_id,
                status=status,
                trigger=trigger,
                reason=reason,
                requested_by=requested_by,
                approved_by=None,
                feedback_count=feedback_count,
                feedback_accuracy=feedback["feedback_accuracy"],
                active_model_id=active_model_id,
                policy=effective_policy,
                details=details,
                created_at=created_at,
                approved_at=None,
                completed_at=None,
            )
        )
    return {
        "request_id": request_id,
        "status": status,
        "trigger": trigger,
        "reason": reason,
        "requested_by": requested_by,
        "feedback_count": feedback_count,
        "feedback_accuracy": feedback["feedback_accuracy"],
        "active_model_id": active_model_id,
        "policy": effective_policy,
        "details": details,
        "created_at": created_at.isoformat(),
    }


def approve_retraining_request(request_id: str, approved_by: str | None, confirm: bool) -> dict[str, Any] | None:
    if not confirm:
        raise ValueError("Aprovação de retreino exige confirm=true.")
    approved_at = now()
    with engine.begin() as connection:
        row = connection.execute(select(retraining_requests).where(retraining_requests.c.id == request_id)).mappings().first()
        if row is None:
            return None
        if row["status"] == "blocked":
            raise ValueError("Solicitação bloqueada não pode ser aprovada.")
        if row["status"] == "completed":
            raise ValueError("Solicitação já concluída não pode ser aprovada.")
        details = dict(row["details"] or {})
        details["approved"] = {"approved_by": approved_by, "approved_at": approved_at.isoformat()}
        details["next_step"] = "run_controlled_retraining_job_in_studio"
        connection.execute(
            retraining_requests.update()
            .where(retraining_requests.c.id == request_id)
            .values(status="approved_pending_runner", approved_by=approved_by, approved_at=approved_at, details=details)
        )
        updated = connection.execute(select(retraining_requests).where(retraining_requests.c.id == request_id)).mappings().first()
    return retraining_request_to_dict(updated)


def complete_retraining_request(
    request_id: str,
    completed_by: str | None,
    confirm: bool,
    success: bool,
    result: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if not confirm:
        raise ValueError("Conclusão de retreino exige confirm=true.")
    completed_at = now()
    final_status = "completed" if success else "runner_failed"
    with engine.begin() as connection:
        row = connection.execute(select(retraining_requests).where(retraining_requests.c.id == request_id)).mappings().first()
        if row is None:
            return None
        if row["status"] == final_status:
            return retraining_request_to_dict(row)
        if row["status"] not in ["approved_pending_runner", "runner_failed"]:
            raise ValueError(f"Solicitação em status {row['status']} não pode ser concluída pelo runner.")
        details = dict(row["details"] or {})
        details["runner"] = {
            "completed_by": completed_by,
            "completed_at": completed_at.isoformat(),
            "success": success,
            "result": result or {},
        }
        details["next_step"] = "review_retrained_model_for_promotion" if success else "inspect_failed_retraining_job"
        connection.execute(
            retraining_requests.update()
            .where(retraining_requests.c.id == request_id)
            .values(status=final_status, completed_at=completed_at, details=details)
        )
        updated = connection.execute(select(retraining_requests).where(retraining_requests.c.id == request_id)).mappings().first()
    return retraining_request_to_dict(updated)


def retraining_status(active_model_id: str) -> dict[str, Any]:
    with engine.connect() as connection:
        total = connection.execute(select(func.count()).select_from(retraining_requests)).scalar_one()
        pending = connection.execute(select(func.count()).select_from(retraining_requests).where(retraining_requests.c.status.in_(["pending_review", "approved_pending_runner"]))).scalar_one()
        latest = connection.execute(select(retraining_requests).order_by(retraining_requests.c.created_at.desc()).limit(1)).mappings().first()
    return {
        "request_count": int(total or 0),
        "pending_count": int(pending or 0),
        "latest_request": retraining_request_to_dict(latest),
        "feedback": feedback_summary(active_model_id),
    }


def retraining_training_set(request_id: str, target_field: str, limit: int = 1000) -> dict[str, Any] | None:
    safe_limit = max(1, min(int(limit or 1000), 10000))
    with engine.connect() as connection:
        request = connection.execute(select(retraining_requests).where(retraining_requests.c.id == request_id)).mappings().first()
        if request is None:
            return None
        rows_query = (
            select(prediction_feedback, prediction_rows.c.input_masked)
            .select_from(prediction_feedback.join(prediction_rows, prediction_feedback.c.row_id == prediction_rows.c.id))
            .where(prediction_feedback.c.model_version_id == request["active_model_id"])
            .order_by(prediction_feedback.c.created_at.desc())
            .limit(safe_limit)
        )
        feedback_rows = connection.execute(rows_query).mappings().all()
    rows: list[dict[str, Any]] = []
    skipped = 0
    for feedback in feedback_rows:
        input_payload = feedback.get("input_masked") if isinstance(feedback.get("input_masked"), dict) else {}
        if not input_payload:
            skipped += 1
            continue
        row = dict(input_payload)
        row[target_field] = feedback.get("actual_label")
        rows.append(row)
    return {
        "request_id": request_id,
        "request_status": request["status"],
        "active_model_id": request["active_model_id"],
        "target": target_field,
        "source": "runtime_feedback",
        "row_count": len(rows),
        "skipped_rows": skipped,
        "limit": safe_limit,
        "rows": rows,
        "payload_policy": "masked_unless_STORE_FULL_PAYLOAD_true",
    }


def retraining_request_to_dict(row: Any) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    for key in ["created_at", "approved_at", "completed_at"]:
        if data.get(key) is not None:
            data[key] = data[key].isoformat()
    return data


def runtime_metrics(active_model_id: str) -> dict[str, Any]:
    with engine.connect() as connection:
        prediction_count = connection.execute(select(func.count()).select_from(prediction_rows)).scalar_one()
        evaluation_count = connection.execute(select(func.count()).select_from(evaluation_runs)).scalar_one()
        drift_count = connection.execute(select(func.count()).select_from(drift_runs)).scalar_one()
        latest_drift_score = connection.execute(select(drift_runs.c.score).order_by(drift_runs.c.created_at.desc()).limit(1)).scalar_one_or_none()
        avg_latency = connection.execute(select(func.avg(prediction_rows.c.latency_ms))).scalar_one()
        retraining_pending = connection.execute(select(func.count()).select_from(retraining_requests).where(retraining_requests.c.status.in_(["pending_review", "approved_pending_runner"]))).scalar_one()
        ab_experiment_count = connection.execute(select(func.count()).select_from(ab_experiments)).scalar_one()
        active_ab_experiment_count = connection.execute(select(func.count()).select_from(ab_experiments).where(ab_experiments.c.status == "active")).scalar_one()
    feedback = feedback_summary(active_model_id)
    return {
        "active_model_id": active_model_id,
        "prediction_count": int(prediction_count or 0),
        "evaluation_count": int(evaluation_count or 0),
        "drift_count": int(drift_count or 0),
        "ab_experiment_count": int(ab_experiment_count or 0),
        "active_ab_experiment_count": int(active_ab_experiment_count or 0),
        "feedback_count": feedback["feedback_count"],
        "feedback_accuracy": feedback["feedback_accuracy"],
        "retraining_pending_count": int(retraining_pending or 0),
        "error_rate": 0.0,
        "latency_avg_ms": float(avg_latency or 0.0),
        "latency_p95_ms": float(avg_latency or 0.0),
        "drift_score": float(latest_drift_score or 0.0),
    }


class Timer:
    def __enter__(self):
        self.started = perf_counter()
        return self

    def __exit__(self, *_args):
        self.latency_ms = (perf_counter() - self.started) * 1000
`;
}
