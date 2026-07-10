export function renderMainPy(): string {
  return `from typing import Any
from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field
from .dashboard import dashboard_html
from .environment import gpu_environment
from .lifecycle import lifespan
from .repository import Timer, ab_testing_status, activate_embedding_profile, approve_retraining_request, check_database, complete_ab_test, complete_retraining_request, create_retraining_request, deployment_status, domain_metadata_summary, feedback_summary, latest_drift, promote_model_version, record_drift, record_evaluation, record_event, record_prediction, record_prediction_feedback, registered_model_version, register_embedding_profile, register_model_version, retraining_status, retraining_training_set, rollback_deployment, runtime_metrics, start_ab_test, start_canary_deployment, start_shadow_deployment
from .runtime import active_model, backtest_records, calculate_drift, embedding_profiles, embedding_search, evaluate_records, latest_training_result, model_by_id, model_card, model_catalog, model_metrics, predict_payload, project, promotion_status, request_embedding_reindex, runtime_manifest
from .security import require_api_key
from .settings import settings


class PredictRequest(BaseModel):
    input: dict[str, Any] = Field(default_factory=dict)
    trace: bool = True


class FeedbackRequest(BaseModel):
    run_id: str
    row_id: str | None = None
    actual_label: Any
    correct: bool | None = None
    source: str = "operator"
    reviewer: str | None = None
    comment: str | None = None


class ModelRegistrationRequest(BaseModel):
    confirm: bool = False
    model_id: str
    algorithm: str | None = None
    artifact_uri: str | None = None
    metrics: dict[str, Any] = Field(default_factory=dict)
    status: str | None = None
    activate: bool = False
    requested_by: str | None = None


class ModelPromotionRequest(BaseModel):
    confirm: bool = False
    approved_by: str | None = None
    evidence: dict[str, Any] = Field(default_factory=dict)


class RetrainingRequest(BaseModel):
    trigger: str = "feedback_threshold"
    reason: str = "Feedback real disponível para retreino controlado."
    requested_by: str | None = None
    min_feedback_count: int = 1
    policy: dict[str, Any] = Field(default_factory=dict)


class RetrainingApprovalRequest(BaseModel):
    confirm: bool = False
    approved_by: str | None = None


class RetrainingCompletionRequest(BaseModel):
    confirm: bool = False
    completed_by: str | None = None
    success: bool = True
    job_id: str | None = None
    training_run_id: str | None = None
    model_id: str | None = None
    message: str | None = None
    metrics: dict[str, Any] = Field(default_factory=dict)


class DeploymentShadowRequest(BaseModel):
    confirm: bool = False
    model_id: str
    requested_by: str | None = None
    reason: str | None = None


class DeploymentCanaryRequest(BaseModel):
    confirm: bool = False
    model_id: str
    traffic_percent: float = 10.0
    requested_by: str | None = None
    reason: str | None = None


class DeploymentRollbackRequest(BaseModel):
    confirm: bool = False
    requested_by: str | None = None
    reason: str | None = None


class ABTestStartRequest(BaseModel):
    confirm: bool = False
    candidate_model_id: str
    baseline_model_id: str | None = None
    traffic_split_percent: float = 50.0
    primary_metric: str | None = None
    requested_by: str | None = None
    reason: str | None = None
    guardrails: dict[str, Any] = Field(default_factory=dict)


class ABTestCompletionRequest(BaseModel):
    confirm: bool = False
    winner_model_id: str | None = None
    completed_by: str | None = None
    metrics: dict[str, Any] = Field(default_factory=dict)


class EvaluateRequest(BaseModel):
    records: list[dict[str, Any]] = Field(default_factory=list)
    labels: list[Any] = Field(default_factory=list)


class BacktestRequest(BaseModel):
    records: list[dict[str, Any]] = Field(default_factory=list)
    labels: list[Any] = Field(default_factory=list)
    model_ids: list[str] = Field(default_factory=list)
    baseline_model_id: str | None = None
    neutral_band: float = 0.0


class DriftRequest(BaseModel):
    reference_records: list[dict[str, Any]] = Field(default_factory=list)
    current_records: list[dict[str, Any]] = Field(default_factory=list)
    records: list[dict[str, Any]] = Field(default_factory=list)
    feature_keys: list[str] = Field(default_factory=list)
    warning_threshold: float = 0.2
    alert_threshold: float = 0.5
    auto_retraining: bool = True
    retraining_min_feedback_count: int = 1
    requested_by: str | None = None


class EmbeddingSearchRequest(BaseModel):
    query: str = ""
    collection: str | None = None
    top_k: int = 5
    profile_id: str | None = None


class EmbeddingProfileRegistrationRequest(BaseModel):
    confirm: bool = False
    profile_id: str
    provider: str | None = None
    model_name: str | None = None
    model_version: str | None = None
    model_digest: str | None = None
    dimension: int | None = None
    similarity_metric: str | None = "cosine"
    preprocessing_version: str | None = None
    chunking_version: str | None = None
    vector_collections: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    requested_by: str | None = None


class EmbeddingProfileActivationRequest(BaseModel):
    confirm: bool = False
    requested_by: str | None = None
    reason: str | None = None


class EmbeddingReindexRequest(BaseModel):
    confirm: bool = False
    profile_id: str | None = None
    requested_by: str | None = None
    reason: str | None = None


app = FastAPI(
    title=settings.app_name,
    version=project["version"],
    lifespan=lifespan,
    dependencies=[Depends(require_api_key)],
)


@app.get("/health")
def health() -> dict[str, Any]:
    database = check_database()
    return {"status": "ok", "database": database, "active_model": active_model()["id"], "execution_profile": settings.execution_profile}


@app.get("/metadata")
def metadata() -> dict[str, Any]:
    return {
        "contract": runtime_manifest["contract"],
        "project": {"id": project["id"], "name": project["name"], "version": project["version"]},
        "problem": project["problem"],
        "domain": project.get("domain", {"kind": "generic"}),
        "active_model_id": active_model()["id"],
        "project_hash": runtime_manifest["projectHash"],
        "pipeline_hash": runtime_manifest["pipelineHash"],
        "execution_profile": settings.execution_profile,
        "persistence": runtime_manifest["persistence"],
        "mlflow_tracking_uri": settings.mlflow_tracking_uri,
        "endpoints": runtime_manifest["endpoints"],
    }


@app.get("/domain/legal")
def get_legal_domain() -> dict[str, Any]:
    return domain_metadata_summary(project)


@app.get("/embeddings/profiles")
def get_embedding_profiles() -> dict[str, Any]:
    return embedding_profiles()


@app.post("/embeddings/profiles/register")
def register_embedding_profile_endpoint(request: EmbeddingProfileRegistrationRequest) -> dict[str, Any]:
    try:
        return register_embedding_profile(
            request.profile_id,
            request.provider,
            request.model_name,
            request.model_version,
            request.model_digest,
            request.dimension,
            request.similarity_metric,
            request.preprocessing_version,
            request.chunking_version,
            request.vector_collections,
            request.metadata,
            request.requested_by,
            request.confirm,
        )
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.post("/embeddings/profiles/{profile_id}/activate")
def activate_embedding_profile_endpoint(profile_id: str, request: EmbeddingProfileActivationRequest) -> dict[str, Any]:
    try:
        result = activate_embedding_profile(profile_id, request.requested_by, request.reason, request.confirm)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if result is None:
        raise HTTPException(status_code=404, detail="Perfil de embedding não encontrado.")
    return result


@app.post("/embeddings/search")
def search_embeddings(request: EmbeddingSearchRequest) -> dict[str, Any]:
    return embedding_search(request.query, request.collection, request.top_k, request.profile_id)


@app.post("/embeddings/reindex")
def reindex_embeddings(request: EmbeddingReindexRequest) -> dict[str, Any]:
    result = request_embedding_reindex(request.profile_id, request.requested_by, request.reason, request.confirm)
    if result.get("status") == "requires_confirmation":
        raise HTTPException(status_code=409, detail=result)
    record_event("embedding_reindex_requested", "Solicitação de reindexação de embeddings registrada", result)
    return result


@app.get("/environment/gpu")
def get_gpu_environment() -> dict[str, Any]:
    return gpu_environment()


@app.get("/model-card")
def get_model_card() -> dict[str, Any]:
    return model_card()


@app.get("/models")
def get_models() -> dict[str, Any]:
    return {"models": model_catalog()}


@app.get("/models/active")
def get_active_model() -> dict[str, Any]:
    return active_model()


@app.post("/models/register")
def register_model(request: ModelRegistrationRequest) -> dict[str, Any]:
    try:
        return register_model_version(
            request.model_id,
            request.algorithm,
            request.artifact_uri,
            request.metrics,
            request.status,
            request.activate,
            request.requested_by,
            request.confirm,
        )
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.get("/models/{model_id}")
def get_model(model_id: str) -> dict[str, Any]:
    registered = registered_model_version(model_id)
    if registered:
        return {"registered": True, "model": registered}
    model = model_by_id(model_id)
    if model:
        return {"registered": False, "model": model}
    raise HTTPException(status_code=404, detail="Modelo não encontrado.")


@app.post("/models/{model_id}/promote")
def promote_model(model_id: str, request: ModelPromotionRequest) -> dict[str, Any]:
    try:
        result = promote_model_version(model_id, request.approved_by, request.evidence, request.confirm)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if result is None:
        raise HTTPException(status_code=404, detail="Modelo não encontrado no registry.")
    return result


@app.get("/metrics/model")
def get_model_metrics() -> dict[str, Any]:
    return model_metrics()


@app.get("/metrics/runtime")
def get_runtime_metrics() -> dict[str, Any]:
    return runtime_metrics(active_model()["id"])


@app.post("/predict")
def predict(request: PredictRequest) -> dict[str, Any]:
    with Timer() as timer:
        output = predict_payload(request.input)
    run_id = record_prediction(request.input, output, output["model_version_id"], timer.latency_ms, project.get("sensitiveFields", []), project)
    record_event("prediction_completed", "Predição executada no runtime", {"run_id": run_id, "model_version_id": output["model_version_id"], "inference_source": output.get("inference_source")})
    return {"run_id": run_id, "latency_ms": timer.latency_ms, **output}


@app.post("/feedback")
def feedback(request: FeedbackRequest) -> dict[str, Any]:
    result = record_prediction_feedback(
        request.run_id,
        request.row_id,
        request.actual_label,
        request.correct,
        request.source,
        request.reviewer,
        request.comment,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Predição não encontrada para feedback.")
    record_event("prediction_feedback_recorded", "Feedback de label real registrado", {"feedback_id": result["feedback_id"], "run_id": result["run_id"], "correct": result["correct"]})
    return result


@app.get("/feedback/summary")
def get_feedback_summary() -> dict[str, Any]:
    return feedback_summary(active_model()["id"])


@app.post("/retraining/requests")
def request_retraining(request: RetrainingRequest) -> dict[str, Any]:
    result = create_retraining_request(
        request.trigger,
        request.reason,
        request.requested_by,
        request.min_feedback_count,
        request.policy,
        active_model()["id"],
    )
    record_event("retraining_requested", "Solicitação de retreino controlado registrada", {"request_id": result["request_id"], "status": result["status"], "feedback_count": result["feedback_count"]})
    return result


@app.post("/retraining/requests/{request_id}/approve")
def approve_retraining(request_id: str, request: RetrainingApprovalRequest) -> dict[str, Any]:
    try:
        result = approve_retraining_request(request_id, request.approved_by, request.confirm)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if result is None:
        raise HTTPException(status_code=404, detail="Solicitação de retreino não encontrada.")
    record_event("retraining_approved", "Solicitação de retreino controlado aprovada", {"request_id": request_id, "approved_by": request.approved_by})
    return result


@app.get("/retraining/requests/{request_id}/training-set")
def get_retraining_training_set(request_id: str, limit: int = 1000) -> dict[str, Any]:
    result = retraining_training_set(request_id, project["problem"]["target"], limit)
    if result is None:
        raise HTTPException(status_code=404, detail="Solicitação de retreino não encontrada.")
    return result


@app.post("/retraining/requests/{request_id}/complete")
def complete_retraining(request_id: str, request: RetrainingCompletionRequest) -> dict[str, Any]:
    result_payload = {
        "job_id": request.job_id,
        "training_run_id": request.training_run_id,
        "model_id": request.model_id,
        "message": request.message,
        "metrics": request.metrics,
    }
    try:
        result = complete_retraining_request(request_id, request.completed_by, request.confirm, request.success, result_payload)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if result is None:
        raise HTTPException(status_code=404, detail="Solicitação de retreino não encontrada.")
    record_event("retraining_completed" if request.success else "retraining_failed", "Solicitação de retreino finalizada pelo Studio", {"request_id": request_id, "success": request.success, "training_run_id": request.training_run_id, "model_id": request.model_id})
    return result


@app.get("/retraining/status")
def get_retraining_status() -> dict[str, Any]:
    return retraining_status(active_model()["id"])


@app.post("/evaluate")
def evaluate(request: EvaluateRequest) -> dict[str, Any]:
    result = evaluate_records(request.records, request.labels)
    evaluation_id = record_evaluation(result)
    record_event("evaluation_completed", "Avaliação executada no runtime", {"evaluation_id": evaluation_id, "model_version_id": result.get("model_version_id"), "record_count": result.get("record_count")})
    return {"evaluation_id": evaluation_id, **result}


@app.post("/backtest")
def backtest(request: BacktestRequest) -> dict[str, Any]:
    result = backtest_records(request.records, request.labels, request.model_ids, request.baseline_model_id, request.neutral_band)
    backtest_id = record_evaluation(result)
    record_event("backtest_completed", "Backtest comparativo executado no runtime", {"backtest_id": backtest_id, "baseline_model_id": result.get("baseline_model_id"), "record_count": result.get("record_count")})
    return {"backtest_id": backtest_id, "evaluation_id": backtest_id, **result}


@app.post("/drift")
def drift(request: DriftRequest) -> dict[str, Any]:
    current_records = request.current_records or request.records
    result = calculate_drift(
        request.reference_records,
        current_records,
        request.feature_keys,
        request.warning_threshold,
        request.alert_threshold,
    )
    drift_id = record_drift(result)
    record_event("drift_completed", "Drift calculado no runtime", {"drift_id": drift_id, "status": result.get("status"), "drift_score": result.get("drift_score")})
    auto_retraining = {"triggered": False, "reason": "status_not_alert"}
    if request.auto_retraining and result.get("status") == "alert":
        auto_retraining = {
            "triggered": True,
            "request": create_retraining_request(
                "drift_alert",
                f"Drift em alerta no monitoramento runtime: drift_id={drift_id}",
                request.requested_by or "runtime_drift_monitor",
                request.retraining_min_feedback_count,
                {"source": "drift_monitor", "drift_id": drift_id, "thresholds": result.get("thresholds", {}), "requires_manual_approval": True},
                active_model()["id"],
            ),
        }
        record_event("drift_retraining_requested", "Drift em alerta gerou solicitação de retreino", {"drift_id": drift_id, "request_id": auto_retraining["request"]["request_id"], "status": auto_retraining["request"]["status"]})
    return {"drift_id": drift_id, "auto_retraining": auto_retraining, **result}


@app.get("/drift/latest")
def get_latest_drift() -> dict[str, Any]:
    return latest_drift() or {"status": "empty", "message": "Nenhum drift calculado ainda."}


@app.get("/promotion/status")
def get_promotion_status() -> dict[str, Any]:
    return promotion_status()


@app.get("/deployment/status")
def get_deployment_status() -> dict[str, Any]:
    return deployment_status(active_model()["id"])


@app.post("/deployment/shadow")
def start_shadow(request: DeploymentShadowRequest) -> dict[str, Any]:
    try:
        result = start_shadow_deployment(active_model()["id"], request.model_id, request.requested_by, request.reason, request.confirm)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return {"deployment": deployment_status(active_model()["id"]), **result}


@app.post("/deployment/canary")
def start_canary(request: DeploymentCanaryRequest) -> dict[str, Any]:
    try:
        result = start_canary_deployment(active_model()["id"], request.model_id, request.traffic_percent, request.requested_by, request.reason, request.confirm)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return {"deployment": deployment_status(active_model()["id"]), **result}


@app.post("/deployment/rollback")
def rollback(request: DeploymentRollbackRequest) -> dict[str, Any]:
    try:
        return rollback_deployment(active_model()["id"], request.requested_by, request.reason, request.confirm)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.get("/experiments/ab-tests")
def get_ab_tests() -> dict[str, Any]:
    return ab_testing_status(active_model()["id"])


@app.get("/experiments/ab-tests/latest")
def get_latest_ab_test() -> dict[str, Any]:
    latest = ab_testing_status(active_model()["id"])["latest_experiment"]
    return latest or {"status": "empty", "message": "Nenhum experimento A/B registrado."}


@app.post("/experiments/ab-tests")
def create_ab_test(request: ABTestStartRequest) -> dict[str, Any]:
    try:
        return start_ab_test(
            active_model()["id"],
            request.candidate_model_id,
            request.baseline_model_id,
            request.traffic_split_percent,
            request.primary_metric or project.get("metrics", {}).get("primary"),
            request.requested_by,
            request.reason,
            request.guardrails,
            request.confirm,
        )
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.post("/experiments/ab-tests/{experiment_id}/complete")
def finish_ab_test(experiment_id: str, request: ABTestCompletionRequest) -> dict[str, Any]:
    try:
        result = complete_ab_test(experiment_id, request.winner_model_id, request.metrics, request.completed_by, request.confirm)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if result is None:
        raise HTTPException(status_code=404, detail="Experimento A/B não encontrado.")
    return result


@app.get("/dashboard")
def dashboard():
    return dashboard_html()
`;
}
