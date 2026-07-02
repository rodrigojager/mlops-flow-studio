
from __future__ import annotations

import importlib
import json
import logging
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

runtime_root = Path(sys.argv[1]).resolve()
base_url = sys.argv[2].rstrip("/")
sys.path.insert(0, str(runtime_root))

logging.getLogger("prefect").disabled = True
logging.getLogger("prefect._internal.concurrency").disabled = True

request_log: list[dict[str, object]] = []


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _read_body(self) -> dict[str, object]:
        length = int(self.headers.get("content-length") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw) if raw else {}

    def _send(self, status: int, body: dict[str, object]) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        request_log.append({"method": "GET", "path": path})
        responses = {
            "/health": {"status": "ok"},
            "/metadata": {"contract": "mlops-flow-v1", "projectId": "orchestration-smoke"},
            "/models/active": {"id": "active_model", "status": "active"},
            "/metrics/runtime": {"prediction_count": 0, "error_count": 0},
        }
        body = responses.get(path)
        if body is None:
            self._send(404, {"error": "not_found", "path": path})
            return
        self._send(200, body)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        body = self._read_body()
        request_log.append({"method": "POST", "path": path, "body": body})
        if path == "/retraining/requests":
            self._send(200, {"request_id": "req-smoke", "status": "pending_review"})
            return
        if path == "/retraining/requests/req-smoke/approve":
            if body.get("confirm") is not True:
                self._send(400, {"error": "confirm_required"})
                return
            self._send(200, {"request_id": "req-smoke", "status": "approved_pending_runner"})
            return
        self._send(404, {"error": "not_found", "path": path})


server_url = urlparse(base_url)
server = ThreadingHTTPServer((server_url.hostname or "127.0.0.1", int(server_url.port or 80)), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()

try:
    prefect_flow = importlib.import_module("orchestration.prefect_flow")
    celery_app = importlib.import_module("orchestration.celery_app")

    def _noop_event(*_args, **_kwargs):
        return None

    try:
        import prefect.context as prefect_context
        import prefect.events.utilities as prefect_events_utilities
        import prefect.flow_engine as prefect_flow_engine
        prefect_events_utilities.emit_event = _noop_event
        prefect_flow_engine.emit_event = _noop_event
        prefect_context.AssetContext.emit_events = lambda self, state: None
    except Exception:
        pass

    prefect_readiness = prefect_flow.runtime_readiness_flow(base_url)
    prefect_retraining = prefect_flow.controlled_retraining_request_flow(base_url, requested_by="prefect-smoke", reason="smoke", confirm=True)

    def call_task(task_obj, *args, **kwargs):
        if hasattr(task_obj, "run"):
            return task_obj.run(*args, **kwargs)
        return task_obj(*args, **kwargs)

    celery_readiness = call_task(celery_app.runtime_readiness, base_url)
    celery_retraining = call_task(celery_app.request_controlled_retraining, base_url, requested_by="celery-smoke", reason="smoke", confirm=True)

    required_paths = {
        ("GET", "/health"),
        ("GET", "/metadata"),
        ("GET", "/models/active"),
        ("GET", "/metrics/runtime"),
        ("POST", "/retraining/requests"),
        ("POST", "/retraining/requests/req-smoke/approve"),
    }
    seen = {(str(item["method"]), str(item["path"])) for item in request_log}
    missing = sorted([f"{method} {path}" for method, path in required_paths - seen])
    status = "ok" if not missing else "error"
    print(json.dumps({
        "status": status,
        "baseUrl": base_url,
        "prefect": {
            "readinessProject": prefect_readiness.get("project") if isinstance(prefect_readiness, dict) else None,
            "retrainingStatus": prefect_retraining.get("approval", {}).get("status") if isinstance(prefect_retraining, dict) else None,
        },
        "celery": {
            "readinessProject": celery_readiness.get("project") if isinstance(celery_readiness, dict) else None,
            "retrainingStatus": celery_retraining.get("approval", {}).get("status") if isinstance(celery_retraining, dict) else None,
            "taskCount": len(celery_app.celery_app.tasks) if getattr(celery_app, "celery_app", None) is not None else 0,
        },
        "requestCount": len(request_log),
        "missing": missing,
    }, ensure_ascii=False))
    if status != "ok":
        raise SystemExit(1)
finally:
    try:
        from prefect.events.worker import EventsWorker
        EventsWorker.drain_all(timeout=10)
    except Exception:
        pass
    server.shutdown()
    server.server_close()
