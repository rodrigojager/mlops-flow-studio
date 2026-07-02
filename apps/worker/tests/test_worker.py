import json
import json
import os
import sqlite3
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from apps.worker.mlops_worker import cli as worker_cli
from apps.worker.mlops_worker.cli import WorkerError, handle_request


class WorkerTest(unittest.TestCase):
    def test_run_python_block(self):
        with tempfile.TemporaryDirectory() as root:
            project, pipeline = minimal_project()
            result = handle_request(
                {
                    "command": "run-python-block",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "nodeId": "decider",
                    "input": {"confidence": 0.4},
                    "context": {},
                }
            )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["isolation"], "process")
        self.assertEqual(result["output"]["decision"], "manual_review")

    def test_run_python_block_container_isolation_uses_docker_network_none(self):
        with tempfile.TemporaryDirectory() as root:
            project, pipeline = minimal_project()
            python_block = pipeline["nodes"][1]["python"]
            python_block["isolationMode"] = "container"
            observed = {}

            def fake_run(args, **kwargs):
                observed["args"] = args
                observed["payload"] = json.loads(kwargs["input"])

                class FakeCompleted:
                    returncode = 0
                    stdout = json.dumps(
                        {
                            "status": "ok",
                            "output": {"decision": "container_review"},
                            "stdout": [],
                            "stderr": [],
                            "networkCalls": [],
                        }
                    )
                    stderr = ""

                return FakeCompleted()

            with patch("apps.worker.mlops_worker.cli.subprocess.run", side_effect=fake_run):
                result = handle_request(
                    {
                        "command": "run-python-block",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "nodeId": "decider",
                        "input": {"confidence": 0.4},
                        "context": {},
                    }
                )

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["isolation"], "container")
        self.assertEqual(result["output"]["decision"], "container_review")
        self.assertEqual(observed["args"][0], "docker")
        self.assertIn("--network", observed["args"])
        self.assertEqual(observed["args"][observed["args"].index("--network") + 1], "none")
        self.assertIn("--read-only", observed["args"])
        self.assertIn("--cap-drop", observed["args"])
        self.assertEqual(observed["payload"]["networkPolicy"], "none")

    def test_run_python_block_container_allowlist_uses_bridge_network(self):
        with tempfile.TemporaryDirectory() as root:
            project, pipeline = minimal_project()
            python_block = pipeline["nodes"][1]["python"]
            python_block["isolationMode"] = "container"
            python_block["networkPolicy"] = "allowlist"
            python_block["allowedHosts"] = ["api.allowed.local"]
            observed = {}

            def fake_run(args, **kwargs):
                observed["args"] = args
                observed["payload"] = json.loads(kwargs["input"])

                class FakeCompleted:
                    returncode = 0
                    stdout = json.dumps(
                        {
                            "status": "ok",
                            "output": {"decision": "container_allowlist"},
                            "stdout": [],
                            "stderr": [],
                            "networkCalls": [
                                {
                                    "status": "ok",
                                    "method": "GET",
                                    "host": "api.allowed.local",
                                    "path": "/score",
                                    "httpStatus": 200,
                                    "secretRefs": [],
                                }
                            ],
                        }
                    )
                    stderr = ""

                return FakeCompleted()

            with patch("apps.worker.mlops_worker.cli.subprocess.run", side_effect=fake_run):
                result = handle_request(
                    {
                        "command": "run-python-block",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "nodeId": "decider",
                        "input": {},
                        "context": {},
                    }
                )

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["isolation"], "container")
        self.assertEqual(result["output"]["decision"], "container_allowlist")
        self.assertEqual(observed["args"][0], "docker")
        self.assertEqual(observed["args"][observed["args"].index("--network") + 1], "bridge")
        self.assertIn("MLOPS_PYTHON_BLOCK_NETWORK_POLICY=allowlist", observed["args"])
        self.assertEqual(observed["payload"]["networkPolicy"], "allowlist")
        self.assertEqual(observed["payload"]["allowedHosts"], ["api.allowed.local"])
        self.assertEqual(result["networkCalls"][0]["host"], "api.allowed.local")

    def test_run_python_block_container_open_uses_configured_network(self):
        with tempfile.TemporaryDirectory() as root:
            project, pipeline = minimal_project()
            python_block = pipeline["nodes"][1]["python"]
            python_block["isolationMode"] = "container"
            python_block["networkPolicy"] = "open"
            observed = {}

            def fake_run(args, **kwargs):
                observed["args"] = args
                observed["payload"] = json.loads(kwargs["input"])

                class FakeCompleted:
                    returncode = 0
                    stdout = json.dumps(
                        {
                            "status": "ok",
                            "output": {"decision": "container_open"},
                            "stdout": [],
                            "stderr": [],
                            "networkCalls": [],
                        }
                    )
                    stderr = ""

                return FakeCompleted()

            with patch.dict(os.environ, {"MLOPS_PYTHON_BLOCK_CONTAINER_NETWORK": "mlops-egress"}):
                with patch("apps.worker.mlops_worker.cli.subprocess.run", side_effect=fake_run):
                    result = handle_request(
                        {
                            "command": "run-python-block",
                            "projectRoot": root,
                            "project": project,
                            "pipeline": pipeline,
                            "nodeId": "decider",
                            "input": {},
                            "context": {},
                        }
                    )

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["isolation"], "container")
        self.assertEqual(result["output"]["decision"], "container_open")
        self.assertEqual(observed["args"][observed["args"].index("--network") + 1], "mlops-egress")
        self.assertIn("MLOPS_PYTHON_BLOCK_NETWORK_POLICY=open", observed["args"])
        self.assertEqual(observed["payload"]["networkPolicy"], "open")

    def test_run_python_block_timeout_does_not_hang_worker(self):
        with tempfile.TemporaryDirectory() as root:
            project, pipeline = minimal_project()
            python_block = pipeline["nodes"][1]["python"]
            python_block["codeInline"] = (
                "def run(input: dict, context: dict) -> dict:\n"
                "    while True:\n"
                "        pass\n"
            )
            with self.assertRaisesRegex(WorkerError, "timeout"):
                handle_request(
                    {
                        "command": "run-python-block",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "nodeId": "decider",
                        "input": {},
                        "context": {},
                        "timeoutSeconds": 1,
                    }
                )

    def test_python_block_http_mock_works_without_network(self):
        with tempfile.TemporaryDirectory() as root:
            project, pipeline = minimal_project()
            python_block = pipeline["nodes"][1]["python"]
            python_block["networkPolicy"] = "none"
            python_block["codeInline"] = (
                "def run(input: dict, context: dict) -> dict:\n"
                "    response = context['http_request']('GET', 'https://api.example.local/score', headers={'Authorization': 'env:MISSING_TOKEN'})\n"
                "    return {'decision': response['json']['decision'], 'status': response['status'], 'mockId': response.get('mockId')}\n"
            )
            python_block["mocks"] = [
                {
                    "id": "score_mock",
                    "request": {"method": "GET", "url": "https://api.example.local/score"},
                    "response": {"httpStatus": 200, "body": {"decision": "mocked_accept"}},
                }
            ]
            result = handle_request(
                {
                    "command": "run-python-block",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "nodeId": "decider",
                    "input": {},
                    "context": {},
                }
            )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["output"]["decision"], "mocked_accept")
        self.assertEqual(result["networkCalls"][0]["status"], "mock")
        self.assertEqual(result["networkCalls"][0]["mockId"], "score_mock")
        self.assertEqual(result["networkCalls"][0]["secretRefs"], ["env:MISSING_TOKEN"])

    def test_python_block_http_allowlist_allows_real_host(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), PreviewApiHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        previous = os.environ.get("TEST_HTTP_TOKEN")
        os.environ["TEST_HTTP_TOKEN"] = "secret-token"
        try:
            with tempfile.TemporaryDirectory() as root:
                project, pipeline = minimal_project()
                python_block = pipeline["nodes"][1]["python"]
                python_block["networkPolicy"] = "allowlist"
                python_block["allowedHosts"] = [f"127.0.0.1:{server.server_port}"]
                python_block["codeInline"] = (
                    "def run(input: dict, context: dict) -> dict:\n"
                    "    response = context['http_request']('GET', input['url'], headers={'Authorization': 'env:TEST_HTTP_TOKEN'})\n"
                    "    return {'httpStatus': response['httpStatus'], 'rows': len(response['json']['items'])}\n"
                )
                result = handle_request(
                    {
                        "command": "run-python-block",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "nodeId": "decider",
                        "input": {"url": f"http://127.0.0.1:{server.server_port}/tickets"},
                        "context": {},
                    }
                )
        finally:
            if previous is None:
                os.environ.pop("TEST_HTTP_TOKEN", None)
            else:
                os.environ["TEST_HTTP_TOKEN"] = previous
            server.shutdown()
            server.server_close()

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["output"]["httpStatus"], 200)
        self.assertEqual(result["output"]["rows"], 4)
        self.assertEqual(result["networkCalls"][0]["status"], "ok")
        self.assertEqual(result["networkCalls"][0]["secretRefs"], ["env:TEST_HTTP_TOKEN"])

    def test_python_block_http_allowlist_blocks_unlisted_host(self):
        with tempfile.TemporaryDirectory() as root:
            project, pipeline = minimal_project()
            python_block = pipeline["nodes"][1]["python"]
            python_block["networkPolicy"] = "allowlist"
            python_block["allowedHosts"] = ["api.allowed.local"]
            python_block["codeInline"] = (
                "def run(input: dict, context: dict) -> dict:\n"
                "    context['http_request']('GET', 'http://127.0.0.1/not-allowed')\n"
                "    return {'unexpected': True}\n"
            )
            with self.assertRaisesRegex(WorkerError, "allowlist"):
                handle_request(
                    {
                        "command": "run-python-block",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "nodeId": "decider",
                        "input": {},
                        "context": {},
                    }
                )

    def test_python_block_blocks_direct_file_open(self):
        with tempfile.TemporaryDirectory() as root:
            project, pipeline = minimal_project()
            python_block = pipeline["nodes"][1]["python"]
            python_block["networkPolicy"] = "none"
            python_block["codeInline"] = (
                "def run(input: dict, context: dict) -> dict:\n"
                "    open('arquivo.txt', 'w').write('x')\n"
                "    return {'unexpected': True}\n"
            )
            with self.assertRaisesRegex(WorkerError, "Chamada direta open"):
                handle_request(
                    {
                        "command": "run-python-block",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "nodeId": "decider",
                        "input": {},
                        "context": {},
                    }
                )

    def test_python_block_blocks_direct_network_import_even_when_open(self):
        with tempfile.TemporaryDirectory() as root:
            project, pipeline = minimal_project()
            python_block = pipeline["nodes"][1]["python"]
            python_block["networkPolicy"] = "open"
            python_block["codeInline"] = (
                "import requests\n"
                "def run(input: dict, context: dict) -> dict:\n"
                "    return {'unexpected': True}\n"
            )
            with self.assertRaisesRegex(WorkerError, "Import direto de requests"):
                handle_request(
                    {
                        "command": "run-python-block",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "nodeId": "decider",
                        "input": {},
                        "context": {},
                    }
                )

    def test_preview_and_train_csv(self):
        with tempfile.TemporaryDirectory() as root:
            project_root = Path(root)
            (project_root / "data").mkdir()
            (project_root / "data" / "tickets.csv").write_text(
                "id,created_at,text,classe_final,email\n"
                "1,2026-01-03,classe_a boleto pagamento,classe_a,a@example.com\n"
                "2,2026-01-08,classe_a segunda via boleto,classe_a,b@example.com\n"
                "3,2026-02-02,classe_a cobrança mensal,classe_a,c@example.com\n"
                "4,2026-01-12,classe_b erro login acesso,classe_b,d@example.com\n"
                "5,2026-01-19,classe_b redefinir senha,classe_b,e@example.com\n"
                "6,2026-02-05,classe_b acesso bloqueado,classe_b,f@example.com\n",
                encoding="utf-8",
            )
            project, pipeline = minimal_project()
            preview = handle_request(
                {
                    "command": "preview-source",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "tickets_csv",
                }
            )
            self.assertEqual(preview["rowCount"], 6)
            self.assertEqual(preview["sample"][0]["email"], "***")

            training = handle_request(
                {
                    "command": "train-baseline",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "tickets_csv",
                }
            )
            self.assertEqual(training["status"], "ok")
            self.assertEqual(training["leaderboard"][0]["modelId"], training["bestModelId"])
            self.assertGreaterEqual(training["leaderboard"][0]["metrics"]["f1_macro"], 0.9)
            self.assertIn(training["leaderboard"][0]["trainingBackend"], {"stdlib", "scikit-learn"})
            self.assertEqual(training["mlflow"]["status"], "disabled")
            artifact_path = project_root / training["artifacts"][0]["path"]
            self.assertTrue(artifact_path.exists())
            artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
            self.assertIn(artifact["type"], {"standard_lib_text_naive_bayes", "sklearn_text_classifier"})

            evaluation = handle_request(
                {
                    "command": "evaluate-model",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "tickets_csv",
                    "runId": training["runId"],
                    "modelId": training["bestModelId"],
                }
            )
            self.assertEqual(evaluation["status"], "ok")
            self.assertEqual(evaluation["kind"], "evaluation_result")
            self.assertEqual(evaluation["runId"], training["runId"])
            self.assertEqual(evaluation["modelId"], training["bestModelId"])
            self.assertEqual(evaluation["rowCount"], 6)
            self.assertGreaterEqual(evaluation["metrics"]["f1_macro"], 0.9)
            self.assertTrue((project_root / "artifacts" / "evaluation_runs" / evaluation["evaluationId"] / "evaluation-result.json").exists())
            self.assertTrue((project_root / "artifacts" / "metric_snapshots" / f"{evaluation['evaluationId']}-metrics.json").exists())

            backtest = handle_request(
                {
                    "command": "backtest-models",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "tickets_csv",
                    "runId": training["runId"],
                    "neutralBand": 0.001,
                    "timeColumn": "created_at",
                    "windowStart": "2026-01-01",
                    "windowEnd": "2026-02-28",
                    "windowGranularity": "month",
                }
            )
            self.assertEqual(backtest["status"], "ok")
            self.assertEqual(backtest["kind"], "backtest_result")
            self.assertEqual(backtest["runId"], training["runId"])
            self.assertEqual(backtest["rowCount"], 6)
            self.assertEqual(backtest["baselineModelId"], training["bestModelId"])
            self.assertEqual(backtest["temporalWindow"]["matchedRows"], 6)
            self.assertEqual(backtest["temporalWindow"]["totalRows"], 6)
            self.assertEqual([window["id"] for window in backtest["windowResults"]], ["2026-01", "2026-02"])
            self.assertEqual(backtest["windowResults"][0]["rowCount"], 4)
            self.assertEqual(backtest["windowResults"][1]["rowCount"], 2)
            self.assertIn(training["bestModelId"], backtest["modelMetrics"])
            self.assertTrue(any(item["color"] in {"green", "red", "neutral"} for item in backtest["evidence"]))
            self.assertTrue((project_root / "artifacts" / "evaluation_runs" / backtest["evaluationId"] / "evaluation-result.json").exists())
            self.assertTrue((project_root / "artifacts" / "metric_snapshots" / f"{backtest['evaluationId']}-metrics.json").exists())

            period_backtest = handle_request(
                {
                    "command": "backtest-models",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "tickets_csv",
                    "runId": training["runId"],
                    "neutralBand": 0.001,
                    "timeColumn": "created_at",
                    "windowStart": "2026-02-01",
                    "windowEnd": "2026-02-28",
                    "comparisonWindowStart": "2026-01-01",
                    "comparisonWindowEnd": "2026-01-31",
                }
            )
            self.assertEqual(period_backtest["rowCount"], 2)
            self.assertEqual(period_backtest["temporalWindow"]["matchedRows"], 2)
            self.assertEqual(period_backtest["periodComparison"]["currentWindow"]["matchedRows"], 2)
            self.assertEqual(period_backtest["periodComparison"]["comparisonWindow"]["matchedRows"], 4)
            self.assertEqual(period_backtest["periodComparison"]["rowCount"], 4)
            self.assertIn(training["bestModelId"], period_backtest["periodComparison"]["modelMetrics"])
            self.assertTrue(period_backtest["periodComparison"]["deltas"])
            self.assertTrue(any(item["color"] in {"green", "red", "neutral"} for item in period_backtest["periodComparison"]["evidence"]))

            weekly_backtest = handle_request(
                {
                    "command": "backtest-models",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "tickets_csv",
                    "runId": training["runId"],
                    "neutralBand": 0.001,
                    "timeColumn": "created_at",
                    "windowStart": "2026-01-01",
                    "windowEnd": "2026-02-28",
                    "windowGranularity": "week",
                }
            )
            self.assertEqual(weekly_backtest["windowGranularity"], "week")
            self.assertEqual([window["id"] for window in weekly_backtest["windowResults"]], ["2026-W01", "2026-W02", "2026-W03", "2026-W04", "2026-W06"])
            self.assertEqual([window["rowCount"] for window in weekly_backtest["windowResults"]], [1, 1, 1, 1, 2])

            daily_backtest = handle_request(
                {
                    "command": "backtest-models",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "tickets_csv",
                    "runId": training["runId"],
                    "neutralBand": 0.001,
                    "timeColumn": "created_at",
                    "windowStart": "2026-01-01",
                    "windowEnd": "2026-02-28",
                    "windowGranularity": "day",
                }
            )
            self.assertEqual(daily_backtest["windowGranularity"], "day")
            self.assertEqual([window["id"] for window in daily_backtest["windowResults"]], ["2026-01-03", "2026-01-08", "2026-01-12", "2026-01-19", "2026-02-02", "2026-02-05"])

            rolling_backtest = handle_request(
                {
                    "command": "backtest-models",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "tickets_csv",
                    "runId": training["runId"],
                    "neutralBand": 0.001,
                    "timeColumn": "created_at",
                    "windowStart": "2026-01-01",
                    "windowEnd": "2026-02-28",
                    "windowGranularity": "rolling_7d",
                }
            )
            self.assertEqual(rolling_backtest["windowGranularity"], "rolling_7d")
            self.assertEqual([window["id"] for window in rolling_backtest["windowResults"]], ["rolling-7d-2026-01-03", "rolling-7d-2026-01-08", "rolling-7d-2026-01-12", "rolling-7d-2026-01-19", "rolling-7d-2026-02-02", "rolling-7d-2026-02-05"])
            self.assertEqual([window["rowCount"] for window in rolling_backtest["windowResults"]], [1, 2, 2, 1, 1, 2])

            (project_root / "data" / "tickets.csv").write_text(
                "id,created_at,text,classe_final,email\n"
                "7,2026-03-03,classe_a acordo pagamento,classe_a,g@example.com\n"
                "8,2026-03-08,classe_a boleto vencido,classe_a,h@example.com\n"
                "9,2026-03-12,classe_b erro autenticação,classe_b,i@example.com\n"
                "10,2026-03-19,classe_b liberar acesso,classe_b,j@example.com\n",
                encoding="utf-8",
            )
            incremental = handle_request(
                {
                    "command": "train-baseline",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "tickets_csv",
                    "incremental": True,
                    "previousRunId": training["runId"],
                }
            )
            self.assertEqual(incremental["status"], "ok")
            self.assertEqual(incremental["trainingMode"], "incremental")
            self.assertEqual(incremental["baseRunId"], training["runId"])
            self.assertEqual(incremental["leaderboard"][0]["incremental"]["applied"], True)
            self.assertEqual(incremental["leaderboard"][0]["trainedAlgorithm"], "standard_lib_text_naive_bayes_incremental")
            self.assertEqual(incremental["incremental"]["appliedModels"][0]["modelId"], training["bestModelId"])
            incremental_artifact_path = project_root / incremental["artifacts"][0]["path"]
            incremental_artifact = json.loads(incremental_artifact_path.read_text(encoding="utf-8"))
            self.assertEqual(incremental_artifact["incremental"]["baseRunId"], training["runId"])
            base_class_count = sum(int(value) for value in artifact["model"]["classCounts"].values())
            incremental_class_count = sum(int(value) for value in incremental_artifact["model"]["classCounts"].values())
            self.assertGreater(incremental_class_count, base_class_count)

    def test_sklearn_text_classifier_incremental_partial_fit(self):
        if not worker_cli.sklearn_available():
            self.skipTest("scikit-learn não está instalado")
        with tempfile.TemporaryDirectory() as root:
            project_root = Path(root)
            (project_root / "data").mkdir()
            (project_root / "data" / "tickets.csv").write_text(
                "id,text,classe_final,email\n"
                "1,classe_a boleto pagamento,classe_a,a@example.com\n"
                "2,classe_a segunda via boleto,classe_a,b@example.com\n"
                "3,classe_a cobrança mensal,classe_a,c@example.com\n"
                "4,classe_b erro login acesso,classe_b,d@example.com\n"
                "5,classe_b redefinir senha,classe_b,e@example.com\n"
                "6,classe_b acesso bloqueado,classe_b,f@example.com\n",
                encoding="utf-8",
            )
            project, pipeline = minimal_project()
            pipeline["nodes"][0]["algorithm"] = "logistic_regression"
            pipeline["nodes"][0]["framework"] = "sklearn"
            pipeline["nodes"][0]["config"] = {"trainingBackend": "sklearn"}

            training = handle_request(
                {
                    "command": "train-baseline",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "tickets_csv",
                }
            )
            self.assertEqual(training["status"], "ok")
            self.assertEqual(training["leaderboard"][0]["trainingBackend"], "scikit-learn")
            self.assertEqual(training["leaderboard"][0]["trainedAlgorithm"], "hashing_multinomial_nb")
            base_artifact_path = project_root / training["artifacts"][0]["path"]
            base_artifact = json.loads(base_artifact_path.read_text(encoding="utf-8"))
            self.assertEqual(base_artifact["type"], "sklearn_text_classifier")
            self.assertTrue(base_artifact["incrementalCapable"])
            self.assertIn("vectorizerBase64", base_artifact)
            self.assertIn("classifierBase64", base_artifact)

            (project_root / "data" / "tickets.csv").write_text(
                "id,text,classe_final,email\n"
                "7,classe_a acordo pagamento,classe_a,g@example.com\n"
                "8,classe_a boleto vencido,classe_a,h@example.com\n"
                "9,classe_b erro autenticação,classe_b,i@example.com\n"
                "10,classe_b liberar acesso,classe_b,j@example.com\n",
                encoding="utf-8",
            )
            incremental = handle_request(
                {
                    "command": "train-baseline",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "tickets_csv",
                    "incremental": True,
                    "previousRunId": training["runId"],
                }
            )
            self.assertEqual(incremental["status"], "ok")
            self.assertEqual(incremental["trainingMode"], "incremental")
            self.assertEqual(incremental["leaderboard"][0]["trainingBackend"], "scikit-learn")
            self.assertEqual(incremental["leaderboard"][0]["incremental"]["applied"], True)
            self.assertEqual(incremental["leaderboard"][0]["trainedAlgorithm"], "hashing_multinomial_nb_incremental")
            self.assertEqual(incremental["incremental"]["appliedModels"][0]["modelId"], training["bestModelId"])
            incremental_artifact_path = project_root / incremental["artifacts"][0]["path"]
            incremental_artifact = json.loads(incremental_artifact_path.read_text(encoding="utf-8"))
            self.assertEqual(incremental_artifact["incremental"]["baseRunId"], training["runId"])
            self.assertEqual(incremental_artifact["incremental"]["strategy"], "partial_fit_hashing_multinomial_nb")
            self.assertEqual(incremental_artifact["incremental"]["baseArtifactUri"], training["leaderboard"][0]["artifactUri"])
            self.assertTrue(incremental_artifact["incremental"]["totalTrainingRows"] > incremental_artifact["incremental"]["baseTrainingRows"])
            evaluation = handle_request(
                {
                    "command": "evaluate-model",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "tickets_csv",
                    "runId": incremental["runId"],
                    "modelId": incremental["bestModelId"],
                }
            )
            self.assertEqual(evaluation["status"], "ok")
            self.assertEqual(evaluation["modelId"], incremental["bestModelId"])
            self.assertGreaterEqual(evaluation["metrics"]["f1_macro"], 0.5)

    def test_sklearn_regressor_incremental_partial_fit(self):
        if not worker_cli.sklearn_available():
            self.skipTest("scikit-learn não está instalado")
        with tempfile.TemporaryDirectory() as root:
            project_root = Path(root)
            (project_root / "data").mkdir()
            (project_root / "data" / "regression.csv").write_text(
                "id,feature_a,feature_b,segment,score,email\n"
                "1,1.0,0.5,alpha,12.0,a@example.com\n"
                "2,1.5,0.7,alpha,13.5,b@example.com\n"
                "3,2.0,1.0,beta,16.0,c@example.com\n"
                "4,2.5,1.2,beta,17.5,d@example.com\n"
                "5,3.0,1.5,alpha,20.0,e@example.com\n"
                "6,3.5,1.7,alpha,21.5,f@example.com\n"
                "7,4.0,2.0,beta,24.0,g@example.com\n"
                "8,4.5,2.2,beta,25.5,h@example.com\n"
                "9,5.0,2.5,alpha,28.0,i@example.com\n"
                "10,5.5,2.7,beta,29.5,j@example.com\n",
                encoding="utf-8",
            )
            project, pipeline = minimal_project()
            project["problem"] = {"type": "regression", "target": "score"}
            project["metrics"] = {"primary": "rmse", "secondary": ["mae", "r2"]}
            project["dataSources"][0]["id"] = "regression_csv"
            project["dataSources"][0]["label"] = "Regressão CSV"
            project["dataSources"][0]["csv"]["path"] = "data/regression.csv"
            pipeline["nodes"][0]["algorithm"] = "ridge_regression"
            pipeline["nodes"][0]["framework"] = "sklearn"
            pipeline["nodes"][0]["config"] = {"trainingBackend": "sklearn"}

            training = handle_request(
                {
                    "command": "train-baseline",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "regression_csv",
                }
            )
            self.assertEqual(training["status"], "ok")
            self.assertEqual(training["leaderboard"][0]["trainingBackend"], "scikit-learn")
            self.assertEqual(training["leaderboard"][0]["trainedAlgorithm"], "feature_hasher_sgd_regressor")
            base_artifact_path = project_root / training["artifacts"][0]["path"]
            base_artifact = json.loads(base_artifact_path.read_text(encoding="utf-8"))
            self.assertEqual(base_artifact["type"], "sklearn_regressor")
            self.assertTrue(base_artifact["incrementalCapable"])
            self.assertIn("vectorizerBase64", base_artifact)
            self.assertIn("regressorBase64", base_artifact)

            (project_root / "data" / "regression.csv").write_text(
                "id,feature_a,feature_b,segment,score,email\n"
                "11,6.0,3.0,alpha,32.0,k@example.com\n"
                "12,6.5,3.2,beta,33.5,l@example.com\n"
                "13,7.0,3.5,alpha,36.0,m@example.com\n"
                "14,7.5,3.7,beta,37.5,n@example.com\n"
                "15,8.0,4.0,alpha,40.0,o@example.com\n"
                "16,8.5,4.2,beta,41.5,p@example.com\n",
                encoding="utf-8",
            )
            incremental = handle_request(
                {
                    "command": "train-baseline",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "regression_csv",
                    "incremental": True,
                    "previousRunId": training["runId"],
                }
            )
            self.assertEqual(incremental["status"], "ok")
            self.assertEqual(incremental["trainingMode"], "incremental")
            self.assertEqual(incremental["leaderboard"][0]["trainingBackend"], "scikit-learn")
            self.assertEqual(incremental["leaderboard"][0]["incremental"]["applied"], True)
            self.assertEqual(incremental["leaderboard"][0]["trainedAlgorithm"], "feature_hasher_sgd_regressor_incremental")
            self.assertEqual(incremental["incremental"]["appliedModels"][0]["modelId"], training["bestModelId"])
            incremental_artifact_path = project_root / incremental["artifacts"][0]["path"]
            incremental_artifact = json.loads(incremental_artifact_path.read_text(encoding="utf-8"))
            self.assertEqual(incremental_artifact["incremental"]["baseRunId"], training["runId"])
            self.assertEqual(incremental_artifact["incremental"]["strategy"], "partial_fit_feature_hasher_sgd_regressor")
            self.assertEqual(incremental_artifact["incremental"]["baseArtifactUri"], training["leaderboard"][0]["artifactUri"])
            self.assertTrue(incremental_artifact["incremental"]["totalTrainingRows"] > incremental_artifact["incremental"]["baseTrainingRows"])
            evaluation = handle_request(
                {
                    "command": "evaluate-model",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "regression_csv",
                    "runId": incremental["runId"],
                    "modelId": incremental["bestModelId"],
                }
            )
            self.assertEqual(evaluation["status"], "ok")
            self.assertEqual(evaluation["modelId"], incremental["bestModelId"])
            self.assertIn("rmse", evaluation["metrics"])

    def test_xgboost_node_uses_optional_backend_or_fallback(self):
        with tempfile.TemporaryDirectory() as root:
            project_root = Path(root)
            (project_root / "data").mkdir()
            (project_root / "data" / "tickets.csv").write_text(
                "id,text,classe_final,email\n"
                "1,classe_a boleto pagamento,classe_a,a@example.com\n"
                "2,classe_a segunda via boleto,classe_a,b@example.com\n"
                "3,classe_b erro login acesso,classe_b,d@example.com\n"
                "4,classe_b redefinir senha,classe_b,e@example.com\n",
                encoding="utf-8",
            )
            project, pipeline = minimal_project()
            pipeline["nodes"][0]["algorithm"] = "xgboost"
            pipeline["nodes"][0]["framework"] = "xgboost"
            pipeline["nodes"][0]["dependencies"] = ["xgboost>=2,<3"]

            training = handle_request(
                {
                    "command": "train-baseline",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "tickets_csv",
                }
            )

            self.assertEqual(training["status"], "ok")
            self.assertIn(training["leaderboard"][0]["trainingBackend"], {"stdlib", "xgboost"})
            artifact_path = project_root / training["artifacts"][0]["path"]
            artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
            self.assertIn(artifact["type"], {"standard_lib_text_naive_bayes", "xgboost_text_classifier"})

    def test_xgboost_text_classifier_incremental_continues_booster(self):
        if not worker_cli.xgboost_available() or not worker_cli.sklearn_available():
            self.skipTest("xgboost ou scikit-learn não está instalado")
        with tempfile.TemporaryDirectory() as root:
            project_root = Path(root)
            (project_root / "data").mkdir()
            (project_root / "data" / "tickets.csv").write_text(
                "id,text,classe_final,email\n"
                "1,classe_a boleto pagamento,classe_a,a@example.com\n"
                "2,classe_a segunda via boleto,classe_a,b@example.com\n"
                "3,classe_a acordo cobrança,classe_a,c@example.com\n"
                "4,classe_b erro login,classe_b,d@example.com\n"
                "5,classe_b redefinir senha,classe_b,e@example.com\n"
                "6,classe_b acesso bloqueado,classe_b,f@example.com\n",
                encoding="utf-8",
            )
            project, pipeline = minimal_project()
            pipeline["nodes"][0]["algorithm"] = "xgboost"
            pipeline["nodes"][0]["framework"] = "xgboost"
            pipeline["nodes"][0]["config"] = {"trainingBackend": "xgboost", "nEstimators": 3, "maxDepth": 2}

            training = handle_request(
                {
                    "command": "train-baseline",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "tickets_csv",
                }
            )
            self.assertEqual(training["status"], "ok")
            self.assertEqual(training["leaderboard"][0]["trainingBackend"], "xgboost")
            self.assertEqual(training["leaderboard"][0]["trainedAlgorithm"], "tfidf_xgboost_classifier")
            base_artifact_path = project_root / training["artifacts"][0]["path"]
            base_artifact = json.loads(base_artifact_path.read_text(encoding="utf-8"))
            self.assertEqual(base_artifact["type"], "xgboost_text_classifier")
            self.assertTrue(base_artifact["incrementalCapable"])

            (project_root / "data" / "tickets.csv").write_text(
                "id,text,classe_final,email\n"
                "7,classe_b recuperar acesso,classe_b,g@example.com\n"
                "8,classe_b erro autenticação,classe_b,h@example.com\n"
                "9,classe_b liberar login,classe_b,i@example.com\n"
                "10,classe_b senha bloqueada,classe_b,j@example.com\n",
                encoding="utf-8",
            )
            incremental = handle_request(
                {
                    "command": "train-baseline",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "tickets_csv",
                    "incremental": True,
                    "previousRunId": training["runId"],
                }
            )
            self.assertEqual(incremental["status"], "ok")
            self.assertEqual(incremental["trainingMode"], "incremental")
            self.assertEqual(incremental["leaderboard"][0]["incremental"]["applied"], True)
            self.assertEqual(incremental["leaderboard"][0]["trainedAlgorithm"], "tfidf_xgboost_classifier_incremental")
            incremental_artifact_path = project_root / incremental["artifacts"][0]["path"]
            incremental_artifact = json.loads(incremental_artifact_path.read_text(encoding="utf-8"))
            self.assertEqual(incremental_artifact["incremental"]["strategy"], "xgb_model_continuation")
            self.assertEqual(incremental_artifact["incremental"]["baseArtifactUri"], training["leaderboard"][0]["artifactUri"])
            self.assertGreater(incremental_artifact["incremental"]["totalBoostedRounds"], incremental_artifact["incremental"]["baseBoostedRounds"])
            evaluation = handle_request(
                {
                    "command": "evaluate-model",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "tickets_csv",
                    "runId": incremental["runId"],
                    "modelId": incremental["bestModelId"],
                }
            )
            self.assertEqual(evaluation["status"], "ok")
            self.assertEqual(evaluation["modelId"], incremental["bestModelId"])

    def test_xgboost_regressor_incremental_continues_booster(self):
        if not worker_cli.xgboost_available() or not worker_cli.sklearn_available():
            self.skipTest("xgboost ou scikit-learn não está instalado")
        with tempfile.TemporaryDirectory() as root:
            project_root = Path(root)
            (project_root / "data").mkdir()
            (project_root / "data" / "regression.csv").write_text(
                "id,feature_a,feature_b,segment,score,email\n"
                "1,1.0,0.5,alpha,12.0,a@example.com\n"
                "2,1.5,0.7,alpha,13.5,b@example.com\n"
                "3,2.0,1.0,beta,16.0,c@example.com\n"
                "4,2.5,1.2,beta,17.5,d@example.com\n"
                "5,3.0,1.5,alpha,20.0,e@example.com\n"
                "6,3.5,1.7,alpha,21.5,f@example.com\n"
                "7,4.0,2.0,beta,24.0,g@example.com\n"
                "8,4.5,2.2,beta,25.5,h@example.com\n",
                encoding="utf-8",
            )
            project, pipeline = minimal_project()
            project["problem"] = {"type": "regression", "target": "score"}
            project["metrics"] = {"primary": "rmse", "secondary": ["mae", "r2"]}
            project["dataSources"][0]["id"] = "regression_csv"
            project["dataSources"][0]["label"] = "Regressão CSV"
            project["dataSources"][0]["csv"]["path"] = "data/regression.csv"
            pipeline["nodes"][0]["algorithm"] = "xgboost_regressor"
            pipeline["nodes"][0]["framework"] = "xgboost"
            pipeline["nodes"][0]["task"] = "regression"
            pipeline["nodes"][0]["config"] = {"trainingBackend": "xgboost", "nEstimators": 3, "maxDepth": 2}

            training = handle_request(
                {
                    "command": "train-baseline",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "regression_csv",
                }
            )
            self.assertEqual(training["status"], "ok")
            self.assertEqual(training["leaderboard"][0]["trainingBackend"], "xgboost")
            self.assertEqual(training["leaderboard"][0]["trainedAlgorithm"], "dictvectorizer_xgboost_regressor")
            base_artifact_path = project_root / training["artifacts"][0]["path"]
            base_artifact = json.loads(base_artifact_path.read_text(encoding="utf-8"))
            self.assertEqual(base_artifact["type"], "xgboost_regressor")
            self.assertTrue(base_artifact["incrementalCapable"])

            (project_root / "data" / "regression.csv").write_text(
                "id,feature_a,feature_b,segment,score,email\n"
                "9,5.0,2.5,alpha,28.0,i@example.com\n"
                "10,5.5,2.7,beta,29.5,j@example.com\n"
                "11,6.0,3.0,alpha,32.0,k@example.com\n"
                "12,6.5,3.2,beta,33.5,l@example.com\n"
                "13,7.0,3.5,alpha,36.0,m@example.com\n"
                "14,7.5,3.7,beta,37.5,n@example.com\n",
                encoding="utf-8",
            )
            incremental = handle_request(
                {
                    "command": "train-baseline",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "regression_csv",
                    "incremental": True,
                    "previousRunId": training["runId"],
                }
            )
            self.assertEqual(incremental["status"], "ok")
            self.assertEqual(incremental["trainingMode"], "incremental")
            self.assertEqual(incremental["leaderboard"][0]["incremental"]["applied"], True)
            self.assertEqual(incremental["leaderboard"][0]["trainedAlgorithm"], "dictvectorizer_xgboost_regressor_incremental")
            incremental_artifact_path = project_root / incremental["artifacts"][0]["path"]
            incremental_artifact = json.loads(incremental_artifact_path.read_text(encoding="utf-8"))
            self.assertEqual(incremental_artifact["incremental"]["strategy"], "xgb_model_continuation")
            self.assertEqual(incremental_artifact["incremental"]["baseArtifactUri"], training["leaderboard"][0]["artifactUri"])
            self.assertGreater(incremental_artifact["incremental"]["totalBoostedRounds"], incremental_artifact["incremental"]["baseBoostedRounds"])
            evaluation = handle_request(
                {
                    "command": "evaluate-model",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "regression_csv",
                    "runId": incremental["runId"],
                    "modelId": incremental["bestModelId"],
                }
            )
            self.assertEqual(evaluation["status"], "ok")
            self.assertEqual(evaluation["modelId"], incremental["bestModelId"])
            self.assertIn("rmse", evaluation["metrics"])

    def test_embedding_node_trains_sentence_transformers_artifact_when_available(self):
        if not worker_cli.sklearn_available():
            self.skipTest("scikit-learn não está instalado")

        class FakeSentenceTransformer:
            def encode(self, texts, **_kwargs):
                return [[1.0, 0.0] if "classe_a" in text else [0.0, 1.0] for text in texts]

        with tempfile.TemporaryDirectory() as root:
            project_root = Path(root)
            (project_root / "data").mkdir()
            (project_root / "data" / "tickets.csv").write_text(
                "id,text,classe_final,email\n"
                "1,classe_a boleto pagamento,classe_a,a@example.com\n"
                "2,classe_a segunda via boleto,classe_a,b@example.com\n"
                "3,classe_b erro login acesso,classe_b,d@example.com\n"
                "4,classe_b redefinir senha,classe_b,e@example.com\n",
                encoding="utf-8",
            )
            project, pipeline = minimal_project()
            pipeline["nodes"].insert(
                0,
                {
                    "id": "embeddings",
                    "type": "embedding",
                    "label": "Embeddings",
                    "framework": "sentence-transformers",
                    "config": {
                        "enabled": True,
                        "model": "fake-bert",
                        "normalizeEmbeddings": True,
                        "fineTuning": {
                            "enabled": True,
                            "epochs": 2,
                            "batchSize": 4,
                            "learningRate": 0.00002,
                            "maxRows": 100,
                            "device": "cuda",
                            "requiresGpu": True,
                            "mixedPrecision": True,
                            "gradientCheckpointing": True,
                        },
                    },
                },
            )
            pipeline["edges"] = [{"from": "embeddings", "to": "model", "mapping": {}}]

            with patch.object(worker_cli, "sentence_transformers_available", return_value=True), patch.object(worker_cli, "load_sentence_transformer_model", return_value=FakeSentenceTransformer()):
                training = worker_cli.handle_request(
                    {
                        "command": "train-baseline",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "sourceId": "tickets_csv",
                    }
                )
                self.assertEqual(training["status"], "ok")
                self.assertEqual(training["leaderboard"][0]["trainingBackend"], "sentence-transformers")
                artifact_path = project_root / training["artifacts"][0]["path"]
                artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
                self.assertEqual(artifact["type"], "sentence_transformers_text_classifier")
                self.assertEqual(artifact["embeddingModel"], "fake-bert")
                self.assertTrue(artifact["incrementalCapable"])
                self.assertTrue(artifact["fineTuning"]["enabled"])
                self.assertEqual(artifact["fineTuning"]["status"], "planned")
                self.assertEqual(artifact["fineTuning"]["device"], "cuda")
                self.assertTrue(artifact["fineTuning"]["requiresGpu"])
                self.assertTrue(artifact["fineTuning"]["mixedPrecision"])
                self.assertTrue(artifact["fineTuning"]["gradientCheckpointing"])
                self.assertEqual(training["leaderboard"][0]["trainedAlgorithm"], "sentence_transformers_sgd_classifier")
                self.assertEqual(training["leaderboard"][0]["fineTuning"]["epochs"], 2)

                evaluation = worker_cli.handle_request(
                    {
                        "command": "evaluate-model",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "sourceId": "tickets_csv",
                        "runId": training["runId"],
                        "modelId": training["bestModelId"],
                    }
                )
                self.assertEqual(evaluation["status"], "ok")
                self.assertGreaterEqual(evaluation["metrics"]["f1_macro"], 0.9)

    def test_sentence_transformers_classifier_incremental_partial_fit(self):
        if not worker_cli.sklearn_available():
            self.skipTest("scikit-learn não está instalado")

        class FakeSentenceTransformer:
            def encode(self, texts, **_kwargs):
                return [[1.0, 0.0] if "classe_a" in text else [0.0, 1.0] for text in texts]

        with tempfile.TemporaryDirectory() as root:
            project_root = Path(root)
            (project_root / "data").mkdir()
            (project_root / "data" / "tickets.csv").write_text(
                "id,text,classe_final,email\n"
                "1,classe_a boleto pagamento,classe_a,a@example.com\n"
                "2,classe_a segunda via boleto,classe_a,b@example.com\n"
                "3,classe_a acordo cobrança,classe_a,c@example.com\n"
                "4,classe_b erro login acesso,classe_b,d@example.com\n"
                "5,classe_b redefinir senha,classe_b,e@example.com\n"
                "6,classe_b acesso bloqueado,classe_b,f@example.com\n",
                encoding="utf-8",
            )
            project, pipeline = minimal_project()
            pipeline["nodes"].insert(
                0,
                {
                    "id": "embeddings",
                    "type": "embedding",
                    "label": "Embeddings",
                    "framework": "sentence-transformers",
                    "config": {"enabled": True, "model": "fake-bert", "normalizeEmbeddings": True},
                },
            )
            pipeline["edges"] = [{"from": "embeddings", "to": "model", "mapping": {}}]

            with patch.object(worker_cli, "sentence_transformers_available", return_value=True), patch.object(worker_cli, "load_sentence_transformer_model", return_value=FakeSentenceTransformer()):
                training = worker_cli.handle_request(
                    {
                        "command": "train-baseline",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "sourceId": "tickets_csv",
                    }
                )
                self.assertEqual(training["status"], "ok")
                self.assertEqual(training["leaderboard"][0]["trainedAlgorithm"], "sentence_transformers_sgd_classifier")

                (project_root / "data" / "tickets.csv").write_text(
                    "id,text,classe_final,email\n"
                    "7,classe_b recuperar acesso,classe_b,g@example.com\n"
                    "8,classe_b erro autenticação,classe_b,h@example.com\n"
                    "9,classe_b liberar login,classe_b,i@example.com\n"
                    "10,classe_b senha bloqueada,classe_b,j@example.com\n",
                    encoding="utf-8",
                )
                incremental = worker_cli.handle_request(
                    {
                        "command": "train-baseline",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "sourceId": "tickets_csv",
                        "incremental": True,
                        "previousRunId": training["runId"],
                    }
                )
                self.assertEqual(incremental["status"], "ok")
                self.assertEqual(incremental["trainingMode"], "incremental")
                self.assertEqual(incremental["leaderboard"][0]["incremental"]["applied"], True)
                self.assertEqual(incremental["leaderboard"][0]["trainedAlgorithm"], "sentence_transformers_sgd_classifier_incremental")
                incremental_artifact_path = project_root / incremental["artifacts"][0]["path"]
                incremental_artifact = json.loads(incremental_artifact_path.read_text(encoding="utf-8"))
                self.assertEqual(incremental_artifact["incremental"]["strategy"], "partial_fit_sentence_transformers_sgd_classifier")
                self.assertEqual(incremental_artifact["incremental"]["baseArtifactUri"], training["leaderboard"][0]["artifactUri"])
                self.assertGreater(incremental_artifact["incremental"]["totalTrainingRows"], incremental_artifact["incremental"]["baseTrainingRows"])

                evaluation = worker_cli.handle_request(
                    {
                        "command": "evaluate-model",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "sourceId": "tickets_csv",
                        "runId": incremental["runId"],
                        "modelId": incremental["bestModelId"],
                    }
                )
                self.assertEqual(evaluation["status"], "ok")
                self.assertEqual(evaluation["modelId"], incremental["bestModelId"])

    def test_sentence_transformers_regressor_incremental_partial_fit(self):
        if not worker_cli.sklearn_available():
            self.skipTest("scikit-learn não está instalado")

        class FakeSentenceTransformer:
            def encode(self, texts, **_kwargs):
                vectors = []
                for text in texts:
                    values = []
                    for token in text.replace(",", " ").split():
                        try:
                            values.append(float(token))
                        except ValueError:
                            continue
                    total = sum(values)
                    vectors.append([total, 1.0])
                return vectors

        with tempfile.TemporaryDirectory() as root:
            project_root = Path(root)
            (project_root / "data").mkdir()
            (project_root / "data" / "regression.csv").write_text(
                "id,feature_a,feature_b,segment,score,email\n"
                "1,1.0,0.5,alpha,12.0,a@example.com\n"
                "2,1.5,0.7,alpha,13.5,b@example.com\n"
                "3,2.0,1.0,beta,16.0,c@example.com\n"
                "4,2.5,1.2,beta,17.5,d@example.com\n"
                "5,3.0,1.5,alpha,20.0,e@example.com\n"
                "6,3.5,1.7,alpha,21.5,f@example.com\n",
                encoding="utf-8",
            )
            project, pipeline = minimal_project()
            project["problem"] = {"type": "regression", "target": "score"}
            project["metrics"] = {"primary": "rmse", "secondary": ["mae", "r2"]}
            project["dataSources"][0]["id"] = "regression_csv"
            project["dataSources"][0]["label"] = "Regressão CSV"
            project["dataSources"][0]["csv"]["path"] = "data/regression.csv"
            pipeline["nodes"].insert(
                0,
                {
                    "id": "embeddings",
                    "type": "embedding",
                    "label": "Embeddings",
                    "framework": "sentence-transformers",
                    "config": {"enabled": True, "model": "fake-regressor-bert", "normalizeEmbeddings": True},
                },
            )
            pipeline["nodes"][1]["algorithm"] = "sentence_transformers_regressor"
            pipeline["nodes"][1]["framework"] = "sentence-transformers"
            pipeline["nodes"][1]["task"] = "regression"
            pipeline["edges"] = [{"from": "embeddings", "to": "model", "mapping": {}}]

            with patch.object(worker_cli, "sentence_transformers_available", return_value=True), patch.object(worker_cli, "load_sentence_transformer_model", return_value=FakeSentenceTransformer()):
                training = worker_cli.handle_request(
                    {
                        "command": "train-baseline",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "sourceId": "regression_csv",
                    }
                )
                self.assertEqual(training["status"], "ok")
                self.assertEqual(training["leaderboard"][0]["trainingBackend"], "sentence-transformers")
                self.assertEqual(training["leaderboard"][0]["trainedAlgorithm"], "sentence_transformers_sgd_regressor")
                base_artifact_path = project_root / training["artifacts"][0]["path"]
                base_artifact = json.loads(base_artifact_path.read_text(encoding="utf-8"))
                self.assertEqual(base_artifact["type"], "sentence_transformers_regressor")
                self.assertTrue(base_artifact["incrementalCapable"])

                (project_root / "data" / "regression.csv").write_text(
                    "id,feature_a,feature_b,segment,score,email\n"
                    "7,4.0,2.0,beta,24.0,g@example.com\n"
                    "8,4.5,2.2,beta,25.5,h@example.com\n"
                    "9,5.0,2.5,alpha,28.0,i@example.com\n"
                    "10,5.5,2.7,beta,29.5,j@example.com\n",
                    encoding="utf-8",
                )
                incremental = worker_cli.handle_request(
                    {
                        "command": "train-baseline",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "sourceId": "regression_csv",
                        "incremental": True,
                        "previousRunId": training["runId"],
                    }
                )
                self.assertEqual(incremental["status"], "ok")
                self.assertEqual(incremental["trainingMode"], "incremental")
                self.assertEqual(incremental["leaderboard"][0]["incremental"]["applied"], True)
                self.assertEqual(incremental["leaderboard"][0]["trainedAlgorithm"], "sentence_transformers_sgd_regressor_incremental")
                incremental_artifact_path = project_root / incremental["artifacts"][0]["path"]
                incremental_artifact = json.loads(incremental_artifact_path.read_text(encoding="utf-8"))
                self.assertEqual(incremental_artifact["incremental"]["strategy"], "partial_fit_sentence_transformers_sgd_regressor")
                self.assertEqual(incremental_artifact["incremental"]["baseArtifactUri"], training["leaderboard"][0]["artifactUri"])
                self.assertGreater(incremental_artifact["incremental"]["totalTrainingRows"], incremental_artifact["incremental"]["baseTrainingRows"])

                evaluation = worker_cli.handle_request(
                    {
                        "command": "evaluate-model",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "sourceId": "regression_csv",
                        "runId": incremental["runId"],
                        "modelId": incremental["bestModelId"],
                    }
                )
                self.assertEqual(evaluation["status"], "ok")
                self.assertEqual(evaluation["modelId"], incremental["bestModelId"])
                self.assertIn("rmse", evaluation["metrics"])

    def test_preview_sqlite_source_real(self):
        with tempfile.TemporaryDirectory() as root:
            project_root = Path(root)
            database_path = project_root / "source.db"
            connection = sqlite3.connect(database_path)
            try:
                connection.execute("CREATE TABLE tickets (id integer, text text, classe_final text, email text)")
                connection.executemany(
                    "INSERT INTO tickets VALUES (?, ?, ?, ?)",
                    [
                        (1, "classe_a boleto pagamento", "classe_a", "a@example.com"),
                        (2, "classe_a segunda via boleto", "classe_a", "b@example.com"),
                        (3, "classe_b erro login", "classe_b", "c@example.com"),
                        (4, "classe_b redefinir senha", "classe_b", "d@example.com"),
                    ],
                )
                connection.commit()
            finally:
                connection.close()
            previous = os.environ.get("TEST_SQLITE_URL")
            os.environ["TEST_SQLITE_URL"] = f"sqlite:///{database_path}"
            try:
                project, pipeline = minimal_project()
                project["dataSources"].append(
                    {
                        "id": "tickets_sql",
                        "type": "sql",
                        "label": "Tickets SQL",
                        "sensitiveFields": ["email"],
                        "sql": {"connectionRef": "env:TEST_SQLITE_URL", "query": "SELECT id, text, classe_final, email FROM tickets"},
                    }
                )
                preview = handle_request(
                    {
                        "command": "preview-source",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "sourceId": "tickets_sql",
                    }
                )
                training = handle_request(
                    {
                        "command": "train-baseline",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "sourceId": "tickets_sql",
                        "datasetSnapshotMode": "full_rows",
                        "allowSensitiveDatasetSnapshot": True,
                    }
                )
            finally:
                if previous is None:
                    os.environ.pop("TEST_SQLITE_URL", None)
                else:
                    os.environ["TEST_SQLITE_URL"] = previous
            self.assertEqual(preview["status"], "ok")
            self.assertEqual(preview["mode"], "sqlite")
            self.assertEqual(preview["sample"][0]["email"], "***")
            self.assertEqual(training["status"], "ok")
            self.assertEqual(training["sourceMode"], "sqlite")
            self.assertEqual(training["rowCount"], 4)
            dataset_artifact = training["datasetVersion"]
            self.assertEqual(dataset_artifact["kind"], "dataset_version")
            dataset_snapshot = json.loads((project_root / dataset_artifact["path"]).read_text(encoding="utf-8"))
            self.assertEqual(dataset_snapshot["sourceMode"], "sqlite")
            self.assertEqual(dataset_snapshot["rowCount"], 4)
            self.assertEqual(dataset_snapshot["sample"][0]["email"], "***")
            self.assertEqual(dataset_snapshot["sourceDescriptor"]["connectionRef"], "env:TEST_SQLITE_URL")
            self.assertIn("queryHash", dataset_snapshot["sourceDescriptor"])
            self.assertNotIn("query", dataset_snapshot["sourceDescriptor"])
            self.assertTrue(dataset_snapshot["rowArtifact"]["available"])
            self.assertEqual(dataset_snapshot["rowArtifact"]["mode"], "full_rows")
            self.assertTrue(dataset_snapshot["rowArtifact"]["sensitiveFieldsRetained"])
            self.assertEqual(training["datasetVersion"]["rowArtifact"]["path"], dataset_snapshot["rowArtifact"]["path"])
            row_snapshot = [
                json.loads(line)
                for line in (project_root / dataset_snapshot["rowArtifact"]["path"]).read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(len(row_snapshot), 4)
            self.assertEqual(row_snapshot[0]["email"], "a@example.com")

    def test_preview_api_source_requires_real_confirmation(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), PreviewApiHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as root:
                project_root = Path(root)
                project, pipeline = minimal_project()
                project["dataSources"].append(
                    {
                        "id": "tickets_api",
                        "type": "api",
                        "label": "Tickets API",
                        "sensitiveFields": ["email"],
                        "api": {"method": "GET", "url": f"http://127.0.0.1:{server.server_port}/tickets", "timeoutSeconds": 5},
                    }
                )
                safe_preview = handle_request(
                    {
                        "command": "preview-source",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "sourceId": "tickets_api",
                    }
                )
                real_preview = handle_request(
                    {
                        "command": "preview-source",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "sourceId": "tickets_api",
                        "mode": "real",
                        "allowExternal": True,
                    }
                )
                training = handle_request(
                    {
                        "command": "train-baseline",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "sourceId": "tickets_api",
                        "mode": "real",
                        "allowExternal": True,
                        "datasetSnapshotMode": "masked_rows",
                        "datasetSnapshotRetentionDays": 2,
                    }
                )
                dataset_artifact = training["datasetVersion"]
                dataset_snapshot = json.loads((project_root / dataset_artifact["path"]).read_text(encoding="utf-8"))
                row_snapshot = [
                    json.loads(line)
                    for line in (project_root / dataset_snapshot["rowArtifact"]["path"]).read_text(encoding="utf-8").splitlines()
                ]
        finally:
            server.shutdown()
            server.server_close()

        self.assertEqual(safe_preview["status"], "contract")
        self.assertEqual(real_preview["status"], "ok")
        self.assertEqual(real_preview["mode"], "api")
        self.assertEqual(real_preview["httpStatus"], 200)
        self.assertEqual(real_preview["sample"][0]["email"], "***")
        self.assertEqual(training["status"], "ok")
        self.assertEqual(training["sourceMode"], "api")
        self.assertEqual(training["rowCount"], 4)
        self.assertEqual(dataset_snapshot["sourceMode"], "api")
        self.assertEqual(dataset_snapshot["sourceDescriptor"]["fetch"]["httpStatus"], 200)
        self.assertEqual(dataset_snapshot["sourceDescriptor"]["url"]["host"], f"127.0.0.1:{server.server_port}")
        self.assertEqual(dataset_snapshot["sample"][0]["email"], "***")
        self.assertRegex(dataset_snapshot["rowDigest"], r"^[0-9a-f]{64}$")
        self.assertTrue(dataset_snapshot["rowArtifact"]["available"])
        self.assertEqual(dataset_snapshot["rowArtifact"]["mode"], "masked_rows")
        self.assertFalse(dataset_snapshot["rowArtifact"]["sensitiveFieldsRetained"])
        self.assertEqual(dataset_snapshot["rowArtifact"]["retention"]["policy"], "delete_after_days")
        self.assertEqual(dataset_snapshot["rowArtifact"]["retention"]["days"], 2)
        self.assertRegex(dataset_snapshot["rowArtifact"]["retention"]["expiresAt"], r"Z$")
        self.assertEqual(row_snapshot[0]["email"], "***")

    def test_full_dataset_snapshot_requires_explicit_sensitive_allow(self):
        with tempfile.TemporaryDirectory() as root:
            project, pipeline = minimal_project()
            with self.assertRaises(WorkerError) as error:
                handle_request(
                    {
                        "command": "train-baseline",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "sourceId": "tickets_csv",
                        "mockRows": [
                            {"text": "classe_a boleto", "classe_final": "classe_a", "email": "a@example.com"},
                            {"text": "classe_b login", "classe_final": "classe_b", "email": "b@example.com"},
                        ],
                        "datasetSnapshotMode": "full_rows",
                    }
                )
        self.assertIn("allowSensitiveDatasetSnapshot=true", str(error.exception))

    def test_api_source_persisted_mock_supports_safe_preview_and_training(self):
        with tempfile.TemporaryDirectory() as root:
            project_root = Path(root)
            project, pipeline = minimal_project()
            project["dataSources"].append(
                {
                    "id": "tickets_api",
                    "type": "api",
                    "label": "Tickets API",
                    "sensitiveFields": ["email"],
                    "api": {
                        "method": "GET",
                        "url": "https://api.example.local/tickets",
                        "timeoutSeconds": 5,
                        "mocks": [
                            {
                                "id": "tickets_api_contract",
                                "request": {"method": "GET", "path": "/tickets"},
                                "response": {
                                    "httpStatus": 200,
                                    "body": [
                                        {"id": 1, "text": "classe_a boleto pagamento", "classe_final": "classe_a", "email": "a@example.com"},
                                        {"id": 2, "text": "classe_a segunda via boleto", "classe_final": "classe_a", "email": "b@example.com"},
                                        {"id": 3, "text": "classe_b erro login", "classe_final": "classe_b", "email": "c@example.com"},
                                        {"id": 4, "text": "classe_b redefinir senha", "classe_final": "classe_b", "email": "d@example.com"},
                                    ],
                                },
                            }
                        ],
                    },
                }
            )

            preview = handle_request(
                {
                    "command": "preview-source",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "tickets_api",
                }
            )
            training = handle_request(
                {
                    "command": "train-baseline",
                    "projectRoot": root,
                    "project": project,
                    "pipeline": pipeline,
                    "sourceId": "tickets_api",
                }
            )
            dataset_artifact = training["datasetVersion"]
            dataset_snapshot = json.loads((project_root / dataset_artifact["path"]).read_text(encoding="utf-8"))

        self.assertEqual(preview["status"], "ok")
        self.assertEqual(preview["mode"], "mock")
        self.assertEqual(preview["mockId"], "tickets_api_contract")
        self.assertEqual(preview["sample"][0]["email"], "***")
        self.assertEqual(training["status"], "ok")
        self.assertEqual(training["sourceMode"], "mock")
        self.assertEqual(training["rowCount"], 4)
        self.assertEqual(dataset_snapshot["sourceMode"], "mock")
        self.assertEqual(dataset_snapshot["sourceDescriptor"]["fetch"]["origin"], "persisted_mock")
        self.assertEqual(dataset_snapshot["sourceDescriptor"]["url"]["host"], "api.example.local")
        self.assertEqual(dataset_snapshot["sample"][0]["email"], "***")

    def test_preview_api_source_uses_post_body_template(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), PreviewApiHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as root:
                project, pipeline = minimal_project()
                project["dataSources"].append(
                    {
                        "id": "tickets_api_post",
                        "type": "api",
                        "label": "Tickets API POST",
                        "sensitiveFields": ["email"],
                        "api": {
                            "method": "POST",
                            "url": f"http://127.0.0.1:{server.server_port}/tickets/search",
                            "headers": {"Authorization": "env:TEST_API_POST_TOKEN"},
                            "bodyTemplate": {"query": "classe_a", "limit": 2},
                            "timeoutSeconds": 5,
                        },
                    }
                )
                previous = os.environ.get("TEST_API_POST_TOKEN")
                os.environ["TEST_API_POST_TOKEN"] = "secret-token"
                try:
                    preview = handle_request(
                        {
                            "command": "preview-source",
                            "projectRoot": root,
                            "project": project,
                            "pipeline": pipeline,
                            "sourceId": "tickets_api_post",
                            "mode": "real",
                            "allowExternal": True,
                        }
                    )
                finally:
                    if previous is None:
                        os.environ.pop("TEST_API_POST_TOKEN", None)
                    else:
                        os.environ["TEST_API_POST_TOKEN"] = previous
        finally:
            server.shutdown()
            server.server_close()

        self.assertEqual(preview["status"], "ok")
        self.assertEqual(preview["mode"], "api")
        self.assertEqual(preview["sample"][0]["transport"], "post")
        self.assertEqual(preview["sample"][0]["requestedQuery"], "classe_a")

    def test_preview_api_source_uses_page_pagination(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), PreviewApiHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as root:
                project, pipeline = minimal_project()
                project["dataSources"].append(
                    {
                        "id": "tickets_api_pages",
                        "type": "api",
                        "label": "Tickets API paginada",
                        "sensitiveFields": ["email"],
                        "api": {
                            "method": "GET",
                            "url": f"http://127.0.0.1:{server.server_port}/tickets/pages",
                            "pagination": {"mode": "page", "pageParam": "page"},
                            "timeoutSeconds": 5,
                        },
                    }
                )
                preview = handle_request(
                    {
                        "command": "preview-source",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "sourceId": "tickets_api_pages",
                        "mode": "real",
                        "allowExternal": True,
                        "limit": 4,
                    }
                )
                training = handle_request(
                    {
                        "command": "train-baseline",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "sourceId": "tickets_api_pages",
                        "mode": "real",
                        "allowExternal": True,
                        "maxRows": 4,
                    }
                )
        finally:
            server.shutdown()
            server.server_close()

        self.assertEqual(preview["status"], "ok")
        self.assertEqual(preview["mode"], "api")
        self.assertEqual(preview["paginationMode"], "page")
        self.assertEqual(preview["pagesFetched"], 2)
        self.assertEqual(preview["paginationStopReason"], "limit_reached")
        self.assertEqual(preview["rowCount"], 4)
        self.assertEqual(preview["sample"][0]["email"], "***")
        self.assertEqual(training["status"], "ok")
        self.assertEqual(training["sourceMode"], "api")
        self.assertEqual(training["rowCount"], 4)

    def test_preview_api_source_uses_cursor_pagination(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), PreviewApiHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as root:
                project, pipeline = minimal_project()
                project["dataSources"].append(
                    {
                        "id": "tickets_api_cursor",
                        "type": "api",
                        "label": "Tickets API cursor",
                        "sensitiveFields": ["email"],
                        "api": {
                            "method": "GET",
                            "url": f"http://127.0.0.1:{server.server_port}/tickets/cursor",
                            "pagination": {"mode": "cursor", "pageParam": "cursor", "cursorPath": "meta.next_cursor"},
                            "timeoutSeconds": 5,
                        },
                    }
                )
                preview = handle_request(
                    {
                        "command": "preview-source",
                        "projectRoot": root,
                        "project": project,
                        "pipeline": pipeline,
                        "sourceId": "tickets_api_cursor",
                        "mode": "real",
                        "allowExternal": True,
                    }
                )
        finally:
            server.shutdown()
            server.server_close()

        self.assertEqual(preview["status"], "ok")
        self.assertEqual(preview["mode"], "api")
        self.assertEqual(preview["paginationMode"], "cursor")
        self.assertEqual(preview["pagesFetched"], 2)
        self.assertEqual(preview["paginationStopReason"], "no_cursor")
        self.assertEqual(preview["rowCount"], 4)
        self.assertEqual(preview["sample"][0]["email"], "***")


class PreviewApiHandler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/tickets/pages":
            page = int(query.get("page", ["1"])[0])
            pages = {
                1: [
                    {"id": 1, "text": "classe_a boleto pagamento", "classe_final": "classe_a", "email": "a@example.com"},
                    {"id": 2, "text": "classe_a segunda via boleto", "classe_final": "classe_a", "email": "b@example.com"},
                ],
                2: [
                    {"id": 3, "text": "classe_b erro login", "classe_final": "classe_b", "email": "c@example.com"},
                    {"id": 4, "text": "classe_b redefinir senha", "classe_final": "classe_b", "email": "d@example.com"},
                ],
            }
            self.write_json({"items": pages.get(page, [])})
            return
        if parsed.path == "/tickets/cursor":
            cursor = query.get("cursor", [""])[0]
            if not cursor:
                self.write_json(
                    {
                        "items": [
                            {"id": 1, "text": "classe_a boleto pagamento", "classe_final": "classe_a", "email": "a@example.com"},
                            {"id": 2, "text": "classe_a segunda via boleto", "classe_final": "classe_a", "email": "b@example.com"},
                        ],
                        "meta": {"next_cursor": "batch-2"},
                    }
                )
                return
            if cursor == "batch-2":
                self.write_json(
                    {
                        "items": [
                            {"id": 3, "text": "classe_b erro login", "classe_final": "classe_b", "email": "c@example.com"},
                            {"id": 4, "text": "classe_b redefinir senha", "classe_final": "classe_b", "email": "d@example.com"},
                        ],
                        "meta": {},
                    }
                )
                return
            self.write_json({"items": [], "meta": {}})
            return
        self.write_json(
            {
                "items": [
                    {"id": 1, "text": "classe_a boleto pagamento", "classe_final": "classe_a", "email": "a@example.com"},
                    {"id": 2, "text": "classe_a segunda via boleto", "classe_final": "classe_a", "email": "b@example.com"},
                    {"id": 3, "text": "classe_b erro login", "classe_final": "classe_b", "email": "c@example.com"},
                    {"id": 4, "text": "classe_b redefinir senha", "classe_final": "classe_b", "email": "d@example.com"},
                ]
            }
        )

    def do_POST(self):  # noqa: N802
        content_length = int(self.headers.get("content-length") or "0")
        payload = json.loads(self.rfile.read(content_length).decode("utf-8") or "{}")
        self.write_json(
            {
                "items": [
                    {
                        "id": 10,
                        "text": "classe_a busca post",
                        "classe_final": "classe_a",
                        "email": "post@example.com",
                        "transport": "post",
                        "requestedQuery": payload.get("query"),
                    }
                ]
            }
        )

    def write_json(self, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        return


def minimal_project():
    project = {
        "id": "demo",
        "name": "Demo",
        "version": "0.1.0",
        "problem": {"type": "multiclass_classification", "target": "classe_final", "classes": ["classe_a", "classe_b"]},
        "metrics": {"primary": "f1_macro", "secondary": ["accuracy"]},
        "sensitiveFields": ["email"],
        "dataSources": [
            {
                "id": "tickets_csv",
                "type": "csv",
                "label": "Tickets CSV",
                "sensitiveFields": ["email"],
                "csv": {"path": "data/tickets.csv", "delimiter": ",", "encoding": "utf-8"},
            }
        ],
        "promotionPolicy": {
            "rules": [
                {
                    "kind": "metric",
                    "id": "f1",
                    "label": "F1",
                    "left": {"metric": "f1_macro"},
                    "operator": "gte",
                    "value": 0.8,
                    "neutralBand": 0,
                    "severity": "block",
                }
            ]
        },
    }
    pipeline = {
        "id": "demo-pipeline",
        "nodes": [
            {
                "id": "model",
                "type": "model",
                "label": "Modelo",
                "algorithm": "standard_lib_text_naive_bayes",
                "modelRole": "active",
            },
            {
                "id": "decider",
                "type": "python_function",
                "python": {
                    "entrypoint": "run",
                    "networkPolicy": "none",
                    "codeInline": "def run(input: dict, context: dict) -> dict:\n    if input.get('confidence', 0) < 0.5:\n        return {'decision': 'manual_review'}\n    return {'decision': 'accept'}\n",
                },
            },
        ],
        "edges": [],
    }
    return project, pipeline


if __name__ == "__main__":
    unittest.main()
