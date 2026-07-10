export function renderContractTestPy(): string {
  return `import base64
import os
import pickle
from pathlib import Path

os.environ.setdefault("MLOPS_RUNTIME_API_KEY", "test-runtime-api-key-with-32-characters")

from fastapi.testclient import TestClient
from sqlalchemy import select
from app import runtime as runtime_module
from app.db import ab_experiments, app_events, deployment_rollouts, drift_runs, engine, evaluation_runs, metric_snapshots, model_versions, prediction_feedback, prediction_rows, prediction_runs, promotion_decisions, retraining_requests, training_runs
from app.main import app
from app.runtime import latest_training_result, project


AUTH_HEADERS = {"Authorization": "Bearer " + os.environ["MLOPS_RUNTIME_API_KEY"]}


class FakeEmbeddingEstimator:
    classes_ = ["classe_a", "classe_b"]

    def predict(self, matrix):
        return ["classe_a" for _row in matrix]

    def predict_proba(self, matrix):
        return [[0.91, 0.09] for _row in matrix]


class FakeSentenceTransformer:
    def encode(self, texts, **_kwargs):
        return [[1.0, 0.0] for _text in texts]


def test_optional_orchestration_artifacts():
    runtime_root = Path(__file__).resolve().parents[1]
    expected_files = [
        "requirements-orchestration.txt",
        "docker-compose.capabilities.yml",
        "docker-compose.orchestration.yml",
        "orchestration/prefect_flow.py",
        "orchestration/celery_app.py",
        "grpc/README.md",
        "grpc/legal_classification.proto",
        ".mlops/capabilities.yaml",
        ".mlops/promotion_policy.yaml",
        ".mlops/orchestration_manifest.yaml",
    ]
    for relative_path in expected_files:
        assert (runtime_root / relative_path).exists()
    promotion_policy = (runtime_root / ".mlops/promotion_policy.yaml").read_text(encoding="utf-8")
    assert "kind: promotion_policy" in promotion_policy
    assert "recommendationEndpoint: GET /promotion/status" in promotion_policy
    manifest = (runtime_root / ".mlops/orchestration_manifest.yaml").read_text(encoding="utf-8")
    assert "kind: orchestration_manifest" in manifest
    assert "composeFile: docker-compose.orchestration.yml" in manifest
    assert "entrypoint: orchestration/prefect_flow.py" in manifest
    assert "entrypoint: orchestration/celery_app.py" in manifest
    capabilities = (runtime_root / ".mlops/capabilities.yaml").read_text(encoding="utf-8")
    assert "kind: capability_manifest" in capabilities
    assert "capabilities:" in capabilities
    compose = (runtime_root / "docker-compose.orchestration.yml").read_text(encoding="utf-8")
    assert "orchestration-redis:" in compose
    assert "celery-worker:" in compose
    assert "prefect-server:" in compose
    proto = (runtime_root / "grpc/legal_classification.proto").read_text(encoding="utf-8")
    assert "service LegalClassificationService" in proto
    assert "rpc Classify" in proto


def test_runtime_auth_and_openapi_security():
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        dashboard = client.get("/dashboard")
        assert dashboard.status_code == 200
        assert "Content-Security-Policy" in dashboard.headers
        assert ".innerHTML" not in dashboard.text
        assert "textContent" in dashboard.text
        unauthorized = client.get("/metadata")
        assert unauthorized.status_code == 401
        assert unauthorized.headers["www-authenticate"] == "Bearer"
        openapi = client.get("/openapi.json").json()
        assert "RuntimeBearer" in openapi["components"]["securitySchemes"]
    with TestClient(app, headers=AUTH_HEADERS) as client:
        assert client.get("/metadata").status_code == 200


def test_contract_endpoints():
    with TestClient(app, headers=AUTH_HEADERS) as client:
        assert client.get("/health").status_code == 200
        metadata = client.get("/metadata").json()
        assert metadata["contract"] == "mlops-flow-v1"
        gpu_environment = client.get("/environment/gpu")
        assert gpu_environment.status_code == 200
        gpu_body = gpu_environment.json()
        assert gpu_body["status"] == "ok"
        assert "torchCudaAvailable" in gpu_body["summary"]
        assert client.get("/models/active").status_code == 200
        assert client.get("/metrics/model").status_code == 200
        assert client.get("/metrics/runtime").status_code == 200
        response = client.post("/predict", json={"input": {"text": "exemplo", "email": "pessoa@example.com"}})
        assert response.status_code == 200
        body = response.json()
        assert "model_version_id" in body
        assert "run_id" in body
        assert body["inference_source"] in {"artifact", "synthetic"}
        assert body["cache"]["hit"] is False
        cached_response = client.post("/predict", json={"input": {"text": "exemplo", "email": "pessoa@example.com"}})
        assert cached_response.status_code == 200
        assert cached_response.json()["cache"]["hit"] is True
        embedding_profiles = client.get("/embeddings/profiles")
        assert embedding_profiles.status_code == 200
        assert "profiles" in embedding_profiles.json()
        if project.get("domain", {}).get("kind") == "legal_classification":
            assert body["explanation"]["kind"] == "legal_classification"
            assert body["explanation"]["category"]["code"] in project["problem"]["classes"]
            assert body["explanation"]["decisionPolicy"]["version"]
            assert isinstance(body["explanation"]["topCandidates"], list)
            assert body["review"]["status"] in {"accepted", "review", "blocked"}
            assert body["decision"]["humanReviewRequired"] == body["review"]["humanReviewRequired"]
            if project.get("domain", {}).get("legal", {}).get("embeddingProfiles"):
                assert body["embedding_profile"]["id"]
            legal_domain = client.get("/domain/legal")
            assert legal_domain.status_code == 200
            legal_body = legal_domain.json()
            legal_manifest = project["domain"]["legal"]
            assert legal_body["kind"] == "legal_classification"
            assert legal_body["counts"]["categories"] >= len(legal_manifest.get("categories", []))
            assert legal_body["counts"]["workflow_steps"] >= len(legal_manifest.get("workflowSteps", []))
            assert legal_body["counts"]["embedding_profiles"] >= len(legal_manifest.get("embeddingProfiles", []))
            assert legal_body["counts"]["documents"] >= 1
            assert legal_body["counts"]["andamentos"] >= 1
            profile_body = embedding_profiles.json()
            assert profile_body["activeProfileId"] == legal_manifest["embeddingProfiles"][0]["id"]
            embedding_search = client.post("/embeddings/search", json={"query": "sentença recurso apelação", "collection": "categories", "top_k": 3})
            assert embedding_search.status_code == 200
            search_body = embedding_search.json()
            assert search_body["status"] == "ok"
            assert search_body["profileId"] == profile_body["activeProfileId"]
            assert len(search_body["results"]) >= 1
            reindex = client.post("/embeddings/reindex", json={"confirm": True, "requested_by": "pytest", "reason": "validar contrato de reindexação"})
            assert reindex.status_code == 200
            assert reindex.json()["status"] == "queued"
            new_profile_id = "pytest-embedding-" + body["run_id"][:8]
            embedding_register_without_confirm = client.post("/embeddings/profiles/register", json={"profile_id": new_profile_id})
            assert embedding_register_without_confirm.status_code == 409
            embedding_register = client.post(
                "/embeddings/profiles/register",
                json={
                    "confirm": True,
                    "profile_id": new_profile_id,
                    "provider": "sentence-transformers",
                    "model_name": "BAAI/bge-m3",
                    "model_version": "pytest-v2",
                    "dimension": 1024,
                    "similarity_metric": "cosine",
                    "preprocessing_version": "legal-preprocess-v1",
                    "chunking_version": "legal-chunking-v2",
                    "vector_collections": {"categories": new_profile_id + "-categories", "workflowSteps": new_profile_id + "-workflow"},
                    "metadata": {"normalization": "l2", "source": "contract_test"},
                    "requested_by": "pytest",
                },
            )
            assert embedding_register.status_code == 200
            assert embedding_register.json()["profile"]["id"] == new_profile_id
            activate_without_confirm = client.post(f"/embeddings/profiles/{new_profile_id}/activate", json={"requested_by": "pytest"})
            assert activate_without_confirm.status_code == 409
            activate_embedding = client.post(f"/embeddings/profiles/{new_profile_id}/activate", json={"confirm": True, "requested_by": "pytest", "reason": "validar troca versionada"})
            assert activate_embedding.status_code == 200
            assert activate_embedding.json()["profile"]["status"] == "active"
            profile_after_activation = client.get("/embeddings/profiles").json()
            assert profile_after_activation["activeProfileId"] == new_profile_id
            embedding_search_after_activation = client.post("/embeddings/search", json={"query": "sentença recurso apelação", "collection": "categories", "top_k": 3})
            assert embedding_search_after_activation.status_code == 200
            assert embedding_search_after_activation.json()["profileId"] == new_profile_id
            reindex_active = client.post("/embeddings/reindex", json={"confirm": True, "requested_by": "pytest", "reason": "validar reindexação do profile ativo"})
            assert reindex_active.status_code == 200
            assert reindex_active.json()["profileId"] == new_profile_id
            with engine.connect() as connection:
                stored_embedding_event = connection.execute(select(app_events.c.event_type).where(app_events.c.event_type == "embedding_profile_activated").order_by(app_events.c.id.desc()).limit(1)).scalar_one_or_none()
            assert stored_embedding_event == "embedding_profile_activated"
        with engine.connect() as connection:
            stored_prediction_run = connection.execute(
                select(prediction_runs.c.id).where(prediction_runs.c.id == body["run_id"])
            ).scalar_one_or_none()
            stored_prediction_row = connection.execute(
                select(prediction_rows).where(prediction_rows.c.run_id == body["run_id"])
            ).mappings().first()
            stored_prediction_event = connection.execute(
                select(app_events.c.event_type).where(app_events.c.event_type == "prediction_completed").order_by(app_events.c.id.desc()).limit(1)
            ).scalar_one_or_none()
        assert stored_prediction_run == body["run_id"]
        assert stored_prediction_row is not None
        assert stored_prediction_row["input_digest"]
        expected_email = "***" if "email" in project.get("sensitiveFields", []) else "pessoa@example.com"
        assert stored_prediction_row["input_masked"]["email"] == expected_email
        assert stored_prediction_row["output"]["model_version_id"] == body["model_version_id"]
        assert stored_prediction_event == "prediction_completed"
        if latest_training_result:
            models = client.get("/models").json()["models"]
            rollout_candidate = next((item["id"] for item in models if item["id"] != body["model_version_id"]), models[0]["id"])
            deployment_before = client.get("/deployment/status")
            assert deployment_before.status_code == 200
            shadow = client.post("/deployment/shadow", json={"confirm": True, "model_id": rollout_candidate, "requested_by": "pytest", "reason": "validar shadow"})
            assert shadow.status_code == 200
            assert shadow.json()["rollout"]["kind"] == "shadow"
            shadow_prediction = client.post("/predict", json={"input": {"text": "exemplo shadow", "email": "shadow@example.com"}})
            assert shadow_prediction.status_code == 200
            shadow_body = shadow_prediction.json()
            assert shadow_body["deployment"]["mode"] == "shadow"
            assert "shadow_prediction" in shadow_body
            canary = client.post("/deployment/canary", json={"confirm": True, "model_id": rollout_candidate, "traffic_percent": 100, "requested_by": "pytest", "reason": "validar canary"})
            assert canary.status_code == 409
            canary = client.post("/deployment/canary", json={"confirm": True, "model_id": rollout_candidate, "traffic_percent": 50, "requested_by": "pytest", "reason": "validar canary"})
            assert canary.status_code == 200
            assert canary.json()["rollout"]["kind"] == "canary"
            canary_prediction = client.post("/predict", json={"input": {"text": "exemplo canary", "email": "canary@example.com"}})
            assert canary_prediction.status_code == 200
            assert canary_prediction.json()["deployment"]["mode"] == "canary"
            if rollout_candidate != body["model_version_id"]:
                ab_without_confirm = client.post("/experiments/ab-tests", json={"candidate_model_id": rollout_candidate, "traffic_split_percent": 50, "requested_by": "pytest"})
                assert ab_without_confirm.status_code == 409
                ab_start = client.post(
                    "/experiments/ab-tests",
                    json={
                        "confirm": True,
                        "baseline_model_id": body["model_version_id"],
                        "candidate_model_id": rollout_candidate,
                        "traffic_split_percent": 50,
                        "primary_metric": project.get("metrics", {}).get("primary", "f1_macro"),
                        "requested_by": "pytest",
                        "reason": "validar experimento A/B",
                        "guardrails": {"min_sample_size": 10, "max_error_rate": 0.01},
                    },
                )
                assert ab_start.status_code == 200
                ab_body = ab_start.json()
                experiment_id = ab_body["experiment"]["id"]
                assert ab_body["experiment"]["status"] == "active"
                assert ab_body["experiment"]["baseline_model_id"] == body["model_version_id"]
                assert ab_body["experiment"]["candidate_model_id"] == rollout_candidate
                assert ab_body["experiment"]["traffic_split_percent"] == 50
                ab_status = client.get("/experiments/ab-tests")
                assert ab_status.status_code == 200
                assert ab_status.json()["active_count"] >= 1
                assert client.get("/experiments/ab-tests/latest").json()["id"] == experiment_id
                ab_complete = client.post(
                    f"/experiments/ab-tests/{experiment_id}/complete",
                    json={"confirm": True, "winner_model_id": body["model_version_id"], "completed_by": "pytest", "metrics": {"f1_macro": 0.91}},
                )
                assert ab_complete.status_code == 200
                assert ab_complete.json()["experiment"]["status"] == "completed"
                assert ab_complete.json()["experiment"]["winner_model_id"] == body["model_version_id"]
                with engine.connect() as connection:
                    stored_ab = connection.execute(select(ab_experiments).where(ab_experiments.c.id == experiment_id)).mappings().first()
                    stored_ab_snapshot = connection.execute(select(metric_snapshots.c.id).where(metric_snapshots.c.id == f"{experiment_id}-metrics")).scalar_one_or_none()
                    stored_ab_event = connection.execute(select(app_events.c.event_type).where(app_events.c.event_type == "ab_test_completed").order_by(app_events.c.id.desc()).limit(1)).scalar_one_or_none()
                assert stored_ab is not None
                assert stored_ab["status"] == "completed"
                assert stored_ab_snapshot == f"{experiment_id}-metrics"
                assert stored_ab_event == "ab_test_completed"
            rollback = client.post("/deployment/rollback", json={"confirm": True, "requested_by": "pytest", "reason": "validar rollback"})
            assert rollback.status_code == 200
            assert rollback.json()["rollout"]["kind"] == "rollback"
            assert client.get("/deployment/status").json()["mode"] == "active"
            with engine.connect() as connection:
                rollout_count = len(connection.execute(select(deployment_rollouts.c.id)).fetchall())
            assert rollout_count >= 3
        feedback = client.post("/feedback", json={"run_id": body["run_id"], "actual_label": body["prediction"], "source": "pytest"})
        assert feedback.status_code == 200
        feedback_body = feedback.json()
        assert feedback_body["run_id"] == body["run_id"]
        assert feedback_body["correct"] is True
        feedback_summary = client.get("/feedback/summary")
        assert feedback_summary.status_code == 200
        feedback_summary_body = feedback_summary.json()
        assert feedback_summary_body["feedback_count"] >= 1
        assert feedback_summary_body["feedback_accuracy"] == 1.0
        with engine.connect() as connection:
            stored_feedback = connection.execute(
                select(prediction_feedback).where(prediction_feedback.c.id == feedback_body["feedback_id"])
            ).mappings().first()
            stored_feedback_snapshot = connection.execute(
                select(metric_snapshots.c.id).where(metric_snapshots.c.id == f"{feedback_body['feedback_id']}-metrics")
            ).scalar_one_or_none()
            stored_feedback_event = connection.execute(
                select(app_events.c.event_type).where(app_events.c.event_type == "prediction_feedback_recorded").order_by(app_events.c.id.desc()).limit(1)
            ).scalar_one_or_none()
        assert stored_feedback is not None
        assert stored_feedback["actual_label"] == body["prediction"]
        assert stored_feedback_snapshot == f"{feedback_body['feedback_id']}-metrics"
        assert stored_feedback_event == "prediction_feedback_recorded"
        retraining_request = client.post("/retraining/requests", json={"min_feedback_count": 1, "requested_by": "pytest", "reason": "validar retreino controlado"})
        assert retraining_request.status_code == 200
        retraining_body = retraining_request.json()
        assert retraining_body["status"] == "pending_review"
        assert retraining_body["feedback_count"] >= 1
        retraining_status = client.get("/retraining/status")
        assert retraining_status.status_code == 200
        assert retraining_status.json()["pending_count"] >= 1
        approval = client.post(f"/retraining/requests/{retraining_body['request_id']}/approve", json={"confirm": True, "approved_by": "pytest"})
        assert approval.status_code == 200
        approval_body = approval.json()
        assert approval_body["status"] == "approved_pending_runner"
        training_set = client.get(f"/retraining/requests/{retraining_body['request_id']}/training-set")
        assert training_set.status_code == 200
        training_set_body = training_set.json()
        assert training_set_body["row_count"] >= 1
        assert training_set_body["target"] in training_set_body["rows"][0]
        assert training_set_body["rows"][0][training_set_body["target"]] == body["prediction"]
        completion = client.post(
            f"/retraining/requests/{retraining_body['request_id']}/complete",
            json={"confirm": True, "completed_by": "pytest", "success": True, "job_id": "job-pytest", "training_run_id": "train-pytest", "model_id": body["model_version_id"], "metrics": {"feedback_rows": training_set_body["row_count"]}},
        )
        assert completion.status_code == 200
        completion_body = completion.json()
        assert completion_body["status"] == "completed"
        with engine.connect() as connection:
            stored_retraining = connection.execute(
                select(retraining_requests).where(retraining_requests.c.id == retraining_body["request_id"])
            ).mappings().first()
            stored_retraining_event = connection.execute(
                select(app_events.c.event_type).where(app_events.c.event_type == "retraining_completed").order_by(app_events.c.id.desc()).limit(1)
            ).scalar_one_or_none()
        assert stored_retraining is not None
        assert stored_retraining["status"] == "completed"
        assert stored_retraining["completed_at"] is not None
        assert stored_retraining_event == "retraining_completed"
        target = project["problem"]["target"]
        if project["problem"]["type"] == "regression":
            record = {"feature": 1.0, target: 1.0}
        else:
            label = (project["problem"].get("classes") or ["classe_a"])[0]
            record = {"text": f"exemplo {label}", target: label}
        evaluation = client.post("/evaluate", json={"records": [record]})
        assert evaluation.status_code == 200
        evaluation_body = evaluation.json()
        assert evaluation_body["status"] == "ok"
        assert "evaluation_id" in evaluation_body
        if project["problem"]["type"] != "regression":
            for metric_name in ["top_3_accuracy", "top_5_accuracy", "brier_score", "expected_calibration_error", "roc_auc_ovr", "pr_auc_macro", "low_confidence_rate", "human_review_rate", "invalid_workflow_transition_rate"]:
                assert metric_name in evaluation_body["metrics"]
        with engine.connect() as connection:
            stored_evaluation_id = connection.execute(
                select(evaluation_runs.c.id).where(evaluation_runs.c.id == evaluation_body["evaluation_id"])
            ).scalar_one_or_none()
            stored_snapshot_id = connection.execute(
                select(metric_snapshots.c.id).where(metric_snapshots.c.id == f"{evaluation_body['evaluation_id']}-metrics")
            ).scalar_one_or_none()
        assert stored_evaluation_id == evaluation_body["evaluation_id"]
        assert stored_snapshot_id == f"{evaluation_body['evaluation_id']}-metrics"
        backtest = client.post("/backtest", json={"records": [record], "neutral_band": 0.001})
        assert backtest.status_code == 200
        backtest_body = backtest.json()
        assert backtest_body["status"] == "ok"
        assert "backtest_id" in backtest_body
        assert "baseline_model_id" in backtest_body
        assert isinstance(backtest_body["evidence"], list)
        assert any(item["color"] in {"green", "red", "neutral"} for item in backtest_body["evidence"])
        with engine.connect() as connection:
            stored_backtest_id = connection.execute(
                select(evaluation_runs.c.id).where(evaluation_runs.c.id == backtest_body["backtest_id"])
            ).scalar_one_or_none()
        assert stored_backtest_id == backtest_body["backtest_id"]
        drift = client.post(
            "/drift",
            json={
                "reference_records": [{"text": "normal", "priority": "baixa", "amount": 10}],
                "current_records": [{"text": "normal", "priority": "baixa", "amount": 11}],
            },
        )
        assert drift.status_code == 200
        drift_body = drift.json()
        assert "drift_id" in drift_body
        assert "drift_score" in drift_body
        latest_drift = client.get("/drift/latest")
        assert latest_drift.status_code == 200
        assert latest_drift.json()["id"] == drift_body["drift_id"]
        runtime_metrics = client.get("/metrics/runtime").json()
        assert runtime_metrics["drift_count"] >= 1
        assert runtime_metrics["feedback_count"] >= 1
        assert runtime_metrics["feedback_accuracy"] == 1.0
        assert runtime_metrics["retraining_pending_count"] >= 0
        with engine.connect() as connection:
            stored_drift_id = connection.execute(
                select(drift_runs.c.id).where(drift_runs.c.id == drift_body["drift_id"])
            ).scalar_one_or_none()
        assert stored_drift_id == drift_body["drift_id"]
        alert_drift = client.post(
            "/drift",
            json={
                "reference_records": [{"amount": 10}, {"amount": 10}],
                "current_records": [{"amount": 1000}, {"amount": 1000}],
                "warning_threshold": 0.2,
                "alert_threshold": 0.5,
                "requested_by": "pytest",
            },
        )
        assert alert_drift.status_code == 200
        alert_body = alert_drift.json()
        assert alert_body["status"] == "alert"
        assert alert_body["auto_retraining"]["triggered"] is True
        auto_request_id = alert_body["auto_retraining"]["request"]["request_id"]
        with engine.connect() as connection:
            stored_auto_retraining = connection.execute(select(retraining_requests).where(retraining_requests.c.id == auto_request_id)).mappings().first()
            stored_auto_retraining_event = connection.execute(select(app_events.c.event_type).where(app_events.c.event_type == "drift_retraining_requested").order_by(app_events.c.id.desc()).limit(1)).scalar_one_or_none()
        assert stored_auto_retraining is not None
        assert stored_auto_retraining["trigger"] == "drift_alert"
        assert stored_auto_retraining_event == "drift_retraining_requested"
        registered_model_id = "pytest_registered_model_" + body["run_id"][:8]
        register_without_confirm = client.post("/models/register", json={"model_id": registered_model_id, "algorithm": "external_xgboost"})
        assert register_without_confirm.status_code == 409
        registered = client.post(
            "/models/register",
            json={
                "confirm": True,
                "model_id": registered_model_id,
                "algorithm": "external_xgboost",
                "artifact_uri": "registry://pytest/registered-model",
                "metrics": {"f1_macro": 0.93},
                "requested_by": "pytest",
            },
        )
        assert registered.status_code == 200
        assert registered.json()["model"]["id"] == registered_model_id
        model_detail = client.get(f"/models/{registered_model_id}")
        assert model_detail.status_code == 200
        assert model_detail.json()["registered"] is True
        promote_without_confirm = client.post(f"/models/{registered_model_id}/promote", json={"approved_by": "pytest"})
        assert promote_without_confirm.status_code == 409
        promoted = client.post(
            f"/models/{registered_model_id}/promote",
            json={"confirm": True, "approved_by": "pytest", "evidence": {"source": "contract_test", "f1_macro": 0.93}},
        )
        assert promoted.status_code == 200
        assert promoted.json()["model"]["is_active"] is True
        assert client.get("/models/active").json()["id"] == registered_model_id
        with engine.connect() as connection:
            stored_model = connection.execute(select(model_versions).where(model_versions.c.id == registered_model_id)).mappings().first()
            stored_promotion = connection.execute(select(promotion_decisions).where(promotion_decisions.c.candidate_model_id == registered_model_id)).mappings().first()
            stored_promotion_event = connection.execute(select(app_events.c.event_type).where(app_events.c.event_type == "model_promoted").order_by(app_events.c.id.desc()).limit(1)).scalar_one_or_none()
        assert stored_model is not None
        assert stored_model["is_active"] is True
        assert stored_promotion is not None
        assert stored_promotion_event == "model_promoted"


def test_operational_training_metadata_seeded():
    if not latest_training_result:
        return
    with TestClient(app, headers=AUTH_HEADERS) as client:
        client.get("/health")
        with engine.connect() as connection:
            stored_run_id = connection.execute(
                select(training_runs.c.id).where(training_runs.c.id == latest_training_result["runId"])
            ).scalar_one_or_none()
            model_count = len(connection.execute(select(model_versions.c.id)).fetchall())
    assert stored_run_id == latest_training_result["runId"]
    assert model_count >= 1


def test_sentence_transformers_artifact_loader(monkeypatch):
    artifact = {
        "type": "sentence_transformers_text_classifier",
        "format": "pickle_base64",
        "modelBase64": base64.b64encode(pickle.dumps(FakeEmbeddingEstimator())).decode("ascii"),
        "embeddingModel": "fake-bert",
        "normalizeEmbeddings": True,
        "classes": ["classe_a", "classe_b"],
    }
    monkeypatch.setattr(runtime_module, "load_sentence_transformer_model", lambda _name: FakeSentenceTransformer())
    result = runtime_module.predict_from_artifact(
        artifact,
        {"text": "classe_a boleto"},
        project["problem"],
        [],
        {"id": "embedding_model"},
    )
    assert result is not None
    assert result["prediction"] == "classe_a"
    assert result["confidence"] == 0.91
    assert result["inference_source"] == "artifact"
`;
}
