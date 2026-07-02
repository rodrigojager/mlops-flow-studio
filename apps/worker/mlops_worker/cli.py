from __future__ import annotations

import ast
import base64
import csv
import hashlib
import io
import json
import math
import os
import pickle
import re
import sqlite3
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from calendar import monthrange
from collections import Counter, defaultdict
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, time as datetime_time, timezone
from importlib.util import find_spec
from pathlib import Path
from typing import Any
from uuid import uuid4


class WorkerError(Exception):
    pass


BACKTEST_WINDOW_GRANULARITIES = {"none", "day", "week", "month", "rolling_7d", "rolling_30d"}
BACKTEST_WINDOW_GRANULARITY_MESSAGE = "none, day, week, month, rolling_7d ou rolling_30d"
DATASET_SNAPSHOT_MODES = {"manifest", "masked_rows", "full_rows"}


SAFE_PYTHON_BLOCK_IMPORTS = {
    "collections",
    "datetime",
    "decimal",
    "functools",
    "itertools",
    "json",
    "math",
    "random",
    "re",
    "statistics",
    "time",
    "typing",
}

BLOCKED_PYTHON_BLOCK_IMPORT_PREFIXES = {
    "builtins",
    "httpx",
    "importlib",
    "os",
    "pathlib",
    "pickle",
    "requests",
    "shutil",
    "socket",
    "sqlite3",
    "subprocess",
    "sys",
    "urllib",
}

BLOCKED_PYTHON_BLOCK_CALLS = {"__import__", "compile", "eval", "exec", "input", "open"}


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "--python-block-child":
        python_block_child_main()
        return
    request: dict[str, Any] = {}
    try:
        request = json.load(sys.stdin)
        result = handle_request(request)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as exc:
        emit_worker_event(request, "command_failed", str(exc), level="error", error=exc.__class__.__name__)
        print(
            json.dumps(
                {
                    "status": "error",
                    "error": exc.__class__.__name__,
                    "message": str(exc),
                    "traceback": traceback.format_exc(limit=12),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        raise SystemExit(1) from exc


def handle_request(request: dict[str, Any]) -> dict[str, Any]:
    command = request.get("command")
    emit_worker_event(request, "command_started", f"Worker iniciou {command}.", command=command)
    if command == "run-python-block":
        result = run_python_block(request)
        emit_worker_event(request, "command_completed", f"Worker concluiu {command}.", command=command, status=result.get("status"), kind=result.get("kind"))
        return result
    if command == "preview-source":
        result = preview_source(request)
        emit_worker_event(request, "command_completed", f"Worker concluiu {command}.", command=command, status=result.get("status"), kind=result.get("kind"))
        return result
    if command == "train-baseline":
        result = train_baseline_from_any_source(request)
        emit_worker_event(request, "command_completed", f"Worker concluiu {command}.", command=command, status=result.get("status"), kind=result.get("kind"))
        return result
    if command == "evaluate-model":
        result = evaluate_model(request)
        emit_worker_event(request, "command_completed", f"Worker concluiu {command}.", command=command, status=result.get("status"), kind=result.get("kind"))
        return result
    if command == "backtest-models":
        result = backtest_models(request)
        emit_worker_event(request, "command_completed", f"Worker concluiu {command}.", command=command, status=result.get("status"), kind=result.get("kind"))
        return result
    raise WorkerError(f"Comando desconhecido: {command}")


def run_python_block(request: dict[str, Any]) -> dict[str, Any]:
    project, pipeline, project_root = load_request_context(request)
    node_id = require_string(request, "nodeId")
    node = find_node(pipeline, node_id)
    if node.get("type") != "python_function":
        raise WorkerError(f"Nó {node_id} não é python_function.")
    python_block = node.get("python") or {}
    entrypoint = python_block.get("entrypoint") or "run"
    code = load_python_code(project_root, python_block)
    network_policy = python_block_network_policy(python_block)
    isolation_mode = python_block_isolation_mode(request, python_block)
    allowed_hosts = [str(item) for item in python_block.get("allowedHosts", []) if str(item).strip()]
    mocks = [item for item in python_block.get("mocks", []) if isinstance(item, dict)]
    try:
        code_audit = audit_python_block_code(code, network_policy)
    except WorkerError as exc:
        emit_worker_event(request, "python_block_policy_violation", str(exc), level="error", nodeId=node_id, networkPolicy=network_policy)
        raise
    emit_worker_event(
        request,
        "python_block_started",
        f"Executando bloco Python {node_id}.",
        nodeId=node_id,
        entrypoint=entrypoint,
        networkPolicy=network_policy,
        isolation=isolation_mode,
        allowedHosts=allowed_hosts,
        mocks=len(mocks),
        importCount=code_audit["importCount"],
    )

    started = time.perf_counter()
    input_payload = request.get("input") if isinstance(request.get("input"), dict) else {}
    context_payload = request.get("context") if isinstance(request.get("context"), dict) else {}
    context_payload = {
        **context_payload,
        "project": {"id": project.get("id"), "name": project.get("name"), "version": project.get("version")},
        "node": {"id": node.get("id"), "label": node.get("label"), "type": node.get("type")},
        "networkPolicy": network_policy,
        "allowedHosts": allowed_hosts,
    }
    child_payload = {
        "nodeId": node_id,
        "entrypoint": entrypoint,
        "code": code,
        "input": input_payload,
        "context": context_payload,
        "networkPolicy": network_policy,
        "allowedHosts": allowed_hosts,
        "mocks": mocks,
        "timeoutSeconds": python_block_timeout_seconds(request),
    }
    child_result = run_python_block_in_container(child_payload) if isolation_mode == "container" else run_python_block_in_subprocess(child_payload)
    network_calls = [item for item in child_result.get("networkCalls", []) if isinstance(item, dict)]
    emit_python_http_events(request, node_id, network_calls)
    if child_result.get("status") != "ok":
        message = str(child_result.get("message") or "Bloco Python falhou no subprocesso.")
        raise WorkerError(message)
    output = child_result.get("output")
    if not isinstance(output, dict):
        raise WorkerError(f"Função {entrypoint} deve retornar dict.")

    duration_ms = round((time.perf_counter() - started) * 1000, 3)
    emit_worker_event(request, "python_block_completed", f"Bloco Python {node_id} concluído.", nodeId=node_id, durationMs=duration_ms, outputKeys=sorted(output.keys()))
    return {
        "status": "ok",
        "kind": "python_block_result",
        "projectId": project.get("id"),
        "nodeId": node_id,
        "entrypoint": entrypoint,
        "networkPolicy": network_policy,
        "isolation": isolation_mode,
        "inputPreview": preview_value(input_payload),
        "output": output,
        "stdout": child_result.get("stdout") if isinstance(child_result.get("stdout"), list) else [],
        "stderr": child_result.get("stderr") if isinstance(child_result.get("stderr"), list) else [],
        "networkCalls": network_calls,
        "durationMs": duration_ms,
    }


def python_block_timeout_seconds(request: dict[str, Any]) -> int:
    raw_seconds = request.get("timeoutSeconds") or request.get("pythonTimeoutSeconds")
    if raw_seconds is None and isinstance(request.get("timeoutMs"), (int, float)):
        raw_seconds = float(request["timeoutMs"]) / 1000
    timeout = int(raw_seconds or 30)
    return max(1, min(timeout, 300))


def python_block_isolation_mode(request: dict[str, Any], python_block: dict[str, Any]) -> str:
    mode = str(request.get("isolationMode") or python_block.get("isolationMode") or python_block.get("isolation") or "process").strip().lower()
    if mode in {"subprocess", "process"}:
        return "process"
    if mode == "container":
        return "container"
    raise WorkerError("isolationMode deve ser process ou container.")


def python_block_network_policy(python_block: dict[str, Any]) -> str:
    policy = str(python_block.get("networkPolicy") or "none").strip().lower()
    if policy in {"none", "allowlist", "open"}:
        return policy
    raise WorkerError("networkPolicy deve ser none, allowlist ou open.")


def run_python_block_in_subprocess(payload: dict[str, Any]) -> dict[str, Any]:
    timeout_seconds = int(payload.get("timeoutSeconds") or 30)
    try:
        completed = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--python-block-child"],
            input=json.dumps(payload, ensure_ascii=False),
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
    except subprocess.TimeoutExpired as exc:
        return {
            "status": "error",
            "error": "TimeoutExpired",
            "message": f"Bloco Python excedeu timeout de {timeout_seconds}s no subprocesso.",
            "stdout": split_process_lines(exc.stdout),
            "stderr": split_process_lines(exc.stderr),
            "networkCalls": [],
        }

    stdout_text = completed.stdout or ""
    try:
        parsed = json.loads(stdout_text)
    except json.JSONDecodeError:
        return {
            "status": "error",
            "error": "InvalidChildOutput",
            "message": "Subprocesso do bloco Python não retornou JSON válido.",
            "stdout": stdout_text.splitlines(),
            "stderr": (completed.stderr or "").splitlines(),
            "networkCalls": [],
        }
    if not isinstance(parsed, dict):
        return {
            "status": "error",
            "error": "InvalidChildOutput",
            "message": "Subprocesso do bloco Python retornou payload inválido.",
            "stdout": stdout_text.splitlines(),
            "stderr": (completed.stderr or "").splitlines(),
            "networkCalls": [],
        }
    if completed.returncode != 0 and parsed.get("status") == "ok":
        return {
            **parsed,
            "status": "error",
            "error": "ChildProcessFailed",
            "message": f"Subprocesso do bloco Python terminou com código {completed.returncode}.",
        }
    return parsed


def run_python_block_in_container(payload: dict[str, Any]) -> dict[str, Any]:
    timeout_seconds = int(payload.get("timeoutSeconds") or 30)
    image = str(os.environ.get("MLOPS_PYTHON_BLOCK_CONTAINER_IMAGE") or "python:3.13-slim").strip()
    network_policy = str(payload.get("networkPolicy") or "none")
    docker_network = docker_network_for_python_block_policy(network_policy)
    workspace_root = Path(__file__).resolve().parents[3]
    docker_args = [
        "run",
        "--rm",
        "-i",
        "--network",
        docker_network,
        "--cpus",
        "1",
        "--memory",
        "512m",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "--security-opt",
        "no-new-privileges",
        "--cap-drop",
        "ALL",
        "-e",
        "PYTHONIOENCODING=utf-8",
        "-e",
        "PYTHONDONTWRITEBYTECODE=1",
        "-e",
        f"MLOPS_PYTHON_BLOCK_NETWORK_POLICY={network_policy}",
        "-v",
        f"{workspace_root}:/workspace:ro",
        image,
        "python",
        "/workspace/apps/worker/mlops_worker/cli.py",
        "--python-block-child",
    ]
    try:
        completed = subprocess.run(
            ["docker", *docker_args],
            input=json.dumps(payload, ensure_ascii=False),
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
    except FileNotFoundError:
        return {
            "status": "error",
            "error": "DockerUnavailable",
            "message": "Docker não está disponível para isolamento por container.",
            "stdout": [],
            "stderr": [],
            "networkCalls": [],
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "status": "error",
            "error": "TimeoutExpired",
            "message": f"Bloco Python excedeu timeout de {timeout_seconds}s no container.",
            "stdout": split_process_lines(exc.stdout),
            "stderr": split_process_lines(exc.stderr),
            "networkCalls": [],
        }

    stdout_text = completed.stdout or ""
    try:
        parsed = json.loads(stdout_text)
    except json.JSONDecodeError:
        return {
            "status": "error",
            "error": "ContainerFailed",
            "message": f"Container do bloco Python terminou com código {completed.returncode}.",
            "stdout": split_process_lines(completed.stdout),
            "stderr": split_process_lines(completed.stderr),
            "networkCalls": [],
        }
    if completed.returncode != 0 and parsed.get("status") == "ok":
        return {
            "status": "error",
            "error": "ContainerFailed",
            "message": f"Container do bloco Python terminou com código {completed.returncode}.",
            "stdout": split_process_lines(completed.stdout),
            "stderr": split_process_lines(completed.stderr),
            "networkCalls": [],
        }
    return parsed


def docker_network_for_python_block_policy(network_policy: str) -> str:
    if network_policy == "none":
        return "none"
    if network_policy in {"allowlist", "open"}:
        return str(os.environ.get("MLOPS_PYTHON_BLOCK_CONTAINER_NETWORK") or "bridge").strip() or "bridge"
    raise WorkerError("networkPolicy deve ser none, allowlist ou open.")


def split_process_lines(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace").splitlines()
    return str(value).splitlines()


def python_block_child_main() -> None:
    payload: dict[str, Any] = {}
    try:
        loaded = json.load(sys.stdin)
        if not isinstance(loaded, dict):
            raise WorkerError("Payload do subprocesso precisa ser objeto.")
        payload = loaded
        result = execute_python_block_child(payload)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(
            json.dumps(
                {
                    "status": "error",
                    "error": exc.__class__.__name__,
                    "message": str(exc),
                    "traceback": traceback.format_exc(limit=8),
                    "stdout": [],
                    "stderr": [],
                    "networkCalls": [],
                },
                ensure_ascii=False,
            )
        )
        raise SystemExit(1) from exc


def execute_python_block_child(payload: dict[str, Any]) -> dict[str, Any]:
    node_id = require_string(payload, "nodeId")
    entrypoint = require_string(payload, "entrypoint")
    code = require_string(payload, "code")
    network_policy = str(payload.get("networkPolicy") or "none")
    allowed_hosts = [str(item) for item in payload.get("allowedHosts", []) if str(item).strip()] if isinstance(payload.get("allowedHosts"), list) else []
    mocks = [item for item in payload.get("mocks", []) if isinstance(item, dict)] if isinstance(payload.get("mocks"), list) else []
    input_payload = payload.get("input") if isinstance(payload.get("input"), dict) else {}
    base_context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    http_client = PythonBlockHttpClient({}, node_id, network_policy, allowed_hosts, mocks)
    context_payload = {
        **base_context,
        "http": http_client,
        "http_request": http_client.request,
    }
    stdout_buffer = io.StringIO()
    stderr_buffer = io.StringIO()
    globals_dict = {"__builtins__": builtins_for_policy(network_policy)}
    locals_dict: dict[str, Any] = {}
    try:
        with redirect_stdout(stdout_buffer), redirect_stderr(stderr_buffer):
            exec(compile(code, f"<mlops-node:{node_id}>", "exec"), globals_dict, locals_dict)
            fn = locals_dict.get(entrypoint) or globals_dict.get(entrypoint)
            if not callable(fn):
                raise WorkerError(f"Função {entrypoint} não encontrada no bloco {node_id}.")
            output = fn(input_payload, context_payload)
    except Exception as exc:
        return {
            "status": "error",
            "error": exc.__class__.__name__,
            "message": str(exc),
            "traceback": traceback.format_exc(limit=8),
            "stdout": stdout_buffer.getvalue().splitlines(),
            "stderr": stderr_buffer.getvalue().splitlines(),
            "networkCalls": http_client.audit_log,
        }
    return {
        "status": "ok",
        "output": output,
        "stdout": stdout_buffer.getvalue().splitlines(),
        "stderr": stderr_buffer.getvalue().splitlines(),
        "networkCalls": http_client.audit_log,
    }


def preview_source(request: dict[str, Any]) -> dict[str, Any]:
    project, _pipeline, project_root = load_request_context(request)
    source_id = require_string(request, "sourceId")
    source = find_source(project, source_id)
    limit = int(request.get("limit") or 20)
    limit = max(1, min(limit, 200))
    preview_mode = str(request.get("mode") or "safe").lower()
    allow_external = request.get("allowExternal") is True or preview_mode == "real"
    emit_worker_event(request, "source_preview_started", f"Preparando preview de {source_id}.", sourceId=source_id, sourceType=source.get("type"), mode=preview_mode, limit=limit, allowExternal=allow_external)

    if source["type"] == "csv":
        csv_config = source.get("csv") or {}
        relative_path = csv_config.get("path")
        if not relative_path:
            raise WorkerError(f"Fonte CSV {source_id} não declara path.")
        csv_path = safe_resolve(project_root, relative_path)
        if not csv_path.exists():
            return {
                "status": "missing",
                "kind": "source_preview",
                "sourceId": source_id,
                "sourceType": "csv",
                "path": relative_path,
                "message": "Arquivo CSV ainda não existe.",
            }
        rows = read_csv_rows(csv_path, csv_config)
        result = source_preview_response(source, rows, limit)
        emit_source_preview_event(request, result)
        return result

    if source["type"] == "sql":
        mock_rows = request.get("mockRows")
        if isinstance(mock_rows, list):
            result = source_preview_response(source, normalize_rows(mock_rows), limit, mode="mock")
            emit_source_preview_event(request, result)
            return result
        sql_config = source.get("sql") or {}
        env_name = secret_env_name(sql_config.get("connectionRef", ""))
        database_url = os.getenv(env_name, "") if env_name else ""
        if not database_url:
            result = source_contract_response(source, "Preview SQL real exige connectionRef env resolvido.", connectionRef=sql_config.get("connectionRef"), query=sql_config.get("query"))
            emit_source_preview_event(request, result)
            return result
        if database_url.startswith("sqlite:///"):
            rows = preview_sqlite(database_url.removeprefix("sqlite:///"), sql_config.get("query", ""), limit)
            result = source_preview_response(source, rows, limit, mode="sqlite")
            emit_source_preview_event(request, result)
            return result
        if not allow_external:
            result = source_contract_response(source, "Preview SQL externo exige confirmação real.", connectionRef=sql_config.get("connectionRef"), query=sql_config.get("query"))
            emit_source_preview_event(request, result)
            return result
        if database_url.startswith(("postgresql://", "postgres://")):
            if find_spec("psycopg") is None:
                result = source_contract_response(source, "Preview PostgreSQL exige pacote psycopg instalado no Python do worker.", connectionRef=sql_config.get("connectionRef"), query=sql_config.get("query"))
                emit_source_preview_event(request, result)
                return result
            rows = preview_postgres(database_url, sql_config.get("query", ""), limit)
            result = source_preview_response(source, rows, limit, mode="postgres")
            emit_source_preview_event(request, result)
            return result
        result = source_contract_response(source, "Preview SQL real suporta sqlite:/// e PostgreSQL neste MVP.", connectionRef=sql_config.get("connectionRef"), query=sql_config.get("query"))
        emit_source_preview_event(request, result)
        return result

    if source["type"] == "api":
        mock_rows = request.get("mockRows")
        if isinstance(mock_rows, list):
            result = source_preview_response(source, normalize_rows(mock_rows), limit, mode="mock")
            emit_source_preview_event(request, result)
            return result
        api_config = source.get("api") or {}
        mocked = api_mock_preview(api_config, limit)
        if mocked and (preview_mode == "mock" or not allow_external):
            rows, details = mocked
            result = source_preview_response(source, rows, limit, mode="mock", extra=details)
            emit_source_preview_event(request, result)
            return result
        if not allow_external:
            result = source_contract_response(source, "Preview de API externa exige confirmação real para usar rede ou mock persistido.", method=api_config.get("method"), url=api_config.get("url"), mocksAvailable=api_mock_count(api_config))
            emit_source_preview_event(request, result)
            return result
        try:
            rows, details = preview_api(api_config, limit)
        except WorkerError as exc:
            result = source_contract_response(source, str(exc), method=api_config.get("method"), url=api_config.get("url"))
            emit_source_preview_event(request, result)
            return result
        result = source_preview_response(source, rows, limit, mode="api", extra=details)
        emit_source_preview_event(request, result)
        return result

    raise WorkerError(f"Tipo de fonte não suportado: {source.get('type')}")


def train_baseline_from_any_source(request: dict[str, Any]) -> dict[str, Any]:
    project, pipeline, project_root = load_request_context(request)
    source_id = request.get("sourceId") or first_trainable_source_id(project)
    if not source_id:
        raise WorkerError("Nenhuma fonte disponível para treino baseline.")
    source = find_source(project, str(source_id))
    training_mode = str(request.get("mode") or "safe").lower()
    allow_external = request.get("allowExternal") is True or training_mode == "real"
    max_rows = int(request.get("maxRows") or 10_000)
    max_rows = max(2, min(max_rows, 200_000))
    emit_worker_event(request, "training_started", f"Carregando dados de treino de {source_id}.", sourceId=source_id, sourceType=source.get("type"), mode=training_mode, maxRows=max_rows, allowExternal=allow_external)
    rows, source_mode, source_details = training_rows_from_source(source, project_root, request, max_rows, allow_external)

    target = project.get("problem", {}).get("target")
    if not target:
        raise WorkerError("Projeto não declara problem.target.")
    rows = [row for row in rows if str(row.get(target, "")).strip()]
    if len(rows) < 2:
        raise WorkerError("Treino baseline precisa de pelo menos 2 linhas com target.")
    emit_worker_event(request, "training_rows_loaded", f"{len(rows)} linha(s) prontas para treino.", sourceId=source_id, sourceMode=source_mode, rowCount=len(rows), target=target)

    problem_type = project.get("problem", {}).get("type")
    run_id = f"train-{int(time.time())}-{uuid4().hex[:8]}"
    dataset_artifact = write_dataset_version(project_root, run_id, project, source, source_mode, source_details, rows, target, request)
    row_artifact = dataset_artifact.get("rowArtifact") if isinstance(dataset_artifact.get("rowArtifact"), dict) else None
    if row_artifact and row_artifact.get("available"):
        emit_worker_event(
            request,
            "dataset_rows_snapshot_persisted",
            f"Snapshot replayável do dataset gravado em modo {row_artifact.get('mode')}.",
            runId=run_id,
            datasetVersionId=dataset_artifact.get("datasetVersionId"),
            rowArtifactPath=row_artifact.get("path"),
            rowArtifactMode=row_artifact.get("mode"),
            rowCount=row_artifact.get("rowCount"),
        )
    incremental_context = incremental_training_context(request, project_root)
    if incremental_context:
        emit_worker_event(
            request,
            "incremental_training_started",
            f"Retreino incremental usando base {incremental_context['baseRunId']}.",
            runId=run_id,
            baseRunId=incremental_context["baseRunId"],
            updateRows=len(rows),
        )
    model_nodes = [node for node in pipeline.get("nodes", []) if node.get("type") == "model"]
    if not model_nodes:
        model_nodes = [{"id": "standard_baseline", "label": "Standard baseline", "algorithm": "standard_baseline", "modelRole": "active"}]
    model_nodes = enrich_model_nodes_with_embedding_config(pipeline, model_nodes)

    if problem_type == "regression":
        leaderboard, artifacts = train_regression_baselines(project, project_root, rows, target, model_nodes, run_id, request, incremental_context)
    else:
        leaderboard, artifacts = train_classification_baselines(project, project_root, rows, target, model_nodes, run_id, request, incremental_context)

    primary_metric = project.get("metrics", {}).get("primary")
    leaderboard = sort_leaderboard(leaderboard, primary_metric, problem_type)
    best = choose_best_model(leaderboard, primary_metric, problem_type)
    emit_worker_event(request, "training_best_model", f"Melhor modelo: {best.get('modelId')}.", runId=run_id, bestModelId=best.get("modelId"), primaryMetric=primary_metric, primaryMetricValue=best.get("metrics", {}).get(primary_metric) if primary_metric else None)
    evidence = promotion_evidence(project, best.get("metrics", {}))
    result = {
        "status": "ok",
        "kind": "training_result",
        "runId": run_id,
        "projectId": project.get("id"),
        "sourceId": source_id,
        "sourceType": source.get("type"),
        "sourceMode": source_mode,
        "problemType": problem_type,
        "rowCount": len(rows),
        "target": target,
        "primaryMetric": primary_metric,
        "bestModelId": best.get("modelId"),
        "leaderboard": leaderboard,
        "promotionEvidence": evidence,
        "artifacts": [*artifacts, dataset_artifact],
        "datasetVersion": dataset_artifact,
        "trainingMode": "incremental" if incremental_context else "full",
    }
    if incremental_context:
        result["baseRunId"] = incremental_context["baseRunId"]
        result["incremental"] = summarize_incremental_training(leaderboard, incremental_context["baseRunId"], len(rows))
    result["mlflow"] = maybe_log_mlflow(project, project_root, result)
    write_training_result(project_root, result)
    emit_worker_event(request, "training_result_persisted", f"Resultado de treino {run_id} persistido.", runId=run_id, artifactCount=len(artifacts), mlflowStatus=result.get("mlflow", {}).get("status") if isinstance(result.get("mlflow"), dict) else None)
    return result


def train_baseline(request: dict[str, Any]) -> dict[str, Any]:
    project, pipeline, project_root = load_request_context(request)
    source_id = request.get("sourceId") or first_csv_source_id(project)
    if not source_id:
        raise WorkerError("Nenhuma fonte CSV disponível para treino baseline.")
    source = find_source(project, str(source_id))
    if source.get("type") != "csv":
        raise WorkerError("Treino baseline inicial usa fonte CSV.")
    csv_config = source.get("csv") or {}
    csv_path = safe_resolve(project_root, csv_config.get("path", ""))
    if not csv_path.exists():
        raise WorkerError(f"Arquivo CSV não encontrado: {csv_config.get('path')}")

    rows = read_csv_rows(csv_path, csv_config)
    target = project.get("problem", {}).get("target")
    if not target:
        raise WorkerError("Projeto não declara problem.target.")
    rows = [row for row in rows if str(row.get(target, "")).strip()]
    if len(rows) < 2:
        raise WorkerError("Treino baseline precisa de pelo menos 2 linhas com target.")

    problem_type = project.get("problem", {}).get("type")
    run_id = f"train-{int(time.time())}-{uuid4().hex[:8]}"
    model_nodes = [node for node in pipeline.get("nodes", []) if node.get("type") == "model"]
    if not model_nodes:
        model_nodes = [{"id": "standard_baseline", "label": "Standard baseline", "algorithm": "standard_baseline", "modelRole": "active"}]
    model_nodes = enrich_model_nodes_with_embedding_config(pipeline, model_nodes)

    if problem_type == "regression":
        leaderboard, artifacts = train_regression_baselines(project, project_root, rows, target, model_nodes, run_id)
    else:
        leaderboard, artifacts = train_classification_baselines(project, project_root, rows, target, model_nodes, run_id)

    primary_metric = project.get("metrics", {}).get("primary")
    leaderboard = sort_leaderboard(leaderboard, primary_metric, problem_type)
    best = choose_best_model(leaderboard, primary_metric, problem_type)
    evidence = promotion_evidence(project, best.get("metrics", {}))
    result = {
        "status": "ok",
        "kind": "training_result",
        "runId": run_id,
        "projectId": project.get("id"),
        "sourceId": source_id,
        "problemType": problem_type,
        "rowCount": len(rows),
        "target": target,
        "primaryMetric": primary_metric,
        "bestModelId": best.get("modelId"),
        "leaderboard": leaderboard,
        "promotionEvidence": evidence,
        "artifacts": artifacts,
    }
    result["mlflow"] = maybe_log_mlflow(project, project_root, result)
    write_training_result(project_root, result)
    return result


def evaluate_model(request: dict[str, Any]) -> dict[str, Any]:
    project, pipeline, project_root = load_request_context(request)
    source_id = request.get("sourceId") or first_trainable_source_id(project)
    if not source_id:
        raise WorkerError("Nenhuma fonte disponível para avaliação.")
    source = find_source(project, str(source_id))
    evaluation_mode = str(request.get("mode") or "safe").lower()
    allow_external = request.get("allowExternal") is True or evaluation_mode == "real"
    max_rows = int(request.get("maxRows") or 10_000)
    max_rows = max(2, min(max_rows, 200_000))
    emit_worker_event(request, "evaluation_started", f"Carregando dados de avaliação de {source_id}.", sourceId=source_id, sourceType=source.get("type"), mode=evaluation_mode, maxRows=max_rows, allowExternal=allow_external)
    rows, source_mode, _source_details = training_rows_from_source(source, project_root, request, max_rows, allow_external)

    target = project.get("problem", {}).get("target")
    if not target:
        raise WorkerError("Projeto não declara problem.target.")
    rows = [row for row in rows if str(row.get(target, "")).strip()]
    if len(rows) < 1:
        raise WorkerError("Avaliação precisa de pelo menos 1 linha com target.")

    run_id = str(request.get("runId") or latest_training_run_id(project_root) or "")
    model_id = str(request.get("modelId") or active_model_id(pipeline) or "")
    training_result = load_training_result(project_root, run_id) if run_id else latest_training_result(project_root)
    if not training_result:
        raise WorkerError("Avaliação exige um training-result.json persistido.")
    if not model_id:
        model_id = str(training_result.get("bestModelId") or "")
    problem_type = project.get("problem", {}).get("type")
    model_row = find_leaderboard_model(training_result, model_id)
    evaluated = evaluate_leaderboard_model(project, project_root, model_row, rows, target, problem_type, source.get("sensitiveFields", []))
    metrics = evaluated["metrics"]

    evaluation_id = f"eval-{int(time.time())}-{uuid4().hex[:8]}"
    primary_metric = project.get("metrics", {}).get("primary")
    result = {
        "status": "ok",
        "kind": "evaluation_result",
        "evaluationId": evaluation_id,
        "projectId": project.get("id"),
        "runId": training_result.get("runId"),
        "modelId": model_id,
        "sourceId": source_id,
        "sourceType": source.get("type"),
        "sourceMode": source_mode,
        "problemType": problem_type,
        "rowCount": len(rows),
        "target": target,
        "primaryMetric": primary_metric,
        "metrics": metrics,
        "artifactUri": evaluated["artifactUri"],
        "metricSnapshot": {
            "id": f"{evaluation_id}-metrics",
            "scope": "evaluation",
            "modelId": model_id,
            "runId": training_result.get("runId"),
            "metrics": numeric_metric_subset(metrics),
        },
        "sample": evaluated["sample"],
    }
    write_evaluation_result(project_root, result)
    emit_worker_event(request, "evaluation_completed", f"Avaliação {evaluation_id} concluída.", evaluationId=evaluation_id, modelId=model_id, rowCount=len(rows), primaryMetric=primary_metric, primaryMetricValue=metrics.get(primary_metric) if isinstance(metrics, dict) else None)
    return result


def backtest_models(request: dict[str, Any]) -> dict[str, Any]:
    project, _pipeline, project_root = load_request_context(request)
    source_id = request.get("sourceId") or first_trainable_source_id(project)
    if not source_id:
        raise WorkerError("Nenhuma fonte disponível para backtest.")
    source = find_source(project, str(source_id))
    backtest_mode = str(request.get("mode") or "safe").lower()
    allow_external = request.get("allowExternal") is True or backtest_mode == "real"
    max_rows = int(request.get("maxRows") or 10_000)
    max_rows = max(2, min(max_rows, 200_000))
    neutral_band = float(request.get("neutralBand") or 0)
    window_granularity = str(request.get("windowGranularity") or request.get("temporalGranularity") or "none").lower()
    emit_worker_event(request, "backtest_started", f"Carregando dados de backtest de {source_id}.", sourceId=source_id, sourceType=source.get("type"), mode=backtest_mode, maxRows=max_rows, allowExternal=allow_external)
    source_rows, source_mode, _source_details = training_rows_from_source(source, project_root, request, max_rows, allow_external)
    rows = source_rows
    temporal_window = temporal_window_from_request(request)
    comparison_window = comparison_window_from_request(request)
    comparison_rows: list[dict[str, Any]] = []
    if temporal_window:
        rows, temporal_window = filter_temporal_window(rows, temporal_window)
        emit_worker_event(
            request,
            "backtest_window_filtered",
            f"Janela temporal filtrou {temporal_window['matchedRows']} de {temporal_window['totalRows']} linha(s).",
            sourceId=source_id,
            timeColumn=temporal_window["timeColumn"],
            windowStart=temporal_window.get("start"),
            windowEnd=temporal_window.get("end"),
            totalRows=temporal_window["totalRows"],
            matchedRows=temporal_window["matchedRows"],
            excludedRows=temporal_window["excludedRows"],
        )
    if comparison_window:
        comparison_rows, comparison_window = filter_temporal_window(source_rows, comparison_window)
        emit_worker_event(
            request,
            "backtest_comparison_window_filtered",
            f"Janela de comparação filtrou {comparison_window['matchedRows']} de {comparison_window['totalRows']} linha(s).",
            sourceId=source_id,
            timeColumn=comparison_window["timeColumn"],
            comparisonWindowStart=comparison_window.get("start"),
            comparisonWindowEnd=comparison_window.get("end"),
            totalRows=comparison_window["totalRows"],
            matchedRows=comparison_window["matchedRows"],
            excludedRows=comparison_window["excludedRows"],
        )
    if window_granularity not in BACKTEST_WINDOW_GRANULARITIES:
        raise WorkerError(f"windowGranularity deve ser {BACKTEST_WINDOW_GRANULARITY_MESSAGE}.")
    if window_granularity != "none" and not temporal_window:
        raise WorkerError("Backtest multi-janela exige timeColumn.")

    target = project.get("problem", {}).get("target")
    if not target:
        raise WorkerError("Projeto não declara problem.target.")
    rows = [row for row in rows if str(row.get(target, "")).strip()]
    if len(rows) < 1:
        raise WorkerError("Backtest precisa de pelo menos 1 linha com target.")
    if comparison_window:
        comparison_rows = [row for row in comparison_rows if str(row.get(target, "")).strip()]
        if len(comparison_rows) < 1:
            raise WorkerError("Comparação de períodos precisa de pelo menos 1 linha com target na janela de referência.")

    run_id = str(request.get("runId") or latest_training_run_id(project_root) or "")
    training_result = load_training_result(project_root, run_id) if run_id else latest_training_result(project_root)
    if not training_result:
        raise WorkerError("Backtest exige um training-result.json persistido.")
    leaderboard = [row for row in training_result.get("leaderboard", []) if isinstance(row, dict) and row.get("artifactUri")]
    if not leaderboard:
        raise WorkerError("Backtest exige pelo menos um modelo com artifactUri no leaderboard.")

    requested_model_ids = request.get("modelIds")
    if isinstance(requested_model_ids, list) and requested_model_ids:
        requested = {str(item) for item in requested_model_ids if str(item).strip()}
        selected_models = [row for row in leaderboard if str(row.get("modelId")) in requested]
    else:
        selected_models = leaderboard
    if not selected_models:
        raise WorkerError("Nenhum modelo selecionado para backtest foi encontrado no treino.")

    baseline_model_id = str(request.get("baselineModelId") or request.get("baseline_model_id") or training_result.get("bestModelId") or selected_models[0].get("modelId") or "")
    if not any(str(row.get("modelId")) == baseline_model_id for row in selected_models):
        selected_models = [row for row in leaderboard if str(row.get("modelId")) == baseline_model_id] + selected_models
    baseline_row = next((row for row in selected_models if str(row.get("modelId")) == baseline_model_id), selected_models[0])
    baseline_model_id = str(baseline_row.get("modelId"))

    problem_type = project.get("problem", {}).get("type")
    primary_metric = project.get("metrics", {}).get("primary")
    model_metrics: dict[str, dict[str, Any]] = {}
    model_artifacts: dict[str, str] = {}
    model_samples: dict[str, list[dict[str, Any]]] = {}
    for model_row in selected_models:
        model_id = str(model_row.get("modelId"))
        evaluated = evaluate_leaderboard_model(project, project_root, model_row, rows, target, problem_type, source.get("sensitiveFields", []))
        model_metrics[model_id] = evaluated["metrics"]
        model_artifacts[model_id] = evaluated["artifactUri"]
        model_samples[model_id] = evaluated["sample"]
        emit_worker_event(request, "model_backtested", f"Modelo {model_id} avaliado no backtest.", modelId=model_id, primaryMetric=primary_metric, primaryMetricValue=numeric_metric_value(evaluated["metrics"], primary_metric))

    baseline_value = numeric_metric_value(model_metrics.get(baseline_model_id, {}), primary_metric)
    minimize = metric_should_minimize(primary_metric, problem_type)
    evidence = [
        model_comparison_evidence(str(model_row.get("modelId")), model_metrics.get(str(model_row.get("modelId")), {}), baseline_model_id, baseline_value, primary_metric, minimize, neutral_band)
        for model_row in selected_models
    ]
    candidate_evidence = [item for item in evidence if item["modelId"] != baseline_model_id]
    best_model_id = choose_best_backtest_model(model_metrics, primary_metric, minimize) or baseline_model_id
    recommended_evidence = next((item for item in evidence if item["modelId"] == best_model_id), None)
    if recommended_evidence and best_model_id != baseline_model_id and recommended_evidence["status"] == "pass":
        recommendation = "promote"
    elif candidate_evidence and all(item["status"] == "fail" for item in candidate_evidence):
        recommendation = "reject"
    else:
        recommendation = "review"

    backtest_id = f"backtest-{int(time.time())}-{uuid4().hex[:8]}"
    summary_metrics = summarize_backtest_metrics(model_metrics, primary_metric, baseline_model_id, best_model_id)
    period_comparison = None
    if comparison_window:
        current_window = temporal_window or {
            "timeColumn": comparison_window["timeColumn"],
            "start": None,
            "end": None,
            "totalRows": len(source_rows),
            "matchedRows": len(rows),
            "excludedRows": len(source_rows) - len(rows),
            "invalidRows": 0,
        }
        period_comparison = compare_backtest_periods(
            project,
            project_root,
            selected_models,
            comparison_rows,
            target,
            problem_type,
            primary_metric,
            baseline_model_id,
            minimize,
            neutral_band,
            source.get("sensitiveFields", []),
            current_window,
            comparison_window,
            model_metrics,
        )
        emit_worker_event(
            request,
            "backtest_period_compared",
            f"Backtest comparou período atual com {comparison_window['matchedRows']} linha(s) de referência.",
            backtestId=backtest_id,
            primaryMetric=primary_metric,
            comparisonRows=len(comparison_rows),
        )
    window_results = []
    if window_granularity != "none" and temporal_window:
        grouped_windows = group_rows_by_temporal_window(rows, temporal_window["timeColumn"], window_granularity)
        window_results = [
            evaluate_backtest_window(
                project,
                project_root,
                selected_models,
                window_rows,
                target,
                problem_type,
                primary_metric,
                baseline_model_id,
                minimize,
                neutral_band,
                source.get("sensitiveFields", []),
                window_meta,
            )
            for window_meta, window_rows in grouped_windows
        ]
    result = {
        "status": "ok",
        "kind": "backtest_result",
        "evaluationId": backtest_id,
        "backtestId": backtest_id,
        "projectId": project.get("id"),
        "runId": training_result.get("runId"),
        "modelId": baseline_model_id,
        "sourceId": source_id,
        "sourceType": source.get("type"),
        "sourceMode": source_mode,
        "problemType": problem_type,
        "rowCount": len(rows),
        "target": target,
        "primaryMetric": primary_metric,
        "metrics": summary_metrics,
        "artifactUri": None,
        "baselineModelId": baseline_model_id,
        "candidateModelIds": [str(row.get("modelId")) for row in selected_models if str(row.get("modelId")) != baseline_model_id],
        "recommendedModelId": best_model_id,
        "recommendation": recommendation,
        "neutralBand": neutral_band,
        "direction": "minimize" if minimize else "maximize",
        "temporalWindow": temporal_window,
        "windowGranularity": window_granularity,
        "windowResults": window_results,
        "modelMetrics": model_metrics,
        "modelArtifacts": model_artifacts,
        "evidence": evidence,
        "periodComparison": period_comparison,
        "metricSnapshot": {
            "id": f"{backtest_id}-metrics",
            "scope": "backtest",
            "modelId": baseline_model_id,
            "runId": training_result.get("runId"),
            "metrics": numeric_metric_subset(summary_metrics),
            "models": model_metrics,
            "evidence": evidence,
            "recommendation": recommendation,
            "recommendedModelId": best_model_id,
            "temporalWindow": temporal_window,
            "windowGranularity": window_granularity,
            "windowResults": window_results,
            "periodComparison": period_comparison,
        },
        "sample": backtest_sample(rows, target, model_samples, source.get("sensitiveFields", []) + project.get("sensitiveFields", [])),
    }
    write_evaluation_result(project_root, result)
    emit_worker_event(request, "backtest_completed", f"Backtest {backtest_id} concluído.", backtestId=backtest_id, baselineModelId=baseline_model_id, recommendedModelId=best_model_id, recommendation=recommendation, rowCount=len(rows), primaryMetric=primary_metric)
    return result


def train_classification_baselines(
    project: dict[str, Any],
    project_root: Path,
    rows: list[dict[str, Any]],
    target: str,
    model_nodes: list[dict[str, Any]],
    run_id: str,
    request: dict[str, Any] | None = None,
    incremental_context: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    train_rows, validation_rows = split_classification_rows(rows, target)
    labels = sorted(set(project.get("problem", {}).get("classes") or []) | {str(row[target]) for row in rows})
    leaderboard = []
    artifacts = []
    for node in model_nodes:
        if should_train_sentence_transformers_model(node) and sentence_transformers_available() and sklearn_available():
            row, artifact = train_sentence_transformers_classifier(project, project_root, train_rows, validation_rows, target, labels, node, run_id, incremental_context)
        elif should_train_xgboost_classifier(node) and xgboost_available() and sklearn_available():
            row, artifact = train_xgboost_text_classifier(project, project_root, train_rows, validation_rows, target, labels, node, run_id, incremental_context)
        elif should_train_sklearn_classifier(node) and sklearn_available():
            row, artifact = train_sklearn_text_classifier(project, project_root, train_rows, validation_rows, target, labels, node, run_id, incremental_context)
        else:
            row, artifact = train_stdlib_text_naive_bayes(project, project_root, train_rows, validation_rows, target, labels, node, run_id, incremental_context)
        if incremental_context and not isinstance(row.get("incremental"), dict):
            row["incremental"] = unsupported_incremental_metadata(str(row.get("trainingBackend") or row.get("trainedAlgorithm") or "backend"), incremental_context["baseRunId"])
        leaderboard.append(row)
        artifacts.append(artifact)
        emit_model_trained_event(request, run_id, row)
    return leaderboard, artifacts


def train_regression_baselines(
    project: dict[str, Any],
    project_root: Path,
    rows: list[dict[str, Any]],
    target: str,
    model_nodes: list[dict[str, Any]],
    run_id: str,
    request: dict[str, Any] | None = None,
    incremental_context: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    train_rows, validation_rows = split_sequential(rows)
    values = [float(row[target]) for row in train_rows]
    mean_value = sum(values) / len(values)
    actuals = [float(row[target]) for row in validation_rows]
    predictions = [mean_value for _row in validation_rows]
    metrics = regression_metrics(actuals, predictions)
    leaderboard = []
    artifacts = []
    for node in model_nodes:
        if should_train_sentence_transformers_model(node) and sentence_transformers_available() and sklearn_available():
            row, artifact = train_sentence_transformers_regressor(project, project_root, train_rows, validation_rows, target, node, run_id, incremental_context)
        elif should_train_xgboost_regressor(node) and xgboost_available() and sklearn_available():
            row, artifact = train_xgboost_regressor(project, project_root, train_rows, validation_rows, target, node, run_id, incremental_context)
        elif should_train_sklearn_regressor(node) and sklearn_available():
            row, artifact = train_sklearn_regressor(project, project_root, train_rows, validation_rows, target, node, run_id, incremental_context)
        else:
            model_id = str(node.get("id"))
            artifact = write_model_artifact(project_root, run_id, model_id, {"type": "mean_regressor", "mean": mean_value})
            row = {
                "modelId": model_id,
                "label": node.get("label") or model_id,
                "algorithm": node.get("algorithm") or "mean_regressor",
                "role": node.get("modelRole", "candidate"),
                "trainingBackend": "stdlib",
                "trainedAlgorithm": "mean_regressor",
                "metrics": metrics,
                "trainingRows": len(train_rows),
                "validationRows": len(validation_rows),
                "artifactUri": artifact["path"],
            }
        if incremental_context and not isinstance(row.get("incremental"), dict):
            row["incremental"] = unsupported_incremental_metadata(str(row.get("trainingBackend") or row.get("trainedAlgorithm") or "backend"), incremental_context["baseRunId"])
        leaderboard.append(row)
        artifacts.append(artifact)
        emit_model_trained_event(request, run_id, row)
    return leaderboard, artifacts


def train_stdlib_text_naive_bayes(
    project: dict[str, Any],
    project_root: Path,
    train_rows: list[dict[str, Any]],
    validation_rows: list[dict[str, Any]],
    target: str,
    labels: list[str],
    node: dict[str, Any],
    run_id: str,
    incremental_context: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    model_id = str(node.get("id"))
    update_model = fit_text_naive_bayes(train_rows, target, project.get("sensitiveFields", []))
    model = update_model
    incremental_metadata: dict[str, Any] | None = None
    if incremental_context:
        base_artifact_uri, base_artifact = compatible_previous_model_artifact(project_root, incremental_context["baseResult"], model_id, "standard_lib_text_naive_bayes")
        if base_artifact_uri and isinstance(base_artifact.get("model"), dict):
            model = merge_text_naive_bayes_models(base_artifact["model"], update_model)
            incremental_metadata = {
                "requested": True,
                "applied": True,
                "baseRunId": incremental_context["baseRunId"],
                "baseArtifactUri": base_artifact_uri,
                "updateRows": len(train_rows),
                "validationRows": len(validation_rows),
                "strategy": "merge_naive_bayes_counts",
            }
        else:
            incremental_metadata = {
                "requested": True,
                "applied": False,
                "baseRunId": incremental_context["baseRunId"],
                "updateRows": len(train_rows),
                "validationRows": len(validation_rows),
                "strategy": "full_retrain",
                "reason": "Artefato base compatível não encontrado para este modelo.",
            }
    predictions = [predict_text_naive_bayes(model, row, target, project.get("sensitiveFields", [])) for row in validation_rows]
    actuals = [str(row[target]) for row in validation_rows]
    metrics = classification_metrics(actuals, predictions, labels)
    payload = {"type": "standard_lib_text_naive_bayes", "model": model}
    if incremental_metadata:
        payload["incremental"] = incremental_metadata
    artifact = write_model_artifact(project_root, run_id, model_id, payload)
    trained_algorithm = "standard_lib_text_naive_bayes_incremental" if incremental_metadata and incremental_metadata.get("applied") else "standard_lib_text_naive_bayes"
    return (
        {
            "modelId": model_id,
            "label": node.get("label") or model_id,
            "algorithm": node.get("algorithm") or node.get("framework") or "standard_lib_text_naive_bayes",
            "role": node.get("modelRole", "candidate"),
            "trainingBackend": "stdlib",
            "trainedAlgorithm": trained_algorithm,
            "metrics": metrics,
            "trainingRows": len(train_rows),
            "validationRows": len(validation_rows),
            "artifactUri": artifact["path"],
            **({"incremental": incremental_metadata} if incremental_metadata else {}),
        },
        artifact,
    )


def train_sklearn_text_classifier(
    project: dict[str, Any],
    project_root: Path,
    train_rows: list[dict[str, Any]],
    validation_rows: list[dict[str, Any]],
    target: str,
    labels: list[str],
    node: dict[str, Any],
    run_id: str,
    incremental_context: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    from sklearn.feature_extraction.text import HashingVectorizer
    from sklearn.naive_bayes import MultinomialNB
    from sklearn.pipeline import Pipeline

    config = node.get("config") if isinstance(node.get("config"), dict) else {}
    n_features = int(config.get("nFeatures") or config.get("n_features") or 262144)
    n_features = max(1024, min(n_features, 1048576))
    alpha = float(config.get("alpha") or 1.0)
    train_texts = [text_from_row(row, target, project.get("sensitiveFields", [])) for row in train_rows]
    validation_texts = [text_from_row(row, target, project.get("sensitiveFields", [])) for row in validation_rows]
    model_id = str(node.get("id"))
    class_labels = sorted({str(item) for item in labels} | {str(row[target]) for row in train_rows + validation_rows})
    incremental_metadata: dict[str, Any] | None = None
    base_artifact_uri = None
    base_artifact: dict[str, Any] = {}
    if incremental_context:
        base_artifact_uri, base_artifact = compatible_previous_model_artifact(project_root, incremental_context["baseResult"], model_id, "sklearn_text_classifier")

    if base_artifact and base_artifact.get("incrementalCapable") is True and base_artifact.get("vectorizerBase64") and base_artifact.get("classifierBase64"):
        vectorizer = decode_pickle_base64(str(base_artifact.get("vectorizerBase64") or ""))
        classifier = decode_pickle_base64(str(base_artifact.get("classifierBase64") or ""))
        base_classes = {str(item) for item in base_artifact.get("classes", [])}
        class_labels = sorted(base_classes | set(class_labels))
        train_matrix = vectorizer.transform(train_texts)
        classifier.partial_fit(train_matrix, [str(row[target]) for row in train_rows])
        incremental_metadata = {
            "requested": True,
            "applied": True,
            "baseRunId": incremental_context["baseRunId"] if incremental_context else None,
            "baseArtifactUri": base_artifact_uri,
            "updateRows": len(train_rows),
            "validationRows": len(validation_rows),
            "strategy": "partial_fit_hashing_multinomial_nb",
            "baseTrainingRows": int(base_artifact.get("trainingRows") or 0),
            "totalTrainingRows": int(base_artifact.get("trainingRows") or 0) + len(train_rows),
        }
    else:
        vectorizer = HashingVectorizer(n_features=n_features, alternate_sign=False, norm=None, ngram_range=(1, 2), strip_accents="unicode")
        classifier = MultinomialNB(alpha=alpha)
        train_matrix = vectorizer.transform(train_texts)
        classifier.partial_fit(train_matrix, [str(row[target]) for row in train_rows], classes=class_labels)
        if incremental_context:
            incremental_metadata = {
                "requested": True,
                "applied": False,
                "baseRunId": incremental_context["baseRunId"],
                "baseArtifactUri": base_artifact_uri,
                "updateRows": len(train_rows),
                "validationRows": len(validation_rows),
                "strategy": "full_retrain",
                "reason": "Artefato base scikit-learn incremental compatível não encontrado para este modelo.",
            }

    estimator = Pipeline([("hashing", vectorizer), ("classifier", classifier)])
    predictions = [str(item) for item in estimator.predict(validation_texts)]
    actuals = [str(row[target]) for row in validation_rows]
    metrics = classification_metrics(actuals, predictions, labels)
    payload = {
        "type": "sklearn_text_classifier",
        "format": "pickle_base64",
        "modelBase64": encode_pickle_base64(estimator),
        "vectorizerBase64": encode_pickle_base64(vectorizer),
        "classifierBase64": encode_pickle_base64(classifier),
        "incrementalCapable": True,
        "inputMode": "joined_text",
        "target": target,
        "sensitiveFields": project.get("sensitiveFields", []),
        "classes": [str(item) for item in getattr(estimator, "classes_", labels)],
        "trainingRows": len(train_rows),
        "packageVersions": python_package_versions(["scikit-learn"]),
    }
    if incremental_metadata:
        payload["incremental"] = incremental_metadata
    artifact = write_model_artifact(project_root, run_id, model_id, payload)
    trained_algorithm = "hashing_multinomial_nb_incremental" if incremental_metadata and incremental_metadata.get("applied") else "hashing_multinomial_nb"
    return (
        {
            "modelId": model_id,
            "label": node.get("label") or model_id,
            "algorithm": node.get("algorithm") or "multinomial_nb",
            "role": node.get("modelRole", "candidate"),
            "trainingBackend": "scikit-learn",
            "trainedAlgorithm": trained_algorithm,
            "metrics": metrics,
            "trainingRows": len(train_rows),
            "validationRows": len(validation_rows),
            "artifactUri": artifact["path"],
            **({"incremental": incremental_metadata} if incremental_metadata else {}),
        },
        artifact,
    )


def train_sentence_transformers_classifier(
    project: dict[str, Any],
    project_root: Path,
    train_rows: list[dict[str, Any]],
    validation_rows: list[dict[str, Any]],
    target: str,
    labels: list[str],
    node: dict[str, Any],
    run_id: str,
    incremental_context: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    from sklearn.linear_model import SGDClassifier

    config = sentence_transformer_training_config(project, node)
    fine_tuning = sentence_transformer_fine_tuning_plan(project, config, "classification", train_rows, validation_rows)
    train_matrix = encode_sentence_transformer_rows(train_rows, target, project.get("sensitiveFields", []), config)
    validation_matrix = encode_sentence_transformer_rows(validation_rows, target, project.get("sensitiveFields", []), config)
    train_targets = [str(row[target]) for row in train_rows]
    model_id = str(node.get("id"))
    class_labels = sorted({str(item) for item in labels} | {str(row[target]) for row in train_rows + validation_rows})
    epochs = max(1, int(config.get("partialFitEpochs") or config.get("partial_fit_epochs") or 5))
    alpha = float(config.get("alpha") or 0.0001)
    incremental_metadata: dict[str, Any] | None = None
    base_artifact_uri = None
    base_artifact: dict[str, Any] = {}
    if incremental_context:
        base_artifact_uri, base_artifact = compatible_previous_model_artifact(project_root, incremental_context["baseResult"], model_id, "sentence_transformers_text_classifier")

    base_classes = [str(item) for item in base_artifact.get("classes", [])] if base_artifact else []
    base_compatible = (
        bool(base_artifact)
        and base_artifact.get("incrementalCapable") is True
        and bool(base_artifact.get("modelBase64"))
        and sentence_transformer_artifact_config_matches(base_artifact, config)
        and bool(base_classes)
        and set(train_targets).issubset(set(base_classes))
    )
    if base_compatible:
        estimator = decode_pickle_base64(str(base_artifact.get("modelBase64") or ""))
        for _ in range(epochs):
            estimator.partial_fit(train_matrix, train_targets)
        class_labels = base_classes
        incremental_metadata = {
            "requested": True,
            "applied": True,
            "baseRunId": incremental_context["baseRunId"] if incremental_context else None,
            "baseArtifactUri": base_artifact_uri,
            "updateRows": len(train_rows),
            "validationRows": len(validation_rows),
            "strategy": "partial_fit_sentence_transformers_sgd_classifier",
            "baseTrainingRows": int(base_artifact.get("trainingRows") or 0),
            "totalTrainingRows": int(base_artifact.get("trainingRows") or 0) + len(train_rows),
        }
    else:
        estimator = SGDClassifier(loss="log_loss", penalty="l2", alpha=alpha, random_state=int(config.get("randomState") or config.get("random_state") or 42))
        for _ in range(epochs):
            estimator.partial_fit(train_matrix, train_targets, classes=class_labels)
        if incremental_context:
            incremental_metadata = {
                "requested": True,
                "applied": False,
                "baseRunId": incremental_context["baseRunId"],
                "baseArtifactUri": base_artifact_uri,
                "updateRows": len(train_rows),
                "validationRows": len(validation_rows),
                "strategy": "full_retrain",
                "reason": "Artefato base SentenceTransformers compatível não encontrado, configuração de embedding mudou ou há classes novas.",
            }

    predictions = [str(item) for item in estimator.predict(validation_matrix)]
    actuals = [str(row[target]) for row in validation_rows]
    metrics = classification_metrics(actuals, predictions, labels)
    payload = {
        "type": "sentence_transformers_text_classifier",
        "format": "pickle_base64",
        "modelBase64": encode_pickle_base64(estimator),
        "incrementalCapable": True,
        "inputMode": "sentence_transformers",
        "target": target,
        "sensitiveFields": project.get("sensitiveFields", []),
        "embeddingModel": config["embeddingModel"],
        "normalizeEmbeddings": bool(config.get("normalizeEmbeddings", True)),
        "fineTuning": fine_tuning,
        "trainingRows": len(train_rows),
        "classes": [str(item) for item in getattr(estimator, "classes_", labels)],
        "packageVersions": python_package_versions(["sentence-transformers", "scikit-learn", "torch", "transformers"]),
    }
    if incremental_metadata:
        payload["incremental"] = incremental_metadata
    artifact = write_model_artifact(project_root, run_id, model_id, payload)
    trained_algorithm = "sentence_transformers_sgd_classifier_incremental" if incremental_metadata and incremental_metadata.get("applied") else "sentence_transformers_sgd_classifier"
    return (
        {
            "modelId": model_id,
            "label": node.get("label") or model_id,
            "algorithm": "sentence_transformers_sgd_classifier",
            "role": node.get("modelRole", "candidate"),
            "trainingBackend": "sentence-transformers",
            "trainedAlgorithm": trained_algorithm,
            "metrics": metrics,
            "trainingRows": len(train_rows),
            "validationRows": len(validation_rows),
            "artifactUri": artifact["path"],
            "fineTuning": fine_tuning,
            **({"incremental": incremental_metadata} if incremental_metadata else {}),
        },
        artifact,
    )


def train_sklearn_regressor(
    project: dict[str, Any],
    project_root: Path,
    train_rows: list[dict[str, Any]],
    validation_rows: list[dict[str, Any]],
    target: str,
    node: dict[str, Any],
    run_id: str,
    incremental_context: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    from sklearn.feature_extraction import FeatureHasher
    from sklearn.linear_model import SGDRegressor
    from sklearn.pipeline import Pipeline

    config = node.get("config") if isinstance(node.get("config"), dict) else {}
    n_features = int(config.get("nFeatures") or config.get("n_features") or 262144)
    n_features = max(1024, min(n_features, 1048576))
    alpha = float(config.get("alpha") or 0.0001)
    max_iter = int(config.get("maxIter") or config.get("max_iter") or 1000)
    train_features = [feature_dict_from_row(row, target, project.get("sensitiveFields", [])) for row in train_rows]
    validation_features = [feature_dict_from_row(row, target, project.get("sensitiveFields", [])) for row in validation_rows]
    train_targets = [float(row[target]) for row in train_rows]
    model_id = str(node.get("id"))
    incremental_metadata: dict[str, Any] | None = None
    base_artifact_uri = None
    base_artifact: dict[str, Any] = {}
    if incremental_context:
        base_artifact_uri, base_artifact = compatible_previous_model_artifact(project_root, incremental_context["baseResult"], model_id, "sklearn_regressor")

    if base_artifact and base_artifact.get("incrementalCapable") is True and base_artifact.get("vectorizerBase64") and base_artifact.get("regressorBase64"):
        vectorizer = decode_pickle_base64(str(base_artifact.get("vectorizerBase64") or ""))
        regressor = decode_pickle_base64(str(base_artifact.get("regressorBase64") or ""))
        train_matrix = vectorizer.transform(train_features)
        regressor.partial_fit(train_matrix, train_targets)
        incremental_metadata = {
            "requested": True,
            "applied": True,
            "baseRunId": incremental_context["baseRunId"] if incremental_context else None,
            "baseArtifactUri": base_artifact_uri,
            "updateRows": len(train_rows),
            "validationRows": len(validation_rows),
            "strategy": "partial_fit_feature_hasher_sgd_regressor",
            "baseTrainingRows": int(base_artifact.get("trainingRows") or 0),
            "totalTrainingRows": int(base_artifact.get("trainingRows") or 0) + len(train_rows),
        }
    else:
        vectorizer = FeatureHasher(n_features=n_features, input_type="dict", alternate_sign=False)
        regressor = SGDRegressor(loss="squared_error", penalty="l2", alpha=alpha, max_iter=max_iter, tol=1e-3, random_state=42)
        train_matrix = vectorizer.transform(train_features)
        regressor.partial_fit(train_matrix, train_targets)
        if incremental_context:
            incremental_metadata = {
                "requested": True,
                "applied": False,
                "baseRunId": incremental_context["baseRunId"],
                "baseArtifactUri": base_artifact_uri,
                "updateRows": len(train_rows),
                "validationRows": len(validation_rows),
                "strategy": "full_retrain",
                "reason": "Artefato base scikit-learn incremental compatível não encontrado para este regressor.",
            }

    estimator = Pipeline([("features", vectorizer), ("regressor", regressor)])
    predictions = [float(item) for item in estimator.predict(validation_features)]
    actuals = [float(row[target]) for row in validation_rows]
    metrics = regression_metrics(actuals, predictions)
    payload = {
        "type": "sklearn_regressor",
        "format": "pickle_base64",
        "modelBase64": encode_pickle_base64(estimator),
        "vectorizerBase64": encode_pickle_base64(vectorizer),
        "regressorBase64": encode_pickle_base64(regressor),
        "incrementalCapable": True,
        "inputMode": "dict_features",
        "target": target,
        "sensitiveFields": project.get("sensitiveFields", []),
        "trainingRows": len(train_rows),
        "packageVersions": python_package_versions(["scikit-learn"]),
    }
    if incremental_metadata:
        payload["incremental"] = incremental_metadata
    artifact = write_model_artifact(project_root, run_id, model_id, payload)
    trained_algorithm = "feature_hasher_sgd_regressor_incremental" if incremental_metadata and incremental_metadata.get("applied") else "feature_hasher_sgd_regressor"
    return (
        {
            "modelId": model_id,
            "label": node.get("label") or model_id,
            "algorithm": node.get("algorithm") or "sgd_regressor",
            "role": node.get("modelRole", "candidate"),
            "trainingBackend": "scikit-learn",
            "trainedAlgorithm": trained_algorithm,
            "metrics": metrics,
            "trainingRows": len(train_rows),
            "validationRows": len(validation_rows),
            "artifactUri": artifact["path"],
            **({"incremental": incremental_metadata} if incremental_metadata else {}),
        },
        artifact,
    )


def train_sentence_transformers_regressor(
    project: dict[str, Any],
    project_root: Path,
    train_rows: list[dict[str, Any]],
    validation_rows: list[dict[str, Any]],
    target: str,
    node: dict[str, Any],
    run_id: str,
    incremental_context: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    from sklearn.linear_model import SGDRegressor

    config = sentence_transformer_training_config(project, node)
    fine_tuning = sentence_transformer_fine_tuning_plan(project, config, "regression", train_rows, validation_rows)
    train_matrix = encode_sentence_transformer_rows(train_rows, target, project.get("sensitiveFields", []), config)
    validation_matrix = encode_sentence_transformer_rows(validation_rows, target, project.get("sensitiveFields", []), config)
    train_targets = [float(row[target]) for row in train_rows]
    model_id = str(node.get("id"))
    epochs = max(1, int(config.get("partialFitEpochs") or config.get("partial_fit_epochs") or 5))
    alpha = float(config.get("alpha") or 0.0001)
    incremental_metadata: dict[str, Any] | None = None
    base_artifact_uri = None
    base_artifact: dict[str, Any] = {}
    if incremental_context:
        base_artifact_uri, base_artifact = compatible_previous_model_artifact(project_root, incremental_context["baseResult"], model_id, "sentence_transformers_regressor")

    base_compatible = (
        bool(base_artifact)
        and base_artifact.get("incrementalCapable") is True
        and bool(base_artifact.get("modelBase64"))
        and sentence_transformer_artifact_config_matches(base_artifact, config)
    )
    if base_compatible:
        estimator = decode_pickle_base64(str(base_artifact.get("modelBase64") or ""))
        for _ in range(epochs):
            estimator.partial_fit(train_matrix, train_targets)
        incremental_metadata = {
            "requested": True,
            "applied": True,
            "baseRunId": incremental_context["baseRunId"] if incremental_context else None,
            "baseArtifactUri": base_artifact_uri,
            "updateRows": len(train_rows),
            "validationRows": len(validation_rows),
            "strategy": "partial_fit_sentence_transformers_sgd_regressor",
            "baseTrainingRows": int(base_artifact.get("trainingRows") or 0),
            "totalTrainingRows": int(base_artifact.get("trainingRows") or 0) + len(train_rows),
        }
    else:
        estimator = SGDRegressor(loss="squared_error", penalty="l2", alpha=alpha, random_state=int(config.get("randomState") or config.get("random_state") or 42))
        for _ in range(epochs):
            estimator.partial_fit(train_matrix, train_targets)
        if incremental_context:
            incremental_metadata = {
                "requested": True,
                "applied": False,
                "baseRunId": incremental_context["baseRunId"],
                "baseArtifactUri": base_artifact_uri,
                "updateRows": len(train_rows),
                "validationRows": len(validation_rows),
                "strategy": "full_retrain",
                "reason": "Artefato base SentenceTransformers compatível não encontrado ou configuração de embedding mudou.",
            }

    predictions = [float(item) for item in estimator.predict(validation_matrix)]
    actuals = [float(row[target]) for row in validation_rows]
    metrics = regression_metrics(actuals, predictions)
    payload = {
        "type": "sentence_transformers_regressor",
        "format": "pickle_base64",
        "modelBase64": encode_pickle_base64(estimator),
        "incrementalCapable": True,
        "inputMode": "sentence_transformers",
        "target": target,
        "sensitiveFields": project.get("sensitiveFields", []),
        "embeddingModel": config["embeddingModel"],
        "normalizeEmbeddings": bool(config.get("normalizeEmbeddings", True)),
        "fineTuning": fine_tuning,
        "trainingRows": len(train_rows),
        "packageVersions": python_package_versions(["sentence-transformers", "scikit-learn", "torch", "transformers"]),
    }
    if incremental_metadata:
        payload["incremental"] = incremental_metadata
    artifact = write_model_artifact(project_root, run_id, model_id, payload)
    trained_algorithm = "sentence_transformers_sgd_regressor_incremental" if incremental_metadata and incremental_metadata.get("applied") else "sentence_transformers_sgd_regressor"
    return (
        {
            "modelId": model_id,
            "label": node.get("label") or model_id,
            "algorithm": "sentence_transformers_sgd_regressor",
            "role": node.get("modelRole", "candidate"),
            "trainingBackend": "sentence-transformers",
            "trainedAlgorithm": trained_algorithm,
            "metrics": metrics,
            "trainingRows": len(train_rows),
            "validationRows": len(validation_rows),
            "artifactUri": artifact["path"],
            "fineTuning": fine_tuning,
            **({"incremental": incremental_metadata} if incremental_metadata else {}),
        },
        artifact,
    )


def train_xgboost_text_classifier(
    project: dict[str, Any],
    project_root: Path,
    train_rows: list[dict[str, Any]],
    validation_rows: list[dict[str, Any]],
    target: str,
    labels: list[str],
    node: dict[str, Any],
    run_id: str,
    incremental_context: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.preprocessing import LabelEncoder
    from xgboost import XGBClassifier

    model_id = str(node.get("id"))
    trained_labels = sorted({str(row[target]) for row in train_rows})
    config = node.get("config") if isinstance(node.get("config"), dict) else {}
    train_texts = [text_from_row(row, target, project.get("sensitiveFields", [])) for row in train_rows]
    validation_texts = [text_from_row(row, target, project.get("sensitiveFields", [])) for row in validation_rows]
    incremental_metadata: dict[str, Any] | None = None
    base_artifact_uri = None
    base_artifact: dict[str, Any] = {}
    if incremental_context:
        base_artifact_uri, base_artifact = compatible_previous_model_artifact(project_root, incremental_context["baseResult"], model_id, "xgboost_text_classifier")

    base_classes = [str(item) for item in base_artifact.get("classes", [])] if base_artifact else []
    base_compatible = (
        bool(base_artifact)
        and base_artifact.get("incrementalCapable") is True
        and bool(base_artifact.get("vectorizerBase64"))
        and bool(base_artifact.get("modelBase64"))
        and len(base_classes) >= 2
        and set(trained_labels).issubset(set(base_classes))
    )
    if len(trained_labels) < 2 and not base_compatible:
        return train_stdlib_text_naive_bayes(project, project_root, train_rows, validation_rows, target, labels, node, run_id)

    n_classes = len(base_classes) if base_compatible else len(trained_labels)
    estimator_params = {
        "n_estimators": int(config.get("nEstimators") or config.get("n_estimators") or 50),
        "max_depth": int(config.get("maxDepth") or config.get("max_depth") or 4),
        "learning_rate": float(config.get("learningRate") or config.get("learning_rate") or 0.1),
        "subsample": float(config.get("subsample") or 1.0),
        "colsample_bytree": float(config.get("colsampleBytree") or config.get("colsample_bytree") or 1.0),
        "objective": "multi:softprob" if n_classes > 2 else "binary:logistic",
        "eval_metric": "mlogloss" if n_classes > 2 else "logloss",
        "n_jobs": int(config.get("nJobs") or config.get("n_jobs") or 1),
        "random_state": int(config.get("randomState") or config.get("random_state") or 42),
    }
    if n_classes > 2:
        estimator_params["num_class"] = n_classes

    if base_compatible:
        from scipy.sparse import vstack

        vectorizer = decode_pickle_base64(str(base_artifact.get("vectorizerBase64") or ""))
        base_estimator = decode_pickle_base64(str(base_artifact.get("modelBase64") or ""))
        class_names = base_classes
        class_index = {label: index for index, label in enumerate(class_names)}
        train_matrix = vectorizer.transform(train_texts)
        encoded_targets = [class_index[str(row[target])] for row in train_rows]
        sample_weight: list[float] | None = None
        missing_classes = [index for index in range(len(class_names)) if index not in set(encoded_targets)]
        if missing_classes:
            train_matrix = vstack([train_matrix, vectorizer.transform([""] * len(missing_classes))])
            encoded_targets = encoded_targets + missing_classes
            sample_weight = [1.0] * len(train_rows) + [0.0] * len(missing_classes)
        estimator = XGBClassifier(**estimator_params)
        estimator.fit(train_matrix, encoded_targets, sample_weight=sample_weight, xgb_model=base_estimator.get_booster(), verbose=False)
        incremental_metadata = {
            "requested": True,
            "applied": True,
            "baseRunId": incremental_context["baseRunId"] if incremental_context else None,
            "baseArtifactUri": base_artifact_uri,
            "updateRows": len(train_rows),
            "validationRows": len(validation_rows),
            "strategy": "xgb_model_continuation",
            "baseTrainingRows": int(base_artifact.get("trainingRows") or 0),
            "totalTrainingRows": int(base_artifact.get("trainingRows") or 0) + len(train_rows),
            "baseBoostedRounds": int(base_artifact.get("boostedRounds") or 0),
            "totalBoostedRounds": len(estimator.get_booster().get_dump()),
        }
    else:
        vectorizer = TfidfVectorizer(ngram_range=(1, 2), min_df=1, strip_accents="unicode")
        encoder = LabelEncoder()
        encoder.fit(trained_labels)
        train_matrix = vectorizer.fit_transform(train_texts)
        class_names = [str(item) for item in encoder.classes_]
        estimator = XGBClassifier(**estimator_params)
        estimator.fit(train_matrix, encoder.transform([str(row[target]) for row in train_rows]), verbose=False)
        if incremental_context:
            incremental_metadata = {
                "requested": True,
                "applied": False,
                "baseRunId": incremental_context["baseRunId"],
                "baseArtifactUri": base_artifact_uri,
                "updateRows": len(train_rows),
                "validationRows": len(validation_rows),
                "strategy": "full_retrain",
                "reason": "Artefato base XGBoost compatível não encontrado ou classes novas não suportadas para continuação local.",
            }

    validation_matrix = vectorizer.transform(validation_texts)
    encoded_predictions = estimator.predict(validation_matrix)
    predictions = [class_names[int(item)] if 0 <= int(item) < len(class_names) else str(item) for item in encoded_predictions]
    actuals = [str(row[target]) for row in validation_rows]
    metrics = classification_metrics(actuals, predictions, labels)
    payload = {
        "type": "xgboost_text_classifier",
        "format": "pickle_base64",
        "modelBase64": encode_pickle_base64(estimator),
        "vectorizerBase64": encode_pickle_base64(vectorizer),
        "incrementalCapable": True,
        "inputMode": "joined_text",
        "target": target,
        "sensitiveFields": project.get("sensitiveFields", []),
        "classes": class_names,
        "trainingRows": len(train_rows),
        "boostedRounds": len(estimator.get_booster().get_dump()),
        "packageVersions": python_package_versions(["xgboost", "scikit-learn"]),
    }
    if incremental_metadata:
        payload["incremental"] = incremental_metadata
    artifact = write_model_artifact(project_root, run_id, model_id, payload)
    trained_algorithm = "tfidf_xgboost_classifier_incremental" if incremental_metadata and incremental_metadata.get("applied") else "tfidf_xgboost_classifier"
    return (
        {
            "modelId": model_id,
            "label": node.get("label") or model_id,
            "algorithm": node.get("algorithm") or "xgboost",
            "role": node.get("modelRole", "candidate"),
            "trainingBackend": "xgboost",
            "trainedAlgorithm": trained_algorithm,
            "metrics": metrics,
            "trainingRows": len(train_rows),
            "validationRows": len(validation_rows),
            "artifactUri": artifact["path"],
            **({"incremental": incremental_metadata} if incremental_metadata else {}),
        },
        artifact,
    )


def train_xgboost_regressor(
    project: dict[str, Any],
    project_root: Path,
    train_rows: list[dict[str, Any]],
    validation_rows: list[dict[str, Any]],
    target: str,
    node: dict[str, Any],
    run_id: str,
    incremental_context: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    from sklearn.feature_extraction import DictVectorizer
    from xgboost import XGBRegressor

    config = node.get("config") if isinstance(node.get("config"), dict) else {}
    model_id = str(node.get("id"))
    train_features = [feature_dict_from_row(row, target, project.get("sensitiveFields", [])) for row in train_rows]
    validation_features = [feature_dict_from_row(row, target, project.get("sensitiveFields", [])) for row in validation_rows]
    incremental_metadata: dict[str, Any] | None = None
    base_artifact_uri = None
    base_artifact: dict[str, Any] = {}
    if incremental_context:
        base_artifact_uri, base_artifact = compatible_previous_model_artifact(project_root, incremental_context["baseResult"], model_id, "xgboost_regressor")

    base_compatible = (
        bool(base_artifact)
        and base_artifact.get("incrementalCapable") is True
        and bool(base_artifact.get("vectorizerBase64"))
        and bool(base_artifact.get("modelBase64"))
    )
    estimator = XGBRegressor(
        n_estimators=int(config.get("nEstimators") or config.get("n_estimators") or 80),
        max_depth=int(config.get("maxDepth") or config.get("max_depth") or 4),
        learning_rate=float(config.get("learningRate") or config.get("learning_rate") or 0.1),
        subsample=float(config.get("subsample") or 1.0),
        colsample_bytree=float(config.get("colsampleBytree") or config.get("colsample_bytree") or 1.0),
        objective=str(config.get("objective") or "reg:squarederror"),
        n_jobs=int(config.get("nJobs") or config.get("n_jobs") or 1),
        random_state=int(config.get("randomState") or config.get("random_state") or 42),
    )
    if base_compatible:
        vectorizer = decode_pickle_base64(str(base_artifact.get("vectorizerBase64") or ""))
        base_estimator = decode_pickle_base64(str(base_artifact.get("modelBase64") or ""))
        train_matrix = vectorizer.transform(train_features)
        estimator.fit(train_matrix, [float(row[target]) for row in train_rows], xgb_model=base_estimator.get_booster(), verbose=False)
        incremental_metadata = {
            "requested": True,
            "applied": True,
            "baseRunId": incremental_context["baseRunId"] if incremental_context else None,
            "baseArtifactUri": base_artifact_uri,
            "updateRows": len(train_rows),
            "validationRows": len(validation_rows),
            "strategy": "xgb_model_continuation",
            "baseTrainingRows": int(base_artifact.get("trainingRows") or 0),
            "totalTrainingRows": int(base_artifact.get("trainingRows") or 0) + len(train_rows),
            "baseBoostedRounds": int(base_artifact.get("boostedRounds") or 0),
            "totalBoostedRounds": len(estimator.get_booster().get_dump()),
        }
    else:
        vectorizer = DictVectorizer(sparse=True)
        train_matrix = vectorizer.fit_transform(train_features)
        estimator.fit(train_matrix, [float(row[target]) for row in train_rows], verbose=False)
        if incremental_context:
            incremental_metadata = {
                "requested": True,
                "applied": False,
                "baseRunId": incremental_context["baseRunId"],
                "baseArtifactUri": base_artifact_uri,
                "updateRows": len(train_rows),
                "validationRows": len(validation_rows),
                "strategy": "full_retrain",
                "reason": "Artefato base XGBoost compatível não encontrado para este regressor.",
            }

    validation_matrix = vectorizer.transform(validation_features)
    predictions = [float(item) for item in estimator.predict(validation_matrix)]
    actuals = [float(row[target]) for row in validation_rows]
    metrics = regression_metrics(actuals, predictions)
    payload = {
        "type": "xgboost_regressor",
        "format": "pickle_base64",
        "modelBase64": encode_pickle_base64(estimator),
        "vectorizerBase64": encode_pickle_base64(vectorizer),
        "incrementalCapable": True,
        "inputMode": "dict_features",
        "target": target,
        "sensitiveFields": project.get("sensitiveFields", []),
        "trainingRows": len(train_rows),
        "boostedRounds": len(estimator.get_booster().get_dump()),
        "packageVersions": python_package_versions(["xgboost", "scikit-learn"]),
    }
    if incremental_metadata:
        payload["incremental"] = incremental_metadata
    artifact = write_model_artifact(project_root, run_id, model_id, payload)
    trained_algorithm = "dictvectorizer_xgboost_regressor_incremental" if incremental_metadata and incremental_metadata.get("applied") else "dictvectorizer_xgboost_regressor"
    return (
        {
            "modelId": model_id,
            "label": node.get("label") or model_id,
            "algorithm": node.get("algorithm") or "xgboost",
            "role": node.get("modelRole", "candidate"),
            "trainingBackend": "xgboost",
            "trainedAlgorithm": trained_algorithm,
            "metrics": metrics,
            "trainingRows": len(train_rows),
            "validationRows": len(validation_rows),
            "artifactUri": artifact["path"],
            **({"incremental": incremental_metadata} if incremental_metadata else {}),
        },
        artifact,
    )


def fit_text_naive_bayes(rows: list[dict[str, Any]], target: str, sensitive_fields: list[str]) -> dict[str, Any]:
    class_counts: Counter[str] = Counter()
    token_counts: dict[str, Counter[str]] = defaultdict(Counter)
    total_tokens: Counter[str] = Counter()
    vocabulary: set[str] = set()
    for row in rows:
        label = str(row[target])
        tokens = tokenize_row(row, target, sensitive_fields)
        class_counts[label] += 1
        token_counts[label].update(tokens)
        total_tokens[label] += len(tokens)
        vocabulary.update(tokens)
    return {
        "classCounts": dict(class_counts),
        "tokenCounts": {label: dict(counts) for label, counts in token_counts.items()},
        "totalTokens": dict(total_tokens),
        "vocabulary": sorted(vocabulary),
    }


def predict_text_naive_bayes(model: dict[str, Any], row: dict[str, Any], target: str, sensitive_fields: list[str]) -> str:
    class_counts = {label: int(count) for label, count in model["classCounts"].items()}
    token_counts = {label: Counter(counts) for label, counts in model["tokenCounts"].items()}
    total_tokens = {label: int(count) for label, count in model["totalTokens"].items()}
    vocabulary = model["vocabulary"]
    vocab_size = max(1, len(vocabulary))
    total_rows = max(1, sum(class_counts.values()))
    tokens = tokenize_row(row, target, sensitive_fields)
    scores: dict[str, float] = {}
    for label, count in class_counts.items():
        score = math.log(count / total_rows)
        denominator = total_tokens.get(label, 0) + vocab_size
        for token in tokens:
            score += math.log((token_counts[label].get(token, 0) + 1) / denominator)
        scores[label] = score
    return max(scores.items(), key=lambda item: item[1])[0]


def incremental_training_context(request: dict[str, Any], project_root: Path) -> dict[str, Any] | None:
    requested = request.get("incremental") is True or str(request.get("trainingMode") or request.get("retrainMode") or "").lower() == "incremental"
    if not requested:
        return None
    base_run_id = str(request.get("previousRunId") or request.get("baseRunId") or request.get("fromRunId") or "").strip()
    if not base_run_id:
        base_run_id = latest_training_run_id(project_root) or ""
    if not base_run_id:
        raise WorkerError("Retreino incremental exige previousRunId ou um treino anterior persistido.")
    base_result = load_training_result(project_root, base_run_id)
    return {
        "requested": True,
        "baseRunId": str(base_result.get("runId") or base_run_id),
        "baseResult": base_result,
    }


def compatible_previous_model_artifact(project_root: Path, base_result: dict[str, Any], model_id: str, expected_type: str) -> tuple[str | None, dict[str, Any]]:
    model_row = next((row for row in base_result.get("leaderboard", []) if isinstance(row, dict) and str(row.get("modelId")) == model_id), None)
    if not model_row:
        return None, {}
    artifact_uri = str(model_row.get("artifactUri") or "")
    if not artifact_uri:
        return None, {}
    try:
        artifact = load_model_artifact(project_root, artifact_uri)
    except WorkerError:
        return artifact_uri, {}
    if artifact.get("type") != expected_type:
        return artifact_uri, {}
    return artifact_uri, artifact


def merge_text_naive_bayes_models(base_model: dict[str, Any], update_model: dict[str, Any]) -> dict[str, Any]:
    class_counts = Counter({str(label): int(count) for label, count in base_model.get("classCounts", {}).items()})
    class_counts.update({str(label): int(count) for label, count in update_model.get("classCounts", {}).items()})

    token_counts: dict[str, Counter[str]] = defaultdict(Counter)
    for source_model in (base_model, update_model):
        for label, counts in source_model.get("tokenCounts", {}).items():
            token_counts[str(label)].update({str(token): int(count) for token, count in counts.items()})

    total_tokens = Counter({str(label): int(count) for label, count in base_model.get("totalTokens", {}).items()})
    total_tokens.update({str(label): int(count) for label, count in update_model.get("totalTokens", {}).items()})
    vocabulary = set(str(token) for token in base_model.get("vocabulary", [])) | set(str(token) for token in update_model.get("vocabulary", []))
    return {
        "classCounts": dict(class_counts),
        "tokenCounts": {label: dict(counts) for label, counts in token_counts.items()},
        "totalTokens": dict(total_tokens),
        "vocabulary": sorted(vocabulary),
    }


def unsupported_incremental_metadata(backend: str, base_run_id: str) -> dict[str, Any]:
    return {
        "requested": True,
        "applied": False,
        "baseRunId": base_run_id,
        "strategy": "full_retrain",
        "reason": f"Backend {backend} ainda não tem atualização incremental local; o modelo foi retreinado com o lote atual.",
    }


def summarize_incremental_training(leaderboard: list[dict[str, Any]], base_run_id: str, update_rows: int) -> dict[str, Any]:
    applied = []
    fallback = []
    for row in leaderboard:
        metadata = row.get("incremental") if isinstance(row.get("incremental"), dict) else {}
        entry = {
            "modelId": row.get("modelId"),
            "backend": row.get("trainingBackend"),
            "strategy": metadata.get("strategy"),
            "reason": metadata.get("reason"),
        }
        if metadata.get("applied") is True:
            applied.append(entry)
        else:
            fallback.append(entry)
    return {
        "requested": True,
        "baseRunId": base_run_id,
        "updateRows": update_rows,
        "appliedModels": applied,
        "fallbackModels": fallback,
    }


def predict_from_artifact(artifact: dict[str, Any], row: dict[str, Any], target: str, sensitive_fields: list[str]) -> Any:
    artifact_type = str(artifact.get("type") or "")
    if artifact_type == "standard_lib_text_naive_bayes":
        model = artifact.get("model")
        if not isinstance(model, dict):
            raise WorkerError("Artefato naive_bayes inválido.")
        return predict_text_naive_bayes(model, row, target, sensitive_fields)
    if artifact_type == "mean_regressor":
        return float(artifact.get("mean", 0))
    if artifact_type == "sklearn_text_classifier":
        estimator = decode_pickle_base64(str(artifact.get("modelBase64") or ""))
        text = text_from_row(row, target, artifact.get("sensitiveFields", sensitive_fields))
        return str(estimator.predict([text])[0])
    if artifact_type == "sklearn_regressor":
        estimator = decode_pickle_base64(str(artifact.get("modelBase64") or ""))
        features = feature_dict_from_row(row, target, artifact.get("sensitiveFields", sensitive_fields))
        return float(estimator.predict([features])[0])
    if artifact_type == "sentence_transformers_text_classifier":
        estimator = decode_pickle_base64(str(artifact.get("modelBase64") or ""))
        matrix = encode_sentence_transformer_rows([row], target, artifact.get("sensitiveFields", sensitive_fields), artifact)
        return str(estimator.predict(matrix)[0])
    if artifact_type == "sentence_transformers_regressor":
        estimator = decode_pickle_base64(str(artifact.get("modelBase64") or ""))
        matrix = encode_sentence_transformer_rows([row], target, artifact.get("sensitiveFields", sensitive_fields), artifact)
        return float(estimator.predict(matrix)[0])
    if artifact_type == "xgboost_text_classifier":
        vectorizer = decode_pickle_base64(str(artifact.get("vectorizerBase64") or ""))
        estimator = decode_pickle_base64(str(artifact.get("modelBase64") or ""))
        text = text_from_row(row, target, artifact.get("sensitiveFields", sensitive_fields))
        encoded = estimator.predict(vectorizer.transform([text]))[0]
        classes = [str(item) for item in artifact.get("classes", [])]
        index = int(encoded)
        return classes[index] if 0 <= index < len(classes) else str(encoded)
    if artifact_type == "xgboost_regressor":
        vectorizer = decode_pickle_base64(str(artifact.get("vectorizerBase64") or ""))
        estimator = decode_pickle_base64(str(artifact.get("modelBase64") or ""))
        features = feature_dict_from_row(row, target, artifact.get("sensitiveFields", sensitive_fields))
        return float(estimator.predict(vectorizer.transform([features]))[0])
    raise WorkerError(f"Tipo de artefato não suportado para avaliação: {artifact_type}")


def find_leaderboard_model(training_result: dict[str, Any], model_id: str) -> dict[str, Any]:
    model_row = next((row for row in training_result.get("leaderboard", []) if isinstance(row, dict) and row.get("modelId") == model_id), None)
    if not isinstance(model_row, dict):
        raise WorkerError(f"Modelo {model_id} não encontrado no leaderboard do treino.")
    if not str(model_row.get("artifactUri") or ""):
        raise WorkerError(f"Modelo {model_id} não tem artifactUri no treino.")
    return model_row


def evaluate_leaderboard_model(
    project: dict[str, Any],
    project_root: Path,
    model_row: dict[str, Any],
    rows: list[dict[str, Any]],
    target: str,
    problem_type: str | None,
    source_sensitive_fields: list[str],
) -> dict[str, Any]:
    model_id = str(model_row.get("modelId") or "")
    artifact_uri = str(model_row.get("artifactUri") or "")
    if not artifact_uri:
        raise WorkerError(f"Modelo {model_id} não tem artifactUri no treino.")
    sensitive_fields = source_sensitive_fields + project.get("sensitiveFields", [])
    artifact = load_model_artifact(project_root, artifact_uri)
    predictions = [predict_from_artifact(artifact, row, target, sensitive_fields) for row in rows]
    if problem_type == "regression":
        actuals_float = [float(row[target]) for row in rows]
        predictions_float = [float(prediction) for prediction in predictions]
        metrics = regression_metrics(actuals_float, predictions_float)
    else:
        actuals = [str(row[target]) for row in rows]
        predictions_str = [str(prediction) for prediction in predictions]
        labels = sorted(set(project.get("problem", {}).get("classes") or []) | set(actuals) | set(predictions_str))
        metrics = classification_metrics(actuals, predictions_str, labels)
    return {
        "modelId": model_id,
        "artifactUri": artifact_uri,
        "metrics": metrics,
        "sample": [
            {
                "actual": rows[index].get(target),
                "prediction": predictions[index],
                "input": mask_row({key: value for key, value in rows[index].items() if key != target}, sensitive_fields),
            }
            for index in range(min(10, len(rows)))
        ],
    }


def classification_metrics(actuals: list[str], predictions: list[str], labels: list[str]) -> dict[str, Any]:
    total = max(1, len(actuals))
    accuracy = sum(1 for actual, prediction in zip(actuals, predictions) if actual == prediction) / total
    per_label = {}
    supports = {}
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
        supports[label] = support
        if support:
            f1_values.append(f1)
            weighted_sum += f1 * support
    f1_macro = sum(f1_values) / len(f1_values) if f1_values else 0.0
    matrix = [[sum(1 for actual, prediction in zip(actuals, predictions) if actual == left and prediction == right) for right in labels] for left in labels]
    return {
        "accuracy": round(accuracy, 6),
        "f1_macro": round(f1_macro, 6),
        "f1_weighted": round(weighted_sum / total, 6),
        "precision_macro": round(sum(item["precision"] for item in per_label.values()) / max(1, len(per_label)), 6),
        "recall_macro": round(sum(item["recall"] for item in per_label.values()) / max(1, len(per_label)), 6),
        "labels": labels,
        "per_label": per_label,
        "confusion_matrix": matrix,
    }


def regression_metrics(actuals: list[float], predictions: list[float]) -> dict[str, float]:
    total = max(1, len(actuals))
    errors = [prediction - actual for actual, prediction in zip(actuals, predictions)]
    mae = sum(abs(error) for error in errors) / total
    rmse = math.sqrt(sum(error * error for error in errors) / total)
    mean_actual = sum(actuals) / total
    ss_tot = sum((actual - mean_actual) ** 2 for actual in actuals)
    ss_res = sum(error * error for error in errors)
    r2 = 1 - ss_res / ss_tot if ss_tot else 0.0
    return {"mae": round(mae, 6), "rmse": round(rmse, 6), "r2": round(r2, 6)}


def promotion_evidence(project: dict[str, Any], metrics: dict[str, Any]) -> list[dict[str, Any]]:
    evidence = []
    for rule in flatten_rules(project.get("promotionPolicy", {}).get("rules", [])):
        if rule.get("kind") != "metric":
            evidence.append({"ruleId": rule.get("id"), "label": rule.get("label"), "status": "neutral", "color": "neutral", "reason": "Regra não métrica exige execução dedicada."})
            continue
        metric_name = rule.get("left", {}).get("metric")
        value = metrics.get(metric_name)
        expected = rule.get("value")
        operator = rule.get("operator")
        neutral_band = float(rule.get("neutralBand") or 0)
        status, color, reason = evaluate_metric_rule(value, operator, expected, neutral_band)
        evidence.append(
            {
                "ruleId": rule.get("id"),
                "label": rule.get("label"),
                "metric": metric_name,
                "value": value,
                "operator": operator,
                "expected": expected,
                "status": status,
                "color": color,
                "severity": rule.get("severity", "block"),
                "reason": reason,
            }
        )
    return evidence


def evaluate_metric_rule(value: Any, operator: str, expected: Any, neutral_band: float) -> tuple[str, str, str]:
    if value is None:
        return "neutral", "neutral", "Métrica indisponível para esta execução."
    try:
        numeric_value = float(value)
        numeric_expected = float(expected)
    except (TypeError, ValueError):
        passed = value == expected if operator == "eq" else value != expected
        return ("pass", "green", "Valor discreto atende à regra.") if passed else ("fail", "red", "Valor discreto viola a regra.")
    delta = numeric_value - numeric_expected
    if abs(delta) <= neutral_band:
        return "neutral", "neutral", "Variação dentro do threshold neutro."
    if operator == "gte":
        passed = numeric_value >= numeric_expected
    elif operator == "gt":
        passed = numeric_value > numeric_expected
    elif operator == "lte":
        passed = numeric_value <= numeric_expected
    elif operator == "lt":
        passed = numeric_value < numeric_expected
    elif operator == "eq":
        passed = numeric_value == numeric_expected
    else:
        passed = delta >= 0
    return ("pass", "green", "Evidência melhor que o limiar.") if passed else ("fail", "red", "Evidência pior que o limiar.")


def flatten_rules(rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
    flat = []
    for rule in rules:
        if rule.get("kind") == "group":
            flat.extend(flatten_rules(rule.get("rules", [])))
        else:
            flat.append(rule)
    return flat


def choose_best_model(leaderboard: list[dict[str, Any]], primary_metric: str | None, problem_type: str | None) -> dict[str, Any]:
    if not leaderboard:
        return {}
    if not primary_metric:
        return leaderboard[0]
    return sort_leaderboard(leaderboard, primary_metric, problem_type)[0]


def sort_leaderboard(leaderboard: list[dict[str, Any]], primary_metric: str | None, problem_type: str | None) -> list[dict[str, Any]]:
    if not leaderboard or not primary_metric:
        return leaderboard
    minimize = primary_metric in {"rmse", "mae", "log_loss", "latency_p95_ms", "error_rate", "drift_score"} or problem_type == "regression" and primary_metric != "r2"
    fallback = float("inf") if minimize else float("-inf")
    return sorted(
        leaderboard,
        key=lambda item: float(item.get("metrics", {}).get(primary_metric, fallback)),
        reverse=not minimize,
    )


def choose_best_backtest_model(model_metrics: dict[str, dict[str, Any]], primary_metric: str | None, minimize: bool) -> str | None:
    scored = [(model_id, numeric_metric_value(metrics, primary_metric)) for model_id, metrics in model_metrics.items()]
    scored = [(model_id, value) for model_id, value in scored if value is not None]
    if not scored:
        return None
    return sorted(scored, key=lambda item: item[1], reverse=not minimize)[0][0]


def summarize_backtest_metrics(model_metrics: dict[str, dict[str, Any]], primary_metric: str | None, baseline_model_id: str, best_model_id: str) -> dict[str, Any]:
    baseline_value = numeric_metric_value(model_metrics.get(baseline_model_id, {}), primary_metric)
    best_value = numeric_metric_value(model_metrics.get(best_model_id, {}), primary_metric)
    summary: dict[str, Any] = {
        "baseline_model_id": baseline_model_id,
        "recommended_model_id": best_model_id,
    }
    if primary_metric and best_value is not None:
        summary[primary_metric] = best_value
        summary[f"recommended_{primary_metric}"] = best_value
    if primary_metric and baseline_value is not None:
        summary[f"baseline_{primary_metric}"] = baseline_value
    if primary_metric and baseline_value is not None and best_value is not None:
        summary[f"delta_{primary_metric}"] = round(best_value - baseline_value, 6)
    return summary


def backtest_sample(rows: list[dict[str, Any]], target: str, model_samples: dict[str, list[dict[str, Any]]], sensitive_fields: list[str]) -> list[dict[str, Any]]:
    sample = []
    model_ids = sorted(model_samples.keys())
    for index in range(min(10, len(rows))):
        predictions = {
            model_id: samples[index].get("prediction")
            for model_id, samples in model_samples.items()
            if index < len(samples)
        }
        sample.append(
            {
                "actual": rows[index].get(target),
                "predictions": {model_id: predictions.get(model_id) for model_id in model_ids},
                "input": mask_row({key: value for key, value in rows[index].items() if key != target}, sensitive_fields),
            }
        )
    return sample


def comparison_window_from_request(request: dict[str, Any]) -> dict[str, Any] | None:
    time_column = str(request.get("timeColumn") or request.get("timestampColumn") or "").strip()
    window_start = str(request.get("comparisonWindowStart") or request.get("comparisonStart") or request.get("referenceWindowStart") or request.get("referenceStartDate") or "").strip()
    window_end = str(request.get("comparisonWindowEnd") or request.get("comparisonEnd") or request.get("referenceWindowEnd") or request.get("referenceEndDate") or "").strip()
    if not window_start and not window_end:
        return None
    if not time_column:
        raise WorkerError("Comparação de períodos exige timeColumn quando comparisonWindowStart ou comparisonWindowEnd são informados.")
    return {
        "timeColumn": time_column,
        "start": window_start or None,
        "end": window_end or None,
    }


def temporal_window_from_request(request: dict[str, Any]) -> dict[str, Any] | None:
    time_column = str(request.get("timeColumn") or request.get("timestampColumn") or "").strip()
    window_start = str(request.get("windowStart") or request.get("startDate") or "").strip()
    window_end = str(request.get("windowEnd") or request.get("endDate") or "").strip()
    if not time_column and not window_start and not window_end:
        return None
    if not time_column:
        raise WorkerError("Backtest temporal exige timeColumn quando windowStart ou windowEnd são informados.")
    return {
        "timeColumn": time_column,
        "start": window_start or None,
        "end": window_end or None,
    }


def filter_temporal_window(rows: list[dict[str, Any]], window: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    time_column = str(window["timeColumn"])
    start_ts = parse_temporal_bound(window.get("start"), is_end=False)
    end_ts = parse_temporal_bound(window.get("end"), is_end=True)
    if start_ts is not None and end_ts is not None and start_ts > end_ts:
        raise WorkerError("windowStart não pode ser maior que windowEnd.")
    filtered = []
    invalid_rows = 0
    for row in rows:
        timestamp = parse_temporal_value(row.get(time_column))
        if timestamp is None:
            invalid_rows += 1
            continue
        if start_ts is not None and timestamp < start_ts:
            continue
        if end_ts is not None and timestamp > end_ts:
            continue
        filtered.append(row)
    if not filtered:
        raise WorkerError("Backtest temporal não encontrou linhas dentro da janela configurada.")
    enriched = {
        **window,
        "totalRows": len(rows),
        "matchedRows": len(filtered),
        "excludedRows": len(rows) - len(filtered),
        "invalidRows": invalid_rows,
    }
    return filtered, enriched


def group_rows_by_temporal_window(rows: list[dict[str, Any]], time_column: str, granularity: str) -> list[tuple[dict[str, Any], list[dict[str, Any]]]]:
    if granularity in {"day", "week", "month"}:
        return group_rows_by_calendar_window(rows, time_column, granularity)
    if granularity == "rolling_7d":
        return group_rows_by_rolling_window(rows, time_column, 7)
    if granularity == "rolling_30d":
        return group_rows_by_rolling_window(rows, time_column, 30)
    raise WorkerError(f"windowGranularity deve ser {BACKTEST_WINDOW_GRANULARITY_MESSAGE}.")


def group_rows_by_calendar_window(rows: list[dict[str, Any]], time_column: str, granularity: str) -> list[tuple[dict[str, Any], list[dict[str, Any]]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    metadata: dict[str, dict[str, Any]] = {}
    for row in rows:
        timestamp = parse_temporal_value(row.get(time_column))
        if timestamp is None:
            continue
        parsed = datetime.fromtimestamp(timestamp, timezone.utc)
        if granularity == "day":
            window_id = parsed.date().isoformat()
            window_start = parsed.date()
            window_end = parsed.date()
        elif granularity == "week":
            iso_year, iso_week, _iso_day = parsed.date().isocalendar()
            window_id = f"{iso_year:04d}-W{iso_week:02d}"
            window_start = parsed.date() - timedelta(days=parsed.weekday())
            window_end = window_start + timedelta(days=6)
        else:
            window_id = f"{parsed.year:04d}-{parsed.month:02d}"
            last_day = monthrange(parsed.year, parsed.month)[1]
            window_start = parsed.date().replace(day=1)
            window_end = parsed.date().replace(day=last_day)
        grouped[window_id].append(row)
        metadata[window_id] = {
            "id": window_id,
            "label": window_id,
            "start": window_start.isoformat(),
            "end": window_end.isoformat(),
            "timeColumn": time_column,
            "granularity": granularity,
        }
    return [(metadata[window_id], grouped[window_id]) for window_id in sorted(grouped)]


def group_rows_by_rolling_window(rows: list[dict[str, Any]], time_column: str, days: int) -> list[tuple[dict[str, Any], list[dict[str, Any]]]]:
    parsed_rows: list[tuple[Any, dict[str, Any]]] = []
    for row in rows:
        timestamp = parse_temporal_value(row.get(time_column))
        if timestamp is None:
            continue
        parsed_rows.append((datetime.fromtimestamp(timestamp, timezone.utc).date(), row))
    parsed_rows.sort(key=lambda item: item[0])

    grouped_windows: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    left_index = 0
    right_index = 0
    distinct_end_dates = sorted({row_date for row_date, _row in parsed_rows})
    for end_date in distinct_end_dates:
        start_date = end_date - timedelta(days=days - 1)
        while right_index < len(parsed_rows) and parsed_rows[right_index][0] <= end_date:
            right_index += 1
        while left_index < right_index and parsed_rows[left_index][0] < start_date:
            left_index += 1
        window_rows = [row for _row_date, row in parsed_rows[left_index:right_index]]
        if not window_rows:
            continue
        granularity = f"rolling_{days}d"
        window_id = f"rolling-{days}d-{end_date.isoformat()}"
        grouped_windows.append(
            (
                {
                    "id": window_id,
                    "label": f"{days}d até {end_date.isoformat()}",
                    "start": start_date.isoformat(),
                    "end": end_date.isoformat(),
                    "timeColumn": time_column,
                    "granularity": granularity,
                },
                window_rows,
            )
        )
    return grouped_windows


def evaluate_backtest_window(
    project: dict[str, Any],
    project_root: Path,
    selected_models: list[dict[str, Any]],
    rows: list[dict[str, Any]],
    target: str,
    problem_type: str | None,
    primary_metric: str | None,
    baseline_model_id: str,
    minimize: bool,
    neutral_band: float,
    source_sensitive_fields: list[str],
    window_meta: dict[str, Any],
) -> dict[str, Any]:
    model_metrics: dict[str, dict[str, Any]] = {}
    for model_row in selected_models:
        model_id = str(model_row.get("modelId"))
        evaluated = evaluate_leaderboard_model(project, project_root, model_row, rows, target, problem_type, source_sensitive_fields)
        model_metrics[model_id] = evaluated["metrics"]
    baseline_value = numeric_metric_value(model_metrics.get(baseline_model_id, {}), primary_metric)
    evidence = [
        {
            **model_comparison_evidence(str(model_row.get("modelId")), model_metrics.get(str(model_row.get("modelId")), {}), baseline_model_id, baseline_value, primary_metric, minimize, neutral_band),
            "windowId": window_meta["id"],
        }
        for model_row in selected_models
    ]
    candidate_evidence = [item for item in evidence if item["modelId"] != baseline_model_id]
    best_model_id = choose_best_backtest_model(model_metrics, primary_metric, minimize) or baseline_model_id
    recommended_evidence = next((item for item in evidence if item["modelId"] == best_model_id), None)
    if recommended_evidence and best_model_id != baseline_model_id and recommended_evidence["status"] == "pass":
        recommendation = "promote"
    elif candidate_evidence and all(item["status"] == "fail" for item in candidate_evidence):
        recommendation = "reject"
    else:
        recommendation = "review"
    return {
        **window_meta,
        "rowCount": len(rows),
        "modelMetrics": model_metrics,
        "metrics": summarize_backtest_metrics(model_metrics, primary_metric, baseline_model_id, best_model_id),
        "baselineModelId": baseline_model_id,
        "recommendedModelId": best_model_id,
        "recommendation": recommendation,
        "evidence": evidence,
    }


def compare_backtest_periods(
    project: dict[str, Any],
    project_root: Path,
    selected_models: list[dict[str, Any]],
    comparison_rows: list[dict[str, Any]],
    target: str,
    problem_type: str | None,
    primary_metric: str | None,
    baseline_model_id: str,
    minimize: bool,
    neutral_band: float,
    source_sensitive_fields: list[str],
    current_window: dict[str, Any],
    comparison_window: dict[str, Any],
    current_model_metrics: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    comparison_model_metrics: dict[str, dict[str, Any]] = {}
    for model_row in selected_models:
        model_id = str(model_row.get("modelId"))
        evaluated = evaluate_leaderboard_model(project, project_root, model_row, comparison_rows, target, problem_type, source_sensitive_fields)
        comparison_model_metrics[model_id] = evaluated["metrics"]

    comparison_best_model_id = choose_best_backtest_model(comparison_model_metrics, primary_metric, minimize) or baseline_model_id
    deltas = [
        period_metric_delta(str(model_row.get("modelId")), current_model_metrics.get(str(model_row.get("modelId")), {}), comparison_model_metrics.get(str(model_row.get("modelId")), {}), primary_metric, minimize, neutral_band)
        for model_row in selected_models
    ]
    evidence = [period_comparison_evidence(delta, neutral_band, minimize) for delta in deltas]
    return {
        "currentWindow": current_window,
        "comparisonWindow": comparison_window,
        "rowCount": len(comparison_rows),
        "modelMetrics": comparison_model_metrics,
        "metrics": summarize_backtest_metrics(comparison_model_metrics, primary_metric, baseline_model_id, comparison_best_model_id),
        "baselineModelId": baseline_model_id,
        "recommendedModelId": comparison_best_model_id,
        "deltas": deltas,
        "evidence": evidence,
    }


def period_metric_delta(
    model_id: str,
    current_metrics: dict[str, Any],
    comparison_metrics: dict[str, Any],
    primary_metric: str | None,
    minimize: bool,
    neutral_band: float,
) -> dict[str, Any]:
    current_value = numeric_metric_value(current_metrics, primary_metric)
    comparison_value = numeric_metric_value(comparison_metrics, primary_metric)
    delta = None
    raw_delta = None
    status = "neutral"
    color = "neutral"
    direction = "unavailable"
    reason = "Métrica primária indisponível para comparação entre períodos."
    if current_value is not None and comparison_value is not None:
        raw_delta = round(current_value - comparison_value, 6)
        delta = round(comparison_value - current_value if minimize else current_value - comparison_value, 6)
        if abs(delta) <= neutral_band:
            direction = "stable"
            reason = "Variação entre períodos dentro do threshold neutro."
        elif delta > 0:
            status = "pass"
            color = "green"
            direction = "better"
            reason = "Período atual melhor que o período de referência."
        else:
            status = "fail"
            color = "red"
            direction = "worse"
            reason = "Período atual pior que o período de referência."
    return {
        "modelId": model_id,
        "metric": primary_metric,
        "currentValue": current_value,
        "comparisonValue": comparison_value,
        "rawDelta": raw_delta,
        "delta": delta,
        "direction": direction,
        "status": status,
        "color": color,
        "neutralBand": neutral_band,
        "reason": reason,
    }


def period_comparison_evidence(delta: dict[str, Any], neutral_band: float, minimize: bool) -> dict[str, Any]:
    model_id = str(delta.get("modelId") or "")
    metric = delta.get("metric")
    return {
        "ruleId": f"period-comparison-{model_id}",
        "label": f"Comparação temporal {model_id}",
        "modelId": model_id,
        "metric": metric,
        "value": delta.get("currentValue"),
        "baselineValue": delta.get("comparisonValue"),
        "delta": delta.get("delta"),
        "neutralBand": neutral_band,
        "operator": "<" if minimize else ">",
        "expected": delta.get("comparisonValue"),
        "severity": "warn",
        "status": delta.get("status"),
        "color": delta.get("color"),
        "reason": delta.get("reason"),
        "comparison": "period",
    }


def parse_temporal_bound(value: Any, is_end: bool) -> float | None:
    if value is None or str(value).strip() == "":
        return None
    return parse_temporal_value(value, end_of_day=is_end)


def parse_temporal_value(value: Any, end_of_day: bool = False) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    text = str(value).strip()
    if not text:
        return None
    if re.fullmatch(r"-?\d+(\.\d+)?", text):
        return float(text)
    normalized = text.replace("Z", "+00:00")
    date_only = bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", normalized))
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if date_only and end_of_day:
        parsed = datetime.combine(parsed.date(), datetime_time.max)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def numeric_metric_value(metrics: dict[str, Any], metric_name: str | None) -> float | None:
    if not metric_name:
        return None
    value = metrics.get(metric_name)
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    return None


def metric_should_minimize(metric_name: str | None, problem_type: str | None = None) -> bool:
    if not metric_name:
        return False
    metric = metric_name.lower()
    return metric in {"rmse", "mae", "mse", "log_loss", "latency_p95_ms", "error_rate", "drift_score"} or (problem_type == "regression" and metric != "r2")


def model_comparison_evidence(
    model_id: str,
    metrics: dict[str, Any],
    baseline_model_id: str,
    baseline_value: float | None,
    primary_metric: str | None,
    minimize: bool,
    neutral_band: float,
) -> dict[str, Any]:
    value = numeric_metric_value(metrics, primary_metric)
    evidence = {
        "ruleId": f"backtest-{model_id}",
        "label": f"Backtest {model_id}",
        "modelId": model_id,
        "baselineModelId": baseline_model_id,
        "metric": primary_metric,
        "value": value,
        "baselineValue": baseline_value,
        "neutralBand": neutral_band,
        "operator": "<" if minimize else ">",
        "expected": baseline_value,
        "severity": "block",
    }
    if model_id == baseline_model_id:
        return {**evidence, "status": "neutral", "color": "neutral", "reason": "Modelo baseline da comparação."}
    if value is None or baseline_value is None:
        return {**evidence, "status": "neutral", "color": "neutral", "reason": "Métrica primária indisponível para comparação."}
    delta = baseline_value - value if minimize else value - baseline_value
    if abs(delta) <= neutral_band:
        return {**evidence, "delta": round(delta, 6), "status": "neutral", "color": "neutral", "reason": "Variação dentro do threshold neutro."}
    if delta > 0:
        return {**evidence, "delta": round(delta, 6), "status": "pass", "color": "green", "reason": "Candidato melhor que o baseline fora do threshold neutro."}
    return {**evidence, "delta": round(delta, 6), "status": "fail", "color": "red", "reason": "Candidato pior que o baseline fora do threshold neutro."}


def source_contract_response(source: dict[str, Any], message: str, **extra: Any) -> dict[str, Any]:
    return {
        "status": "contract",
        "kind": "source_preview",
        "sourceId": source.get("id"),
        "sourceType": source.get("type"),
        "message": message,
        **{key: value for key, value in extra.items() if value is not None},
    }


def source_preview_response(source: dict[str, Any], rows: list[dict[str, Any]], limit: int, mode: str = "file", extra: dict[str, Any] | None = None) -> dict[str, Any]:
    sample = rows[:limit]
    masked = [mask_row(row, source.get("sensitiveFields", [])) for row in sample]
    columns = list(rows[0].keys()) if rows else []
    return {
        "status": "ok",
        "kind": "source_preview",
        "sourceId": source.get("id"),
        "sourceType": source.get("type"),
        "mode": mode,
        "rowCount": len(rows),
        "columns": columns,
        "sensitiveFields": source.get("sensitiveFields", []),
        "sample": masked,
        **(extra or {}),
    }


def training_rows_from_source(source: dict[str, Any], project_root: Path, request: dict[str, Any], max_rows: int, allow_external: bool) -> tuple[list[dict[str, Any]], str, dict[str, Any]]:
    mock_rows = request.get("mockRows")
    if isinstance(mock_rows, list):
        return normalize_rows(mock_rows), "mock", {"origin": "request_mock"}

    if source["type"] == "csv":
        csv_config = source.get("csv") or {}
        relative_path = csv_config.get("path")
        if not relative_path:
            raise WorkerError(f"Fonte CSV {source.get('id')} não declara path.")
        csv_path = safe_resolve(project_root, relative_path)
        if not csv_path.exists():
            raise WorkerError(f"Arquivo CSV não encontrado: {relative_path}")
        return read_csv_rows(csv_path, csv_config)[:max_rows], "csv", {
            "path": str(relative_path),
            "delimiter": csv_config.get("delimiter") or ",",
            "encoding": csv_config.get("encoding") or "utf-8",
            "fileSizeBytes": csv_path.stat().st_size,
            "fileModifiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(csv_path.stat().st_mtime)),
        }

    if source["type"] == "sql":
        sql_config = source.get("sql") or {}
        env_name = secret_env_name(sql_config.get("connectionRef", ""))
        database_url = os.getenv(env_name, "") if env_name else ""
        if not database_url:
            raise WorkerError("Treino SQL exige connectionRef env resolvido.")
        if database_url.startswith("sqlite:///"):
            return preview_sqlite(database_url.removeprefix("sqlite:///"), sql_config.get("query", ""), max_rows), "sqlite", sql_source_details(sql_config, "sqlite")
        if not allow_external:
            raise WorkerError("Treino SQL externo exige confirmação real.")
        if database_url.startswith(("postgresql://", "postgres://")):
            if find_spec("psycopg") is None:
                raise WorkerError("Treino PostgreSQL exige pacote psycopg instalado no Python do worker.")
            return preview_postgres(database_url, sql_config.get("query", ""), max_rows), "postgres", sql_source_details(sql_config, "postgres")
        raise WorkerError("Treino SQL suporta sqlite:/// e PostgreSQL neste MVP.")

    if source["type"] == "api":
        mocked = api_mock_preview(source.get("api") or {}, max_rows)
        if mocked and (str(request.get("mode") or "safe").lower() == "mock" or not allow_external):
            rows, _details = mocked
            return rows[:max_rows], "mock", api_source_details(source.get("api") or {}, {**_details, "origin": "persisted_mock"})
        if not allow_external:
            raise WorkerError("Treino por API externa exige confirmação real para usar rede ou mock persistido.")
        rows, details = preview_api(source.get("api") or {}, max_rows)
        return rows[:max_rows], "api", api_source_details(source.get("api") or {}, details)

    raise WorkerError(f"Tipo de fonte não suportado para treino: {source.get('type')}")


def read_csv_rows(csv_path: Path, csv_config: dict[str, Any]) -> list[dict[str, Any]]:
    delimiter = csv_config.get("delimiter") or ","
    encoding = csv_config.get("encoding") or "utf-8"
    with csv_path.open("r", encoding=encoding, newline="") as handle:
        return [dict(row) for row in csv.DictReader(handle, delimiter=delimiter)]


def preview_sqlite(sqlite_path: str, query: str, limit: int) -> list[dict[str, Any]]:
    if not query.strip():
        raise WorkerError("Fonte SQL precisa declarar query.")
    limited_query = f"SELECT * FROM ({query}) LIMIT {limit}"
    connection = sqlite3.connect(sqlite_path)
    try:
        connection.row_factory = sqlite3.Row
        return [dict(row) for row in connection.execute(limited_query).fetchall()]
    finally:
        connection.close()


def preview_postgres(database_url: str, query: str, limit: int) -> list[dict[str, Any]]:
    if not query.strip():
        raise WorkerError("Fonte SQL precisa declarar query.")
    import psycopg
    from psycopg.rows import dict_row

    limited_query = f"SELECT * FROM ({query}) AS mlops_preview_source LIMIT %s"
    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        with connection.cursor() as cursor:
            cursor.execute(limited_query, (limit,))
            return [dict(row) for row in cursor.fetchall()]


def preview_api(api_config: dict[str, Any], limit: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    method = str(api_config.get("method") or "GET").upper()
    if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
        raise WorkerError("Preview de API suporta GET, POST, PUT, PATCH e DELETE neste MVP.")
    url = str(api_config.get("url") or "").strip()
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise WorkerError("URL de API precisa usar http ou https.")
    timeout = max(1, min(int(api_config.get("timeoutSeconds") or 30), 120))
    headers = resolve_api_headers(api_config.get("headers") if isinstance(api_config.get("headers"), dict) else {})
    body = api_config.get("body", api_config.get("bodyTemplate"))
    pagination = api_config.get("pagination") if isinstance(api_config.get("pagination"), dict) else {}
    rows, details = fetch_api_pages(method, url, timeout, headers, body, pagination, limit)
    return rows, details


def fetch_api_pages(method: str, url: str, timeout: int, headers: dict[str, str], body: Any, pagination: dict[str, Any], limit: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    mode = str(pagination.get("mode") or "none").lower()
    if mode not in {"none", "page", "cursor"}:
        raise WorkerError("Paginação de API suporta none, page e cursor.")
    page_param = str(pagination.get("pageParam") or ("cursor" if mode == "cursor" else "page")).strip()
    if mode != "none" and not page_param:
        raise WorkerError("Paginação de API precisa declarar pageParam.")
    cursor_path = str(pagination.get("cursorPath") or "").strip()
    if mode == "cursor" and not cursor_path:
        raise WorkerError("Paginação cursor precisa declarar cursorPath.")

    max_pages = 1 if mode == "none" else min(500, max(2, limit))
    rows: list[dict[str, Any]] = []
    pages_fetched = 0
    next_cursor: Any = None
    seen_cursors: set[str] = set()
    last_status_code: int | None = None
    last_response_kind = "unknown"
    stop_reason = "single_page"

    for index in range(max_pages):
        if mode == "page":
            page_value: Any = index + 1
        elif mode == "cursor":
            page_value = next_cursor
        else:
            page_value = None

        request_url, request_body = api_request_with_pagination(method, url, body, page_param, page_value)
        payload, status_code, response_kind = request_api_payload(method, request_url, timeout, headers, request_body)
        pages_fetched += 1
        last_status_code = status_code
        last_response_kind = response_kind
        page_rows = rows_from_api_payload(payload)
        rows.extend(page_rows)

        if len(rows) >= limit:
            stop_reason = "limit_reached"
            break
        if mode == "none":
            break
        if not page_rows:
            stop_reason = "empty_page"
            break
        if mode == "page":
            stop_reason = "max_pages" if pages_fetched >= max_pages else "next_page"
            continue

        next_cursor = api_value_at_path(payload, cursor_path)
        if next_cursor in (None, ""):
            stop_reason = "no_cursor"
            break
        cursor_key = api_cursor_key(next_cursor)
        if cursor_key in seen_cursors:
            stop_reason = "repeated_cursor"
            break
        seen_cursors.add(cursor_key)
        stop_reason = "max_pages" if pages_fetched >= max_pages else "next_cursor"
    else:
        stop_reason = "max_pages"

    details: dict[str, Any] = {
        "httpStatus": last_status_code,
        "responseKind": last_response_kind,
    }
    if mode != "none":
        details.update(
            {
                "paginationMode": mode,
                "pageParam": page_param,
                "pagesFetched": pages_fetched,
                "paginationStopReason": stop_reason,
            }
        )
        if mode == "cursor":
            details["cursorPath"] = cursor_path
    return rows[:limit], details


def request_api_payload(method: str, url: str, timeout: int, headers: dict[str, str], body: Any) -> tuple[Any, int, str]:
    data = None
    request_headers = dict(headers)
    if api_method_uses_json_body(method, body):
        data = json.dumps(body if isinstance(body, (dict, list)) else {}, ensure_ascii=False).encode("utf-8")
        request_headers.setdefault("Content-Type", "application/json")
    request_headers.setdefault("Accept", "application/json")
    request_headers.setdefault("User-Agent", "MLOps-Flow-Studio/0.1 source-preview")
    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(2 * 1024 * 1024)
            content_type = response.headers.get("content-type", "")
            status_code = response.status
    except urllib.error.HTTPError as exc:
        raise WorkerError(f"API retornou HTTP {exc.code}.") from exc
    except urllib.error.URLError as exc:
        raise WorkerError(f"Falha ao chamar API: {exc.reason}") from exc
    payload = parse_api_payload(raw, content_type)
    return payload, status_code, api_payload_kind(payload)


def api_request_with_pagination(method: str, url: str, body: Any, page_param: str, value: Any) -> tuple[str, Any]:
    if value in (None, ""):
        return url, body
    if api_method_uses_json_body(method, body) and (body is None or isinstance(body, dict)):
        request_body = dict(body or {})
        request_body[page_param] = value
        return url, request_body
    return url_with_query_param(url, page_param, value), body


def api_method_uses_json_body(method: str, body: Any) -> bool:
    return method in {"POST", "PUT", "PATCH"} or (method == "DELETE" and body is not None)


def url_with_query_param(url: str, key: str, value: Any) -> str:
    parsed = urllib.parse.urlparse(url)
    query = [(item_key, item_value) for item_key, item_value in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True) if item_key != key]
    query.append((key, api_query_value(value)))
    return urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(query)))


def api_query_value(value: Any) -> str:
    if isinstance(value, (str, int, float, bool)):
        return str(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def api_cursor_key(value: Any) -> str:
    return api_query_value(value)


def api_value_at_path(payload: Any, path: str) -> Any:
    current = payload
    for part in [item for item in path.split(".") if item]:
        if isinstance(current, dict):
            current = current.get(part)
            continue
        if isinstance(current, list) and part.isdigit():
            index = int(part)
            current = current[index] if 0 <= index < len(current) else None
            continue
        return None
    return current


def api_mock_preview(api_config: dict[str, Any], limit: int) -> tuple[list[dict[str, Any]], dict[str, Any]] | None:
    mock = select_api_mock(api_config)
    if mock is None:
        return None
    response = mock.get("response") if isinstance(mock.get("response"), dict) else {}
    body = response.get("body", response.get("json", response))
    rows = rows_from_api_payload(body)[:limit]
    return rows, {
        "httpStatus": int(response.get("httpStatus") or response.get("statusCode") or 200),
        "responseKind": api_payload_kind(body),
        "mockId": str(mock.get("id") or "mock"),
        "mockDescription": mock.get("description") if isinstance(mock.get("description"), str) else None,
    }


def select_api_mock(api_config: dict[str, Any]) -> dict[str, Any] | None:
    mocks = [item for item in api_config.get("mocks", []) if isinstance(item, dict)]
    if not mocks:
        return None
    method = str(api_config.get("method") or "GET").upper()
    parsed = urllib.parse.urlparse(str(api_config.get("url") or "").strip())
    payload = api_config.get("body", api_config.get("bodyTemplate"))
    for mock in mocks:
        request_spec = mock.get("request") if isinstance(mock.get("request"), dict) else {}
        if mock_request_matches(request_spec, method, parsed, payload):
            return mock
    return mocks[0]


def api_mock_count(api_config: dict[str, Any]) -> int:
    return len([item for item in api_config.get("mocks", []) if isinstance(item, dict)])


class PythonBlockHttpClient:
    def __init__(self, request: dict[str, Any], node_id: str, network_policy: str, allowed_hosts: list[str], mocks: list[dict[str, Any]]):
        self.request_context = request
        self.node_id = node_id
        self.network_policy = network_policy
        self.allowed_hosts = allowed_hosts
        self.mocks = mocks
        self.audit_log: list[dict[str, Any]] = []

    def request(
        self,
        method: str,
        url: str,
        headers: dict[str, Any] | None = None,
        json_body: Any = None,
        body: Any = None,
        timeoutSeconds: int = 30,
        **kwargs: Any,
    ) -> dict[str, Any]:
        if json_body is None and "json" in kwargs:
            json_body = kwargs["json"]
        method = str(method or "GET").upper()
        if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
            raise WorkerError(f"Método HTTP não permitido em bloco Python: {method}")
        parsed = urllib.parse.urlparse(str(url).strip())
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or not parsed.hostname:
            raise WorkerError("Chamada HTTP de bloco Python precisa usar URL http ou https.")

        input_headers = headers if isinstance(headers, dict) else {}
        secret_refs = secret_refs_from_headers(input_headers)
        started = time.perf_counter()
        mock = self.match_mock(method, parsed, json_body if json_body is not None else body)
        if mock is not None:
            result = self.mock_response(method, parsed, mock, started, secret_refs)
            self.audit_log.append({key: value for key, value in result.items() if key != "json" and key != "text"})
            return result

        if self.network_policy == "none":
            raise self.blocked_call(method, parsed, started, secret_refs, "Política de rede none bloqueou chamada externa.")
        if self.network_policy == "allowlist" and not host_allowed(parsed, self.allowed_hosts):
            raise self.blocked_call(method, parsed, started, secret_refs, "Host não está na allowlist do bloco Python.")
        if self.network_policy not in {"allowlist", "open"}:
            raise self.blocked_call(method, parsed, started, secret_refs, f"Política de rede inválida: {self.network_policy}")

        timeout = max(1, min(int(timeoutSeconds or 30), 120))
        resolved_headers = resolve_python_http_headers(input_headers)
        data = None
        if json_body is not None:
            data = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
            resolved_headers.setdefault("Content-Type", "application/json")
        elif body is not None:
            data = body if isinstance(body, bytes) else str(body).encode("utf-8")
        resolved_headers.setdefault("Accept", "application/json")
        resolved_headers.setdefault("User-Agent", "MLOps-Flow-Studio/0.1 python-block")

        request = urllib.request.Request(parsed.geturl(), data=data, headers=resolved_headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read(2 * 1024 * 1024)
                content_type = response.headers.get("content-type", "")
                status_code = response.status
        except urllib.error.HTTPError as exc:
            raise self.failed_call(method, parsed, started, secret_refs, timeout, f"HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise self.failed_call(method, parsed, started, secret_refs, timeout, str(exc.reason)) from exc

        text = raw.decode("utf-8", errors="replace")
        parsed_payload = parse_api_payload(raw, content_type)
        result = {
            "status": "ok",
            "method": method,
            "host": parsed.netloc,
            "path": parsed.path or "/",
            "httpStatus": status_code,
            "durationMs": round((time.perf_counter() - started) * 1000, 3),
            "timeoutSeconds": timeout,
            "secretRefs": secret_refs,
            "responseKind": api_payload_kind(parsed_payload),
            "json": parsed_payload,
            "text": cap_text(text),
        }
        self.audit_log.append({key: value for key, value in result.items() if key != "json" and key != "text"})
        return result

    def match_mock(self, method: str, parsed: urllib.parse.ParseResult, payload: Any) -> dict[str, Any] | None:
        for mock in self.mocks:
            request_spec = mock.get("request") if isinstance(mock.get("request"), dict) else {}
            if mock_request_matches(request_spec, method, parsed, payload):
                return mock
        return None

    def mock_response(self, method: str, parsed: urllib.parse.ParseResult, mock: dict[str, Any], started: float, secret_refs: list[str]) -> dict[str, Any]:
        response = mock.get("response") if isinstance(mock.get("response"), dict) else {}
        status_code = int(response.get("httpStatus") or response.get("statusCode") or 200)
        body = response.get("body", response)
        text = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)
        return {
            "status": "mock",
            "method": method,
            "host": parsed.netloc,
            "path": parsed.path or "/",
            "httpStatus": status_code,
            "durationMs": round((time.perf_counter() - started) * 1000, 3),
            "timeoutSeconds": None,
            "secretRefs": secret_refs,
            "mockId": str(mock.get("id") or "mock"),
            "responseKind": api_payload_kind(body),
            "json": body,
            "text": cap_text(text),
        }

    def blocked_call(self, method: str, parsed: urllib.parse.ParseResult, started: float, secret_refs: list[str], message: str) -> WorkerError:
        self.audit_log.append(
            {
                "status": "blocked",
                "method": method,
                "host": parsed.netloc,
                "path": parsed.path or "/",
                "durationMs": round((time.perf_counter() - started) * 1000, 3),
                "secretRefs": secret_refs,
                "error": message,
            }
        )
        return WorkerError(message)

    def failed_call(self, method: str, parsed: urllib.parse.ParseResult, started: float, secret_refs: list[str], timeout: int, message: str) -> WorkerError:
        self.audit_log.append(
            {
                "status": "error",
                "method": method,
                "host": parsed.netloc,
                "path": parsed.path or "/",
                "durationMs": round((time.perf_counter() - started) * 1000, 3),
                "timeoutSeconds": timeout,
                "secretRefs": secret_refs,
                "error": message,
            }
        )
        return WorkerError(f"Falha em chamada HTTP do bloco Python: {message}")


def emit_python_http_events(request: dict[str, Any], node_id: str, audit_log: list[dict[str, Any]]) -> None:
    for item in audit_log:
        status = str(item.get("status") or "unknown")
        event_type = "python_http_mocked" if status == "mock" else "python_http_blocked" if status == "blocked" else "python_http_failed" if status == "error" else "python_http_called"
        level = "error" if status in {"blocked", "error"} else "info"
        emit_worker_event(
            request,
            event_type,
            f"Chamada HTTP do bloco {node_id}: {status}.",
            level=level,
            nodeId=node_id,
            status=status,
            method=item.get("method"),
            host=item.get("host"),
            path=item.get("path"),
            httpStatus=item.get("httpStatus"),
            durationMs=item.get("durationMs"),
            timeoutSeconds=item.get("timeoutSeconds"),
            secretRefs=item.get("secretRefs"),
            mockId=item.get("mockId"),
            error=item.get("error"),
        )


def mock_request_matches(request_spec: dict[str, Any], method: str, parsed: urllib.parse.ParseResult, payload: Any) -> bool:
    if not request_spec:
        return True
    expected_method = request_spec.get("method")
    if expected_method and str(expected_method).upper() != method:
        return False
    expected_url = request_spec.get("url")
    if expected_url and str(expected_url).strip() != parsed.geturl():
        return False
    expected_host = request_spec.get("host")
    if expected_host and str(expected_host).lower() not in {str(parsed.hostname or "").lower(), parsed.netloc.lower()}:
        return False
    expected_path = request_spec.get("path")
    if expected_path and str(expected_path) != (parsed.path or "/"):
        return False
    expected_body = request_spec.get("body", request_spec.get("json"))
    if expected_body is not None and expected_body != payload:
        return False
    return True


def host_allowed(parsed: urllib.parse.ParseResult, allowed_hosts: list[str]) -> bool:
    host = str(parsed.hostname or "").lower()
    netloc = parsed.netloc.lower()
    path = parsed.path or "/"
    for allowed in allowed_hosts:
        allowed = str(allowed).strip().lower()
        if not allowed:
            continue
        allowed_parsed = urllib.parse.urlparse(allowed if "://" in allowed else f"//{allowed}")
        allowed_host = str(allowed_parsed.hostname or allowed.split("/")[0].split(":")[0]).lower()
        allowed_netloc = allowed_parsed.netloc.lower() if allowed_parsed.netloc else allowed.split("/")[0].lower()
        allowed_path = allowed_parsed.path.rstrip("/")
        host_matches = allowed_host.startswith("*.") and host.endswith(allowed_host[1:]) or host == allowed_host or netloc == allowed_netloc
        path_matches = not allowed_path or path == allowed_path or path.startswith(f"{allowed_path}/")
        if host_matches and path_matches:
            return True
    return False


def resolve_python_http_headers(headers: dict[str, Any]) -> dict[str, str]:
    resolved: dict[str, str] = {}
    for key, value in headers.items():
        header_name = str(key).strip()
        if not header_name:
            continue
        raw_value = str(value)
        env_name = secret_env_name(raw_value)
        if env_name:
            env_value = os.getenv(env_name)
            if env_value is None:
                raise WorkerError(f"Header {header_name} referencia segredo ausente: env:{env_name}.")
            resolved[header_name] = env_value
        else:
            resolved[header_name] = raw_value
    return resolved


def secret_refs_from_headers(headers: dict[str, Any]) -> list[str]:
    refs: list[str] = []
    for value in headers.values():
        env_name = secret_env_name(str(value))
        if env_name:
            refs.append(f"env:{env_name}")
    return sorted(set(refs))


def cap_text(value: str, max_length: int = 64 * 1024) -> str:
    return value if len(value) <= max_length else value[:max_length]


def resolve_api_headers(headers: dict[str, Any]) -> dict[str, str]:
    resolved: dict[str, str] = {}
    for key, value in headers.items():
        header_name = str(key).strip()
        if not header_name:
            continue
        raw_value = str(value)
        env_name = secret_env_name(raw_value)
        if env_name:
            env_value = os.getenv(env_name)
            if env_value is None:
                raise WorkerError(f"Header {header_name} referencia segredo ausente: env:{env_name}.")
            resolved[header_name] = env_value
        else:
            resolved[header_name] = raw_value
    return resolved


def parse_api_payload(raw: bytes, content_type: str) -> Any:
    text = raw.decode("utf-8", errors="replace")
    if "json" in content_type.lower() or text.strip().startswith(("{", "[")):
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise WorkerError("Resposta de API não é JSON válido.") from exc
    return {"text": text}


def rows_from_api_payload(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return rows_from_list(payload)
    if isinstance(payload, dict):
        for key in ("items", "data", "results", "records", "rows"):
            value = payload.get(key)
            if isinstance(value, list):
                return rows_from_list(value)
        return [payload]
    return [{"value": payload}]


def rows_from_list(items: list[Any]) -> list[dict[str, Any]]:
    rows = []
    for item in items:
        if isinstance(item, dict):
            rows.append(item)
        else:
            rows.append({"value": item})
    return rows


def api_payload_kind(payload: Any) -> str:
    if isinstance(payload, list):
        return "array"
    if isinstance(payload, dict):
        for key in ("items", "data", "results", "records", "rows"):
            if isinstance(payload.get(key), list):
                return f"object.{key}"
        return "object"
    return type(payload).__name__


def split_classification_rows(rows: list[dict[str, Any]], target: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row[target])].append(row)
    train_rows = []
    validation_rows = []
    for group_rows in grouped.values():
        if len(group_rows) == 1:
            train_rows.extend(group_rows)
            validation_rows.extend(group_rows)
        else:
            train_rows.extend(group_rows[:-1])
            validation_rows.append(group_rows[-1])
    return train_rows, validation_rows


def split_sequential(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    split_at = max(1, int(len(rows) * 0.8))
    return rows[:split_at], rows[split_at:] or rows[-1:]


def tokenize_row(row: dict[str, Any], target: str, sensitive_fields: list[str]) -> list[str]:
    return re.findall(r"[A-Za-zÀ-ÿ0-9_]+", text_from_row(row, target, sensitive_fields).lower())


def text_from_row(row: dict[str, Any], target: str, sensitive_fields: list[str]) -> str:
    return " ".join(str(value) for key, value in row.items() if key != target and key not in sensitive_fields and value is not None)


def feature_dict_from_row(row: dict[str, Any], target: str, sensitive_fields: list[str]) -> dict[str, Any]:
    features: dict[str, Any] = {}
    for key, value in row.items():
        if key == target or key in sensitive_fields or value is None or value == "":
            continue
        features[key] = parse_feature_value(value)
    return features


def parse_feature_value(value: Any) -> Any:
    if isinstance(value, (int, float, bool)):
        return value
    try:
        return float(str(value).replace(",", "."))
    except ValueError:
        return str(value)


def enrich_model_nodes_with_embedding_config(pipeline: dict[str, Any], model_nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    nodes_by_id = {str(node.get("id")): node for node in pipeline.get("nodes", []) if isinstance(node, dict)}
    incoming: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for edge in pipeline.get("edges", []):
        if isinstance(edge, dict):
            incoming[str(edge.get("to") or "")].append(edge)
    enriched = []
    for model_node in model_nodes:
        model_id = str(model_node.get("id") or "")
        embedding_node = next(
            (
                nodes_by_id.get(str(edge.get("from") or ""))
                for edge in incoming.get(model_id, [])
                if nodes_by_id.get(str(edge.get("from") or ""), {}).get("type") == "embedding"
            ),
            None,
        )
        config = model_node.get("config") if isinstance(model_node.get("config"), dict) else {}
        embedding_config = config.get("embedding") if isinstance(config.get("embedding"), dict) else None
        if embedding_node is not None:
            embedding_node_config = embedding_node.get("config") if isinstance(embedding_node.get("config"), dict) else {}
            enabled = embedding_node_config.get("enabled")
            if enabled is not False:
                embedding_config = {
                    "nodeId": embedding_node.get("id"),
                    "framework": embedding_node.get("framework"),
                    **embedding_node_config,
                    **(embedding_config or {}),
                }
        if embedding_config and embedding_config.get("enabled") is not False:
            enriched.append({**model_node, "__embeddingConfig": embedding_config})
        else:
            enriched.append(model_node)
    return enriched


def should_train_sentence_transformers_model(node: dict[str, Any]) -> bool:
    config = node.get("config") if isinstance(node.get("config"), dict) else {}
    embedding_config = node.get("__embeddingConfig") if isinstance(node.get("__embeddingConfig"), dict) else config.get("embedding") if isinstance(config.get("embedding"), dict) else {}
    framework = str(embedding_config.get("framework") or embedding_config.get("backend") or "").lower()
    model_name = str(embedding_config.get("model") or embedding_config.get("modelName") or embedding_config.get("embeddingModel") or "").lower()
    return bool(embedding_config) and (
        framework in {"sentence-transformers", "sentence_transformers", "bert", "transformers"}
        or "sentence-transformers" in model_name
        or "bert" in model_name
    )


def should_train_sklearn_classifier(node: dict[str, Any]) -> bool:
    config = node.get("config") if isinstance(node.get("config"), dict) else {}
    framework = str(node.get("framework") or config.get("framework") or "").lower()
    algorithm = str(node.get("algorithm") or config.get("algorithm") or "").lower()
    backend = str(config.get("trainingBackend") or config.get("backend") or "").lower()
    return backend in {"sklearn", "scikit-learn"} or framework in {"sklearn", "scikit-learn"} or algorithm in {"logistic_regression", "linear_model", "sklearn_logistic_regression"}


def should_train_xgboost_classifier(node: dict[str, Any]) -> bool:
    config = node.get("config") if isinstance(node.get("config"), dict) else {}
    framework = str(node.get("framework") or config.get("framework") or "").lower()
    algorithm = str(node.get("algorithm") or config.get("algorithm") or "").lower()
    backend = str(config.get("trainingBackend") or config.get("backend") or "").lower()
    task = str(node.get("task") or config.get("task") or "").lower()
    return (
        backend in {"xgboost", "xgb"}
        or framework in {"xgboost", "xgb"}
        or algorithm in {"xgboost", "xgb", "xgb_classifier", "xgboost_classifier"}
        or (algorithm in {"xgbclassifier", "xgb_classifier"} and "regression" not in task)
    )


def should_train_sklearn_regressor(node: dict[str, Any]) -> bool:
    config = node.get("config") if isinstance(node.get("config"), dict) else {}
    framework = str(node.get("framework") or config.get("framework") or "").lower()
    algorithm = str(node.get("algorithm") or config.get("algorithm") or "").lower()
    backend = str(config.get("trainingBackend") or config.get("backend") or "").lower()
    return backend in {"sklearn", "scikit-learn"} or framework in {"sklearn", "scikit-learn"} or algorithm in {"ridge", "ridge_regression", "linear_regression"}


def should_train_xgboost_regressor(node: dict[str, Any]) -> bool:
    config = node.get("config") if isinstance(node.get("config"), dict) else {}
    framework = str(node.get("framework") or config.get("framework") or "").lower()
    algorithm = str(node.get("algorithm") or config.get("algorithm") or "").lower()
    backend = str(config.get("trainingBackend") or config.get("backend") or "").lower()
    task = str(node.get("task") or config.get("task") or "").lower()
    return (
        backend in {"xgboost", "xgb"}
        or framework in {"xgboost", "xgb"}
        or algorithm in {"xgboost", "xgb", "xgboost_regressor", "xgb_regressor", "xgbregressor"}
        or (algorithm in {"xgboost", "xgb"} and "regression" in task)
    )


def sklearn_available() -> bool:
    return find_spec("sklearn") is not None


def xgboost_available() -> bool:
    return find_spec("xgboost") is not None


def sentence_transformers_available() -> bool:
    return find_spec("sentence_transformers") is not None


def sentence_transformer_training_config(project: dict[str, Any], node: dict[str, Any]) -> dict[str, Any]:
    config = node.get("config") if isinstance(node.get("config"), dict) else {}
    embedding_config = node.get("__embeddingConfig") if isinstance(node.get("__embeddingConfig"), dict) else config.get("embedding") if isinstance(config.get("embedding"), dict) else {}
    model_name = (
        embedding_config.get("model")
        or embedding_config.get("modelName")
        or embedding_config.get("embeddingModel")
        or "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
    )
    execution_profile = str(project.get("execution", {}).get("profile") or "cpu").lower()
    device = embedding_config.get("device")
    if not device and execution_profile == "gpu_cuda":
        device = "cuda"
    return {
        **config,
        **embedding_config,
        "embeddingModel": str(model_name),
        "device": device,
        "normalizeEmbeddings": embedding_config.get("normalizeEmbeddings", embedding_config.get("normalize", True)),
    }


def sentence_transformer_fine_tuning_plan(
    project: dict[str, Any],
    config: dict[str, Any],
    task: str,
    train_rows: list[dict[str, Any]],
    validation_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    fine_config = config.get("fineTuning") if isinstance(config.get("fineTuning"), dict) else {}
    enabled = bool(config.get("fineTune") or fine_config.get("enabled") or fine_config.get("mode") in {"finetune", "fine_tune"})
    if not enabled:
        return {"enabled": False, "status": "disabled"}
    execution_profile = str(project.get("execution", {}).get("profile") or "cpu").lower()
    device = str(fine_config.get("device") or config.get("device") or ("cuda" if execution_profile == "gpu_cuda" else "cpu"))
    epochs = bounded_int(fine_config.get("epochs") or fine_config.get("numEpochs") or config.get("fineTuneEpochs") or 1, 1, 20, "fineTuning.epochs")
    batch_size = bounded_int(fine_config.get("batchSize") or fine_config.get("batch_size") or config.get("batchSize") or 8, 1, 256, "fineTuning.batchSize")
    max_rows = bounded_int(fine_config.get("maxRows") or fine_config.get("max_rows") or 2000, 1, 200000, "fineTuning.maxRows")
    learning_rate = float(fine_config.get("learningRate") or fine_config.get("learning_rate") or 2e-5)
    execute = bool(fine_config.get("execute") or fine_config.get("executeFineTuning"))
    env_guard = os.getenv("MLOPS_ENABLE_BERT_FINE_TUNING") == "true"
    status = "ready_for_execution" if execute and env_guard else "planned"
    reason = None
    if execute and not env_guard:
        status = "blocked_by_env_guard"
        reason = "Execução real exige MLOPS_ENABLE_BERT_FINE_TUNING=true para evitar fine-tuning BERT acidental."
    if task != "classification" and execute:
        status = "planned"
        reason = "Execução automática de fine-tuning está limitada a classificação; regressão mantém plano auditável."
    return {
        "enabled": True,
        "status": status,
        "task": task,
        "embeddingModel": str(config.get("embeddingModel") or config.get("model") or ""),
        "device": device,
        "requiresGpu": bool(fine_config.get("requiresGpu") or fine_config.get("gpuRequired") or device == "cuda"),
        "executionProfile": execution_profile,
        "epochs": epochs,
        "batchSize": batch_size,
        "learningRate": learning_rate,
        "maxRows": max_rows,
        "trainRowsPlanned": min(len(train_rows), max_rows),
        "validationRows": len(validation_rows),
        "mixedPrecision": bool(fine_config.get("mixedPrecision") or fine_config.get("fp16") or device == "cuda"),
        "gradientCheckpointing": bool(fine_config.get("gradientCheckpointing") or fine_config.get("gradient_checkpointing")),
        "executeRequested": execute,
        "envGuard": "MLOPS_ENABLE_BERT_FINE_TUNING",
        "reason": reason,
    }


def bounded_int(value: Any, minimum: int, maximum: int, field_name: str) -> int:
    try:
        parsed = int(value)
    except Exception as exc:
        raise WorkerError(f"{field_name} deve ser inteiro entre {minimum} e {maximum}.") from exc
    if parsed < minimum or parsed > maximum:
        raise WorkerError(f"{field_name} deve ser inteiro entre {minimum} e {maximum}.")
    return parsed


def sentence_transformer_artifact_config_matches(artifact: dict[str, Any], config: dict[str, Any]) -> bool:
    return (
        str(artifact.get("embeddingModel") or "") == str(config.get("embeddingModel") or config.get("model") or "")
        and bool(artifact.get("normalizeEmbeddings", True)) == bool(config.get("normalizeEmbeddings", True))
    )


def encode_sentence_transformer_rows(rows: list[dict[str, Any]], target: str, sensitive_fields: list[str], config: dict[str, Any]) -> Any:
    texts = [text_from_row(row, target, sensitive_fields) for row in rows]
    model = load_sentence_transformer_model(str(config.get("embeddingModel") or config.get("model") or "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"), config.get("device"))
    kwargs = {
        "batch_size": int(config.get("batchSize") or config.get("batch_size") or 32),
        "show_progress_bar": False,
        "convert_to_numpy": True,
        "normalize_embeddings": bool(config.get("normalizeEmbeddings", True)),
    }
    try:
        return model.encode(texts, **kwargs)
    except TypeError:
        return model.encode(texts)


def load_sentence_transformer_model(model_name: str, device: Any = None) -> Any:
    try:
        from sentence_transformers import SentenceTransformer
    except Exception as exc:
        raise WorkerError("Pacote sentence-transformers não está instalado no Python do worker.") from exc
    if device:
        return SentenceTransformer(model_name, device=str(device))
    return SentenceTransformer(model_name)


def encode_pickle_base64(value: Any) -> str:
    return base64.b64encode(pickle.dumps(value)).decode("ascii")


def decode_pickle_base64(value: str) -> Any:
    if not value:
        raise WorkerError("Artefato serializado está vazio.")
    return pickle.loads(base64.b64decode(value.encode("ascii")))


def python_package_versions(packages: list[str]) -> dict[str, str]:
    try:
        from importlib.metadata import version
    except ImportError:
        return {}
    versions: dict[str, str] = {}
    for package in packages:
        try:
            versions[package] = version(package)
        except Exception:
            continue
    return versions


def maybe_log_mlflow(project: dict[str, Any], project_root: Path, result: dict[str, Any]) -> dict[str, Any]:
    mlflow_config = project.get("runtime", {}).get("mlflow", {})
    if not isinstance(mlflow_config, dict) or not mlflow_config.get("enabled"):
        return {"enabled": False, "status": "disabled"}
    if find_spec("mlflow") is None:
        return {"enabled": True, "status": "unavailable", "reason": "Pacote mlflow não instalado no Python do worker."}

    tracking_uri = resolve_mlflow_tracking_uri(mlflow_config)
    if not tracking_uri:
        return {"enabled": True, "status": "unavailable", "reason": "MLflow habilitado, mas tracking URI não foi resolvida."}

    try:
        import mlflow

        experiment_name = mlflow_config.get("experimentName") or project.get("id") or "mlops-flow-studio"
        mlflow.set_tracking_uri(tracking_uri)
        mlflow.set_experiment(str(experiment_name))
        with mlflow.start_run(run_name=str(result.get("runId"))) as run:
            mlflow.set_tags(
                {
                    "mlops.project_id": str(project.get("id")),
                    "mlops.project_version": str(project.get("version")),
                    "mlops.source_id": str(result.get("sourceId")),
                    "mlops.problem_type": str(result.get("problemType")),
                    "mlops.best_model_id": str(result.get("bestModelId")),
                    "mlops.primary_metric": str(result.get("primaryMetric")),
                    "mlops.contract": str(project.get("contract", "mlops-flow-v1")),
                }
            )
            best = best_leaderboard_row(result)
            if best:
                mlflow.log_params(
                    {
                        "best_model_id": best.get("modelId"),
                        "best_algorithm": best.get("algorithm"),
                        "best_training_backend": best.get("trainingBackend"),
                        "best_trained_algorithm": best.get("trainedAlgorithm"),
                        "training_rows": best.get("trainingRows"),
                        "validation_rows": best.get("validationRows"),
                    }
                )
                for metric_name, value in (best.get("metrics") or {}).items():
                    if isinstance(value, (int, float)):
                        mlflow.log_metric(safe_mlflow_key(str(metric_name)), float(value))

            for row in result.get("leaderboard", []):
                if not isinstance(row, dict):
                    continue
                model_id = safe_mlflow_key(str(row.get("modelId", "model")))
                for metric_name, value in (row.get("metrics") or {}).items():
                    if isinstance(value, (int, float)):
                        mlflow.log_metric(f"{model_id}.{safe_mlflow_key(str(metric_name))}", float(value))

            for artifact in result.get("artifacts", []):
                if not isinstance(artifact, dict) or not artifact.get("path"):
                    continue
                artifact_path = safe_resolve(project_root, str(artifact["path"]))
                if artifact_path.exists():
                    mlflow.log_artifact(str(artifact_path), artifact_path=f"models/{safe_mlflow_key(str(artifact.get('modelId', 'model')))}")

            return {
                "enabled": True,
                "status": "logged",
                "trackingUri": tracking_uri,
                "experimentName": str(experiment_name),
                "runId": run.info.run_id,
                "runName": result.get("runId"),
                "artifactUri": run.info.artifact_uri,
            }
    except Exception as exc:
        return {
            "enabled": True,
            "status": "error",
            "trackingUri": tracking_uri,
            "message": str(exc),
        }


def resolve_mlflow_tracking_uri(mlflow_config: dict[str, Any]) -> str | None:
    direct = mlflow_config.get("trackingUri") or mlflow_config.get("trackingURI")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()
    ref = mlflow_config.get("trackingUriRef")
    if isinstance(ref, str) and ref.startswith("env:"):
        value = os.getenv(ref.removeprefix("env:"), "").strip()
        return value or None
    if isinstance(ref, str) and ref.strip() and not ref.startswith("env:"):
        return ref.strip()
    return None


def best_leaderboard_row(result: dict[str, Any]) -> dict[str, Any] | None:
    best_model_id = result.get("bestModelId")
    for row in result.get("leaderboard", []):
        if isinstance(row, dict) and row.get("modelId") == best_model_id:
            return row
    for row in result.get("leaderboard", []):
        if isinstance(row, dict):
            return row
    return None


def safe_mlflow_key(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("._-") or "metric"


def emit_worker_event(request: dict[str, Any] | None, event_type: str, message: str, level: str = "info", **fields: Any) -> None:
    if not isinstance(request, dict) or request.get("emitEvents") is not True:
        return
    event = {
        "kind": "worker_event",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "level": level,
        "type": event_type,
        "message": message,
        **{key: json_safe(value) for key, value in fields.items() if value is not None},
    }
    print(json.dumps(event, ensure_ascii=False, sort_keys=True), file=sys.stderr, flush=True)


def emit_source_preview_event(request: dict[str, Any], result: dict[str, Any]) -> None:
    status = str(result.get("status") or "unknown")
    level = "warning" if status in {"contract", "missing"} else "error" if status == "error" else "info"
    emit_worker_event(
        request,
        "source_preview_completed",
        f"Preview de {result.get('sourceId')} retornou {status}.",
        level=level,
        sourceId=result.get("sourceId"),
        sourceType=result.get("sourceType"),
        mode=result.get("mode"),
        status=status,
        rowCount=result.get("rowCount"),
        columnCount=len(result.get("columns") or []),
        previewMessage=result.get("message"),
    )


def emit_model_trained_event(request: dict[str, Any] | None, run_id: str, row: dict[str, Any]) -> None:
    metrics = row.get("metrics") if isinstance(row.get("metrics"), dict) else {}
    emit_worker_event(
        request,
        "model_trained",
        f"Modelo {row.get('modelId')} treinado.",
        runId=run_id,
        modelId=row.get("modelId"),
        label=row.get("label"),
        algorithm=row.get("algorithm"),
        trainingBackend=row.get("trainingBackend"),
        trainedAlgorithm=row.get("trainedAlgorithm"),
        metrics=metrics,
        trainingRows=row.get("trainingRows"),
        validationRows=row.get("validationRows"),
    )


def json_safe(value: Any) -> Any:
    if isinstance(value, (str, int, bool)) or value is None:
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_safe(item) for item in value]
    return str(value)


def canonical_json_hash(value: Any) -> str:
    payload = json.dumps(json_safe(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def normalize_rows(rows: list[Any]) -> list[dict[str, Any]]:
    return [row for row in rows if isinstance(row, dict)]


def mask_row(row: dict[str, Any], sensitive_fields: list[str]) -> dict[str, Any]:
    return {key: "***" if key in sensitive_fields else value for key, value in row.items()}


def infer_snapshot_value_type(value: Any) -> str:
    if value is None or value == "":
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int) and not isinstance(value, bool):
        return "integer"
    if isinstance(value, float):
        return "number"
    text = str(value)
    try:
        int(text)
        return "integer"
    except ValueError:
        pass
    try:
        float(text.replace(",", "."))
        return "number"
    except ValueError:
        return "string"


def dataset_schema_profile(rows: list[dict[str, Any]], sensitive_fields: list[str]) -> list[dict[str, Any]]:
    columns = sorted({str(key) for row in rows for key in row.keys()})
    schema = []
    for column in columns:
        observed_types = sorted({infer_snapshot_value_type(row.get(column)) for row in rows if row.get(column) not in (None, "")})
        schema.append(
            {
                "name": column,
                "type": observed_types[0] if len(observed_types) == 1 else "mixed" if observed_types else "null",
                "nullable": any(row.get(column) in (None, "") for row in rows),
                "nonNullCount": sum(1 for row in rows if row.get(column) not in (None, "")),
                "sensitive": column in sensitive_fields,
            }
        )
    return schema


def dataset_quality_profile(rows: list[dict[str, Any]], target: str, sensitive_fields: list[str]) -> dict[str, Any]:
    columns = sorted({str(key) for row in rows for key in row.keys()})
    masked_hashes = [canonical_json_hash(mask_row(row, sensitive_fields)) for row in rows]
    duplicate_count = len(masked_hashes) - len(set(masked_hashes))
    return {
        "rowCount": len(rows),
        "columnCount": len(columns),
        "targetMissingCount": sum(1 for row in rows if str(row.get(target, "")).strip() == ""),
        "missingByColumn": {column: sum(1 for row in rows if row.get(column) in (None, "")) for column in columns},
        "nonNullByColumn": {column: sum(1 for row in rows if row.get(column) not in (None, "")) for column in columns},
        "duplicateMaskedRowCount": duplicate_count,
    }


def sql_source_details(sql_config: dict[str, Any], connection_kind: str) -> dict[str, Any]:
    query = str(sql_config.get("query") or "")
    return {
        "connectionKind": connection_kind,
        "connectionRef": sql_config.get("connectionRef"),
        "queryHash": canonical_json_hash(query),
        "queryLength": len(query),
    }


def api_url_descriptor(url: str) -> dict[str, Any]:
    parsed = urllib.parse.urlparse(url)
    return {
        "scheme": parsed.scheme,
        "host": parsed.netloc,
        "path": parsed.path,
        "queryParamNames": sorted(urllib.parse.parse_qs(parsed.query).keys()),
    }


def api_source_details(api_config: dict[str, Any], fetch_details: dict[str, Any]) -> dict[str, Any]:
    headers = api_config.get("headers") if isinstance(api_config.get("headers"), dict) else {}
    body = api_config.get("body", api_config.get("bodyTemplate"))
    pagination = api_config.get("pagination") if isinstance(api_config.get("pagination"), dict) else {}
    return {
        "method": str(api_config.get("method") or "GET").upper(),
        "url": api_url_descriptor(str(api_config.get("url") or "")),
        "timeoutSeconds": api_config.get("timeoutSeconds"),
        "headerNames": sorted(str(key) for key in headers.keys()),
        "bodyTemplateHash": canonical_json_hash(body) if body not in (None, "") else None,
        "pagination": {
            "mode": pagination.get("mode") or "none",
            "pageParam": pagination.get("pageParam"),
            "cursorPath": pagination.get("cursorPath"),
        },
        "fetch": json_safe(fetch_details),
    }


def dataset_snapshot_mode(request: dict[str, Any]) -> str:
    raw_mode = str(request.get("datasetSnapshotMode") or "manifest").strip().lower()
    aliases = {
        "none": "manifest",
        "manifest_only": "manifest",
        "masked": "masked_rows",
        "masked_rows": "masked_rows",
        "full": "full_rows",
        "full_rows": "full_rows",
    }
    mode = aliases.get(raw_mode, raw_mode)
    if mode not in DATASET_SNAPSHOT_MODES:
        raise WorkerError("datasetSnapshotMode deve ser manifest, masked_rows ou full_rows.")
    return mode


def dataset_snapshot_retention_days(request: dict[str, Any]) -> int | None:
    value = request.get("datasetSnapshotRetentionDays")
    if value in (None, ""):
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value < 1 or value > 3650:
        raise WorkerError("datasetSnapshotRetentionDays deve ser inteiro entre 1 e 3650.")
    return value


def dataset_snapshot_retention(created_at: str, retention_days: int | None) -> dict[str, Any]:
    if retention_days is None:
        return {"policy": "manual"}
    created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    expires_at = created + timedelta(days=retention_days)
    return {
        "policy": "delete_after_days",
        "days": retention_days,
        "expiresAt": expires_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def write_dataset_rows_artifact(
    project_root: Path,
    artifact_dir: Path,
    dataset_version_id: str,
    rows: list[dict[str, Any]],
    masked_rows: list[dict[str, Any]],
    mode: str,
    created_at: str,
    retention_days: int | None,
) -> dict[str, Any]:
    if mode == "manifest":
        return {
            "available": False,
            "mode": "manifest",
            "format": "jsonl",
            "reason": "datasetSnapshotMode não solicitou materialização de linhas",
        }
    snapshot_rows = rows if mode == "full_rows" else masked_rows
    rows_path = artifact_dir / f"{safe_file_segment(dataset_version_id)}.rows.jsonl"
    payload = "\n".join(json.dumps(json_safe(row), ensure_ascii=False, sort_keys=True) for row in snapshot_rows)
    if payload:
        payload = f"{payload}\n"
    rows_path.write_text(payload, encoding="utf-8")
    return {
        "available": True,
        "mode": mode,
        "format": "jsonl",
        "path": relative_to_project(project_root, rows_path),
        "rowCount": len(snapshot_rows),
        "digest": canonical_json_hash(snapshot_rows),
        "sensitiveFieldsRetained": mode == "full_rows",
        "retention": dataset_snapshot_retention(created_at, retention_days),
    }


def preview_value(value: dict[str, Any]) -> dict[str, Any]:
    return {"keys": sorted(value.keys()), "size": len(value)}


def first_csv_source_id(project: dict[str, Any]) -> str | None:
    for source in project.get("dataSources", []):
        if source.get("type") == "csv":
            return source.get("id")
    return None


def first_trainable_source_id(project: dict[str, Any]) -> str | None:
    for preferred_type in ("csv", "sql", "api"):
        for source in project.get("dataSources", []):
            if source.get("type") == preferred_type:
                return source.get("id")
    return None


def find_source(project: dict[str, Any], source_id: str) -> dict[str, Any]:
    for source in project.get("dataSources", []):
        if source.get("id") == source_id:
            return source
    raise WorkerError(f"Fonte não encontrada: {source_id}")


def find_node(pipeline: dict[str, Any], node_id: str) -> dict[str, Any]:
    for node in pipeline.get("nodes", []):
        if node.get("id") == node_id:
            return node
    raise WorkerError(f"Nó não encontrado: {node_id}")


def load_python_code(project_root: Path, python_block: dict[str, Any]) -> str:
    if python_block.get("codeInline"):
        code = str(python_block["codeInline"])
        if "\\n" in code and "\n" not in code:
            code = code.replace("\\n", "\n")
        return code
    if python_block.get("codePath"):
        return safe_resolve(project_root, str(python_block["codePath"])).read_text(encoding="utf-8")
    raise WorkerError("Bloco Python não declara codeInline nem codePath.")


def audit_python_block_code(code: str, network_policy: str) -> dict[str, Any]:
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        raise WorkerError(f"Bloco Python inválido: {exc.msg}.") from exc

    imported_modules: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported_modules.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported_modules.append(node.module or "")
        elif isinstance(node, ast.Call):
            call_name = python_call_name(node.func)
            if call_name in BLOCKED_PYTHON_BLOCK_CALLS:
                raise WorkerError(f"Chamada direta {call_name} não é permitida em bloco Python; use contratos e helpers auditáveis.")

    for module_name in imported_modules:
        root_module = module_name.split(".")[0]
        if network_policy != "open":
            raise WorkerError("Imports em bloco Python exigem networkPolicy open e continuam sujeitos à auditoria de segurança.")
        if root_module in BLOCKED_PYTHON_BLOCK_IMPORT_PREFIXES or module_name in BLOCKED_PYTHON_BLOCK_IMPORT_PREFIXES:
            raise WorkerError(f"Import direto de {module_name} não é permitido em bloco Python; use context['http_request'] para rede auditável.")
        if root_module not in SAFE_PYTHON_BLOCK_IMPORTS:
            raise WorkerError(f"Import {module_name} não está na allowlist de blocos Python.")

    return {"importCount": len(imported_modules), "imports": imported_modules}


def python_call_name(func: ast.AST) -> str:
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return ""


def builtins_for_policy(network_policy: str) -> dict[str, Any]:
    allowed = {
        "abs": abs,
        "bool": bool,
        "dict": dict,
        "enumerate": enumerate,
        "Exception": Exception,
        "float": float,
        "int": int,
        "len": len,
        "list": list,
        "max": max,
        "min": min,
        "print": print,
        "range": range,
        "round": round,
        "set": set,
        "sorted": sorted,
        "str": str,
        "sum": sum,
        "tuple": tuple,
        "ValueError": ValueError,
        "zip": zip,
    }
    if network_policy == "open":
        allowed["__import__"] = __import__
    return allowed


def load_request_context(request: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], Path]:
    project = request.get("project")
    pipeline = request.get("pipeline")
    if not isinstance(project, dict):
        raise WorkerError("Request precisa de project.")
    if not isinstance(pipeline, dict):
        raise WorkerError("Request precisa de pipeline.")
    project_root = Path(require_string(request, "projectRoot")).resolve()
    if not project_root.exists():
        raise WorkerError(f"projectRoot não existe: {project_root}")
    return project, pipeline, project_root


def safe_resolve(root: Path, relative_path: str) -> Path:
    if not relative_path:
        raise WorkerError("Caminho relativo vazio.")
    target = (root / relative_path).resolve()
    if target != root and root not in target.parents:
        raise WorkerError(f"Caminho fora do projeto: {relative_path}")
    return target


def require_string(request: dict[str, Any], name: str) -> str:
    value = request.get(name)
    if not isinstance(value, str) or not value.strip():
        raise WorkerError(f"{name} é obrigatório.")
    return value


def secret_env_name(secret_ref: str) -> str | None:
    if secret_ref.startswith("env:"):
        return secret_ref.removeprefix("env:")
    return None


def write_dataset_version(
    project_root: Path,
    run_id: str,
    project: dict[str, Any],
    source: dict[str, Any],
    source_mode: str,
    source_details: dict[str, Any],
    rows: list[dict[str, Any]],
    target: str,
    request: dict[str, Any],
) -> dict[str, Any]:
    source_id = str(source.get("id") or "source")
    sensitive_fields = list(dict.fromkeys([*project.get("sensitiveFields", []), *source.get("sensitiveFields", [])]))
    schema = dataset_schema_profile(rows, sensitive_fields)
    masked_rows = [mask_row(row, sensitive_fields) for row in rows]
    dataset_version_id = f"dataset-{safe_file_segment(run_id)}-{safe_file_segment(source_id)}"
    snapshot_mode = dataset_snapshot_mode(request)
    retention_days = dataset_snapshot_retention_days(request)
    if snapshot_mode == "full_rows" and request.get("allowSensitiveDatasetSnapshot") is not True:
        raise WorkerError("Snapshot de dataset com linhas completas exige allowSensitiveDatasetSnapshot=true.")
    artifact_dir = project_root / "artifacts" / "dataset_versions"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    created_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    row_artifact = write_dataset_rows_artifact(project_root, artifact_dir, dataset_version_id, rows, masked_rows, snapshot_mode, created_at, retention_days)
    payload = {
        "id": dataset_version_id,
        "kind": "dataset_version",
        "projectId": project.get("id"),
        "runId": run_id,
        "sourceId": source_id,
        "sourceType": source.get("type"),
        "sourceMode": source_mode,
        "target": target,
        "createdAt": created_at,
        "rowCount": len(rows),
        "columns": [item["name"] for item in schema],
        "schema": schema,
        "schemaHash": canonical_json_hash(schema),
        "rowDigest": canonical_json_hash(masked_rows),
        "sourceDescriptor": {
            "label": source.get("label"),
            "type": source.get("type"),
            "mode": source_mode,
            **json_safe(source_details),
        },
        "quality": dataset_quality_profile(rows, target, sensitive_fields),
        "lineage": {
            "operation": "train-baseline",
            "inputSourceId": source_id,
            "trainingRunId": run_id,
        },
        "rowArtifact": row_artifact,
        "sample": masked_rows[:5],
    }
    file_path = artifact_dir / f"{safe_file_segment(dataset_version_id)}.json"
    file_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "kind": "dataset_version",
        "datasetVersionId": dataset_version_id,
        "path": relative_to_project(project_root, file_path),
        "rowCount": len(rows),
        "schemaHash": payload["schemaHash"],
        "rowDigest": payload["rowDigest"],
        "sourceMode": source_mode,
        "rowArtifact": row_artifact,
    }


def write_model_artifact(project_root: Path, run_id: str, model_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    artifact_dir = project_root / "artifacts" / "training_runs" / run_id
    artifact_dir.mkdir(parents=True, exist_ok=True)
    file_path = artifact_dir / f"{safe_file_segment(model_id)}.model.json"
    file_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"kind": "model", "modelId": model_id, "path": relative_to_project(project_root, file_path)}


def write_training_result(project_root: Path, result: dict[str, Any]) -> None:
    run_id = str(result["runId"])
    artifact_dir = project_root / "artifacts" / "training_runs" / run_id
    artifact_dir.mkdir(parents=True, exist_ok=True)
    result_path = artifact_dir / "training-result.json"
    payload = {**result, "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    result_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def latest_training_run_id(project_root: Path) -> str | None:
    runs_root = project_root / "artifacts" / "training_runs"
    if not runs_root.exists():
        return None
    candidates = [item for item in runs_root.iterdir() if item.is_dir() and (item / "training-result.json").exists()]
    if not candidates:
        return None
    return max(candidates, key=lambda item: (item / "training-result.json").stat().st_mtime).name


def latest_training_result(project_root: Path) -> dict[str, Any] | None:
    run_id = latest_training_run_id(project_root)
    return load_training_result(project_root, run_id) if run_id else None


def load_training_result(project_root: Path, run_id: str) -> dict[str, Any]:
    result_path = project_root / "artifacts" / "training_runs" / safe_file_segment(run_id) / "training-result.json"
    if not result_path.exists():
        raise WorkerError(f"training-result.json não encontrado para {run_id}.")
    loaded = json.loads(result_path.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict):
        raise WorkerError(f"training-result.json inválido para {run_id}.")
    return loaded


def load_model_artifact(project_root: Path, artifact_uri: str) -> dict[str, Any]:
    artifact_path = safe_resolve(project_root, artifact_uri)
    if not artifact_path.exists():
        raise WorkerError(f"Artefato de modelo não encontrado: {artifact_uri}")
    loaded = json.loads(artifact_path.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict):
        raise WorkerError(f"Artefato de modelo inválido: {artifact_uri}")
    return loaded


def write_evaluation_result(project_root: Path, result: dict[str, Any]) -> None:
    evaluation_id = str(result["evaluationId"])
    artifact_dir = project_root / "artifacts" / "evaluation_runs" / evaluation_id
    artifact_dir.mkdir(parents=True, exist_ok=True)
    payload = {**result, "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    (artifact_dir / "evaluation-result.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    snapshots_dir = project_root / "artifacts" / "metric_snapshots"
    snapshots_dir.mkdir(parents=True, exist_ok=True)
    snapshot = {**payload["metricSnapshot"], "evaluationId": evaluation_id, "createdAt": payload["createdAt"]}
    (snapshots_dir / f"{safe_file_segment(str(snapshot['id']))}.json").write_text(
        json.dumps(snapshot, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def numeric_metric_subset(metrics: dict[str, Any]) -> dict[str, float]:
    return {str(key): float(value) for key, value in metrics.items() if isinstance(value, (int, float)) and math.isfinite(float(value))}


def active_model_id(pipeline: dict[str, Any]) -> str | None:
    model_nodes = [node for node in pipeline.get("nodes", []) if isinstance(node, dict) and node.get("type") == "model"]
    active = next((node for node in model_nodes if node.get("modelRole") == "active"), None)
    candidate = active or (model_nodes[0] if model_nodes else None)
    return str(candidate.get("id")) if isinstance(candidate, dict) and candidate.get("id") else None


def relative_to_project(project_root: Path, target: Path) -> str:
    return str(target.resolve().relative_to(project_root.resolve())).replace(os.sep, "/")


def safe_file_segment(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-") or "artifact"


if __name__ == "__main__":
    main()
