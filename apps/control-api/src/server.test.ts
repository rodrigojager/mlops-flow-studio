import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./server.ts";

const execFileAsync = promisify(execFile);
const insecureTestApp = { allowInsecureNoAuth: true } as const;

async function exists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

test("control api exige Bearer token e restringe CORS à origem local", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mlops-flow-studio-security-"));
  const authToken = "test-control-api-token-32-characters";
  assert.throws(
    () => buildApp({ workspaceRoot }),
    /authentication is required/i,
  );

  const app = buildApp({ workspaceRoot, authToken });
  try {
    const missingToken = await app.inject({ method: "GET", url: "/health" });
    assert.equal(missingToken.statusCode, 401);
    assert.equal(missingToken.headers["www-authenticate"], "Bearer");

    const rejectedOrigin = await app.inject({
      method: "OPTIONS",
      url: "/projects",
      headers: { origin: "https://attacker.example" },
    });
    assert.equal(rejectedOrigin.statusCode, 403);
    assert.equal(rejectedOrigin.headers["access-control-allow-origin"], undefined);

    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/projects",
      headers: { origin: "http://127.0.0.1:5273" },
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], "http://127.0.0.1:5273");
    assert.match(String(preflight.headers["access-control-allow-headers"]), /authorization/);

    const authorized = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        origin: "null",
        authorization: `Bearer ${authToken}`,
      },
    });
    assert.equal(authorized.statusCode, 200);
    assert.equal(authorized.headers["access-control-allow-origin"], "null");
  } finally {
    await app.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("control api cria ids únicos e salva project/pipeline em um único bundle", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mlops-flow-studio-bundle-"));
  await cp(path.join(process.cwd(), "templates"), path.join(workspaceRoot, "templates"), { recursive: true });
  await cp(path.join(process.cwd(), "examples"), path.join(workspaceRoot, "examples"), { recursive: true });
  const app = buildApp({ workspaceRoot, ...insecureTestApp });
  try {
    const templates = await app.inject({ method: "GET", url: "/templates" });
    assert.equal(templates.statusCode, 200);
    assert.equal(templates.json().templates.some((template: { id: string }) => template.id === "support_ticket_classification"), true);

    const fromTemplate = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Suporte por template", templateId: "support_ticket_classification" },
    });
    assert.equal(fromTemplate.statusCode, 200, fromTemplate.body);
    assert.equal(fromTemplate.json().pipeline.nodes.length, 11);
    assert.equal(await exists(path.join(workspaceRoot, "projects", "suporte-por-template", "data", "tickets.csv")), true);

    const first = await app.inject({ method: "POST", url: "/projects", payload: {} });
    const second = await app.inject({ method: "POST", url: "/projects", payload: {} });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.notEqual(first.json().project.id, second.json().project.id);

    const projectId = first.json().project.id as string;
    const nextProject = { ...first.json().project, name: "Bundle persistido" };
    const nextPipeline = { ...first.json().pipeline, name: "Pipeline persistido" };
    const saved = await app.inject({
      method: "PUT",
      url: `/projects/${projectId}/bundle`,
      payload: { project: nextProject, pipeline: nextPipeline },
    });
    assert.equal(saved.statusCode, 200, saved.body);

    const loaded = await app.inject({ method: "GET", url: `/projects/${projectId}` });
    assert.equal(loaded.json().project.name, "Bundle persistido");
    assert.equal(loaded.json().pipeline.name, "Pipeline persistido");

    const rejected = await app.inject({
      method: "PUT",
      url: `/projects/${projectId}/bundle`,
      payload: { project: { ...nextProject, name: "Não deve persistir" }, pipeline: { nodes: [] } },
    });
    assert.notEqual(rejected.statusCode, 200);
    const afterRejected = await app.inject({ method: "GET", url: `/projects/${projectId}` });
    assert.equal(afterRejected.json().project.name, "Bundle persistido");
  } finally {
    await app.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("control api não lista nem lê arquivos de credencial em artefatos", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mlops-flow-studio-artifact-security-"));
  const outDir = path.join(workspaceRoot, "generated", "security-runtime");
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "README.md"), "safe", "utf-8");
  await writeFile(path.join(outDir, ".env"), "SECRET=unsafe", "utf-8");
  await writeFile(path.join(outDir, "credentials.json"), "{}", "utf-8");
  const app = buildApp({ workspaceRoot, ...insecureTestApp });
  try {
    const listing = await app.inject({ method: "GET", url: "/artifacts?outDir=generated/security-runtime" });
    assert.equal(listing.statusCode, 200);
    assert.deepEqual(listing.json().files.map((file: { path: string }) => file.path), ["README.md"]);

    const blocked = await app.inject({ method: "GET", url: "/artifacts/file?outDir=generated/security-runtime&path=.env" });
    assert.equal(blocked.statusCode, 404);
  } finally {
    await app.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("control api exclui projeto com confirmacao explicita", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mlops-flow-studio-delete-"));
  const app = buildApp({ workspaceRoot, ...insecureTestApp });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { id: "delete_demo", name: "Delete Demo" },
    });
    assert.equal(created.statusCode, 200);
    assert.equal(await exists(path.join(workspaceRoot, "projects", "delete_demo", "project.yaml")), true);

    const rejected = await app.inject({
      method: "DELETE",
      url: "/projects/delete_demo",
      payload: { confirm: false },
    });
    assert.equal(rejected.statusCode, 400);
    assert.equal(await exists(path.join(workspaceRoot, "projects", "delete_demo", "project.yaml")), true);

    const deleted = await app.inject({
      method: "DELETE",
      url: "/projects/delete_demo",
      payload: { confirm: true },
    });
    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.json().projectId, "delete_demo");
    assert.equal(await exists(path.join(workspaceRoot, "projects", "delete_demo")), false);
  } finally {
    await app.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("control api cria, valida e gera runtime", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mlops-flow-studio-"));
  const snapshotStoreRoot = path.join(workspaceRoot, "snapshot-store");
  const app = buildApp({
    workspaceRoot,
    ...insecureTestApp,
    datasetSnapshotStoreRoot: snapshotStoreRoot,
    datasetSnapshotEncryptionKey: "test-snapshot-encryption-key",
    datasetSnapshotEncryptionKeyRef: "env:TEST_SNAPSHOT_KEY",
  });
  let appClosed = false;
  try {
    const created = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { id: "demo", name: "Demo", problemType: "multiclass_classification", target: "classe_final", classes: ["classe_a", "classe_b"] },
    });
    assert.equal(created.statusCode, 200);
    const createdBody = created.json() as { project: Record<string, unknown>; pipeline: Record<string, unknown> };
    await mkdir(path.join(workspaceRoot, "projects", "demo", "data"), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, "projects", "demo", "data", "tickets.csv"),
      [
        "id,created_at,text,classe_final,email",
        "1,2026-01-03,classe_a boleto pagamento,classe_a,a@example.com",
        "2,2026-01-08,classe_a segunda via boleto,classe_a,b@example.com",
        "3,2026-02-02,classe_a cobrança mensal,classe_a,c@example.com",
        "4,2026-01-12,classe_b erro login acesso,classe_b,d@example.com",
        "5,2026-01-19,classe_b redefinir senha,classe_b,e@example.com",
        "6,2026-02-05,classe_b acesso bloqueado,classe_b,f@example.com",
      ].join("\n"),
      "utf-8",
    );

    const validation = await app.inject({ method: "POST", url: "/projects/demo/validate" });
    assert.equal(validation.statusCode, 200);
    assert.equal(validation.json().status, "ok");

    const dependencies = await app.inject({ method: "GET", url: "/environment/worker-dependencies" });
    assert.equal(dependencies.statusCode, 200);
    assert.ok(dependencies.json().packages.some((item: { name: string }) => item.name === "scikit-learn"));

    const gpuEnvironment = await app.inject({ method: "GET", url: "/environment/gpu" });
    assert.equal(gpuEnvironment.statusCode, 200);
    assert.equal(gpuEnvironment.json().status, "ok");
    assert.ok(["gpu_cuda_ready", "gpu_driver_ready_python_cpu_fallback", "cpu_only"].includes(gpuEnvironment.json().recommendation));
    assert.equal(typeof gpuEnvironment.json().summary.gpuDetected, "boolean");

    const embeddingEnvironment = await app.inject({ method: "GET", url: "/environment/embedding" });
    assert.equal(embeddingEnvironment.statusCode, 200);
    assert.equal(embeddingEnvironment.json().status, "ok");
    assert.equal(typeof embeddingEnvironment.json().packages.sentenceTransformers.installed, "boolean");
    assert.equal(embeddingEnvironment.json().smoke.attempted, false);

    const embeddingSmoke = await app.inject({
      method: "GET",
      url: "/environment/embedding?smoke=true&localFilesOnly=true&model=__mlops_missing_sentence_transformer_model__&timeoutMs=60000",
    });
    assert.equal(embeddingSmoke.statusCode, 200);
    assert.equal(embeddingSmoke.json().status, "ok");
    assert.equal(embeddingSmoke.json().smoke.attempted, true);
    assert.equal(embeddingSmoke.json().smoke.ok, false);
    assert.ok(["package_missing", "model_unavailable_or_failed"].includes(embeddingSmoke.json().recommendation));

    const preview = await app.inject({
      method: "POST",
      url: "/projects/demo/data-sources/tickets_csv/preview",
      payload: { limit: 2 },
    });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().rowCount, 6);
    assert.equal(preview.json().sample[0].email, "***");

    const pythonRun = await app.inject({
      method: "POST",
      url: "/projects/demo/python-nodes/deterministic_decider/run",
      payload: { input: { confidence: 0.4, prediction: "classe_a" } },
    });
    assert.equal(pythonRun.statusCode, 200);
    assert.equal(pythonRun.json().output.decision, "manual_review");

    const previewJobStart = await app.inject({
      method: "POST",
      url: "/projects/demo/data-sources/tickets_csv/preview/jobs",
      payload: { limit: 2, timeoutMs: 60_000 },
    });
    assert.equal(previewJobStart.statusCode, 200);
    assert.equal(previewJobStart.json().status, "running");
    assert.equal(previewJobStart.json().sourceId, "tickets_csv");
    const previewJob = await waitForJob(app, previewJobStart.json().jobId);
    assert.equal(previewJob.status, "completed", JSON.stringify(previewJob));
    assert.equal(previewJob.result.kind, "source_preview");
    assert.equal(previewJob.result.rowCount, 6);
    assert.ok(previewJob.events.some((event: { type?: string }) => event.type === "source_preview_completed"));
    assert.equal(String(previewJob.stderr ?? "").includes("worker_event"), false);

    const pythonJobStart = await app.inject({
      method: "POST",
      url: "/projects/demo/python-nodes/deterministic_decider/run/jobs",
      payload: { input: { confidence: 0.4, prediction: "classe_a" }, timeoutMs: 60_000 },
    });
    assert.equal(pythonJobStart.statusCode, 200);
    assert.equal(pythonJobStart.json().status, "running");
    assert.equal(pythonJobStart.json().nodeId, "deterministic_decider");
    const pythonJob = await waitForJob(app, pythonJobStart.json().jobId);
    assert.equal(pythonJob.status, "completed", JSON.stringify(pythonJob));
    assert.equal(pythonJob.result.kind, "python_block_result");
    assert.equal(pythonJob.result.output.decision, "manual_review");
    assert.ok(pythonJob.events.some((event: { type?: string }) => event.type === "python_block_completed"));

    const training = await app.inject({
      method: "POST",
      url: "/projects/demo/train-baseline",
      payload: { sourceId: "tickets_csv", datasetSnapshotMode: "masked_rows" },
    });
    assert.equal(training.statusCode, 200);
    const trainingBody = training.json();
    assert.equal(trainingBody.rowCount, 6);
    assert.equal(trainingBody.sourceMode, "csv");
    assert.equal(trainingBody.leaderboard[0].modelId, trainingBody.bestModelId);
    assert.ok(trainingBody.leaderboard[0].metrics.f1_macro >= 0.9);
    assert.equal(trainingBody.mlflow.status, "disabled");
    await stat(path.join(workspaceRoot, "projects", "demo", trainingBody.artifacts[0].path));
    assert.equal(trainingBody.datasetVersion.rowArtifact.available, true);
    assert.equal(trainingBody.datasetVersion.rowArtifact.mode, "masked_rows");
    const datasetVersionId = trainingBody.datasetVersion.datasetVersionId as string;
    const datasetManifestPath = path.join(workspaceRoot, "projects", "demo", "artifacts", "dataset_versions", `${datasetVersionId}.json`);
    const rowSnapshotPath = path.join(workspaceRoot, "projects", "demo", trainingBody.datasetVersion.rowArtifact.path);
    await stat(rowSnapshotPath);

    const snapshotStatus = await app.inject({ method: "GET", url: "/projects/demo/dataset-snapshots/status" });
    assert.equal(snapshotStatus.statusCode, 200);
    assert.equal(snapshotStatus.json().store.configured, true);
    assert.equal(snapshotStatus.json().store.storeType, "filesystem");
    assert.equal(snapshotStatus.json().encryption.enabled, true);
    assert.equal(snapshotStatus.json().encryption.keyRef, "env:TEST_SNAPSHOT_KEY");
    assert.equal(snapshotStatus.json().local.manifestCount, 1);
    assert.equal(snapshotStatus.json().local.availableRows, 1);
    assert.equal(snapshotStatus.json().local.maskedRows, 1);
    assert.equal(snapshotStatus.json().remote.archiveMetadataCount, 0);

    const archivedSnapshots = await app.inject({ method: "POST", url: "/projects/demo/dataset-snapshots/archive" });
    assert.equal(archivedSnapshots.statusCode, 200);
    assert.equal(archivedSnapshots.json().archived, 1);
    assert.equal(archivedSnapshots.json().artifacts[0].datasetVersionId, datasetVersionId);
    assert.equal(archivedSnapshots.json().artifacts[0].encrypted, true);
    const archivedRowsPath = path.join(snapshotStoreRoot, "demo", "dataset_versions", `${datasetVersionId}.rows.jsonl.enc`);
    await stat(archivedRowsPath);
    assert.equal((await readFile(archivedRowsPath, "utf-8")).includes("a@example.com"), false);
    const archivedMetadata = JSON.parse(await readFile(path.join(snapshotStoreRoot, "demo", "dataset_versions", `${datasetVersionId}.archive.json`), "utf-8")) as { encryption?: { algorithm?: string; keyRef?: string; keyFingerprint?: string }; plaintextSha256?: string };
    assert.equal(archivedMetadata.encryption?.algorithm, "aes-256-gcm");
    assert.equal(archivedMetadata.encryption?.keyRef, "env:TEST_SNAPSHOT_KEY");
    assert.match(archivedMetadata.encryption?.keyFingerprint ?? "", /^[0-9a-f]{64}$/);
    assert.match(archivedMetadata.plaintextSha256 ?? "", /^[0-9a-f]{64}$/);
    const archivedManifest = JSON.parse(await readFile(datasetManifestPath, "utf-8")) as { rowArtifact: { externalArchive?: { type?: string; storePath?: string; fileSha256?: string; encrypted?: boolean; encryption?: { keyRef?: string } } } };
    assert.equal(archivedManifest.rowArtifact.externalArchive?.type, "filesystem");
    assert.ok(archivedManifest.rowArtifact.externalArchive?.storePath);
    assert.equal(archivedManifest.rowArtifact.externalArchive?.encrypted, true);
    assert.equal(archivedManifest.rowArtifact.externalArchive?.encryption?.keyRef, "env:TEST_SNAPSHOT_KEY");
    assert.match(archivedManifest.rowArtifact.externalArchive?.fileSha256 ?? "", /^[0-9a-f]{64}$/);

    const archivedSnapshotStatus = await app.inject({ method: "GET", url: "/projects/demo/dataset-snapshots/status" });
    assert.equal(archivedSnapshotStatus.statusCode, 200);
    assert.equal(archivedSnapshotStatus.json().local.archivedRows, 1);
    assert.equal(archivedSnapshotStatus.json().remote.archiveMetadataCount, 1);
    assert.equal(archivedSnapshotStatus.json().artifacts[0].encrypted, true);

    await rm(rowSnapshotPath, { force: true });
    const purgedTrainingManifest = JSON.parse(await readFile(datasetManifestPath, "utf-8")) as { rowArtifact: Record<string, unknown> };
    purgedTrainingManifest.rowArtifact = {
      ...purgedTrainingManifest.rowArtifact,
      available: false,
      reason: "Snapshot removido localmente para teste de restauração.",
      purgedAt: new Date().toISOString(),
      purgedPath: trainingBody.datasetVersion.rowArtifact.path,
      path: undefined,
    };
    await writeFile(datasetManifestPath, `${JSON.stringify(purgedTrainingManifest, null, 2)}\n`, "utf-8");

    const restoredSnapshots = await app.inject({ method: "POST", url: "/projects/demo/dataset-snapshots/restore" });
    assert.equal(restoredSnapshots.statusCode, 200);
    assert.equal(restoredSnapshots.json().restored, 1);
    assert.equal(restoredSnapshots.json().artifacts[0].encrypted, true);
    await stat(rowSnapshotPath);
    assert.equal((await readFile(rowSnapshotPath, "utf-8")).includes("***"), true);
    const restoredManifest = JSON.parse(await readFile(datasetManifestPath, "utf-8")) as { rowArtifact: { available?: boolean; path?: string; purgedPath?: string; restoredFrom?: { type?: string; encrypted?: boolean; encryption?: { keyRef?: string } } } };
    assert.equal(restoredManifest.rowArtifact.available, true);
    assert.equal(restoredManifest.rowArtifact.path, trainingBody.datasetVersion.rowArtifact.path);
    assert.equal(restoredManifest.rowArtifact.purgedPath, undefined);
    assert.equal(restoredManifest.rowArtifact.restoredFrom?.type, "filesystem");
    assert.equal(restoredManifest.rowArtifact.restoredFrom?.encrypted, true);
    assert.equal(restoredManifest.rowArtifact.restoredFrom?.encryption?.keyRef, "env:TEST_SNAPSHOT_KEY");

    const restoredSnapshotStatus = await app.inject({ method: "GET", url: "/projects/demo/dataset-snapshots/status" });
    assert.equal(restoredSnapshotStatus.statusCode, 200);
    assert.equal(restoredSnapshotStatus.json().local.availableRows, 1);
    assert.equal(restoredSnapshotStatus.json().local.purgedRows, 0);

    const trainingRuns = await app.inject({ method: "GET", url: "/projects/demo/training-runs" });
    assert.equal(trainingRuns.statusCode, 200);
    assert.equal(trainingRuns.json().latestRun.runId, trainingBody.runId);
    assert.equal(trainingRuns.json().latestRun.mlflow.status, "disabled");

    const incrementalTraining = await app.inject({
      method: "POST",
      url: "/projects/demo/train-baseline",
      payload: { sourceId: "tickets_csv", incremental: true, previousRunId: trainingBody.runId },
    });
    assert.equal(incrementalTraining.statusCode, 200);
    assert.equal(incrementalTraining.json().trainingMode, "incremental");
    assert.equal(incrementalTraining.json().baseRunId, trainingBody.runId);
    assert.ok(incrementalTraining.json().incremental.appliedModels.length >= 1 || incrementalTraining.json().incremental.fallbackModels.length >= 1);

    const evaluation = await app.inject({
      method: "POST",
      url: "/projects/demo/evaluate-model",
      payload: { sourceId: "tickets_csv", runId: trainingBody.runId, modelId: trainingBody.bestModelId },
    });
    assert.equal(evaluation.statusCode, 200);
    assert.equal(evaluation.json().kind, "evaluation_result");
    assert.equal(evaluation.json().runId, trainingBody.runId);
    assert.equal(evaluation.json().modelId, trainingBody.bestModelId);
    assert.ok(evaluation.json().metrics.f1_macro >= 0.9);
    await stat(path.join(workspaceRoot, "projects", "demo", "artifacts", "evaluation_runs", evaluation.json().evaluationId, "evaluation-result.json"));

    const backtest = await app.inject({
      method: "POST",
      url: "/projects/demo/backtest-models",
      payload: {
        sourceId: "tickets_csv",
        runId: trainingBody.runId,
        neutralBand: 0.001,
        timeColumn: "created_at",
        windowStart: "2026-01-01",
        windowEnd: "2026-02-28",
        comparisonWindowStart: "2026-01-01",
        comparisonWindowEnd: "2026-01-31",
        windowGranularity: "month",
      },
    });
    assert.equal(backtest.statusCode, 200);
    assert.equal(backtest.json().kind, "backtest_result");
    assert.equal(backtest.json().runId, trainingBody.runId);
    assert.equal(backtest.json().rowCount, 6);
    assert.equal(backtest.json().baselineModelId, trainingBody.bestModelId);
    assert.equal(backtest.json().temporalWindow.matchedRows, 6);
    assert.equal(backtest.json().temporalWindow.totalRows, 6);
    assert.deepEqual(backtest.json().windowResults.map((item: { id: string }) => item.id), ["2026-01", "2026-02"]);
    assert.equal(backtest.json().windowResults[0].rowCount, 4);
    assert.equal(backtest.json().windowResults[1].rowCount, 2);
    assert.ok(backtest.json().modelMetrics[trainingBody.bestModelId]);
    assert.ok(backtest.json().evidence.some((item: { color?: string }) => ["green", "red", "neutral"].includes(String(item.color))));
    assert.equal(backtest.json().periodComparison.comparisonWindow.matchedRows, 4);
    assert.ok(backtest.json().periodComparison.modelMetrics[trainingBody.bestModelId]);
    assert.ok(backtest.json().periodComparison.evidence.some((item: { color?: string }) => ["green", "red", "neutral"].includes(String(item.color))));
    await stat(path.join(workspaceRoot, "projects", "demo", "artifacts", "evaluation_runs", backtest.json().evaluationId, "evaluation-result.json"));

    const rollingBacktest = await app.inject({
      method: "POST",
      url: "/projects/demo/backtest-models",
      payload: { sourceId: "tickets_csv", runId: trainingBody.runId, neutralBand: 0.001, timeColumn: "created_at", windowStart: "2026-01-01", windowEnd: "2026-02-28", windowGranularity: "rolling_30d" },
    });
    assert.equal(rollingBacktest.statusCode, 200);
    assert.equal(rollingBacktest.json().windowGranularity, "rolling_30d");
    assert.ok(rollingBacktest.json().windowResults.length >= 1);
    assert.equal(rollingBacktest.json().windowResults[0].granularity, "rolling_30d");

    const evaluations = await app.inject({ method: "GET", url: "/projects/demo/evaluation-runs" });
    assert.equal(evaluations.statusCode, 200);
    assert.equal(evaluations.json().latestRun.evaluationId, rollingBacktest.json().evaluationId);
    assert.equal(evaluations.json().latestRun.kind, "backtest_result");
    assert.equal(evaluations.json().latestRun.metricSnapshot.scope, "backtest");

    const previousMlflowTrackingUri = process.env.MLFLOW_TRACKING_URI;
    process.env.MLFLOW_TRACKING_URI = "http://127.0.0.1:9";
    try {
      const mlflowStatus = await app.inject({ method: "GET", url: "/projects/demo/mlflow/status" });
      assert.equal(mlflowStatus.statusCode, 200);
      assert.equal(mlflowStatus.json().configured, true);
      assert.equal(mlflowStatus.json().trackingUri, "http://127.0.0.1:9/");
      assert.equal(mlflowStatus.json().health.reachable, false);
      assert.equal(mlflowStatus.json().latestRun.runId, incrementalTraining.json().runId);
      assert.equal(mlflowStatus.json().latestRun.mlflowStatus, "disabled");
    } finally {
      if (previousMlflowTrackingUri === undefined) {
        delete process.env.MLFLOW_TRACKING_URI;
      } else {
        process.env.MLFLOW_TRACKING_URI = previousMlflowTrackingUri;
      }
    }

    const fakeMlflow = await startFakeMlflowServer();
    process.env.MLFLOW_TRACKING_URI = fakeMlflow.url;
    try {
      const mlflowCatalog = await app.inject({ method: "GET", url: "/projects/demo/mlflow/catalog" });
      assert.equal(mlflowCatalog.statusCode, 200);
      assert.equal(mlflowCatalog.json().configured, true);
      assert.equal(mlflowCatalog.json().experiments.count, 1);
      assert.equal(mlflowCatalog.json().experiments.items[0].name, "demo");
      assert.match(mlflowCatalog.json().experiments.items[0].uiUrl, /#\/experiments\/1$/);
      assert.equal(mlflowCatalog.json().runs.count, 1);
      assert.match(mlflowCatalog.json().runs.items[0].uiUrl, /#\/experiments\/1\/runs\/mlflow-run-1$/);
      assert.equal(mlflowCatalog.json().registeredModels.items[0].name, "ticket-router");
      assert.match(mlflowCatalog.json().registeredModels.items[0].uiUrl, /#\/models\/ticket-router$/);
      assert.equal(mlflowCatalog.json().modelVersions.items[0].runId, "mlflow-run-1");
      assert.match(mlflowCatalog.json().modelVersions.items[0].uiUrl, /#\/models\/ticket-router\/versions\/1$/);

      const aliasRejected = await app.inject({
        method: "POST",
        url: "/projects/demo/mlflow/registry/alias",
        payload: { name: "ticket-router", version: "1", alias: "champion" },
      });
      assert.equal(aliasRejected.statusCode, 400);

      const aliasResult = await app.inject({
        method: "POST",
        url: "/projects/demo/mlflow/registry/alias",
        payload: { name: "ticket-router", version: "1", alias: "champion", confirm: true },
      });
      assert.equal(aliasResult.statusCode, 200);
      assert.equal(aliasResult.json().action, "set_alias");
      assert.equal(aliasResult.json().request.alias, "champion");
      assert.equal(aliasResult.json().mlflow.registered_model_alias.version, "1");

      const stageResult = await app.inject({
        method: "POST",
        url: "/projects/demo/mlflow/registry/stage",
        payload: { name: "ticket-router", version: "1", stage: "Production", archiveExistingVersions: true, confirm: true },
      });
      assert.equal(stageResult.statusCode, 200);
      assert.equal(stageResult.json().action, "transition_stage");
      assert.equal(stageResult.json().request.stage, "Production");
      assert.equal(stageResult.json().mlflow.model_version.current_stage, "Production");

      const deleteAliasResult = await app.inject({
        method: "DELETE",
        url: "/projects/demo/mlflow/registry/alias",
        payload: { name: "ticket-router", alias: "champion", confirm: true },
      });
      assert.equal(deleteAliasResult.statusCode, 200);
      assert.equal(deleteAliasResult.json().action, "delete_alias");
      assert.equal(deleteAliasResult.json().mlflow.deleted_alias.alias, "champion");
    } finally {
      await fakeMlflow.close();
      if (previousMlflowTrackingUri === undefined) {
        delete process.env.MLFLOW_TRACKING_URI;
      } else {
        process.env.MLFLOW_TRACKING_URI = previousMlflowTrackingUri;
      }
    }

    const promotion = await app.inject({ method: "GET", url: "/projects/demo/promotion/status" });
    assert.equal(promotion.statusCode, 200);
    assert.equal(promotion.json().latestRunId, incrementalTraining.json().runId);
    assert.equal(promotion.json().applied, incrementalTraining.json().bestModelId === "baseline_candidate");

    const promotionApplyRejected = await app.inject({
      method: "POST",
      url: "/projects/demo/promotion/apply",
      payload: { runId: trainingBody.runId, candidateModelId: trainingBody.bestModelId },
    });
    assert.equal(promotionApplyRejected.statusCode, 400);

    const promotionApply = await app.inject({
      method: "POST",
      url: "/projects/demo/promotion/apply",
      payload: { runId: trainingBody.runId, candidateModelId: trainingBody.bestModelId, confirm: true },
    });
    assert.equal(promotionApply.statusCode, 200);
    assert.equal(promotionApply.json().activeModelId, trainingBody.bestModelId);
    assert.equal(promotionApply.json().previousActiveModelId, "baseline_candidate");
    assert.equal(promotionApply.json().mlflowSync.status, "skipped");
    assert.equal(promotionApply.json().promotionStatus.applied, true);
    await stat(path.join(workspaceRoot, promotionApply.json().decisionPath));
    const persistedPipeline = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo", "pipeline.flow.json"), "utf-8")) as { nodes: Array<{ id: string; modelRole?: string }> };
    assert.equal(persistedPipeline.nodes.find((node) => node.id === trainingBody.bestModelId)?.modelRole, "active");
    if (trainingBody.bestModelId !== "baseline_candidate") {
      assert.equal(persistedPipeline.nodes.find((node) => node.id === "baseline_candidate")?.modelRole, "baseline");
    }

    const promotionAfterApply = await app.inject({ method: "GET", url: "/projects/demo/promotion/status" });
    assert.equal(promotionAfterApply.statusCode, 200);
    assert.equal(promotionAfterApply.json().applied, true);
    assert.equal(promotionAfterApply.json().activeModelId, trainingBody.bestModelId);

    const generated = await app.inject({ method: "POST", url: "/projects/demo/generate" });
    assert.equal(generated.statusCode, 200);
    assert.equal(generated.json().outDir, "generated/demo-runtime");

    const artifacts = await app.inject({ method: "GET", url: "/artifacts?outDir=generated/demo-runtime" });
    assert.equal(artifacts.statusCode, 200);
    assert.ok(artifacts.json().files.some((file: { path: string }) => file.path === "app/main.py"));
    assert.ok(artifacts.json().files.some((file: { path: string }) => file.path === "app/environment.py"));
    assert.ok(artifacts.json().files.some((file: { path: string }) => file.path === "docker-compose.gpu.yml"));
    assert.ok(artifacts.json().files.some((file: { path: string }) => file.path === "docker-compose.orchestration.yml"));
    assert.ok(artifacts.json().files.some((file: { path: string }) => file.path === "requirements-orchestration.txt"));
    assert.ok(artifacts.json().files.some((file: { path: string }) => file.path === "orchestration/prefect_flow.py"));
    assert.ok(artifacts.json().files.some((file: { path: string }) => file.path === "orchestration/celery_app.py"));
    assert.ok(artifacts.json().files.some((file: { path: string }) => file.path === "app/metadata/latest-training-result.json"));
    const runtimeManifest = JSON.parse(await readFile(path.join(workspaceRoot, "generated", "demo-runtime", "app", "metadata", "runtime.manifest.json"), "utf-8")) as { endpoints: string[] };
    assert.ok(runtimeManifest.endpoints.includes("GET /environment/gpu"));
    const gpuCompose = await readFile(path.join(workspaceRoot, "generated", "demo-runtime", "docker-compose.gpu.yml"), "utf-8");
    assert.match(gpuCompose, /gpus: all/);
    const orchestrationCompose = await readFile(path.join(workspaceRoot, "generated", "demo-runtime", "docker-compose.orchestration.yml"), "utf-8");
    assert.match(orchestrationCompose, /orchestration-redis:/);
    assert.match(orchestrationCompose, /celery-worker:/);
    assert.match(orchestrationCompose, /prefect-server:/);
    const generatedDockerfile = await readFile(path.join(workspaceRoot, "generated", "demo-runtime", "Dockerfile"), "utf-8");
    assert.match(generatedDockerfile, /io\.mlops-flow\.contract="mlops-flow-v1"/);
    assert.match(generatedDockerfile, /io\.mlops-flow\.project-id="demo"/);
    assert.match(generatedDockerfile, /io\.mlops-flow\.endpoints=/);
    const canonicalManifestNames = [
      "data_source.yaml",
      "dataset_manifest.yaml",
      "feature_set.yaml",
      "experiment_manifest.yaml",
      "training_manifest.yaml",
      "promotion_policy.yaml",
      "model_card.yaml",
      "api_manifest.yaml",
      "container_manifest.yaml",
    ];
    for (const manifestName of canonicalManifestNames) {
      const canonicalManifest = await readFile(path.join(workspaceRoot, "generated", "demo-runtime", ".mlops", manifestName), "utf-8");
      assert.match(canonicalManifest, /contract: mlops-flow-v1/);
      assert.match(canonicalManifest, /projectId: demo/);
    }
    const dataSourceManifest = await readFile(path.join(workspaceRoot, "generated", "demo-runtime", ".mlops", "data_source.yaml"), "utf-8");
    assert.match(dataSourceManifest, /kind: data_source/);
    assert.match(dataSourceManifest, /connectors:/);
    assert.match(dataSourceManifest, /id: tickets_csv/);
    const promotionPolicyManifest = await readFile(path.join(workspaceRoot, "generated", "demo-runtime", ".mlops", "promotion_policy.yaml"), "utf-8");
    assert.match(promotionPolicyManifest, /kind: promotion_policy/);
    assert.match(promotionPolicyManifest, /policyId: default-promotion-policy/);
    assert.match(promotionPolicyManifest, /recommendationEndpoint: GET \/promotion\/status/);
    const apiManifest = await readFile(path.join(workspaceRoot, "generated", "demo-runtime", ".mlops", "api_manifest.yaml"), "utf-8");
    assert.match(apiManifest, /path: \/predict/);
    const containerManifest = await readFile(path.join(workspaceRoot, "generated", "demo-runtime", ".mlops", "container_manifest.yaml"), "utf-8");
    assert.match(containerManifest, /docker-compose\.gpu\.yml/);
    assert.match(containerManifest, /docker-compose\.orchestration\.yml/);
    const orchestrationManifest = await readFile(path.join(workspaceRoot, "generated", "demo-runtime", ".mlops", "orchestration_manifest.yaml"), "utf-8");
    assert.match(orchestrationManifest, /kind: orchestration_manifest/);
    assert.match(orchestrationManifest, /composeFile: docker-compose\.orchestration\.yml/);
    assert.match(orchestrationManifest, /entrypoint: orchestration\/prefect_flow\.py/);
    assert.match(orchestrationManifest, /entrypoint: orchestration\/celery_app\.py/);

    const manifestValidation = await app.inject({ method: "GET", url: "/artifacts/validate-manifest?outDir=generated/demo-runtime" });
    assert.equal(manifestValidation.statusCode, 200);
    assert.equal(manifestValidation.json().status, "ok", JSON.stringify(manifestValidation.json().diagnostics));
    assert.equal(manifestValidation.json().summary.errors, 0);
    assert.equal(manifestValidation.json().summary.missingRequiredFiles.length, 0);
    assert.equal(manifestValidation.json().manifest.projectId, "demo");
    assert.ok(manifestValidation.json().manifest.endpoints.includes("GET /metadata"));
    assert.ok(manifestValidation.json().manifest.endpoints.includes("POST /predict"));

    const dockerStatus = await app.inject({ method: "GET", url: "/runtime/docker/status?outDir=generated/demo-runtime" });
    assert.equal(dockerStatus.statusCode, 200);
    assert.equal(dockerStatus.json().exists, true);
    assert.equal(dockerStatus.json().composeExists, true);

    const dockerHistory = await app.inject({ method: "GET", url: "/runtime/docker/history?outDir=generated/demo-runtime" });
    assert.equal(dockerHistory.statusCode, 200);
    assert.equal(dockerHistory.json().outDir, "generated/demo-runtime");
    assert.deepEqual(dockerHistory.json().history, []);

    const dockerInspect = await app.inject({ method: "GET", url: "/runtime/docker/inspect?outDir=generated/demo-runtime" });
    assert.equal(dockerInspect.statusCode, 200);
    assert.equal(dockerInspect.json().outDir, "generated/demo-runtime");
    assert.equal(dockerInspect.json().summary.filesOk, true);
    assert.equal(dockerInspect.json().composeFile.exists, true);
    assert.equal(dockerInspect.json().dockerfile.exists, true);
    assert.equal(dockerInspect.json().history[0].action, "inspect");

    const runtimeSmokeServer = await startRuntimeSmokeServer();
    try {
      const runtimeSmoke = await app.inject({
        method: "POST",
        url: "/runtime/docker/smoke",
        payload: { baseUrl: runtimeSmokeServer.baseUrl, timeoutMs: 5_000 },
      });
      assert.equal(runtimeSmoke.statusCode, 200);
      const smokeBody = runtimeSmoke.json() as { status: string; summary: { total: number; passed: number; failed: number; predictionLogged: boolean; feedbackLogged: boolean; retrainingRequested: boolean; retrainingCompleted: boolean; deploymentObserved: boolean; deploymentRolledBack: boolean }; checks: Array<{ name: string; status: string }> };
      assert.equal(smokeBody.status, "ok", JSON.stringify(smokeBody));
      assert.equal(smokeBody.summary.total, 21);
      assert.equal(smokeBody.summary.passed, 21);
      assert.equal(smokeBody.summary.failed, 0);
      assert.equal(smokeBody.summary.predictionLogged, true);
      assert.equal(smokeBody.summary.feedbackLogged, true);
      assert.equal(smokeBody.summary.retrainingRequested, true);
      assert.equal(smokeBody.summary.retrainingCompleted, true);
      assert.equal(smokeBody.summary.deploymentObserved, true);
      assert.equal(smokeBody.summary.deploymentRolledBack, true);
      assert.deepEqual(smokeBody.checks.map((check) => check.name), ["health", "metadata", "models", "active_model", "model_metrics", "runtime_metrics", "predict", "deployment_status", "deployment_shadow", "deployment_shadow_predict", "deployment_canary", "deployment_canary_predict", "deployment_rollback", "feedback", "feedback_summary", "retraining_request", "retraining_approval", "retraining_training_set", "retraining_completion", "retraining_status", "dashboard"]);
    } finally {
      await runtimeSmokeServer.close();
    }

    const remoteRuntimeServer = await startRuntimeSmokeServer();
    try {
      const remoteInspection = await app.inject({
        method: "POST",
        url: "/runtime/remote/inspect",
        payload: { baseUrl: remoteRuntimeServer.baseUrl, timeoutMs: 5_000 },
      });
      assert.equal(remoteInspection.statusCode, 200);
      const inspectionBody = remoteInspection.json() as {
        status: string;
        mode: string;
        readOnly: boolean;
        identity: { projectId: string | null; projectName: string | null; contract: string | null };
        summary: { ok: number; missing: number; contractEndpointsOk: number; contractEndpointsTotal: number };
        checks: Array<{ name: string; status: string; method: string }>;
        recommendations: string[];
      };
      assert.equal(inspectionBody.mode, "white_box");
      assert.equal(inspectionBody.readOnly, true);
      assert.equal(inspectionBody.identity.projectId, "demo");
      assert.equal(inspectionBody.identity.projectName, "Demo");
      assert.equal(inspectionBody.identity.contract, "mlops-flow-v1");
      assert.equal(inspectionBody.summary.ok >= 6, true);
      assert.equal(inspectionBody.summary.contractEndpointsOk >= 5, true);
      assert.equal(inspectionBody.summary.contractEndpointsTotal >= inspectionBody.summary.contractEndpointsOk, true);
      assert.deepEqual(inspectionBody.checks.slice(0, 2).map((check) => check.name), ["health", "metadata"]);
      assert.equal(inspectionBody.checks.every((check) => check.method === "GET"), true);
      assert.equal(remoteRuntimeServer.requests.some((item) => item.method === "POST"), false);
      assert.ok(inspectionBody.recommendations.includes("remote_inspection_read_only_no_predict"));
    } finally {
      await remoteRuntimeServer.close();
    }

    const blackBoxRuntimeServer = await startBlackBoxRuntimeServer();
    try {
      const blockedBlackBoxImport = await app.inject({
        method: "POST",
        url: "/projects/import-runtime",
        payload: { remoteBaseUrl: blackBoxRuntimeServer.baseUrl, targetProjectId: "demo_remote_black_box" },
      });
      assert.equal(blockedBlackBoxImport.statusCode, 409);

      const importedBlackBox = await app.inject({
        method: "POST",
        url: "/projects/import-runtime",
        payload: { remoteBaseUrl: blackBoxRuntimeServer.baseUrl, targetProjectId: "demo_remote_black_box", confirmBlackBox: true, timeoutMs: 5_000 },
      });
      assert.equal(importedBlackBox.statusCode, 200, importedBlackBox.body);
      assert.equal(importedBlackBox.json().importSource, "remote_black_box");
      assert.equal(importedBlackBox.json().project.id, "demo_remote_black_box");
      assert.equal(importedBlackBox.json().project.problem.target, "prediction");
      assert.equal(importedBlackBox.json().project.dataSources[0].type, "api");
      assert.equal(importedBlackBox.json().project.dataSources[0].api.url, `${blackBoxRuntimeServer.baseUrl}/predict`);
      assert.equal(importedBlackBox.json().pipeline.nodes.some((node: { id?: string; type?: string }) => node.id === "remote_active_model" && node.type === "model"), true);
      assert.equal(importedBlackBox.json().remoteInspection.mode, "black_box_observable");
      await stat(path.join(workspaceRoot, "projects", "demo_remote_black_box", ".mlops", "remote-inspection.json"));
      const blackBoxManifest = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_remote_black_box", ".mlops", "runtime.manifest.json"), "utf-8")) as { endpoints: string[]; projectId: string };
      assert.equal(blackBoxManifest.projectId, "demo_remote_black_box");
      assert.ok(blackBoxManifest.endpoints.includes("GET /health"));
      const blackBoxMeta = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_remote_black_box", ".mlops", "generated-meta.json"), "utf-8")) as { importedFrom: string; readOnly: boolean };
      assert.equal(blackBoxMeta.importedFrom, "remote_black_box");
      assert.equal(blackBoxMeta.readOnly, true);
      assert.equal(blackBoxRuntimeServer.requests.every((item) => item.method === "GET"), true);
      assert.equal(blackBoxRuntimeServer.requests.some((item) => item.method === "POST"), false);
    } finally {
      await blackBoxRuntimeServer.close();
    }

    const latestTraining = await app.inject({ method: "GET", url: "/artifacts/file?outDir=generated/demo-runtime&path=app%2Fmetadata%2Flatest-training-result.json" });
    assert.equal(latestTraining.statusCode, 200);
    assert.equal(JSON.parse(latestTraining.json().content).runId, incrementalTraining.json().runId);

    const approvedRetrainingServer = await startRuntimeSmokeServer();
    try {
      const requestResponse = await fetch(`${approvedRetrainingServer.baseUrl}/retraining/requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ min_feedback_count: 1, requested_by: "test" }),
      });
      const requestBody = await requestResponse.json() as { request_id: string };
      await fetch(`${approvedRetrainingServer.baseUrl}/retraining/requests/${requestBody.request_id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true, approved_by: "test" }),
      });
      const controlledRetrainingJob = await app.inject({
        method: "POST",
        url: "/projects/demo/retraining/from-runtime/jobs",
        payload: {
          baseUrl: approvedRetrainingServer.baseUrl,
          requestId: requestBody.request_id,
          sourceId: "tickets_csv",
          previousRunId: incrementalTraining.json().runId,
          requireFeedbackRows: true,
          timeoutMs: 60_000,
        },
      });
      assert.equal(controlledRetrainingJob.statusCode, 200, controlledRetrainingJob.body);
      assert.equal(controlledRetrainingJob.json().command, "train-baseline");
      assert.equal(controlledRetrainingJob.json().mode, "mock");
      assert.equal(controlledRetrainingJob.json().retraining.requestId, requestBody.request_id);
      assert.equal(controlledRetrainingJob.json().retraining.trainingRowsSource, "runtime_feedback");
      const controlledJobBody = await waitForJob(app, controlledRetrainingJob.json().jobId);
      assert.equal(controlledJobBody.status, "completed", JSON.stringify(controlledJobBody));
      assert.equal(controlledJobBody.result.trainingMode, "incremental");
      assert.equal(controlledJobBody.result.baseRunId, incrementalTraining.json().runId);
      assert.equal(controlledJobBody.retraining.completion.status, "ok");
      assert.equal(controlledJobBody.retraining.requestStatus, "completed");
      assert.equal(controlledJobBody.events.some((event: { type?: string }) => event.type === "runtime_retraining_request_completed"), true);
      assert.equal(approvedRetrainingServer.requests.some((item) => item.method === "POST" && item.path === `/retraining/requests/${requestBody.request_id}/complete`), true);
      const controlledPromotion = await app.inject({
        method: "POST",
        url: `/projects/demo/retraining/from-runtime/jobs/${controlledRetrainingJob.json().jobId}/promotion/apply`,
        payload: { confirm: true, allowReview: true, allowReject: true, syncMlflow: false },
      });
      assert.equal(controlledPromotion.statusCode, 200, controlledPromotion.body);
      assert.equal(controlledPromotion.json().activeModelId, controlledJobBody.result.bestModelId);
      assert.equal(controlledPromotion.json().promotionStatus.applied, true);
      assert.equal(controlledPromotion.json().job.retraining.promotion.status, "ok");
      assert.equal(controlledPromotion.json().job.retraining.promotion.runId, controlledJobBody.result.runId);
      assert.equal(controlledPromotion.json().job.events.some((event: { type?: string }) => event.type === "runtime_retraining_model_promoted"), true);
      await stat(path.join(workspaceRoot, controlledPromotion.json().decisionPath));
    } finally {
      await approvedRetrainingServer.close();
    }

    const exportedZip = await app.inject({
      method: "POST",
      url: "/artifacts/export-zip",
      payload: { outDir: "generated/demo-runtime" },
    });
    assert.equal(exportedZip.statusCode, 200);
    assert.equal(exportedZip.json().zipPath, "generated/demo-runtime.zip");
    assert.equal(exportedZip.json().fileCount > 0, true);
    await stat(path.join(workspaceRoot, exportedZip.json().zipPath));

    const imported = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceDir: "generated/demo-runtime", targetProjectId: "demo_imported" },
    });
    assert.equal(imported.statusCode, 200);
    assert.equal(imported.json().project.id, "demo_imported");
    assert.equal(imported.json().pipeline.nodes.length > 0, true);
    await stat(path.join(workspaceRoot, "projects", "demo_imported", ".mlops", "project.yaml"));

    const importedRuns = await app.inject({ method: "GET", url: "/projects/demo_imported/training-runs" });
    assert.equal(importedRuns.statusCode, 200);
    assert.equal(importedRuns.json().latestRun.projectId, "demo_imported");

    const importedZip = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceZip: "generated/demo-runtime.zip", targetProjectId: "demo_zip_imported" },
    });
    assert.equal(importedZip.statusCode, 200);
    assert.equal(importedZip.json().sourceZip, "generated/demo-runtime.zip");
    assert.equal(importedZip.json().quarantined, true);
    assert.equal(importedZip.json().project.id, "demo_zip_imported");
    assert.equal(importedZip.json().pipeline.nodes.length > 0, true);
    await stat(path.join(workspaceRoot, "projects", "demo_zip_imported", ".mlops", "runtime.manifest.json"));

    const importedZipRuns = await app.inject({ method: "GET", url: "/projects/demo_zip_imported/training-runs" });
    assert.equal(importedZipRuns.statusCode, 200);
    assert.equal(importedZipRuns.json().latestRun, null);
    await stat(path.join(workspaceRoot, "projects", "demo_zip_imported", ".mlops", "import-security.json"));

    const externalRuntimeRoot = path.join(workspaceRoot, "generated", "demo-external-runtime");
    await rm(externalRuntimeRoot, { recursive: true, force: true });
    await mkdir(externalRuntimeRoot, { recursive: true });
    await cp(path.join(workspaceRoot, "generated", "demo-runtime", "app"), path.join(externalRuntimeRoot, "app"), { recursive: true, force: true });
    const importedExternal = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceDir: "generated/demo-external-runtime", targetProjectId: "demo_external_imported" },
    });
    assert.equal(importedExternal.statusCode, 200);
    assert.equal(importedExternal.json().importSource, "app_metadata");
    assert.equal(importedExternal.json().project.id, "demo_external_imported");
    assert.equal(importedExternal.json().pipeline.nodes.length > 0, true);
    await stat(path.join(workspaceRoot, "projects", "demo_external_imported", ".mlops", "project.yaml"));
    await stat(path.join(workspaceRoot, "projects", "demo_external_imported", ".mlops", "runtime.manifest.json"));

    const gitRuntimeRoot = path.join(workspaceRoot, "generated", "demo-git-runtime");
    await rm(gitRuntimeRoot, { recursive: true, force: true });
    await cp(path.join(workspaceRoot, "generated", "demo-runtime"), gitRuntimeRoot, { recursive: true, force: true });
    await mkdir(path.join(gitRuntimeRoot, ".mlops", "artifacts"), { recursive: true });
    await writeFile(path.join(gitRuntimeRoot, ".mlops", "artifacts", "untrusted.pkl"), "malicious pickle placeholder");
    await mkdir(path.join(gitRuntimeRoot, ".mlops", "custom_code"), { recursive: true });
    await writeFile(path.join(gitRuntimeRoot, ".mlops", "custom_code", "untrusted.py"), "raise RuntimeError('must never be imported')\n");
    await execFileAsync("git", ["init"], { cwd: gitRuntimeRoot });
    await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: gitRuntimeRoot });
    await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: gitRuntimeRoot });
    await execFileAsync("git", ["add", "."], { cwd: gitRuntimeRoot });
    await execFileAsync("git", ["commit", "-m", "runtime"], { cwd: gitRuntimeRoot });
    const blockedGitImport = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceGitUrl: "generated/demo-git-runtime", targetProjectId: "demo_git_imported" },
    });
    assert.equal(blockedGitImport.statusCode, 409);
    const importedGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceGitUrl: "generated/demo-git-runtime", targetProjectId: "demo_git_imported", confirmExternalSource: true },
    });
    assert.equal(importedGit.statusCode, 200, importedGit.body);
    assert.equal(importedGit.json().sourceGitUrl, "generated/demo-git-runtime");
    assert.equal(importedGit.json().importSource, "mlops_package");
    assert.equal(importedGit.json().quarantined, true);
    assert.equal(importedGit.json().project.id, "demo_git_imported");
    assert.equal(importedGit.json().pipeline.nodes.length > 0, true);
    await stat(path.join(workspaceRoot, "projects", "demo_git_imported", ".mlops", "project.yaml"));
    await stat(path.join(workspaceRoot, "projects", "demo_git_imported", ".mlops", "import-security.json"));
    assert.equal(await exists(path.join(workspaceRoot, "projects", "demo_git_imported", ".mlops", "artifacts", "untrusted.pkl")), false);
    assert.equal(await exists(path.join(workspaceRoot, "projects", "demo_git_imported", ".mlops", "custom_code", "untrusted.py")), false);
    assert.equal(await exists(path.join(workspaceRoot, "projects", "demo_git_imported", ".mlops", "latest-training-result.json")), false);
    for (const node of importedGit.json().pipeline.nodes as Array<{ python?: { codeInline?: string; codePath?: string } }>) {
      if (node.python) {
        assert.match(node.python.codeInline ?? "", /quarentena/);
        assert.equal(node.python.codePath, undefined);
      }
    }

    const staticGitRuntimeRoot = path.join(workspaceRoot, "generated", "demo-static-git-runtime");
    await rm(staticGitRuntimeRoot, { recursive: true, force: true });
    await mkdir(staticGitRuntimeRoot, { recursive: true });
    await writeFile(
      path.join(staticGitRuntimeRoot, "openapi.json"),
      `${JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Static Git Runtime", version: "2.1.0" },
        paths: {
          "/health": { get: { responses: { "200": { description: "ok" } } } },
          "/predict": { post: { responses: { "200": { description: "prediction" } } } },
        },
      }, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      path.join(staticGitRuntimeRoot, "Dockerfile"),
      [
        "FROM python:3.11-slim",
        "LABEL io.mlops-flow.project-name=\"Static Git Runtime\" \\",
        "      io.mlops-flow.project-version=\"2.1.0\" \\",
        "      io.mlops-flow.execution-profile=\"cpu\"",
        "CMD [\"python\", \"-m\", \"app\"]",
        "",
      ].join("\n"),
      "utf-8",
    );
    await execFileAsync("git", ["init"], { cwd: staticGitRuntimeRoot });
    await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: staticGitRuntimeRoot });
    await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: staticGitRuntimeRoot });
    await execFileAsync("git", ["add", "."], { cwd: staticGitRuntimeRoot });
    await execFileAsync("git", ["commit", "-m", "static runtime"], { cwd: staticGitRuntimeRoot });
    const importedStaticGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceGitUrl: "generated/demo-static-git-runtime", targetProjectId: "demo_static_git_imported", confirmExternalSource: true },
    });
    assert.equal(importedStaticGit.statusCode, 200, importedStaticGit.body);
    assert.equal(importedStaticGit.json().importSource, "git_static_black_box");
    assert.equal(importedStaticGit.json().project.id, "demo_static_git_imported");
    assert.equal(importedStaticGit.json().pipeline.nodes.some((node: { id?: string; type?: string }) => node.id === "git_static_model" && node.type === "model"), true);
    const staticGitInspection = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_git_imported", ".mlops", "git-static-inspection.json"), "utf-8")) as { observedEndpoints: string[]; openapi: { path: string } | null };
    assert.deepEqual(staticGitInspection.observedEndpoints, ["GET /health", "POST /predict"]);
    assert.equal(staticGitInspection.openapi?.path, "openapi.json");
    const staticGitMeta = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_git_imported", ".mlops", "generated-meta.json"), "utf-8")) as { importedFrom: string; noCodeExecution: boolean; noContainerRun: boolean };
    assert.equal(staticGitMeta.importedFrom, "git_static_black_box");
    assert.equal(staticGitMeta.noCodeExecution, true);
    assert.equal(staticGitMeta.noContainerRun, true);

    const staticComposeGitRoot = path.join(workspaceRoot, "generated", "demo-static-compose-runtime");
    await rm(staticComposeGitRoot, { recursive: true, force: true });
    await mkdir(staticComposeGitRoot, { recursive: true });
    await writeFile(
      path.join(staticComposeGitRoot, "docker-compose.yml"),
      [
        "services:",
        "  api:",
        "    image: static-compose-runtime:latest",
        "    labels:",
        "      io.mlops-flow.project-name: Static Compose Runtime",
        "      io.mlops-flow.project-version: 3.0.0",
        "      io.mlops-flow.execution-profile: cpu",
        `      io.mlops-flow.endpoints: '${JSON.stringify(["GET /health", "POST /predict", "GET /metrics/runtime"])}'`,
        "",
      ].join("\n"),
      "utf-8",
    );
    await execFileAsync("git", ["init"], { cwd: staticComposeGitRoot });
    await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: staticComposeGitRoot });
    await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: staticComposeGitRoot });
    await execFileAsync("git", ["add", "."], { cwd: staticComposeGitRoot });
    await execFileAsync("git", ["commit", "-m", "static compose runtime"], { cwd: staticComposeGitRoot });
    const importedStaticComposeGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceGitUrl: "generated/demo-static-compose-runtime", targetProjectId: "demo_static_compose_imported", confirmExternalSource: true },
    });
    assert.equal(importedStaticComposeGit.statusCode, 200, importedStaticComposeGit.body);
    assert.equal(importedStaticComposeGit.json().importSource, "git_static_black_box");
    assert.equal(importedStaticComposeGit.json().project.id, "demo_static_compose_imported");
    assert.equal(importedStaticComposeGit.json().project.name, "Git black-box Static Compose Runtime");
    const staticComposeInspection = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_compose_imported", ".mlops", "git-static-inspection.json"), "utf-8")) as { observedEndpoints: string[]; compose: { path: string; services: string[] } | null; signals: string[] };
    assert.deepEqual(staticComposeInspection.observedEndpoints, ["GET /health", "POST /predict", "GET /metrics/runtime"]);
    assert.equal(staticComposeInspection.compose?.path, "docker-compose.yml");
    assert.deepEqual(staticComposeInspection.compose?.services, ["api"]);
    assert.ok(staticComposeInspection.signals.includes("compose_labels"));

    const staticFastApiGitRoot = path.join(workspaceRoot, "generated", "demo-static-fastapi-runtime");
    await rm(staticFastApiGitRoot, { recursive: true, force: true });
    await mkdir(path.join(staticFastApiGitRoot, "app"), { recursive: true });
    await writeFile(
      path.join(staticFastApiGitRoot, "app", "main.py"),
      [
        "from fastapi import FastAPI",
        "",
        "app = FastAPI(title=\"Static FastAPI Runtime\")",
        "",
        "@app.get(\"/health\")",
        "def health():",
        "    return {\"status\": \"ok\"}",
        "",
        "@app.post(\"/predict\")",
        "def predict(payload: dict):",
        "    return {\"prediction\": \"unknown\"}",
        "",
      ].join("\n"),
      "utf-8",
    );
    await execFileAsync("git", ["init"], { cwd: staticFastApiGitRoot });
    await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: staticFastApiGitRoot });
    await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: staticFastApiGitRoot });
    await execFileAsync("git", ["add", "."], { cwd: staticFastApiGitRoot });
    await execFileAsync("git", ["commit", "-m", "static fastapi runtime"], { cwd: staticFastApiGitRoot });
    const importedStaticFastApiGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceGitUrl: "generated/demo-static-fastapi-runtime", targetProjectId: "demo_static_fastapi_imported", confirmExternalSource: true },
    });
    assert.equal(importedStaticFastApiGit.statusCode, 200, importedStaticFastApiGit.body);
    assert.equal(importedStaticFastApiGit.json().importSource, "git_static_black_box");
    assert.equal(importedStaticFastApiGit.json().project.id, "demo_static_fastapi_imported");
    assert.equal(importedStaticFastApiGit.json().pipeline.nodes.some((node: { id?: string; type?: string }) => node.id === "git_static_model" && node.type === "model"), true);
    const staticFastApiInspection = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_fastapi_imported", ".mlops", "git-static-inspection.json"), "utf-8")) as { observedEndpoints: string[]; fastapi: { files: Array<{ path: string; endpoints: string[] }> } | null; signals: string[] };
    assert.deepEqual(staticFastApiInspection.observedEndpoints, ["GET /health", "POST /predict"]);
    assert.equal(staticFastApiInspection.fastapi?.files[0]?.path, "app/main.py");
    assert.ok(staticFastApiInspection.signals.includes("fastapi_routes"));
    const staticFastApiMeta = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_fastapi_imported", ".mlops", "generated-meta.json"), "utf-8")) as { importedFrom: string; noCodeExecution: boolean; noContainerRun: boolean; sourceFiles: string[] };
    assert.equal(staticFastApiMeta.importedFrom, "git_static_black_box");
    assert.equal(staticFastApiMeta.noCodeExecution, true);
    assert.equal(staticFastApiMeta.noContainerRun, true);
    assert.ok(staticFastApiMeta.sourceFiles.includes("app/main.py"));

    const staticFlaskGitRoot = path.join(workspaceRoot, "generated", "demo-static-flask-runtime");
    await rm(staticFlaskGitRoot, { recursive: true, force: true });
    await mkdir(staticFlaskGitRoot, { recursive: true });
    await writeFile(
      path.join(staticFlaskGitRoot, "app.py"),
      [
        "from flask import Flask, request",
        "",
        "app = Flask(__name__)",
        "",
        "@app.route(\"/health\")",
        "def health():",
        "    return {\"status\": \"ok\"}",
        "",
        "@app.route(\"/predict\", methods=[\"POST\"])",
        "def predict():",
        "    payload = request.get_json(silent=True) or {}",
        "    return {\"prediction\": payload.get(\"prediction\", \"unknown\")}",
        "",
      ].join("\n"),
      "utf-8",
    );
    await execFileAsync("git", ["init"], { cwd: staticFlaskGitRoot });
    await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: staticFlaskGitRoot });
    await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: staticFlaskGitRoot });
    await execFileAsync("git", ["add", "."], { cwd: staticFlaskGitRoot });
    await execFileAsync("git", ["commit", "-m", "static flask runtime"], { cwd: staticFlaskGitRoot });
    const importedStaticFlaskGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceGitUrl: "generated/demo-static-flask-runtime", targetProjectId: "demo_static_flask_imported", confirmExternalSource: true },
    });
    assert.equal(importedStaticFlaskGit.statusCode, 200, importedStaticFlaskGit.body);
    assert.equal(importedStaticFlaskGit.json().importSource, "git_static_black_box");
    assert.equal(importedStaticFlaskGit.json().project.id, "demo_static_flask_imported");
    assert.equal(importedStaticFlaskGit.json().pipeline.nodes.some((node: { id?: string; type?: string }) => node.id === "git_static_model" && node.type === "model"), true);
    const staticFlaskInspection = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_flask_imported", ".mlops", "git-static-inspection.json"), "utf-8")) as { observedEndpoints: string[]; flask: { files: Array<{ path: string; endpoints: string[] }> } | null; signals: string[] };
    assert.deepEqual(staticFlaskInspection.observedEndpoints, ["GET /health", "POST /predict"]);
    assert.equal(staticFlaskInspection.flask?.files[0]?.path, "app.py");
    assert.ok(staticFlaskInspection.signals.includes("flask_routes"));
    const staticFlaskMeta = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_flask_imported", ".mlops", "generated-meta.json"), "utf-8")) as { importedFrom: string; noCodeExecution: boolean; noContainerRun: boolean; sourceFiles: string[] };
    assert.equal(staticFlaskMeta.importedFrom, "git_static_black_box");
    assert.equal(staticFlaskMeta.noCodeExecution, true);
    assert.equal(staticFlaskMeta.noContainerRun, true);
    assert.ok(staticFlaskMeta.sourceFiles.includes("app.py"));

    const staticStarletteGitRoot = path.join(workspaceRoot, "generated", "demo-static-starlette-runtime");
    await rm(staticStarletteGitRoot, { recursive: true, force: true });
    await mkdir(path.join(staticStarletteGitRoot, "service"), { recursive: true });
    await writeFile(
      path.join(staticStarletteGitRoot, "service", "main.py"),
      [
        "from starlette.applications import Starlette",
        "from starlette.responses import JSONResponse",
        "from starlette.routing import Route",
        "",
        "async def health(request):",
        "    return JSONResponse({\"status\": \"ok\"})",
        "",
        "async def predict(request):",
        "    return JSONResponse({\"prediction\": \"unknown\"})",
        "",
        "routes = [",
        "    Route(\"/health\", health, methods=[\"GET\"]),",
        "    Route(\"/predict\", predict, methods=[\"POST\"]),",
        "]",
        "",
        "app = Starlette(routes=routes)",
        "",
      ].join("\n"),
      "utf-8",
    );
    await execFileAsync("git", ["init"], { cwd: staticStarletteGitRoot });
    await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: staticStarletteGitRoot });
    await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: staticStarletteGitRoot });
    await execFileAsync("git", ["add", "."], { cwd: staticStarletteGitRoot });
    await execFileAsync("git", ["commit", "-m", "static starlette runtime"], { cwd: staticStarletteGitRoot });
    const importedStaticStarletteGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceGitUrl: "generated/demo-static-starlette-runtime", targetProjectId: "demo_static_starlette_imported", confirmExternalSource: true },
    });
    assert.equal(importedStaticStarletteGit.statusCode, 200, importedStaticStarletteGit.body);
    assert.equal(importedStaticStarletteGit.json().importSource, "git_static_black_box");
    assert.equal(importedStaticStarletteGit.json().project.id, "demo_static_starlette_imported");
    assert.equal(importedStaticStarletteGit.json().pipeline.nodes.some((node: { id?: string; type?: string }) => node.id === "git_static_model" && node.type === "model"), true);
    const staticStarletteInspection = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_starlette_imported", ".mlops", "git-static-inspection.json"), "utf-8")) as { observedEndpoints: string[]; starlette: { files: Array<{ path: string; endpoints: string[] }> } | null; signals: string[] };
    assert.deepEqual(staticStarletteInspection.observedEndpoints, ["GET /health", "POST /predict"]);
    assert.equal(staticStarletteInspection.starlette?.files[0]?.path, "main.py");
    assert.ok(staticStarletteInspection.signals.includes("starlette_routes"));
    const staticStarletteMeta = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_starlette_imported", ".mlops", "generated-meta.json"), "utf-8")) as { importedFrom: string; noCodeExecution: boolean; noContainerRun: boolean; sourceFiles: string[] };
    assert.equal(staticStarletteMeta.importedFrom, "git_static_black_box");
    assert.equal(staticStarletteMeta.noCodeExecution, true);
    assert.equal(staticStarletteMeta.noContainerRun, true);
    assert.ok(staticStarletteMeta.sourceFiles.includes("main.py"));

    const staticDjangoGitRoot = path.join(workspaceRoot, "generated", "demo-static-django-runtime");
    await rm(staticDjangoGitRoot, { recursive: true, force: true });
    await mkdir(staticDjangoGitRoot, { recursive: true });
    await writeFile(
      path.join(staticDjangoGitRoot, "urls.py"),
      [
        "from django.urls import path",
        "from . import views",
        "",
        "urlpatterns = [",
        "    path(\"health/\", views.health, name=\"health\"),",
        "    path(\"predict/\", views.predict, name=\"predict\"),",
        "]",
        "",
      ].join("\n"),
      "utf-8",
    );
    await execFileAsync("git", ["init"], { cwd: staticDjangoGitRoot });
    await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: staticDjangoGitRoot });
    await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: staticDjangoGitRoot });
    await execFileAsync("git", ["add", "."], { cwd: staticDjangoGitRoot });
    await execFileAsync("git", ["commit", "-m", "static django runtime"], { cwd: staticDjangoGitRoot });
    const importedStaticDjangoGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceGitUrl: "generated/demo-static-django-runtime", targetProjectId: "demo_static_django_imported", confirmExternalSource: true },
    });
    assert.equal(importedStaticDjangoGit.statusCode, 200, importedStaticDjangoGit.body);
    assert.equal(importedStaticDjangoGit.json().importSource, "git_static_black_box");
    assert.equal(importedStaticDjangoGit.json().project.id, "demo_static_django_imported");
    assert.equal(importedStaticDjangoGit.json().pipeline.nodes.some((node: { id?: string; type?: string }) => node.id === "git_static_model" && node.type === "model"), true);
    const staticDjangoInspection = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_django_imported", ".mlops", "git-static-inspection.json"), "utf-8")) as { observedEndpoints: string[]; django: { files: Array<{ path: string; endpoints: string[] }> } | null; signals: string[] };
    assert.deepEqual(staticDjangoInspection.observedEndpoints, ["GET /health/", "POST /predict/"]);
    assert.equal(staticDjangoInspection.django?.files[0]?.path, "urls.py");
    assert.ok(staticDjangoInspection.signals.includes("django_routes"));
    const staticDjangoMeta = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_django_imported", ".mlops", "generated-meta.json"), "utf-8")) as { importedFrom: string; noCodeExecution: boolean; noContainerRun: boolean; sourceFiles: string[] };
    assert.equal(staticDjangoMeta.importedFrom, "git_static_black_box");
    assert.equal(staticDjangoMeta.noCodeExecution, true);
    assert.equal(staticDjangoMeta.noContainerRun, true);
    assert.ok(staticDjangoMeta.sourceFiles.includes("urls.py"));

    const staticExpressGitRoot = path.join(workspaceRoot, "generated", "demo-static-express-runtime");
    await rm(staticExpressGitRoot, { recursive: true, force: true });
    await mkdir(path.join(staticExpressGitRoot, "src"), { recursive: true });
    await writeFile(
      path.join(staticExpressGitRoot, "package.json"),
      `${JSON.stringify({ name: "demo-static-express-runtime", version: "1.0.0", dependencies: { express: "^4.18.0" } }, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      path.join(staticExpressGitRoot, "src", "server.ts"),
      [
        "import express from \"express\";",
        "",
        "const app = express();",
        "const router = express.Router();",
        "",
        "app.get(\"/health\", (_request, response) => response.json({ status: \"ok\" }));",
        "router.post(\"/predict\", (_request, response) => response.json({ prediction: \"unknown\" }));",
        "app.use(\"/\", router);",
        "",
        "export default app;",
        "",
      ].join("\n"),
      "utf-8",
    );
    await execFileAsync("git", ["init"], { cwd: staticExpressGitRoot });
    await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: staticExpressGitRoot });
    await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: staticExpressGitRoot });
    await execFileAsync("git", ["add", "."], { cwd: staticExpressGitRoot });
    await execFileAsync("git", ["commit", "-m", "static express runtime"], { cwd: staticExpressGitRoot });
    const importedStaticExpressGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceGitUrl: "generated/demo-static-express-runtime", targetProjectId: "demo_static_express_imported", confirmExternalSource: true },
    });
    assert.equal(importedStaticExpressGit.statusCode, 200, importedStaticExpressGit.body);
    assert.equal(importedStaticExpressGit.json().importSource, "git_static_black_box");
    assert.equal(importedStaticExpressGit.json().project.id, "demo_static_express_imported");
    assert.equal(importedStaticExpressGit.json().pipeline.nodes.some((node: { id?: string; type?: string }) => node.id === "git_static_model" && node.type === "model"), true);
    const staticExpressInspection = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_express_imported", ".mlops", "git-static-inspection.json"), "utf-8")) as { observedEndpoints: string[]; express: { files: Array<{ path: string; endpoints: string[] }> } | null; signals: string[] };
    assert.deepEqual(staticExpressInspection.observedEndpoints, ["GET /health", "POST /predict"]);
    assert.equal(staticExpressInspection.express?.files[0]?.path, "src/server.ts");
    assert.ok(staticExpressInspection.signals.includes("express_routes"));
    const staticExpressMeta = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_express_imported", ".mlops", "generated-meta.json"), "utf-8")) as { importedFrom: string; noCodeExecution: boolean; noContainerRun: boolean; sourceFiles: string[] };
    assert.equal(staticExpressMeta.importedFrom, "git_static_black_box");
    assert.equal(staticExpressMeta.noCodeExecution, true);
    assert.equal(staticExpressMeta.noContainerRun, true);
    assert.ok(staticExpressMeta.sourceFiles.includes("src/server.ts"));

    const staticFastifyGitRoot = path.join(workspaceRoot, "generated", "demo-static-fastify-runtime");
    await rm(staticFastifyGitRoot, { recursive: true, force: true });
    await mkdir(path.join(staticFastifyGitRoot, "src"), { recursive: true });
    await writeFile(
      path.join(staticFastifyGitRoot, "package.json"),
      `${JSON.stringify({ name: "demo-static-fastify-runtime", version: "1.0.0", dependencies: { fastify: "^4.28.0" } }, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      path.join(staticFastifyGitRoot, "src", "server.ts"),
      [
        "import Fastify from \"fastify\";",
        "",
        "const app = Fastify();",
        "",
        "app.get(\"/health\", async () => ({ status: \"ok\" }));",
        "app.route({ method: \"POST\", url: \"/predict\", handler: async () => ({ prediction: \"unknown\" }) });",
        "app.route({ method: [\"PATCH\", \"DELETE\"], url: \"/feedback\", handler: async () => ({ ok: true }) });",
        "",
        "export default app;",
        "",
      ].join("\n"),
      "utf-8",
    );
    await execFileAsync("git", ["init"], { cwd: staticFastifyGitRoot });
    await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: staticFastifyGitRoot });
    await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: staticFastifyGitRoot });
    await execFileAsync("git", ["add", "."], { cwd: staticFastifyGitRoot });
    await execFileAsync("git", ["commit", "-m", "static fastify runtime"], { cwd: staticFastifyGitRoot });
    const importedStaticFastifyGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceGitUrl: "generated/demo-static-fastify-runtime", targetProjectId: "demo_static_fastify_imported", confirmExternalSource: true },
    });
    assert.equal(importedStaticFastifyGit.statusCode, 200, importedStaticFastifyGit.body);
    assert.equal(importedStaticFastifyGit.json().importSource, "git_static_black_box");
    assert.equal(importedStaticFastifyGit.json().project.id, "demo_static_fastify_imported");
    assert.equal(importedStaticFastifyGit.json().pipeline.nodes.some((node: { id?: string; type?: string }) => node.id === "git_static_model" && node.type === "model"), true);
    const staticFastifyInspection = JSON.parse(
      await readFile(path.join(workspaceRoot, "projects", "demo_static_fastify_imported", ".mlops", "git-static-inspection.json"), "utf-8"),
    ) as { observedEndpoints: string[]; fastify: { files: Array<{ path: string; endpoints: string[] }> } | null; signals: string[] };
    assert.deepEqual(staticFastifyInspection.observedEndpoints, ["GET /health", "POST /predict", "PATCH /feedback", "DELETE /feedback"]);
    assert.equal(staticFastifyInspection.fastify?.files[0]?.path, "src/server.ts");
    assert.ok(staticFastifyInspection.signals.includes("fastify_routes"));
    const staticFastifyMeta = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_fastify_imported", ".mlops", "generated-meta.json"), "utf-8")) as { importedFrom: string; noCodeExecution: boolean; noContainerRun: boolean; sourceFiles: string[] };
    assert.equal(staticFastifyMeta.importedFrom, "git_static_black_box");
    assert.equal(staticFastifyMeta.noCodeExecution, true);
    assert.equal(staticFastifyMeta.noContainerRun, true);
    assert.ok(staticFastifyMeta.sourceFiles.includes("src/server.ts"));

    const staticGoGitRoot = path.join(workspaceRoot, "generated", "demo-static-go-runtime");
    await rm(staticGoGitRoot, { recursive: true, force: true });
    await mkdir(path.join(staticGoGitRoot, "cmd", "api"), { recursive: true });
    await writeFile(
      path.join(staticGoGitRoot, "go.mod"),
      [
        "module example.com/demo-static-go-runtime",
        "",
        "go 1.22",
        "",
        "require github.com/gin-gonic/gin v1.10.0",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      path.join(staticGoGitRoot, "cmd", "api", "main.go"),
      [
        "package main",
        "",
        "import \"github.com/gin-gonic/gin\"",
        "",
        "func main() {",
        "    router := gin.Default()",
        "    router.GET(\"/health\", func(ctx *gin.Context) { ctx.JSON(200, gin.H{\"status\": \"ok\"}) })",
        "    router.POST(\"/predict\", func(ctx *gin.Context) { ctx.JSON(200, gin.H{\"prediction\": \"unknown\"}) })",
        "    _ = router",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );
    await execFileAsync("git", ["init"], { cwd: staticGoGitRoot });
    await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: staticGoGitRoot });
    await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: staticGoGitRoot });
    await execFileAsync("git", ["add", "."], { cwd: staticGoGitRoot });
    await execFileAsync("git", ["commit", "-m", "static go runtime"], { cwd: staticGoGitRoot });
    const importedStaticGoGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceGitUrl: "generated/demo-static-go-runtime", targetProjectId: "demo_static_go_imported", confirmExternalSource: true },
    });
    assert.equal(importedStaticGoGit.statusCode, 200, importedStaticGoGit.body);
    assert.equal(importedStaticGoGit.json().importSource, "git_static_black_box");
    assert.equal(importedStaticGoGit.json().project.id, "demo_static_go_imported");
    assert.equal(importedStaticGoGit.json().pipeline.nodes.some((node: { id?: string; type?: string }) => node.id === "git_static_model" && node.type === "model"), true);
    const staticGoInspection = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_go_imported", ".mlops", "git-static-inspection.json"), "utf-8")) as { observedEndpoints: string[]; go: { files: Array<{ path: string; endpoints: string[] }> } | null; signals: string[] };
    assert.deepEqual(staticGoInspection.observedEndpoints, ["GET /health", "POST /predict"]);
    assert.equal(staticGoInspection.go?.files[0]?.path, "cmd/api/main.go");
    assert.ok(staticGoInspection.signals.includes("go_routes"));
    const staticGoMeta = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_go_imported", ".mlops", "generated-meta.json"), "utf-8")) as { importedFrom: string; noCodeExecution: boolean; noContainerRun: boolean; sourceFiles: string[] };
    assert.equal(staticGoMeta.importedFrom, "git_static_black_box");
    assert.equal(staticGoMeta.noCodeExecution, true);
    assert.equal(staticGoMeta.noContainerRun, true);
    assert.ok(staticGoMeta.sourceFiles.includes("cmd/api/main.go"));

    const staticRubyGitRoot = path.join(workspaceRoot, "generated", "demo-static-ruby-runtime");
    await rm(staticRubyGitRoot, { recursive: true, force: true });
    await mkdir(path.join(staticRubyGitRoot, "config"), { recursive: true });
    await writeFile(
      path.join(staticRubyGitRoot, "Gemfile"),
      [
        "source \"https://rubygems.org\"",
        "gem \"rails\"",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      path.join(staticRubyGitRoot, "config", "routes.rb"),
      [
        "Rails.application.routes.draw do",
        "  get \"/health\", to: \"health#show\"",
        "  post \"/predict\", to: \"predictions#create\"",
        "end",
        "",
      ].join("\n"),
      "utf-8",
    );
    await execFileAsync("git", ["init"], { cwd: staticRubyGitRoot });
    await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: staticRubyGitRoot });
    await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: staticRubyGitRoot });
    await execFileAsync("git", ["add", "."], { cwd: staticRubyGitRoot });
    await execFileAsync("git", ["commit", "-m", "static ruby runtime"], { cwd: staticRubyGitRoot });
    const importedStaticRubyGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceGitUrl: "generated/demo-static-ruby-runtime", targetProjectId: "demo_static_ruby_imported", confirmExternalSource: true },
    });
    assert.equal(importedStaticRubyGit.statusCode, 200, importedStaticRubyGit.body);
    assert.equal(importedStaticRubyGit.json().importSource, "git_static_black_box");
    assert.equal(importedStaticRubyGit.json().project.id, "demo_static_ruby_imported");
    assert.equal(importedStaticRubyGit.json().pipeline.nodes.some((node: { id?: string; type?: string }) => node.id === "git_static_model" && node.type === "model"), true);
    const staticRubyInspection = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_ruby_imported", ".mlops", "git-static-inspection.json"), "utf-8")) as { observedEndpoints: string[]; ruby: { files: Array<{ path: string; endpoints: string[] }> } | null; signals: string[] };
    assert.deepEqual(staticRubyInspection.observedEndpoints, ["GET /health", "POST /predict"]);
    assert.equal(staticRubyInspection.ruby?.files[0]?.path, "config/routes.rb");
    assert.ok(staticRubyInspection.signals.includes("ruby_routes"));
    const staticRubyMeta = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_ruby_imported", ".mlops", "generated-meta.json"), "utf-8")) as { importedFrom: string; noCodeExecution: boolean; noContainerRun: boolean; sourceFiles: string[] };
    assert.equal(staticRubyMeta.importedFrom, "git_static_black_box");
    assert.equal(staticRubyMeta.noCodeExecution, true);
    assert.equal(staticRubyMeta.noContainerRun, true);
    assert.ok(staticRubyMeta.sourceFiles.includes("config/routes.rb"));

    const staticJavaGitRoot = path.join(workspaceRoot, "generated", "demo-static-java-runtime");
    await rm(staticJavaGitRoot, { recursive: true, force: true });
    await mkdir(path.join(staticJavaGitRoot, "src", "main", "java", "com", "example", "demo"), { recursive: true });
    await writeFile(
      path.join(staticJavaGitRoot, "build.gradle"),
      [
        "plugins { id 'org.springframework.boot' version '3.3.0' }",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      path.join(staticJavaGitRoot, "src", "main", "java", "com", "example", "demo", "PredictController.java"),
      [
        "package com.example.demo;",
        "",
        "import org.springframework.web.bind.annotation.GetMapping;",
        "import org.springframework.web.bind.annotation.PostMapping;",
        "import org.springframework.web.bind.annotation.RequestMapping;",
        "import org.springframework.web.bind.annotation.RestController;",
        "",
        "@RestController",
        "@RequestMapping(\"/api\")",
        "public class PredictController {",
        "    @GetMapping(\"/health\")",
        "    public String health() { return \"ok\"; }",
        "",
        "    @PostMapping(\"/predict\")",
        "    public String predict() { return \"unknown\"; }",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );
    await execFileAsync("git", ["init"], { cwd: staticJavaGitRoot });
    await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: staticJavaGitRoot });
    await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: staticJavaGitRoot });
    await execFileAsync("git", ["add", "."], { cwd: staticJavaGitRoot });
    await execFileAsync("git", ["commit", "-m", "static java runtime"], { cwd: staticJavaGitRoot });
    const importedStaticJavaGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceGitUrl: "generated/demo-static-java-runtime", targetProjectId: "demo_static_java_imported", confirmExternalSource: true },
    });
    assert.equal(importedStaticJavaGit.statusCode, 200, importedStaticJavaGit.body);
    assert.equal(importedStaticJavaGit.json().importSource, "git_static_black_box");
    assert.equal(importedStaticJavaGit.json().project.id, "demo_static_java_imported");
    assert.equal(importedStaticJavaGit.json().pipeline.nodes.some((node: { id?: string; type?: string }) => node.id === "git_static_model" && node.type === "model"), true);
    const staticJavaInspection = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_java_imported", ".mlops", "git-static-inspection.json"), "utf-8")) as { observedEndpoints: string[]; java: { files: Array<{ path: string; endpoints: string[] }> } | null; signals: string[] };
    assert.deepEqual(staticJavaInspection.observedEndpoints, ["GET /api/health", "POST /api/predict"]);
    assert.equal(staticJavaInspection.java?.files[0]?.path, "src/main/java/com/example/demo/PredictController.java");
    assert.ok(staticJavaInspection.signals.includes("java_routes"));
    const staticJavaMeta = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_java_imported", ".mlops", "generated-meta.json"), "utf-8")) as { importedFrom: string; noCodeExecution: boolean; noContainerRun: boolean; sourceFiles: string[] };
    assert.equal(staticJavaMeta.importedFrom, "git_static_black_box");
    assert.equal(staticJavaMeta.noCodeExecution, true);
    assert.equal(staticJavaMeta.noContainerRun, true);
    assert.ok(staticJavaMeta.sourceFiles.includes("src/main/java/com/example/demo/PredictController.java"));

    const staticDotnetGitRoot = path.join(workspaceRoot, "generated", "demo-static-dotnet-runtime");
    await rm(staticDotnetGitRoot, { recursive: true, force: true });
    await mkdir(path.join(staticDotnetGitRoot, "Controllers"), { recursive: true });
    await writeFile(
      path.join(staticDotnetGitRoot, "Program.cs"),
      [
        "using Microsoft.AspNetCore.Builder;",
        "",
        "var builder = WebApplication.CreateBuilder(args);",
        "var app = builder.Build();",
        "",
        "app.MapGet(\"/health\", () => Results.Ok(new { status = \"ok\" }));",
        "app.MapPost(\"/predict\", (object payload) => Results.Ok(new { prediction = \"unknown\" }));",
        "",
        "app.Run();",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      path.join(staticDotnetGitRoot, "Controllers", "MetricsController.cs"),
      [
        "using Microsoft.AspNetCore.Mvc;",
        "",
        "[Route(\"metrics\")]",
        "[ApiController]",
        "public class MetricsController : ControllerBase",
        "{",
        "    [HttpGet(\"runtime\")]",
        "    public IActionResult Runtime() => Ok(new { prediction_count = 0 });",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );
    await execFileAsync("git", ["init"], { cwd: staticDotnetGitRoot });
    await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: staticDotnetGitRoot });
    await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: staticDotnetGitRoot });
    await execFileAsync("git", ["add", "."], { cwd: staticDotnetGitRoot });
    await execFileAsync("git", ["commit", "-m", "static dotnet runtime"], { cwd: staticDotnetGitRoot });
    const importedStaticDotnetGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceGitUrl: "generated/demo-static-dotnet-runtime", targetProjectId: "demo_static_dotnet_imported", confirmExternalSource: true },
    });
    assert.equal(importedStaticDotnetGit.statusCode, 200, importedStaticDotnetGit.body);
    assert.equal(importedStaticDotnetGit.json().importSource, "git_static_black_box");
    assert.equal(importedStaticDotnetGit.json().project.id, "demo_static_dotnet_imported");
    assert.equal(importedStaticDotnetGit.json().pipeline.nodes.some((node: { id?: string; type?: string }) => node.id === "git_static_model" && node.type === "model"), true);
    const staticDotnetInspection = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_dotnet_imported", ".mlops", "git-static-inspection.json"), "utf-8")) as { observedEndpoints: string[]; dotnet: { files: Array<{ path: string; endpoints: string[] }> } | null; signals: string[] };
    assert.deepEqual(staticDotnetInspection.observedEndpoints, ["GET /health", "POST /predict", "GET /metrics/runtime"]);
    assert.ok(staticDotnetInspection.dotnet?.files.some((file) => file.path === "Program.cs"));
    assert.ok(staticDotnetInspection.dotnet?.files.some((file) => file.path === "Controllers/MetricsController.cs"));
    assert.ok(staticDotnetInspection.signals.includes("dotnet_routes"));
    const staticDotnetMeta = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_dotnet_imported", ".mlops", "generated-meta.json"), "utf-8")) as { importedFrom: string; noCodeExecution: boolean; noContainerRun: boolean; sourceFiles: string[] };
    assert.equal(staticDotnetMeta.importedFrom, "git_static_black_box");
    assert.equal(staticDotnetMeta.noCodeExecution, true);
    assert.equal(staticDotnetMeta.noContainerRun, true);
    assert.ok(staticDotnetMeta.sourceFiles.includes("Program.cs"));
    assert.ok(staticDotnetMeta.sourceFiles.includes("Controllers/MetricsController.cs"));

    const staticPhpGitRoot = path.join(workspaceRoot, "generated", "demo-static-php-runtime");
    await rm(staticPhpGitRoot, { recursive: true, force: true });
    await mkdir(path.join(staticPhpGitRoot, "routes"), { recursive: true });
    await mkdir(path.join(staticPhpGitRoot, "src", "Controller"), { recursive: true });
    await writeFile(
      path.join(staticPhpGitRoot, "routes", "api.php"),
      [
        "<?php",
        "",
        "use Illuminate\\Support\\Facades\\Route;",
        "",
        "Route::get('/health', [HealthController::class, 'show']);",
        "Route::post('/predict', [PredictionController::class, 'store']);",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      path.join(staticPhpGitRoot, "src", "Controller", "MetricsController.php"),
      [
        "<?php",
        "",
        "namespace App\\Controller;",
        "",
        "use Symfony\\Component\\Routing\\Annotation\\Route;",
        "",
        "final class MetricsController",
        "{",
        "    #[Route('/metrics/runtime', methods: ['GET'])]",
        "    public function runtime(): array",
        "    {",
        "        return ['prediction_count' => 0];",
        "    }",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );
    await execFileAsync("git", ["init"], { cwd: staticPhpGitRoot });
    await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: staticPhpGitRoot });
    await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: staticPhpGitRoot });
    await execFileAsync("git", ["add", "."], { cwd: staticPhpGitRoot });
    await execFileAsync("git", ["commit", "-m", "static php runtime"], { cwd: staticPhpGitRoot });
    const importedStaticPhpGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceGitUrl: "generated/demo-static-php-runtime", targetProjectId: "demo_static_php_imported", confirmExternalSource: true },
    });
    assert.equal(importedStaticPhpGit.statusCode, 200, importedStaticPhpGit.body);
    assert.equal(importedStaticPhpGit.json().importSource, "git_static_black_box");
    assert.equal(importedStaticPhpGit.json().project.id, "demo_static_php_imported");
    assert.equal(importedStaticPhpGit.json().pipeline.nodes.some((node: { id?: string; type?: string }) => node.id === "git_static_model" && node.type === "model"), true);
    const staticPhpInspection = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_php_imported", ".mlops", "git-static-inspection.json"), "utf-8")) as { observedEndpoints: string[]; php: { files: Array<{ path: string; endpoints: string[] }> } | null; signals: string[] };
    assert.deepEqual(staticPhpInspection.observedEndpoints, ["GET /health", "POST /predict", "GET /metrics/runtime"]);
    assert.ok(staticPhpInspection.php?.files.some((file) => file.path === "routes/api.php"));
    assert.ok(staticPhpInspection.php?.files.some((file) => file.path === "src/Controller/MetricsController.php"));
    assert.ok(staticPhpInspection.signals.includes("php_routes"));
    const staticPhpMeta = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_php_imported", ".mlops", "generated-meta.json"), "utf-8")) as { importedFrom: string; noCodeExecution: boolean; noContainerRun: boolean; sourceFiles: string[] };
    assert.equal(staticPhpMeta.importedFrom, "git_static_black_box");
    assert.equal(staticPhpMeta.noCodeExecution, true);
    assert.equal(staticPhpMeta.noContainerRun, true);
    assert.ok(staticPhpMeta.sourceFiles.includes("routes/api.php"));
    assert.ok(staticPhpMeta.sourceFiles.includes("src/Controller/MetricsController.php"));

    const staticKoaGitRoot = path.join(workspaceRoot, "generated", "demo-static-koa-runtime");
    await rm(staticKoaGitRoot, { recursive: true, force: true });
    await mkdir(path.join(staticKoaGitRoot, "src"), { recursive: true });
    await writeFile(
      path.join(staticKoaGitRoot, "package.json"),
      `${JSON.stringify({ name: "demo-static-koa-runtime", version: "1.0.0", dependencies: { koa: "^2.15.0", "@koa/router": "^12.0.0" } }, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      path.join(staticKoaGitRoot, "src", "server.ts"),
      [
        "import Koa from \"koa\";",
        "import Router from \"@koa/router\";",
        "",
        "const app = new Koa();",
        "const router = new Router();",
        "",
        "router.get(\"/health\", (context) => {",
        "  context.body = { status: \"ok\" };",
        "});",
        "",
        "router.post(\"/predict\", (context) => {",
        "  context.body = { prediction: \"unknown\" };",
        "});",
        "",
        "app.use(router.routes());",
        "app.use(router.allowedMethods());",
        "",
      ].join("\n"),
      "utf-8",
    );
    await execFileAsync("git", ["init"], { cwd: staticKoaGitRoot });
    await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: staticKoaGitRoot });
    await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: staticKoaGitRoot });
    await execFileAsync("git", ["add", "."], { cwd: staticKoaGitRoot });
    await execFileAsync("git", ["commit", "-m", "static koa runtime"], { cwd: staticKoaGitRoot });
    const importedStaticKoaGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceGitUrl: "generated/demo-static-koa-runtime", targetProjectId: "demo_static_koa_imported", confirmExternalSource: true },
    });
    assert.equal(importedStaticKoaGit.statusCode, 200, importedStaticKoaGit.body);
    assert.equal(importedStaticKoaGit.json().importSource, "git_static_black_box");
    assert.equal(importedStaticKoaGit.json().project.id, "demo_static_koa_imported");
    assert.equal(importedStaticKoaGit.json().pipeline.nodes.some((node: { id?: string; type?: string }) => node.id === "git_static_model" && node.type === "model"), true);
    const staticKoaInspection = JSON.parse(
      await readFile(path.join(workspaceRoot, "projects", "demo_static_koa_imported", ".mlops", "git-static-inspection.json"), "utf-8"),
    ) as { observedEndpoints: string[]; koa: { files: Array<{ path: string; endpoints: string[] }> } | null; signals: string[] };
    assert.deepEqual(staticKoaInspection.observedEndpoints, ["GET /health", "POST /predict"]);
    assert.equal(staticKoaInspection.koa?.files[0]?.path, "src/server.ts");
    assert.ok(staticKoaInspection.signals.includes("koa_routes"));
    const staticKoaMeta = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_koa_imported", ".mlops", "generated-meta.json"), "utf-8")) as { importedFrom: string; noCodeExecution: boolean; noContainerRun: boolean; sourceFiles: string[] };
    assert.equal(staticKoaMeta.importedFrom, "git_static_black_box");
    assert.equal(staticKoaMeta.noCodeExecution, true);
    assert.equal(staticKoaMeta.noContainerRun, true);
    assert.ok(staticKoaMeta.sourceFiles.includes("src/server.ts"));

    const staticHonoGitRoot = path.join(workspaceRoot, "generated", "demo-static-hono-runtime");
    await rm(staticHonoGitRoot, { recursive: true, force: true });
    await mkdir(path.join(staticHonoGitRoot, "src"), { recursive: true });
    await writeFile(
      path.join(staticHonoGitRoot, "package.json"),
      `${JSON.stringify({ name: "demo-static-hono-runtime", version: "1.0.0", dependencies: { hono: "^4.4.0" } }, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      path.join(staticHonoGitRoot, "src", "server.ts"),
      [
        "import { Hono } from \"hono\";",
        "",
        "const app = new Hono();",
        "",
        "app.get(\"/health\", (c) => c.json({ status: \"ok\" }));",
        "app.on([\"POST\", \"DELETE\"], \"/feedback\", (c) => c.json({ done: true }));",
        "",
      ].join("\n"),
      "utf-8",
    );
    await execFileAsync("git", ["init"], { cwd: staticHonoGitRoot });
    await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: staticHonoGitRoot });
    await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: staticHonoGitRoot });
    await execFileAsync("git", ["add", "."], { cwd: staticHonoGitRoot });
    await execFileAsync("git", ["commit", "-m", "static hono runtime"], { cwd: staticHonoGitRoot });
    const importedStaticHonoGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceGitUrl: "generated/demo-static-hono-runtime", targetProjectId: "demo_static_hono_imported", confirmExternalSource: true },
    });
    assert.equal(importedStaticHonoGit.statusCode, 200, importedStaticHonoGit.body);
    assert.equal(importedStaticHonoGit.json().importSource, "git_static_black_box");
    assert.equal(importedStaticHonoGit.json().project.id, "demo_static_hono_imported");
    assert.equal(importedStaticHonoGit.json().pipeline.nodes.some((node: { id?: string; type?: string }) => node.id === "git_static_model" && node.type === "model"), true);
    const staticHonoInspection = JSON.parse(
      await readFile(path.join(workspaceRoot, "projects", "demo_static_hono_imported", ".mlops", "git-static-inspection.json"), "utf-8"),
    ) as { observedEndpoints: string[]; hono: { files: Array<{ path: string; endpoints: string[] }> } | null; signals: string[] };
    assert.deepEqual(staticHonoInspection.observedEndpoints, ["GET /health", "POST /feedback", "DELETE /feedback"]);
    assert.equal(staticHonoInspection.hono?.files[0]?.path, "src/server.ts");
    assert.ok(staticHonoInspection.signals.includes("hono_routes"));
    const staticHonoMeta = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_hono_imported", ".mlops", "generated-meta.json"), "utf-8")) as { importedFrom: string; noCodeExecution: boolean; noContainerRun: boolean; sourceFiles: string[] };
    assert.equal(staticHonoMeta.importedFrom, "git_static_black_box");
    assert.equal(staticHonoMeta.noCodeExecution, true);
    assert.equal(staticHonoMeta.noContainerRun, true);
    assert.ok(staticHonoMeta.sourceFiles.includes("src/server.ts"));

    const staticNestJsGitRoot = path.join(workspaceRoot, "generated", "demo-static-nestjs-runtime");
    await rm(staticNestJsGitRoot, { recursive: true, force: true });
    await mkdir(path.join(staticNestJsGitRoot, "src"), { recursive: true });
    await writeFile(
      path.join(staticNestJsGitRoot, "package.json"),
      `${JSON.stringify({ name: "demo-static-nestjs-runtime", version: "1.0.0", dependencies: { "@nestjs/common": "^10.4.20", "@nestjs/core": "^10.4.20", "reflect-metadata": "^0.2.2", rxjs: "^7.8.1", "@nestjs/platform-express": "^10.4.20" } }, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      path.join(staticNestJsGitRoot, "src", "main.ts"),
      [
        "import { Controller, Get, Post } from \"@nestjs/common\";",
        "",
        "@Controller(\"api\")",
        "export class PredictController {",
        '  @Get("health")',
        "  health() {",
        '    return { status: "ok" };',
        "  }",
        "",
        '  @Post("predict", { version: "v1" })',
        "  predict() {",
        '    return { prediction: "unknown" };',
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );
    await execFileAsync("git", ["init"], { cwd: staticNestJsGitRoot });
    await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: staticNestJsGitRoot });
    await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: staticNestJsGitRoot });
    await execFileAsync("git", ["add", "."], { cwd: staticNestJsGitRoot });
    await execFileAsync("git", ["commit", "-m", "static nestjs runtime"], { cwd: staticNestJsGitRoot });
    const importedStaticNestJsGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceGitUrl: "generated/demo-static-nestjs-runtime", targetProjectId: "demo_static_nestjs_imported", confirmExternalSource: true },
    });
    assert.equal(importedStaticNestJsGit.statusCode, 200, importedStaticNestJsGit.body);
    assert.equal(importedStaticNestJsGit.json().importSource, "git_static_black_box");
    assert.equal(importedStaticNestJsGit.json().project.id, "demo_static_nestjs_imported");
    assert.equal(importedStaticNestJsGit.json().pipeline.nodes.some((node: { id?: string; type?: string }) => node.id === "git_static_model" && node.type === "model"), true);
    const staticNestJsInspection = JSON.parse(
      await readFile(path.join(workspaceRoot, "projects", "demo_static_nestjs_imported", ".mlops", "git-static-inspection.json"), "utf-8"),
    ) as { observedEndpoints: string[]; nestjs: { files: Array<{ path: string; endpoints: string[] }> } | null; signals: string[] };
    assert.deepEqual(staticNestJsInspection.observedEndpoints, ["GET /api/health", "POST /api/predict"]);
    assert.equal(staticNestJsInspection.nestjs?.files[0]?.path, "src/main.ts");
    assert.ok(staticNestJsInspection.signals.includes("nestjs_routes"));
    const staticNestJsMeta = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_nestjs_imported", ".mlops", "generated-meta.json"), "utf-8")) as {
      importedFrom: string;
      noCodeExecution: boolean;
      noContainerRun: boolean;
      sourceFiles: string[];
    };
    assert.equal(staticNestJsMeta.importedFrom, "git_static_black_box");
    assert.equal(staticNestJsMeta.noCodeExecution, true);
    assert.equal(staticNestJsMeta.noContainerRun, true);
    assert.ok(staticNestJsMeta.sourceFiles.includes("src/main.ts"));

    const staticNextJsGitRoot = path.join(workspaceRoot, "generated", "demo-static-nextjs-runtime");
    await rm(staticNextJsGitRoot, { recursive: true, force: true });
    await mkdir(path.join(staticNextJsGitRoot, "app", "api", "predict"), { recursive: true });
    await writeFile(
      path.join(staticNextJsGitRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "demo-static-nextjs-runtime",
          version: "1.0.0",
          dependencies: { "next": "^14.2.0" },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await writeFile(
      path.join(staticNextJsGitRoot, "app", "api", "predict", "route.ts"),
      [
        "import { NextRequest, NextResponse } from \"next/server\";",
        "",
        "export async function GET(_request: NextRequest) {",
        "  return NextResponse.json({ status: \"ok\" });",
        "}",
        "",
        "export async function POST(_request: NextRequest) {",
        "  return NextResponse.json({ prediction: \"unknown\" });",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );
    await execFileAsync("git", ["init"], { cwd: staticNextJsGitRoot });
    await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: staticNextJsGitRoot });
    await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: staticNextJsGitRoot });
    await execFileAsync("git", ["add", "."], { cwd: staticNextJsGitRoot });
    await execFileAsync("git", ["commit", "-m", "static nextjs runtime"], { cwd: staticNextJsGitRoot });
    const importedStaticNextJsGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceGitUrl: "generated/demo-static-nextjs-runtime", targetProjectId: "demo_static_nextjs_imported", confirmExternalSource: true },
    });
    assert.equal(importedStaticNextJsGit.statusCode, 200, importedStaticNextJsGit.body);
    assert.equal(importedStaticNextJsGit.json().importSource, "git_static_black_box");
    assert.equal(importedStaticNextJsGit.json().project.id, "demo_static_nextjs_imported");
    assert.equal(importedStaticNextJsGit.json().pipeline.nodes.some((node: { id?: string; type?: string }) => node.id === "git_static_model" && node.type === "model"), true);
    const staticNextJsInspection = JSON.parse(
      await readFile(path.join(workspaceRoot, "projects", "demo_static_nextjs_imported", ".mlops", "git-static-inspection.json"), "utf-8"),
    ) as { observedEndpoints: string[]; nextjs: { files: Array<{ path: string; endpoints: string[] }> } | null; signals: string[] };
    assert.deepEqual(staticNextJsInspection.observedEndpoints, ["GET /api/predict", "POST /api/predict"]);
    assert.equal(staticNextJsInspection.nextjs?.files[0]?.path, "app/api/predict/route.ts");
    assert.ok(staticNextJsInspection.signals.includes("nextjs_routes"));
    const staticNextJsMeta = JSON.parse(
      await readFile(path.join(workspaceRoot, "projects", "demo_static_nextjs_imported", ".mlops", "generated-meta.json"), "utf-8"),
    ) as { importedFrom: string; noCodeExecution: boolean; noContainerRun: boolean; sourceFiles: string[] };
    assert.equal(staticNextJsMeta.importedFrom, "git_static_black_box");
    assert.equal(staticNextJsMeta.noCodeExecution, true);
    assert.equal(staticNextJsMeta.noContainerRun, true);
    assert.ok(staticNextJsMeta.sourceFiles.includes("app/api/predict/route.ts"));

    const staticGrpcGitRoot = path.join(workspaceRoot, "generated", "demo-static-grpc-runtime");
    await rm(staticGrpcGitRoot, { recursive: true, force: true });
    await mkdir(path.join(staticGrpcGitRoot, "proto"), { recursive: true });
    await writeFile(
      path.join(staticGrpcGitRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "demo-static-grpc-runtime",
          version: "1.0.0",
          dependencies: {
            "google-protobuf": "^3.21.2",
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await writeFile(
      path.join(staticGrpcGitRoot, "proto", "predict.proto"),
      [
        'syntax = "proto3";',
        "",
        'import "google/api/annotations.proto";',
        "",
        "package demo;",
        "",
        "message PredictRequest { string text = 1; }",
        "message PredictResponse { string label = 1; }",
        "message HealthRequest {}",
        "message HealthResponse { string status = 1; }",
        "",
        "service PredictService {",
        "  rpc Predict(PredictRequest) returns (PredictResponse) {",
        "    option (google.api.http) = {",
        '      post: "/api/v1/predict"',
        '      body: "*"',
        "    };",
        "  }",
        "",
        "  rpc Health(HealthRequest) returns (HealthResponse) {",
        "    option (google.api.http) = {",
        '      get: "/api/v1/health"',
        "    };",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );
    await execFileAsync("git", ["init"], { cwd: staticGrpcGitRoot });
    await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: staticGrpcGitRoot });
    await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: staticGrpcGitRoot });
    await execFileAsync("git", ["add", "."], { cwd: staticGrpcGitRoot });
    await execFileAsync("git", ["commit", "-m", "static grpc runtime"], { cwd: staticGrpcGitRoot });
    const importedStaticGrpcGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: { sourceGitUrl: "generated/demo-static-grpc-runtime", targetProjectId: "demo_static_grpc_imported", confirmExternalSource: true },
    });
    assert.equal(importedStaticGrpcGit.statusCode, 200, importedStaticGrpcGit.body);
    assert.equal(importedStaticGrpcGit.json().importSource, "git_static_black_box");
    assert.equal(importedStaticGrpcGit.json().project.id, "demo_static_grpc_imported");
    assert.equal(importedStaticGrpcGit.json().pipeline.nodes.some((node: { id?: string; type?: string }) => node.id === "git_static_model" && node.type === "model"), true);
    const staticGrpcInspection = JSON.parse(
      await readFile(path.join(workspaceRoot, "projects", "demo_static_grpc_imported", ".mlops", "git-static-inspection.json"), "utf-8"),
    ) as { observedEndpoints: string[]; grpc: { files: Array<{ path: string; endpoints: string[] }> } | null; signals: string[] };
    assert.deepEqual([...staticGrpcInspection.observedEndpoints].sort(), ["GET /api/v1/health", "POST /api/v1/predict"]);
    assert.equal(staticGrpcInspection.grpc?.files[0]?.path, "proto/predict.proto");
    assert.ok(staticGrpcInspection.signals.includes("grpc_routes"));
    const staticGrpcMeta = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_static_grpc_imported", ".mlops", "generated-meta.json"), "utf-8")) as {
      importedFrom: string;
      noCodeExecution: boolean;
      noContainerRun: boolean;
      sourceFiles: string[];
    };
    assert.equal(staticGrpcMeta.importedFrom, "git_static_black_box");
    assert.equal(staticGrpcMeta.noCodeExecution, true);
    assert.equal(staticGrpcMeta.noContainerRun, true);
    assert.ok(staticGrpcMeta.sourceFiles.includes("proto/predict.proto"));

    const staticGrpcNoGatewayGitRoot = path.join(workspaceRoot, "generated", "demo-static-grpc-no-gateway-runtime");
    await rm(staticGrpcNoGatewayGitRoot, { recursive: true, force: true });
    await mkdir(path.join(staticGrpcNoGatewayGitRoot, "proto"), { recursive: true });
    await writeFile(
      path.join(staticGrpcNoGatewayGitRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "demo-static-grpc-no-gateway-runtime",
          version: "1.0.0",
          dependencies: {
            "google-protobuf": "^3.21.2",
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await writeFile(
      path.join(staticGrpcNoGatewayGitRoot, "proto", "streaming.proto"),
      [
        'syntax = "proto3";',
        "",
        "package demo;",
        "",
        "message PingRequest { string input = 1; }",
        "message PingResponse { string output = 1; }",
        "",
        "service UtilsService {",
        "  rpc Ping(PingRequest) returns (PingResponse) {};",
        "  rpc Health(PingRequest) returns (PingResponse);",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );
    await execFileAsync("git", ["init"], { cwd: staticGrpcNoGatewayGitRoot });
    await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: staticGrpcNoGatewayGitRoot });
    await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: staticGrpcNoGatewayGitRoot });
    await execFileAsync("git", ["add", "."], { cwd: staticGrpcNoGatewayGitRoot });
    await execFileAsync("git", ["commit", "-m", "static grpc no gateway runtime"], { cwd: staticGrpcNoGatewayGitRoot });
    const importedStaticGrpcNoGatewayGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: {
        sourceGitUrl: "generated/demo-static-grpc-no-gateway-runtime",
        targetProjectId: "demo_static_grpc_no_gateway_imported",
        confirmExternalSource: true,
      },
    });
    assert.equal(importedStaticGrpcNoGatewayGit.statusCode, 200, importedStaticGrpcNoGatewayGit.body);
    const staticGrpcNoGatewayInspection = JSON.parse(
      await readFile(
        path.join(workspaceRoot, "projects", "demo_static_grpc_no_gateway_imported", ".mlops", "git-static-inspection.json"),
        "utf-8",
      ),
    ) as { observedEndpoints: string[]; grpc: { files: Array<{ path: string; endpoints: string[] }> } | null; signals: string[] };
    assert.deepEqual(staticGrpcNoGatewayInspection.observedEndpoints, ["POST /grpc/UtilsService/Ping", "POST /grpc/UtilsService/Health"]);
    assert.equal(staticGrpcNoGatewayInspection.grpc?.files[0]?.path, "proto/streaming.proto");
    assert.ok(staticGrpcNoGatewayInspection.signals.includes("grpc_routes"));

    const staticLegacyHttpGitRoot = path.join(workspaceRoot, "generated", "demo-static-legacy-http-runtime");
    await rm(staticLegacyHttpGitRoot, { recursive: true, force: true });
    await mkdir(staticLegacyHttpGitRoot, { recursive: true });
    await writeFile(
      path.join(staticLegacyHttpGitRoot, "app.py"),
      [
        "from http.server import BaseHTTPRequestHandler, HTTPServer",
        "",
        "class Handler(BaseHTTPRequestHandler):",
        "    def do_GET(self):",
        "        if self.path == \"/health\":",
        "            self.send_response(200)",
        "            self.end_headers()",
        "",
        "    def do_POST(self):",
        "        if self.path == \"/predict\":",
        "            self.send_response(200)",
        "            self.end_headers()",
        "",
        "HTTPServer((\"127.0.0.1\", 8080), Handler).serve_forever()",
        "",
      ].join("\n"),
      "utf-8",
    );
    await execFileAsync("git", ["init"], { cwd: staticLegacyHttpGitRoot });
    await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: staticLegacyHttpGitRoot });
    await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: staticLegacyHttpGitRoot });
    await execFileAsync("git", ["add", "."], { cwd: staticLegacyHttpGitRoot });
    await execFileAsync("git", ["commit", "-m", "static legacy http runtime"], { cwd: staticLegacyHttpGitRoot });
    const importedStaticLegacyHttpGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: {
        sourceGitUrl: "generated/demo-static-legacy-http-runtime",
        targetProjectId: "demo_static_legacy_http_imported",
        confirmExternalSource: true,
      },
    });
    assert.equal(importedStaticLegacyHttpGit.statusCode, 200, importedStaticLegacyHttpGit.body);
    const staticLegacyHttpInspection = JSON.parse(
      await readFile(
        path.join(workspaceRoot, "projects", "demo_static_legacy_http_imported", ".mlops", "git-static-inspection.json"),
        "utf-8",
      ),
    ) as { observedEndpoints: string[]; legacyHttp: { files: Array<{ path: string; endpoints: string[] }> } | null; signals: string[] };
    assert.deepEqual(staticLegacyHttpInspection.observedEndpoints, ["GET /health", "POST /predict"]);
    assert.equal(staticLegacyHttpInspection.legacyHttp?.files[0]?.path, "app.py");
    assert.ok(staticLegacyHttpInspection.signals.includes("legacy_http_routes"));

    const genericGitRoot = path.join(workspaceRoot, "generated", "demo-generic-git-runtime");
    await rm(genericGitRoot, { recursive: true, force: true });
    await mkdir(genericGitRoot, { recursive: true });
    await writeFile(path.join(genericGitRoot, "README.md"), "# Runtime sem sinais estáticos\n\nAplicação sem contrato MLOps, OpenAPI ou rotas detectáveis.\n", "utf-8");
    await writeFile(
      path.join(genericGitRoot, "package.json"),
      `${JSON.stringify({ name: "generic-runtime-without-signals", version: "0.0.1", scripts: { start: "node index.js" } }, null, 2)}\n`,
      "utf-8",
    );
    await execFileAsync("git", ["init"], { cwd: genericGitRoot });
    await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: genericGitRoot });
    await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: genericGitRoot });
    await execFileAsync("git", ["add", "."], { cwd: genericGitRoot });
    await execFileAsync("git", ["commit", "-m", "generic runtime without signals"], { cwd: genericGitRoot });
    const blockedGenericGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: {
        sourceGitUrl: "generated/demo-generic-git-runtime",
        targetProjectId: "demo_generic_git_imported",
        confirmExternalSource: true,
      },
    });
    assert.equal(blockedGenericGit.statusCode, 409);
    assert.match(blockedGenericGit.json().message, /confirmBlackBox/);
    const importedGenericGit = await app.inject({
      method: "POST",
      url: "/projects/import-runtime",
      payload: {
        sourceGitUrl: "generated/demo-generic-git-runtime",
        targetProjectId: "demo_generic_git_imported",
        confirmExternalSource: true,
        confirmBlackBox: true,
      },
    });
    assert.equal(importedGenericGit.statusCode, 200, importedGenericGit.body);
    assert.equal(importedGenericGit.json().importSource, "git_static_black_box");
    assert.equal(importedGenericGit.json().project.id, "demo_generic_git_imported");
    assert.equal(importedGenericGit.json().project.name, "Git black-box generic-runtime-without-signals");
    assert.equal(importedGenericGit.json().project.dataSources[0].api.url, "http://127.0.0.1:8080/predict");
    const genericGitInspection = JSON.parse(
      await readFile(path.join(workspaceRoot, "projects", "demo_generic_git_imported", ".mlops", "git-static-inspection.json"), "utf-8"),
    ) as { observedEndpoints: string[]; signals: string[]; limitations: string[] };
    assert.deepEqual(genericGitInspection.observedEndpoints, []);
    assert.ok(genericGitInspection.signals.includes("generic_git_repository"));
    assert.ok(genericGitInspection.limitations.some((item) => item.includes("Sem endpoints observáveis")));
    const genericGitMeta = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_generic_git_imported", ".mlops", "generated-meta.json"), "utf-8")) as { importedFrom: string; noCodeExecution: boolean; noContainerRun: boolean; limitations: string[] };
    assert.equal(genericGitMeta.importedFrom, "git_static_black_box");
    assert.equal(genericGitMeta.noCodeExecution, true);
    assert.equal(genericGitMeta.noContainerRun, true);
    assert.ok(genericGitMeta.limitations.some((item) => item.includes("Sem sinais estáticos")));

    const fakeDockerBin = path.join(workspaceRoot, "fake-docker-bin");
    await mkdir(fakeDockerBin, { recursive: true });
    const fakeDockerInspectPath = path.join(workspaceRoot, "fake-docker-inspect.json");
    const fakeDockerRunArgsPath = path.join(workspaceRoot, "fake-docker-run-args.json");
    const fakeDockerBuildArgsPath = path.join(workspaceRoot, "fake-docker-build-args.json");
    const fakeDockerRmArgsPath = path.join(workspaceRoot, "fake-docker-rm-args.json");
    await writeFile(
      fakeDockerInspectPath,
      `${JSON.stringify([
        {
          Id: "sha256:demoimage",
          RepoTags: ["mlops/demo-runtime:latest"],
          RepoDigests: ["mlops/demo-runtime@sha256:abc"],
          Architecture: "amd64",
          Os: "linux",
          Created: "2026-01-01T00:00:00Z",
          Config: {
            Labels: {
              "io.mlops-flow.contract": "mlops-flow-v1",
              "io.mlops-flow.project-id": "demo_image",
              "io.mlops-flow.project-name": "Demo Image",
              "io.mlops-flow.project-version": "0.1.0",
              "io.mlops-flow.active-model-id": "model_demo",
              "io.mlops-flow.execution-profile": "cpu",
              "io.mlops-flow.endpoints": JSON.stringify(["GET /health", "POST /predict"]),
            },
            ExposedPorts: { "8080/tcp": {} },
            Env: ["SECRET_TOKEN=do-not-copy"],
            Entrypoint: null,
            Cmd: ["uvicorn", "app.main:app"],
          },
        },
      ], null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      path.join(fakeDockerBin, "docker.cmd"),
      [
        "@echo off",
        "if \"%1\"==\"image\" if \"%2\"==\"inspect\" (",
        "  type \"%FAKE_DOCKER_INSPECT_JSON%\"",
        "  exit /b 0",
        ")",
        "echo unsupported docker command 1>&2",
        "exit /b 1",
        "",
      ].join("\r\n"),
      "utf-8",
    );
    const fakeDockerUnix = path.join(fakeDockerBin, "docker");
    await writeFile(
      fakeDockerUnix,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"image\" ] && [ \"$2\" = \"inspect\" ]; then",
        "  cat \"$FAKE_DOCKER_INSPECT_JSON\"",
        "  exit 0",
        "fi",
        "echo unsupported docker command >&2",
        "exit 1",
        "",
      ].join("\n"),
      "utf-8",
    );
    await chmod(fakeDockerUnix, 0o755).catch(() => undefined);
    const fakeDockerNode = path.join(fakeDockerBin, "fake-docker.cjs");
    await writeFile(
      fakeDockerNode,
      [
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "if (args[0] === 'build') {",
        "  fs.writeFileSync(process.env.FAKE_DOCKER_BUILD_ARGS_JSON, JSON.stringify(args));",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'image' && args[1] === 'inspect') {",
        "  process.stdout.write(fs.readFileSync(process.env.FAKE_DOCKER_INSPECT_JSON, 'utf8'));",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'image' && args[1] === 'rm') {",
        "  fs.writeFileSync(process.env.FAKE_DOCKER_RM_ARGS_JSON, JSON.stringify(args));",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'run') {",
        "  fs.writeFileSync(process.env.FAKE_DOCKER_RUN_ARGS_JSON, JSON.stringify(args));",
        "  process.stdout.write('__MLOPS_OPENAPI_PATH__=/openapi.json\\n' + JSON.stringify({",
        "    openapi: '3.1.0',",
        "    info: { title: 'Sandboxed Docker Runtime', version: '0.1.0' },",
        "    paths: {",
        "      '/metadata': { get: { responses: { '200': { description: 'metadata' } } } },",
        "      '/score': { post: { responses: { '200': { description: 'score' } } } },",
        "    },",
        "  }, null, 2));",
        "  process.exit(0);",
        "}",
        "process.stderr.write('unsupported docker command\\n');",
        "process.exit(1);",
        "",
      ].join("\n"),
      "utf-8",
    );
    const oldPath = process.env.PATH;
    const oldPathWindows = process.env.Path;
    const oldFakeDockerInspect = process.env.FAKE_DOCKER_INSPECT_JSON;
    const oldFakeDockerRunArgs = process.env.FAKE_DOCKER_RUN_ARGS_JSON;
    const oldFakeDockerBuildArgs = process.env.FAKE_DOCKER_BUILD_ARGS_JSON;
    const oldFakeDockerRmArgs = process.env.FAKE_DOCKER_RM_ARGS_JSON;
    const oldDockerCli = process.env.MLOPS_STUDIO_DOCKER_CLI;
    const oldDockerCliArgs = process.env.MLOPS_STUDIO_DOCKER_CLI_ARGS;
    const oldDockerOpenApiSandbox = process.env.MLOPS_STUDIO_DOCKER_IMAGE_OPENAPI_SANDBOX;
    const oldGitDockerfileOpenApiSandbox = process.env.MLOPS_STUDIO_GIT_DOCKERFILE_OPENAPI_SANDBOX;
    process.env.PATH = `${fakeDockerBin}${path.delimiter}${oldPath ?? ""}`;
    process.env.Path = `${fakeDockerBin}${path.delimiter}${oldPathWindows ?? oldPath ?? ""}`;
    process.env.FAKE_DOCKER_INSPECT_JSON = fakeDockerInspectPath;
    process.env.FAKE_DOCKER_RUN_ARGS_JSON = fakeDockerRunArgsPath;
    process.env.FAKE_DOCKER_BUILD_ARGS_JSON = fakeDockerBuildArgsPath;
    process.env.FAKE_DOCKER_RM_ARGS_JSON = fakeDockerRmArgsPath;
    process.env.MLOPS_STUDIO_DOCKER_CLI = process.execPath;
    process.env.MLOPS_STUDIO_DOCKER_CLI_ARGS = JSON.stringify([fakeDockerNode]);
    process.env.MLOPS_STUDIO_DOCKER_IMAGE_OPENAPI_SANDBOX = "true";
    process.env.MLOPS_STUDIO_GIT_DOCKERFILE_OPENAPI_SANDBOX = "true";
    try {
      const blockedDockerImport = await app.inject({
        method: "POST",
        url: "/projects/import-runtime",
        payload: { sourceDockerImage: "mlops/demo-runtime:latest", targetProjectId: "demo_docker_image" },
      });
      assert.equal(blockedDockerImport.statusCode, 409);
      const importedDockerImage = await app.inject({
        method: "POST",
        url: "/projects/import-runtime",
        payload: { sourceDockerImage: "mlops/demo-runtime:latest", targetProjectId: "demo_docker_image", confirmExternalSource: true },
      });
      assert.equal(importedDockerImage.statusCode, 200, importedDockerImage.body);
      assert.equal(importedDockerImage.json().sourceDockerImage, "mlops/demo-runtime:latest");
      assert.equal(importedDockerImage.json().sourceDockerPort, 8080);
      assert.equal(importedDockerImage.json().importSource, "docker_image_black_box");
      assert.equal(importedDockerImage.json().project.id, "demo_docker_image");
      assert.equal(importedDockerImage.json().pipeline.nodes.some((node: { id?: string; type?: string }) => node.id === "docker_image_model" && node.type === "model"), true);
      const dockerImageInspect = await readFile(path.join(workspaceRoot, "projects", "demo_docker_image", ".mlops", "docker-image-inspect.json"), "utf-8");
      assert.equal(dockerImageInspect.includes("SECRET_TOKEN"), false);
      const dockerManifest = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_docker_image", ".mlops", "runtime.manifest.json"), "utf-8")) as { endpoints: string[]; projectId: string };
      assert.equal(dockerManifest.projectId, "demo_docker_image");
      assert.deepEqual(dockerManifest.endpoints, ["GET /health", "POST /predict", "GET /metadata", "POST /score"]);
      const dockerMeta = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_docker_image", ".mlops", "generated-meta.json"), "utf-8")) as {
        importedFrom: string;
        noContainerRun: boolean;
        runtimeEndpoints: string[];
        openApiInspectionPath: string | null;
        containerSandboxInspection: { enabled: boolean; network: string | null; readOnlyFilesystem: boolean | null; capDropAll: boolean | null; noNewPrivileges: boolean | null };
      };
      assert.equal(dockerMeta.importedFrom, "docker_image_black_box");
      assert.equal(dockerMeta.noContainerRun, false);
      assert.equal(dockerMeta.openApiInspectionPath, "/openapi.json");
      assert.deepEqual(dockerMeta.runtimeEndpoints, ["GET /health", "POST /predict", "GET /metadata", "POST /score"]);
      assert.deepEqual(dockerMeta.containerSandboxInspection, {
        enabled: true,
        network: "none",
        readOnlyFilesystem: true,
        capDropAll: true,
        noNewPrivileges: true,
      });
      const dockerRunArgs = JSON.parse(await readFile(fakeDockerRunArgsPath, "utf-8")) as string[];
      assert.deepEqual(dockerRunArgs.slice(0, 11), ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64"]);
      assert.ok(dockerRunArgs.includes("--memory"));

      const gitDockerfileSandboxRoot = path.join(workspaceRoot, "generated", "demo-git-dockerfile-sandbox-runtime");
      await rm(gitDockerfileSandboxRoot, { recursive: true, force: true });
      await mkdir(gitDockerfileSandboxRoot, { recursive: true });
      await writeFile(
        path.join(gitDockerfileSandboxRoot, "Dockerfile"),
        [
          "FROM local/base:latest",
          "LABEL io.mlops-flow.project-name=\"Sandbox Git Runtime\" \\",
          "      io.mlops-flow.project-version=\"4.0.0\" \\",
          "      io.mlops-flow.execution-profile=\"cpu\"",
          "RUN printf '%s' '{\"openapi\":\"3.1.0\",\"info\":{\"title\":\"Sandbox Git Runtime\",\"version\":\"4.0.0\"},\"paths\":{\"/metadata\":{\"get\":{\"responses\":{\"200\":{\"description\":\"metadata\"}}}},\"/score\":{\"post\":{\"responses\":{\"200\":{\"description\":\"score\"}}}}}}' > /openapi.json",
          "CMD [\"python\", \"server.py\"]",
          "",
        ].join("\n"),
        "utf-8",
      );
      await execFileAsync("git", ["init"], { cwd: gitDockerfileSandboxRoot });
      await execFileAsync("git", ["config", "user.email", "studio@example.local"], { cwd: gitDockerfileSandboxRoot });
      await execFileAsync("git", ["config", "user.name", "MLOps Studio"], { cwd: gitDockerfileSandboxRoot });
      await execFileAsync("git", ["add", "."], { cwd: gitDockerfileSandboxRoot });
      await execFileAsync("git", ["commit", "-m", "dockerfile sandbox runtime"], { cwd: gitDockerfileSandboxRoot });
      const importedGitDockerfileSandbox = await app.inject({
        method: "POST",
        url: "/projects/import-runtime",
        payload: {
          sourceGitUrl: "generated/demo-git-dockerfile-sandbox-runtime",
          targetProjectId: "demo_git_dockerfile_sandbox",
          confirmExternalSource: true,
          confirmBlackBox: true,
          confirmSandboxExecution: true,
        },
      });
      assert.equal(importedGitDockerfileSandbox.statusCode, 200, importedGitDockerfileSandbox.body);
      assert.equal(importedGitDockerfileSandbox.json().importSource, "git_static_black_box");
      const gitSandboxManifest = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_git_dockerfile_sandbox", ".mlops", "runtime.manifest.json"), "utf-8")) as { endpoints: string[]; projectId: string };
      assert.equal(gitSandboxManifest.projectId, "demo_git_dockerfile_sandbox");
      assert.deepEqual(gitSandboxManifest.endpoints, ["GET /metadata", "POST /score"]);
      const gitSandboxInspection = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_git_dockerfile_sandbox", ".mlops", "git-static-inspection.json"), "utf-8")) as {
        observedEndpoints: string[];
        signals: string[];
        sandboxOpenApi: { mode: string; dockerfilePath: string; path: string; endpoints: string[]; noEntrypointRun: boolean; network: string; readOnlyFilesystem: boolean };
      };
      assert.deepEqual(gitSandboxInspection.observedEndpoints, ["GET /metadata", "POST /score"]);
      assert.ok(gitSandboxInspection.signals.includes("git_dockerfile_openapi_sandbox"));
      assert.equal(gitSandboxInspection.sandboxOpenApi.mode, "dockerfile_static_openapi_probe");
      assert.equal(gitSandboxInspection.sandboxOpenApi.dockerfilePath, "Dockerfile");
      assert.equal(gitSandboxInspection.sandboxOpenApi.path, "/openapi.json");
      assert.deepEqual(gitSandboxInspection.sandboxOpenApi.endpoints, ["GET /metadata", "POST /score"]);
      assert.equal(gitSandboxInspection.sandboxOpenApi.noEntrypointRun, true);
      assert.equal(gitSandboxInspection.sandboxOpenApi.network, "none");
      assert.equal(gitSandboxInspection.sandboxOpenApi.readOnlyFilesystem, true);
      const gitSandboxMeta = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "demo_git_dockerfile_sandbox", ".mlops", "generated-meta.json"), "utf-8")) as {
        importedFrom: string;
        noCodeExecution: boolean;
        noContainerRun: boolean;
        noApplicationEntrypointRun: boolean;
        openApiInspectionPath: string | null;
        containerSandboxInspection: { enabled: boolean; mode: string; buildNetwork: string; pullPolicy: string; network: string; readOnlyFilesystem: boolean; noEntrypointRun: boolean; cleanupImage: boolean };
      };
      assert.equal(gitSandboxMeta.importedFrom, "git_static_black_box");
      assert.equal(gitSandboxMeta.noCodeExecution, false);
      assert.equal(gitSandboxMeta.noContainerRun, false);
      assert.equal(gitSandboxMeta.noApplicationEntrypointRun, true);
      assert.equal(gitSandboxMeta.openApiInspectionPath, "/openapi.json");
      assert.equal(gitSandboxMeta.containerSandboxInspection.enabled, true);
      assert.equal(gitSandboxMeta.containerSandboxInspection.mode, "dockerfile_static_openapi_probe");
      assert.equal(gitSandboxMeta.containerSandboxInspection.buildNetwork, "none");
      assert.equal(gitSandboxMeta.containerSandboxInspection.pullPolicy, "local_only");
      assert.equal(gitSandboxMeta.containerSandboxInspection.network, "none");
      assert.equal(gitSandboxMeta.containerSandboxInspection.readOnlyFilesystem, true);
      assert.equal(gitSandboxMeta.containerSandboxInspection.noEntrypointRun, true);
      assert.equal(gitSandboxMeta.containerSandboxInspection.cleanupImage, true);
      const dockerBuildArgs = JSON.parse(await readFile(fakeDockerBuildArgsPath, "utf-8")) as string[];
      assert.deepEqual(dockerBuildArgs.slice(0, 6), ["build", "--network", "none", "--pull=false", "-t", dockerBuildArgs[5]]);
      assert.ok(dockerBuildArgs[5].startsWith("mlops-flow-git-openapi-probe:"));
      assert.ok(dockerBuildArgs.includes("-f"));
      const dockerRmArgs = JSON.parse(await readFile(fakeDockerRmArgsPath, "utf-8")) as string[];
      assert.deepEqual(dockerRmArgs.slice(0, 3), ["image", "rm", "-f"]);
      assert.equal(dockerRmArgs[3], dockerBuildArgs[5]);
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
      if (oldPathWindows === undefined) {
        delete process.env.Path;
      } else {
        process.env.Path = oldPathWindows;
      }
      if (oldFakeDockerInspect === undefined) {
        delete process.env.FAKE_DOCKER_INSPECT_JSON;
      } else {
        process.env.FAKE_DOCKER_INSPECT_JSON = oldFakeDockerInspect;
      }
      if (oldFakeDockerRunArgs === undefined) {
        delete process.env.FAKE_DOCKER_RUN_ARGS_JSON;
      } else {
        process.env.FAKE_DOCKER_RUN_ARGS_JSON = oldFakeDockerRunArgs;
      }
      if (oldFakeDockerBuildArgs === undefined) {
        delete process.env.FAKE_DOCKER_BUILD_ARGS_JSON;
      } else {
        process.env.FAKE_DOCKER_BUILD_ARGS_JSON = oldFakeDockerBuildArgs;
      }
      if (oldFakeDockerRmArgs === undefined) {
        delete process.env.FAKE_DOCKER_RM_ARGS_JSON;
      } else {
        process.env.FAKE_DOCKER_RM_ARGS_JSON = oldFakeDockerRmArgs;
      }
      if (oldDockerCli === undefined) {
        delete process.env.MLOPS_STUDIO_DOCKER_CLI;
      } else {
        process.env.MLOPS_STUDIO_DOCKER_CLI = oldDockerCli;
      }
      if (oldDockerCliArgs === undefined) {
        delete process.env.MLOPS_STUDIO_DOCKER_CLI_ARGS;
      } else {
        process.env.MLOPS_STUDIO_DOCKER_CLI_ARGS = oldDockerCliArgs;
      }
      if (oldDockerOpenApiSandbox === undefined) {
        delete process.env.MLOPS_STUDIO_DOCKER_IMAGE_OPENAPI_SANDBOX;
      } else {
        process.env.MLOPS_STUDIO_DOCKER_IMAGE_OPENAPI_SANDBOX = oldDockerOpenApiSandbox;
      }
      if (oldGitDockerfileOpenApiSandbox === undefined) {
        delete process.env.MLOPS_STUDIO_GIT_DOCKERFILE_OPENAPI_SANDBOX;
      } else {
        process.env.MLOPS_STUDIO_GIT_DOCKERFILE_OPENAPI_SANDBOX = oldGitDockerfileOpenApiSandbox;
      }
    }

    const expiredDatasetDir = path.join(workspaceRoot, "projects", "demo", "artifacts", "dataset_versions");
    await mkdir(expiredDatasetDir, { recursive: true });
    const expiredRowsPath = path.join(expiredDatasetDir, "expired.rows.jsonl");
    const expiredManifestPath = path.join(expiredDatasetDir, "expired.json");
    await writeFile(expiredRowsPath, `${JSON.stringify({ email: "***", text: "linha expirada" })}\n`, "utf-8");
    await writeFile(
      expiredManifestPath,
      `${JSON.stringify({
        id: "expired",
        kind: "dataset_version",
        rowArtifact: {
          available: true,
          mode: "masked_rows",
          format: "jsonl",
          path: "artifacts/dataset_versions/expired.rows.jsonl",
          retention: { policy: "delete_after_days", days: 1, expiresAt: "2000-01-01T00:00:00Z" },
        },
      }, null, 2)}\n`,
      "utf-8",
    );
    const purgedSnapshots = await app.inject({ method: "POST", url: "/projects/demo/dataset-snapshots/purge-expired" });
    assert.equal(purgedSnapshots.statusCode, 200);
    assert.equal(purgedSnapshots.json().purged, 1);
    await assert.rejects(() => stat(expiredRowsPath));
    const purgedManifest = JSON.parse(await readFile(expiredManifestPath, "utf-8")) as { rowArtifact: { available: boolean; purgedAt?: string; purgedPath?: string; path?: string } };
    assert.equal(purgedManifest.rowArtifact.available, false);
    assert.equal(purgedManifest.rowArtifact.purgedPath, "artifacts/dataset_versions/expired.rows.jsonl");
    assert.equal(purgedManifest.rowArtifact.path, undefined);

    const jobStart = await app.inject({
      method: "POST",
      url: "/projects/demo/train-baseline/jobs",
      payload: { sourceId: "tickets_csv", timeoutMs: 60_000 },
    });
    assert.equal(jobStart.statusCode, 200);
    assert.equal(jobStart.json().status, "running");
    const jobId = jobStart.json().jobId as string;
    const jobBody = await waitForJob(app, jobId);
    assert.equal(jobBody.status, "completed", JSON.stringify(jobBody));
    assert.equal(jobBody.result.kind, "training_result");
    assert.equal(jobBody.result.sourceId, "tickets_csv");
    assert.ok(jobBody.events.some((event: { type?: string }) => event.type === "training_rows_loaded"));
    assert.ok(jobBody.events.some((event: { type?: string }) => event.type === "model_trained"));

    const workerJobs = await app.inject({ method: "GET", url: "/worker-jobs" });
    assert.equal(workerJobs.statusCode, 200);
    assert.ok(workerJobs.json().jobs.some((job: { jobId: string }) => job.jobId === jobId));
    assert.ok(workerJobs.json().jobs.some((job: { command: string }) => job.command === "preview-source"));
    assert.ok(workerJobs.json().jobs.some((job: { command: string }) => job.command === "run-python-block"));

    const cancelCompletedJob = await app.inject({ method: "DELETE", url: `/worker-jobs/${jobId}` });
    assert.equal(cancelCompletedJob.statusCode, 200);
    assert.equal(cancelCompletedJob.json().status, "completed");

    const resumablePipelinePath = path.join(workspaceRoot, "projects", "demo", "pipeline.flow.json");
    const resumablePipeline = JSON.parse(await readFile(resumablePipelinePath, "utf-8")) as { nodes: Array<{ id: string; python?: { codeInline?: string; networkPolicy?: string } }> };
    const resumablePythonNode = resumablePipeline.nodes.find((node) => node.id === "deterministic_decider");
    assert.ok(resumablePythonNode?.python);
    resumablePythonNode.python.codeInline = "def run(input: dict, context: dict) -> dict:\n    import time\n    time.sleep(1.0)\n    return {'decision': 'resumed_after_restart', 'reason': 'runner_destacado'}\n";
    resumablePythonNode.python.networkPolicy = "open";
    await writeFile(resumablePipelinePath, `${JSON.stringify(resumablePipeline, null, 2)}\n`, "utf-8");
    const resumableJobStart = await app.inject({
      method: "POST",
      url: "/projects/demo/python-nodes/deterministic_decider/run/jobs",
      payload: { input: { confidence: 0.9, prediction: "classe_a" }, timeoutMs: 60_000 },
    });
    assert.equal(resumableJobStart.statusCode, 200);
    assert.equal(resumableJobStart.json().status, "running");
    const resumableJobId = resumableJobStart.json().jobId as string;

    await app.close();
    appClosed = true;
    await mkdir(path.join(workspaceRoot, ".mlops-studio", "worker-jobs"), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, ".mlops-studio", "worker-jobs", "job-interrupted.request.json"),
      `${JSON.stringify({
        command: "preview-source",
        projectRoot: path.join(workspaceRoot, "projects", "demo"),
        project: createdBody.project,
        pipeline: resumablePipeline,
        emitEvents: true,
        sourceId: "tickets_csv",
        limit: 2,
      }, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      path.join(workspaceRoot, ".mlops-studio", "worker-jobs", "job-interrupted.json"),
      `${JSON.stringify({
        jobId: "job-interrupted",
        command: "preview-source",
        projectId: "demo",
        projectRoot: path.join(workspaceRoot, "projects", "demo"),
        status: "running",
        sourceId: "tickets_csv",
        startedAt: new Date().toISOString(),
        timedOut: false,
        stdout: "",
        stderr: "",
        events: [],
        requestPath: ".mlops-studio/worker-jobs/job-interrupted.request.json",
      }, null, 2)}\n`,
      "utf-8",
    );
    const restartedApp = buildApp({ workspaceRoot, ...insecureTestApp });
    try {
      const resumedJob = await waitForJob(restartedApp, resumableJobId);
      assert.equal(resumedJob.status, "completed", JSON.stringify(resumedJob));
      assert.equal(resumedJob.result.kind, "python_block_result");
      assert.equal(resumedJob.result.output.decision, "resumed_after_restart");
      const persistedWorkerJobs = await restartedApp.inject({ method: "GET", url: "/worker-jobs" });
      assert.equal(persistedWorkerJobs.statusCode, 200);
      const restoredJob = persistedWorkerJobs.json().jobs.find((job: { jobId: string }) => job.jobId === jobId);
      assert.equal(restoredJob.status, "completed");
      assert.ok(restoredJob.events.some((event: { type?: string }) => event.type === "model_trained"));
      const interruptedJob = persistedWorkerJobs.json().jobs.find((job: { jobId: string }) => job.jobId === "job-interrupted");
      assert.equal(interruptedJob.status, "recoverable");
      assert.match(interruptedJob.error, /retomado|retomada|request persistido/);
      const recovered = await restartedApp.inject({ method: "POST", url: "/worker-jobs/job-interrupted/recover" });
      assert.equal(recovered.statusCode, 200);
      assert.equal(recovered.json().status, "running");
      assert.equal(recovered.json().recoveryAttempts, 1);
      const recoveredJob = await waitForJob(restartedApp, "job-interrupted");
      assert.equal(recoveredJob.status, "completed", JSON.stringify(recoveredJob));
      assert.equal(recoveredJob.result.kind, "source_preview");
      assert.equal(recoveredJob.result.rowCount, 6);
      assert.ok(recoveredJob.events.some((event: { type?: string }) => event.type === "worker_job_recovered"));
    } finally {
      await restartedApp.close();
    }
  } finally {
    if (!appClosed) {
      await app.close();
    }
    await removeTempWorkspace(workspaceRoot);
  }
});

test("control api executa scraping Playwright controlado em URL local", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mlops-flow-studio-scrape-"));
  const fixture = await startPlaywrightScrapeFixtureServer();
  const app = buildApp({ workspaceRoot, ...insecureTestApp });
  const previousScrapePassword = process.env.MLOPS_FLOW_STUDIO_TEST_PASSWORD;
  process.env.MLOPS_FLOW_STUDIO_TEST_PASSWORD = "secret-password";
  try {
    const deniedExternal = await app.inject({
      method: "POST",
      url: "/tools/playwright-scrape",
      payload: { url: "https://example.com" },
    });
    assert.equal(deniedExternal.statusCode, 409);
    assert.match(deniedExternal.json().message, /confirmExternalNavigation/);

    const scrape = await app.inject({
      method: "POST",
      url: "/tools/playwright-scrape",
      payload: { url: fixture.url, maxLinks: 10, maxDepth: 1, maxPages: 3, includeScreenshot: true, timeoutMs: 30_000 },
    });
    assert.equal(scrape.statusCode, 200, scrape.body);
    const body = scrape.json() as {
      title: string;
      description: string;
      reportPath: string;
      screenshotPath: string;
      maxDepth: number;
      maxPages: number;
      crawledPageCount: number;
      crawledPages: Array<{ finalUrl: string; depth: number; headings: Array<{ level: string; text: string }> }>;
      links: Array<{ href: string; text: string }>;
      headings: Array<{ level: string; text: string }>;
      forms: Array<{ method: string; action: string; inputs: Array<{ name: string; required: boolean }> }>;
      apiCandidates: Array<{ href: string; text: string }>;
    };
    assert.equal(body.maxDepth, 1);
    assert.equal(body.maxPages, 3);
    assert.equal(body.crawledPageCount, 3);
    assert.ok(body.crawledPages.some((item) => item.finalUrl.endsWith("/dashboard") && item.depth === 1));
    assert.equal(body.title, "MLOps API Docs");
    assert.equal(body.description, "Documentação local para scraping Playwright.");
    assert.ok(body.headings.some((item) => item.level === "h1" && item.text === "Runtime Docs"));
    assert.ok(body.headings.some((item) => item.level === "h1" && item.text === "Runtime Dashboard"));
    assert.ok(body.links.some((item) => item.href === "/openapi.json" && item.text === "OpenAPI"));
    assert.ok(body.apiCandidates.some((item) => item.href === "/openapi.json"));
    assert.equal(body.forms[0]?.method, "post");
    assert.equal(body.forms[0]?.inputs[0]?.name, "text");
    assert.equal(body.forms[0]?.inputs[0]?.required, true);
    await stat(path.join(workspaceRoot, body.reportPath));
    await stat(path.join(workspaceRoot, body.screenshotPath));

    const authenticatedScrape = await app.inject({
      method: "POST",
      url: "/tools/playwright-scrape",
      payload: {
        url: `${fixture.url}/private`,
        maxLinks: 10,
        includeScreenshot: false,
        timeoutMs: 30_000,
        auth: {
          loginUrl: `${fixture.url}/login`,
          username: "alice",
          usernameSelector: "#username",
          passwordSelector: "#password",
          passwordRef: "env:MLOPS_FLOW_STUDIO_TEST_PASSWORD",
          submitSelector: "#submit",
          successSelector: "#private-docs",
        },
        confirmAuthenticatedScrape: true,
      },
    });
    assert.equal(authenticatedScrape.statusCode, 200, authenticatedScrape.body);
    assert.equal(authenticatedScrape.json().title, "Private API Docs");
    assert.equal(authenticatedScrape.json().auth.mode, "form");
    assert.equal(authenticatedScrape.json().auth.passwordRef, "env:MLOPS_FLOW_STUDIO_TEST_PASSWORD");
    assert.ok(authenticatedScrape.json().headings.some((item: { text: string }) => item.text === "Private Runtime Docs"));
    assert.equal(JSON.stringify(authenticatedScrape.json()).includes("secret-password"), false);

    const deniedDeepCrawl = await app.inject({
      method: "POST",
      url: "/tools/playwright-scrape",
      payload: { url: `${fixture.url}/deep`, maxDepth: 3, maxPages: 6, timeoutMs: 30_000 },
    });
    assert.equal(deniedDeepCrawl.statusCode, 409);
    assert.match(deniedDeepCrawl.json().message, /confirmDeepCrawl/);

    const deepCrawl = await app.inject({
      method: "POST",
      url: "/tools/playwright-scrape",
      payload: { url: `${fixture.url}/deep`, maxDepth: 3, maxPages: 6, confirmDeepCrawl: true, timeoutMs: 30_000 },
    });
    assert.equal(deepCrawl.statusCode, 200, deepCrawl.body);
    assert.equal(deepCrawl.json().deepCrawlConfirmed, true);
    assert.equal(deepCrawl.json().crawledPageCount, 4);
    assert.ok(deepCrawl.json().headings.some((item: { text: string }) => item.text === "Deep Level 3"));

    const deniedOpenApiPreview = await app.inject({
      method: "POST",
      url: "/tools/openapi-contract-preview",
      payload: { url: "https://example.com/openapi.json" },
    });
    assert.equal(deniedOpenApiPreview.statusCode, 409);
    assert.match(deniedOpenApiPreview.json().message, /confirmExternalNavigation/);

    const openApiPreview = await app.inject({
      method: "POST",
      url: "/tools/openapi-contract-preview",
      payload: { url: `${fixture.url}/openapi.json` },
    });
    assert.equal(openApiPreview.statusCode, 200, openApiPreview.body);
    assert.equal(openApiPreview.json().kind, "openapi_contract_preview");
    assert.equal(openApiPreview.json().endpointCount, 1);
    assert.ok(openApiPreview.json().endpoints.includes("POST /predict"));
    assert.equal(openApiPreview.json().operationCount, 1);
    assert.equal(openApiPreview.json().operations[0].operationId, "predictTicket");
    assert.equal(openApiPreview.json().operations[0].requestBodyRequired, true);
    assert.deepEqual(openApiPreview.json().operations[0].requestContentTypes, ["application/json"]);
    assert.match(openApiPreview.json().operations[0].requestSchema, /properties=text/);
    assert.deepEqual(openApiPreview.json().operations[0].requestExample, { text: "string" });
    assert.deepEqual(openApiPreview.json().operations[0].requestValidation.required, ["text"]);
    assert.equal(openApiPreview.json().operations[0].requestValidation.properties.text.type, "string");
    assert.equal(openApiPreview.json().operations[0].responses[0].status, "200");
    assert.match(openApiPreview.json().operations[0].responses[0].schema, /properties=label, score/);
    assert.deepEqual(openApiPreview.json().operations[0].responses[0].example, { label: "string", score: 0 });
    assert.equal(openApiPreview.json().operations[0].responses[0].validation.properties.score.type, "number");

    const blockedOperationSmoke = await app.inject({
      method: "POST",
      url: "/tools/openapi-operation-smoke",
      payload: { url: `${fixture.url}/predict`, method: "POST", body: openApiPreview.json().operations[0].requestExample },
    });
    assert.equal(blockedOperationSmoke.statusCode, 409);
    assert.match(blockedOperationSmoke.json().message, /confirmOperationCall/);

    const deniedOperationSmoke = await app.inject({
      method: "POST",
      url: "/tools/openapi-operation-smoke",
      payload: { url: "https://example.com/predict", method: "POST", body: { text: "amostra" }, confirmOperationCall: true },
    });
    assert.equal(deniedOperationSmoke.statusCode, 409);
    assert.match(deniedOperationSmoke.json().message, /confirmExternalNavigation/);

    const invalidOperationSmoke = await app.inject({
      method: "POST",
      url: "/tools/openapi-operation-smoke",
      payload: {
        url: `${fixture.url}/predict`,
        method: "POST",
        body: { score: 1 },
        requestValidation: openApiPreview.json().operations[0].requestValidation,
        confirmOperationCall: true,
      },
    });
    assert.equal(invalidOperationSmoke.statusCode, 422);
    assert.match(invalidOperationSmoke.json().message, /schema OpenAPI/);

    const operationSmoke = await app.inject({
      method: "POST",
      url: "/tools/openapi-operation-smoke",
      payload: {
        url: `${fixture.url}/predict`,
        method: "POST",
        body: openApiPreview.json().operations[0].requestExample,
        requestValidation: openApiPreview.json().operations[0].requestValidation,
        responseValidation: openApiPreview.json().operations[0].responses[0].validation,
        confirmOperationCall: true,
      },
    });
    assert.equal(operationSmoke.statusCode, 200, operationSmoke.body);
    assert.equal(operationSmoke.json().kind, "openapi_operation_smoke");
    assert.equal(operationSmoke.json().statusCode, 200);
    assert.equal(operationSmoke.json().requestBodySent, true);
    assert.equal(operationSmoke.json().requestValidation.checked, true);
    assert.equal(operationSmoke.json().requestValidation.ok, true);
    assert.equal(operationSmoke.json().responseValidation.checked, true);
    assert.equal(operationSmoke.json().responseValidation.ok, true);
    assert.deepEqual(operationSmoke.json().responsePreview, { label: "ok", score: 0.99, received: { text: "string" } });

    const contractEdits = {
      sources: [
        { id: "scraped_page", include: false },
        { id: "scrape_api_candidate_1", label: "Contrato OpenAPI revisado", url: "/api/openapi.json" },
        { id: "scrape_form_1", method: "PATCH", url: "/v2/predict", description: "Contrato revisado antes da gravação.", bodyTemplate: { text: "amostra" } },
      ],
    };
    const previewImport = await app.inject({
      method: "POST",
      url: "/projects/import-scrape/preview",
      payload: { reportPath: body.reportPath, targetProjectId: "scrape_imported", contractEdits },
    });
    assert.equal(previewImport.statusCode, 200, previewImport.body);
    assert.equal(previewImport.json().kind, "playwright_scrape_import_preview");
    assert.equal(previewImport.json().targetProjectId, "scrape_imported");
    assert.equal(previewImport.json().summary.apiCandidates, 1);
    assert.equal(previewImport.json().summary.forms, 1);
    assert.equal(previewImport.json().summary.sourceEdits, 3);
    assert.equal(previewImport.json().summary.dataSources, 2);
    assert.equal(previewImport.json().contractEdits.sources.length, 3);
    assert.equal(previewImport.json().project.dataSources.some((source: { id: string }) => source.id === "scraped_page"), false);
    assert.ok(previewImport.json().project.dataSources.some((source: { id: string; label: string }) => source.id === "scrape_api_candidate_1" && source.label === "Contrato OpenAPI revisado"));
    assert.ok(previewImport.json().project.dataSources.some((source: { id: string; api?: { method?: string } }) => source.id === "scrape_form_1" && source.api?.method === "PATCH"));
    assert.ok(previewImport.json().endpoints.includes("GET /api/openapi.json"));
    assert.ok(previewImport.json().endpoints.includes("PATCH /v2/predict"));

    const deniedImport = await app.inject({
      method: "POST",
      url: "/projects/import-scrape",
      payload: { reportPath: body.reportPath, targetProjectId: "scrape_imported" },
    });
    assert.equal(deniedImport.statusCode, 409);
    assert.match(deniedImport.json().message, /confirmBlackBox/);

    const imported = await app.inject({
      method: "POST",
      url: "/projects/import-scrape",
      payload: { reportPath: body.reportPath, targetProjectId: "scrape_imported", confirmBlackBox: true, contractEdits },
    });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.equal(imported.json().project.id, "scrape_imported");
    assert.equal(imported.json().importSource, "playwright_scrape_black_box");
    assert.equal(imported.json().project.dataSources.some((source: { id: string }) => source.id === "scraped_page"), false);
    assert.ok(imported.json().project.dataSources.some((source: { id: string; label: string }) => source.id === "scrape_api_candidate_1" && source.label === "Contrato OpenAPI revisado"));
    assert.ok(imported.json().project.dataSources.some((source: { id: string; api?: { method?: string } }) => source.id === "scrape_form_1" && source.api?.method === "PATCH"));
    assert.ok(imported.json().pipeline.nodes.some((node: { id: string }) => node.id === "scrape_black_box_runtime"));
    const scrapeMeta = JSON.parse(await readFile(path.join(workspaceRoot, "projects", "scrape_imported", ".mlops", "generated-meta.json"), "utf-8")) as {
      importedFrom: string;
      endpoints: string[];
      contractEdits: { sources: Array<{ id: string }> } | null;
    };
    assert.equal(scrapeMeta.importedFrom, "playwright_scrape_black_box");
    assert.ok(scrapeMeta.endpoints.includes("GET /api/openapi.json"));
    assert.ok(scrapeMeta.endpoints.includes("PATCH /v2/predict"));
    assert.equal(scrapeMeta.contractEdits?.sources.length, 3);
    await stat(path.join(workspaceRoot, "projects", "scrape_imported", ".mlops", "playwright-scrape-report.json"));
  } finally {
    if (previousScrapePassword === undefined) {
      delete process.env.MLOPS_FLOW_STUDIO_TEST_PASSWORD;
    } else {
      process.env.MLOPS_FLOW_STUDIO_TEST_PASSWORD = previousScrapePassword;
    }
    await app.close();
    await fixture.close();
    await removeTempWorkspace(workspaceRoot);
  }
});

test("control api arquiva e restaura snapshots em storage S3/MinIO compatível", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mlops-flow-studio-s3-"));
  const fakeS3 = await startFakeS3Server();
  const app = buildApp({
    workspaceRoot,
    ...insecureTestApp,
    datasetSnapshotStoreBackend: "s3",
    datasetSnapshotS3Bucket: "snapshot-bucket",
    datasetSnapshotS3Prefix: "mlops-prefix",
    datasetSnapshotS3Endpoint: fakeS3.endpoint,
    datasetSnapshotS3Region: "us-east-1",
    datasetSnapshotS3AccessKeyId: "test-access-key",
    datasetSnapshotS3SecretAccessKey: "test-secret-key",
    datasetSnapshotS3ForcePathStyle: true,
    datasetSnapshotEncryptionKey: "s3-snapshot-encryption-key",
    datasetSnapshotEncryptionKeyRef: "env:S3_SNAPSHOT_KEY",
  });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { id: "s3_demo", name: "S3 Demo", problemType: "multiclass_classification", target: "classe_final", classes: ["classe_a", "classe_b"] },
    });
    assert.equal(created.statusCode, 200);
    await mkdir(path.join(workspaceRoot, "projects", "s3_demo", "data"), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, "projects", "s3_demo", "data", "tickets.csv"),
      [
        "id,text,classe_final,email",
        "1,classe_a boleto pagamento,classe_a,a@example.com",
        "2,classe_a segunda via boleto,classe_a,b@example.com",
        "3,classe_b erro login acesso,classe_b,c@example.com",
        "4,classe_b redefinir senha,classe_b,d@example.com",
      ].join("\n"),
      "utf-8",
    );

    const training = await app.inject({
      method: "POST",
      url: "/projects/s3_demo/train-baseline",
      payload: { sourceId: "tickets_csv", datasetSnapshotMode: "masked_rows" },
    });
    assert.equal(training.statusCode, 200);
    const trainingBody = training.json();
    const datasetVersionId = trainingBody.datasetVersion.datasetVersionId as string;
    const datasetManifestPath = path.join(workspaceRoot, "projects", "s3_demo", "artifacts", "dataset_versions", `${datasetVersionId}.json`);
    const rowSnapshotPath = path.join(workspaceRoot, "projects", "s3_demo", trainingBody.datasetVersion.rowArtifact.path);
    await stat(rowSnapshotPath);

    const archivedSnapshots = await app.inject({ method: "POST", url: "/projects/s3_demo/dataset-snapshots/archive" });
    assert.equal(archivedSnapshots.statusCode, 200);
    assert.equal(archivedSnapshots.json().storeType, "s3");
    assert.equal(archivedSnapshots.json().storeUri, "s3://snapshot-bucket/mlops-prefix");
    assert.equal(archivedSnapshots.json().archived, 1);
    assert.equal(archivedSnapshots.json().artifacts[0].encrypted, true);
    const rowObjectKey = `mlops-prefix/s3_demo/dataset_versions/${datasetVersionId}.rows.jsonl.enc`;
    const archiveObjectKey = `mlops-prefix/s3_demo/dataset_versions/${datasetVersionId}.archive.json`;
    const rowObject = fakeS3.objects.get(fakeS3ObjectId("snapshot-bucket", rowObjectKey));
    assert.ok(rowObject);
    assert.equal(rowObject.toString("utf-8").includes("***"), false);
    assert.ok(fakeS3.objects.has(fakeS3ObjectId("snapshot-bucket", archiveObjectKey)));
    const archivedManifest = JSON.parse(await readFile(datasetManifestPath, "utf-8")) as { rowArtifact: { externalArchive?: { type?: string; storePath?: string; objectKey?: string; encrypted?: boolean; encryption?: { keyRef?: string } } } };
    assert.equal(archivedManifest.rowArtifact.externalArchive?.type, "s3");
    assert.equal(archivedManifest.rowArtifact.externalArchive?.storePath, `s3://snapshot-bucket/${rowObjectKey}`);
    assert.equal(archivedManifest.rowArtifact.externalArchive?.objectKey, rowObjectKey);
    assert.equal(archivedManifest.rowArtifact.externalArchive?.encrypted, true);
    assert.equal(archivedManifest.rowArtifact.externalArchive?.encryption?.keyRef, "env:S3_SNAPSHOT_KEY");

    await rm(rowSnapshotPath, { force: true });
    const purgedManifest = JSON.parse(await readFile(datasetManifestPath, "utf-8")) as { rowArtifact: Record<string, unknown> };
    purgedManifest.rowArtifact = {
      ...purgedManifest.rowArtifact,
      available: false,
      reason: "Snapshot removido localmente para teste S3.",
      purgedAt: new Date().toISOString(),
      purgedPath: trainingBody.datasetVersion.rowArtifact.path,
      path: undefined,
    };
    await writeFile(datasetManifestPath, `${JSON.stringify(purgedManifest, null, 2)}\n`, "utf-8");

    const restoredSnapshots = await app.inject({ method: "POST", url: "/projects/s3_demo/dataset-snapshots/restore" });
    assert.equal(restoredSnapshots.statusCode, 200);
    assert.equal(restoredSnapshots.json().storeType, "s3");
    assert.equal(restoredSnapshots.json().restored, 1);
    assert.equal(restoredSnapshots.json().artifacts[0].encrypted, true);
    await stat(rowSnapshotPath);
    assert.equal((await readFile(rowSnapshotPath, "utf-8")).includes("***"), true);
    const restoredManifest = JSON.parse(await readFile(datasetManifestPath, "utf-8")) as { rowArtifact: { restoredFrom?: { type?: string; storePath?: string; objectKey?: string; encrypted?: boolean; encryption?: { keyRef?: string } } } };
    assert.equal(restoredManifest.rowArtifact.restoredFrom?.type, "s3");
    assert.equal(restoredManifest.rowArtifact.restoredFrom?.storePath, `s3://snapshot-bucket/${rowObjectKey}`);
    assert.equal(restoredManifest.rowArtifact.restoredFrom?.objectKey, rowObjectKey);
    assert.equal(restoredManifest.rowArtifact.restoredFrom?.encrypted, true);
    assert.equal(restoredManifest.rowArtifact.restoredFrom?.encryption?.keyRef, "env:S3_SNAPSHOT_KEY");
  } finally {
    await app.close();
    await fakeS3.close();
    await removeTempWorkspace(workspaceRoot);
  }
});

test("control api enfileira jobs quando a concorrência local está ocupada", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mlops-flow-studio-queue-"));
  const app = buildApp({ workspaceRoot, workerJobConcurrency: 1, ...insecureTestApp });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { id: "queue_demo", name: "Queue Demo", problemType: "multiclass_classification", target: "classe_final", classes: ["classe_a", "classe_b"] },
    });
    assert.equal(created.statusCode, 200);

    const pipelinePath = path.join(workspaceRoot, "projects", "queue_demo", "pipeline.flow.json");
    const pipeline = JSON.parse(await readFile(pipelinePath, "utf-8")) as { nodes: Array<{ id: string; python?: { codeInline?: string; networkPolicy?: string } }> };
    const pythonNode = pipeline.nodes.find((node) => node.id === "deterministic_decider");
    assert.ok(pythonNode?.python);
    pythonNode.python.codeInline = "def run(input: dict, context: dict) -> dict:\n    import time\n    time.sleep(1.5)\n    return {'decision': input.get('prediction', 'classe_a'), 'reason': 'fila_local'}\n";
    pythonNode.python.networkPolicy = "open";
    await writeFile(pipelinePath, `${JSON.stringify(pipeline, null, 2)}\n`, "utf-8");

    const firstStart = await app.inject({
      method: "POST",
      url: "/projects/queue_demo/python-nodes/deterministic_decider/run/jobs",
      payload: { input: { prediction: "classe_a" }, timeoutMs: 60_000 },
    });
    assert.equal(firstStart.statusCode, 200);
    assert.equal(firstStart.json().status, "running");

    const secondStart = await app.inject({
      method: "POST",
      url: "/projects/queue_demo/python-nodes/deterministic_decider/run/jobs",
      payload: { input: { prediction: "classe_b" }, timeoutMs: 60_000 },
    });
    assert.equal(secondStart.statusCode, 200);
    assert.equal(secondStart.json().status, "queued");

    const queueStatus = await app.inject({ method: "GET", url: "/worker-jobs/queue" });
    assert.equal(queueStatus.statusCode, 200);
    assert.equal(queueStatus.json().concurrency, 1);
    assert.equal(queueStatus.json().running, 1);
    assert.equal(queueStatus.json().queued, 1);
    assert.equal(queueStatus.json().availableSlots, 0);

    const firstJob = await waitForJob(app, firstStart.json().jobId);
    assert.equal(firstJob.status, "completed", JSON.stringify(firstJob));
    assert.ok(firstJob.events.some((event: { type?: string }) => event.type === "worker_job_started"));

    const secondJob = await waitForJob(app, secondStart.json().jobId);
    assert.equal(secondJob.status, "completed", JSON.stringify(secondJob));
    assert.ok(secondJob.events.some((event: { type?: string }) => event.type === "worker_job_queued"));
    assert.ok(secondJob.events.some((event: { type?: string }) => event.type === "worker_job_started"));
  } finally {
    await app.close();
    await removeTempWorkspace(workspaceRoot);
  }
});

test("control api coordena fila filesystem compartilhada entre múltiplos hosts", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mlops-flow-studio-shared-queue-"));
  const sharedQueueRoot = path.join(workspaceRoot, "shared-worker-queue");
  const appA = buildApp({
    workspaceRoot,
    ...insecureTestApp,
    workerJobConcurrency: 1,
    workerJobQueueRoot: sharedQueueRoot,
    workerJobWorkerId: "host-a",
    workerJobClaimTtlMs: 60_000,
  });
  let appB: FastifyInstance | undefined;
  try {
    const created = await appA.inject({
      method: "POST",
      url: "/projects",
      payload: { id: "shared_queue_demo", name: "Shared Queue Demo", problemType: "multiclass_classification", target: "classe_final", classes: ["classe_a", "classe_b"] },
    });
    assert.equal(created.statusCode, 200);

    const pipelinePath = path.join(workspaceRoot, "projects", "shared_queue_demo", "pipeline.flow.json");
    const pipeline = JSON.parse(await readFile(pipelinePath, "utf-8")) as { nodes: Array<{ id: string; python?: { codeInline?: string; networkPolicy?: string } }> };
    const pythonNode = pipeline.nodes.find((node) => node.id === "deterministic_decider");
    assert.ok(pythonNode?.python);
    pythonNode.python.codeInline = "def run(input: dict, context: dict) -> dict:\n    import time\n    time.sleep(0.8)\n    return {'decision': input.get('prediction', 'classe_a'), 'reason': 'fila_compartilhada'}\n";
    pythonNode.python.networkPolicy = "open";
    await writeFile(pipelinePath, `${JSON.stringify(pipeline, null, 2)}\n`, "utf-8");

    const firstStart = await appA.inject({
      method: "POST",
      url: "/projects/shared_queue_demo/python-nodes/deterministic_decider/run/jobs",
      payload: { input: { prediction: "classe_a" }, timeoutMs: 60_000 },
    });
    assert.equal(firstStart.statusCode, 200);
    assert.equal(firstStart.json().status, "running");
    assert.equal(firstStart.json().queueBackend, "filesystem");
    assert.equal(firstStart.json().runnerWorkerId, "host-a");
    assert.ok(firstStart.json().claimPath);
    assert.ok(firstStart.json().slotPath);

    appB = buildApp({
      workspaceRoot,
      ...insecureTestApp,
      workerJobConcurrency: 1,
      workerJobQueueRoot: sharedQueueRoot,
      workerJobWorkerId: "host-b",
      workerJobClaimTtlMs: 60_000,
    });

    const secondStart = await appB.inject({
      method: "POST",
      url: "/projects/shared_queue_demo/python-nodes/deterministic_decider/run/jobs",
      payload: { input: { prediction: "classe_b" }, timeoutMs: 60_000 },
    });
    assert.equal(secondStart.statusCode, 200);
    assert.equal(secondStart.json().status, "queued");
    assert.equal(secondStart.json().queueBackend, "filesystem");

    const queueWhileBusy = await appB.inject({ method: "GET", url: "/worker-jobs/queue" });
    assert.equal(queueWhileBusy.statusCode, 200);
    assert.equal(queueWhileBusy.json().backend, "filesystem");
    assert.equal(queueWhileBusy.json().workerId, "host-b");
    assert.equal(queueWhileBusy.json().running, 1);
    assert.equal(queueWhileBusy.json().queued, 1);
    assert.equal(queueWhileBusy.json().availableSlots, 0);

    await sleep(2_200);
    const firstAfterRunner = await appB.inject({ method: "GET", url: `/worker-jobs/${firstStart.json().jobId}` });
    assert.equal(firstAfterRunner.statusCode, 200);
    assert.equal(firstAfterRunner.json().status, "completed", JSON.stringify(firstAfterRunner.json()));

    const secondJob = await waitForJob(appB, secondStart.json().jobId);
    assert.equal(secondJob.status, "completed", JSON.stringify(secondJob));
    assert.equal(secondJob.runnerWorkerId, "host-b");
    assert.ok(secondJob.events.some((event: { type?: string }) => event.type === "worker_job_started"));
    assert.equal(secondJob.result.output.reason, "fila_compartilhada");
  } finally {
    await appA.close();
    if (appB) {
      await appB.close();
    }
    await removeTempWorkspace(workspaceRoot);
  }
});

test("control api faz replay automático de snapshot em job distribuído quando a fonte local falta", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mlops-flow-studio-replay-"));
  const snapshotStoreRoot = path.join(workspaceRoot, "snapshot-store");
  const sharedQueueRoot = path.join(workspaceRoot, "shared-worker-queue");
  const app = buildApp({
    workspaceRoot,
    ...insecureTestApp,
    workerJobConcurrency: 1,
    workerJobQueueRoot: sharedQueueRoot,
    workerJobWorkerId: "replay-host",
    datasetSnapshotStoreRoot: snapshotStoreRoot,
    datasetSnapshotEncryptionKey: "replay-snapshot-encryption-key",
    datasetSnapshotEncryptionKeyRef: "env:REPLAY_SNAPSHOT_KEY",
  });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { id: "replay_demo", name: "Replay Demo", problemType: "multiclass_classification", target: "classe_final", classes: ["classe_a", "classe_b"] },
    });
    assert.equal(created.statusCode, 200);
    const projectDataDir = path.join(workspaceRoot, "projects", "replay_demo", "data");
    const csvPath = path.join(projectDataDir, "tickets.csv");
    await mkdir(projectDataDir, { recursive: true });
    await writeFile(
      csvPath,
      [
        "id,text,classe_final,email",
        "1,classe_a boleto pagamento,classe_a,a@example.com",
        "2,classe_a segunda via boleto,classe_a,b@example.com",
        "3,classe_b erro login acesso,classe_b,c@example.com",
        "4,classe_b redefinir senha,classe_b,d@example.com",
      ].join("\n"),
      "utf-8",
    );

    const training = await app.inject({
      method: "POST",
      url: "/projects/replay_demo/train-baseline",
      payload: { sourceId: "tickets_csv", datasetSnapshotMode: "masked_rows" },
    });
    assert.equal(training.statusCode, 200);
    const trainingBody = training.json();
    const datasetVersionId = trainingBody.datasetVersion.datasetVersionId as string;
    const datasetManifestPath = path.join(workspaceRoot, "projects", "replay_demo", "artifacts", "dataset_versions", `${datasetVersionId}.json`);
    const rowSnapshotPath = path.join(workspaceRoot, "projects", "replay_demo", trainingBody.datasetVersion.rowArtifact.path);
    await stat(rowSnapshotPath);

    const archived = await app.inject({ method: "POST", url: "/projects/replay_demo/dataset-snapshots/archive" });
    assert.equal(archived.statusCode, 200);
    assert.equal(archived.json().archived, 1);

    await rm(csvPath, { force: true });
    await rm(rowSnapshotPath, { force: true });
    const purgedManifest = JSON.parse(await readFile(datasetManifestPath, "utf-8")) as { rowArtifact: Record<string, unknown> };
    purgedManifest.rowArtifact = {
      ...purgedManifest.rowArtifact,
      available: false,
      reason: "Snapshot local removido para validar replay automático.",
      purgedAt: new Date().toISOString(),
      purgedPath: trainingBody.datasetVersion.rowArtifact.path,
      path: undefined,
    };
    await writeFile(datasetManifestPath, `${JSON.stringify(purgedManifest, null, 2)}\n`, "utf-8");

    const replayJobStart = await app.inject({
      method: "POST",
      url: "/projects/replay_demo/train-baseline/jobs",
      payload: { sourceId: "tickets_csv", timeoutMs: 60_000 },
    });
    assert.equal(replayJobStart.statusCode, 200);
    assert.equal(replayJobStart.json().status, "running");
    assert.ok(replayJobStart.json().events.some((event: { type?: string; restored?: boolean }) => event.type === "dataset_snapshot_replayed" && event.restored === true));
    await stat(rowSnapshotPath);

    const replayJob = await waitForJob(app, replayJobStart.json().jobId);
    assert.equal(replayJob.status, "completed", JSON.stringify(replayJob));
    assert.equal(replayJob.result.kind, "training_result");
    assert.equal(replayJob.result.sourceMode, "mock");
    assert.equal(replayJob.result.rowCount, 4);
    assert.ok(replayJob.events.some((event: { type?: string }) => event.type === "dataset_snapshot_replayed"));
  } finally {
    await app.close();
    await removeTempWorkspace(workspaceRoot);
  }
});

async function waitForJob(app: FastifyInstance, jobId: string): Promise<Record<string, any>> {
  let jobBody: Record<string, any> = {};
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const polled = await app.inject({ method: "GET", url: `/worker-jobs/${jobId}` });
    assert.equal(polled.statusCode, 200);
    jobBody = polled.json();
    if (jobBody.status !== "queued" && jobBody.status !== "running") {
      return jobBody;
    }
  }
  return jobBody;
}

async function removeTempWorkspace(workspaceRoot: string): Promise<void> {
  const resolvedWorkspace = path.resolve(workspaceRoot);
  const resolvedTemp = path.resolve(os.tmpdir());
  assert.ok(resolvedWorkspace.startsWith(`${resolvedTemp}${path.sep}`), `Recusa remover diretório fora de TEMP: ${resolvedWorkspace}`);
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(resolvedWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
      return;
    } catch (error) {
      lastError = error;
      await sleep(250 * (attempt + 1));
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startFakeS3Server(): Promise<{ endpoint: string; objects: Map<string, Buffer>; close: () => Promise<void> }> {
  const objects = new Map<string, Buffer>();
  const server = createServer((request, response) => {
    void handleFakeS3Request(request, response, objects).catch((error) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    objects,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function startPlaywrightScrapeFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && requestUrl.pathname === "/") {
      sendHtml(
        response,
        `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <title>MLOps API Docs</title>
  <meta name="description" content="Documentação local para scraping Playwright." />
  <link rel="canonical" href="/docs" />
</head>
<body>
  <h1>Runtime Docs</h1>
  <h2>Endpoints</h2>
  <a href="/openapi.json">OpenAPI</a>
  <a href="/dashboard">Dashboard</a>
  <form method="post" action="/predict">
    <input name="text" placeholder="texto do ticket" required />
    <button type="submit">Enviar</button>
  </form>
</body>
</html>`,
      );
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/openapi.json") {
      sendJson(response, {
        openapi: "3.1.0",
        info: { title: "Fixture Runtime", version: "1.0.0" },
        paths: {
          "/predict": {
            post: {
              operationId: "predictTicket",
              summary: "Predizer ticket",
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["text"],
                      properties: {
                        text: { type: "string" },
                      },
                    },
                  },
                },
              },
              responses: {
                "200": {
                  description: "Predição gerada",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          label: { type: "string" },
                          score: { type: "number" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/dashboard") {
      sendHtml(
        response,
        `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <title>Runtime Dashboard</title>
</head>
<body>
  <h1>Runtime Dashboard</h1>
  <p>Visão operacional do runtime local.</p>
  <a href="/docs">Docs</a>
</body>
</html>`,
      );
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/login") {
      sendHtml(
        response,
        `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <title>Login</title>
</head>
<body>
  <form method="post" action="/login">
    <input id="username" name="username" />
    <input id="password" name="password" type="password" />
    <button id="submit" type="submit">Entrar</button>
  </form>
</body>
</html>`,
      );
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/login") {
      let rawBody = "";
      request.setEncoding("utf-8");
      request.on("data", (chunk) => {
        rawBody += chunk;
      });
      request.on("end", () => {
        const form = new URLSearchParams(rawBody);
        if (form.get("username") === "alice" && form.get("password") === "secret-password") {
          response.writeHead(303, { location: "/private", "set-cookie": "scrape_session=ok; HttpOnly; SameSite=Lax" });
          response.end();
          return;
        }
        response.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
        response.end("unauthorized");
      });
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/private") {
      if (!String(request.headers.cookie ?? "").includes("scrape_session=ok")) {
        response.writeHead(302, { location: "/login" });
        response.end();
        return;
      }
      sendHtml(
        response,
        `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <title>Private API Docs</title>
</head>
<body>
  <h1 id="private-docs">Private Runtime Docs</h1>
  <a href="/openapi.json">OpenAPI privada</a>
</body>
</html>`,
      );
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/deep") {
      sendHtml(
        response,
        `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8" /><title>Deep Root</title></head>
<body><h1>Deep Root</h1><a href="/deep/1">Level 1</a></body>
</html>`,
      );
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/deep/1") {
      sendHtml(
        response,
        `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8" /><title>Deep Level 1</title></head>
<body><h1>Deep Level 1</h1><a href="/deep/2">Level 2</a></body>
</html>`,
      );
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/deep/2") {
      sendHtml(
        response,
        `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8" /><title>Deep Level 2</title></head>
<body><h1>Deep Level 2</h1><a href="/deep/3">Level 3</a></body>
</html>`,
      );
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/deep/3") {
      sendHtml(
        response,
        `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8" /><title>Deep Level 3</title></head>
<body><h1>Deep Level 3</h1></body>
</html>`,
      );
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/predict") {
      let rawBody = "";
      request.setEncoding("utf-8");
      request.on("data", (chunk) => {
        rawBody += chunk;
      });
      request.on("end", () => {
        const received = rawBody ? JSON.parse(rawBody) as unknown : null;
        sendJson(response, { label: "ok", score: 0.99, received });
      });
      return;
    }
    response.statusCode = 404;
    sendJson(response, { message: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture Playwright não abriu porta TCP.");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function handleFakeS3Request(request: IncomingMessage, response: ServerResponse, objects: Map<string, Buffer>): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const segments = requestUrl.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  const bucket = segments[0] ?? "";
  const key = segments.slice(1).join("/");
  if (!bucket) {
    response.statusCode = 400;
    response.end("Bucket ausente.");
    return;
  }

  if (request.method === "PUT" && key) {
    objects.set(fakeS3ObjectId(bucket, key), await readRequestBuffer(request));
    response.statusCode = 200;
    response.end();
    return;
  }

  if (request.method === "GET" && requestUrl.searchParams.get("list-type") === "2") {
    const prefix = requestUrl.searchParams.get("prefix") ?? "";
    const keys = [...objects.keys()]
      .filter((objectId) => objectId.startsWith(`${bucket}/`))
      .map((objectId) => objectId.slice(bucket.length + 1))
      .filter((objectKey) => objectKey.startsWith(prefix))
      .sort();
    sendXml(response, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
      `<Name>${escapeXml(bucket)}</Name>`,
      `<Prefix>${escapeXml(prefix)}</Prefix>`,
      "<KeyCount>" + keys.length + "</KeyCount>",
      "<MaxKeys>1000</MaxKeys>",
      "<IsTruncated>false</IsTruncated>",
      ...keys.map((objectKey) => {
        const body = objects.get(fakeS3ObjectId(bucket, objectKey)) ?? Buffer.alloc(0);
        return [
          "<Contents>",
          `<Key>${escapeXml(objectKey)}</Key>`,
          "<LastModified>2026-01-01T00:00:00.000Z</LastModified>",
          '<ETag>"fake"</ETag>',
          `<Size>${body.length}</Size>`,
          "<StorageClass>STANDARD</StorageClass>",
          "</Contents>",
        ].join("");
      }),
      "</ListBucketResult>",
    ].join(""));
    return;
  }

  if (request.method === "GET" && key) {
    const body = objects.get(fakeS3ObjectId(bucket, key));
    if (!body) {
      response.statusCode = 404;
      response.end("<Error><Code>NoSuchKey</Code></Error>");
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-length", String(body.length));
    response.end(body);
    return;
  }

  response.statusCode = 405;
  response.end("Método não suportado pelo S3 fake.");
}

function fakeS3ObjectId(bucket: string, key: string): string {
  return `${bucket}/${key}`;
}

async function readRequestBuffer(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendXml(response: ServerResponse, body: string): void {
  response.statusCode = 200;
  response.setHeader("content-type", "application/xml");
  response.end(body);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", `&${"amp"};`)
    .replaceAll("<", `&${"lt"};`)
    .replaceAll(">", `&${"gt"};`)
    .replaceAll('"', `&${"quot"};`)
    .replaceAll("'", `&${"apos"};`);
}

async function startFakeMlflowServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void handleFakeMlflowRequest(request, response);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake MLflow não abriu porta TCP.");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function startBlackBoxRuntimeServer(): Promise<{ baseUrl: string; requests: Array<{ method: string; path: string }>; close: () => Promise<void> }> {
  const requests: Array<{ method: string; path: string }> = [];
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({ method: request.method ?? "GET", path: requestUrl.pathname });
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(response, { status: "ok" });
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/dashboard") {
      sendHtml(response, "<!doctype html><title>Runtime remoto</title><body>Runtime remoto</body>");
      return;
    }
    response.statusCode = 404;
    sendJson(response, { message: "not found" });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Runtime fake black-box não abriu porta TCP.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function startRuntimeSmokeServer(): Promise<{ baseUrl: string; requests: Array<{ method: string; path: string }>; close: () => Promise<void> }> {
  let predictionCount = 0;
  let feedbackCount = 0;
  let retrainingCount = 0;
  let latestRetrainingRequestId = "";
  let latestRetrainingStatus = "none";
  let latestDeploymentKind: "shadow" | "canary" | "rollback" | "" = "";
  let latestDeploymentId = "";
  let latestDeploymentCandidateId = "";
  let latestDeploymentTrafficPercent = 0;
  const requests: Array<{ method: string; path: string }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      requests.push({ method: request.method ?? "GET", path: requestUrl.pathname });
      if (request.method === "GET" && requestUrl.pathname === "/health") {
        sendJson(response, { status: "ok", database: { ok: true }, active_model: "model" });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/metadata") {
        sendJson(response, { contract: "mlops-flow-v1", project: { id: "demo", name: "Demo" } });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/models/active") {
        sendJson(response, { id: "model", status: "active" });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/models") {
        sendJson(response, { models: [{ id: "model", status: "active" }, { id: "candidate", status: "candidate" }] });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/metrics/model") {
        sendJson(response, { active_model_id: "model", metrics: { f1_macro: 0.9 } });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/metrics/runtime") {
        sendJson(response, { active_model_id: "model", prediction_count: predictionCount, latency_avg_ms: 0 });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/predict") {
        await readRequestBody(request);
        predictionCount += 1;
        const deployment = latestDeploymentKind && latestDeploymentKind !== "rollback"
          ? { mode: latestDeploymentKind, rollout_id: latestDeploymentId, routed_to: latestDeploymentKind === "canary" ? "candidate" : "active", active_model_id: "model", candidate_model_id: latestDeploymentCandidateId, traffic_percent: latestDeploymentTrafficPercent }
          : undefined;
        sendJson(response, {
          run_id: "pred-1",
          model_version_id: latestDeploymentKind === "canary" ? "candidate" : "model",
          prediction: "classe_a",
          inference_source: "artifact",
          ...(deployment ? { deployment } : {}),
          ...(latestDeploymentKind === "shadow" ? { shadow_prediction: { model_version_id: "candidate", prediction: "classe_a", confidence: 0.9, inference_source: "artifact" } } : {}),
        });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/feedback") {
        await readRequestBody(request);
        feedbackCount += 1;
        sendJson(response, { feedback_id: `feedback-${feedbackCount}`, run_id: "pred-1", row_id: "row-1", model_version_id: "model", predicted_value: "classe_a", actual_label: "classe_a", correct: true, source: "smoke" });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/feedback/summary") {
        sendJson(response, { feedback_count: feedbackCount, correct_count: feedbackCount, feedback_accuracy: feedbackCount > 0 ? 1 : null, active_model_id: "model", active_model_feedback_count: feedbackCount, active_model_feedback_accuracy: feedbackCount > 0 ? 1 : null });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/retraining/requests") {
        await readRequestBody(request);
        retrainingCount += 1;
        latestRetrainingRequestId = `retrain-${retrainingCount}`;
        latestRetrainingStatus = "pending_review";
        sendJson(response, { request_id: latestRetrainingRequestId, status: "pending_review", trigger: "feedback_threshold", feedback_count: feedbackCount, active_model_id: "model" });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname.match(/^\/retraining\/requests\/[^/]+\/approve$/)) {
        await readRequestBody(request);
        const requestId = requestUrl.pathname.split("/")[3];
        latestRetrainingStatus = "approved_pending_runner";
        sendJson(response, { id: requestId, status: "approved_pending_runner", trigger: "feedback_threshold", feedback_count: feedbackCount, active_model_id: "model" });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname.match(/^\/retraining\/requests\/[^/]+\/training-set$/)) {
        const requestId = requestUrl.pathname.split("/")[3];
        sendJson(response, {
          request_id: requestId,
          request_status: latestRetrainingStatus,
          active_model_id: "model",
          target: "classe_final",
          source: "runtime_feedback",
          row_count: 2,
          rows: [
            { text: "classe_a boleto aprovado por feedback", classe_final: "classe_a" },
            { text: "classe_b senha aprovada por feedback", classe_final: "classe_b" },
          ],
        });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname.match(/^\/retraining\/requests\/[^/]+\/complete$/)) {
        const completionBody = parseRequestJson(await readRequestBody(request));
        const requestId = requestUrl.pathname.split("/")[3];
        latestRetrainingStatus = completionBody.success === false ? "runner_failed" : "completed";
        sendJson(response, {
          id: requestId,
          request_id: requestId,
          status: latestRetrainingStatus,
          trigger: "feedback_threshold",
          feedback_count: feedbackCount,
          active_model_id: "model",
          completed_at: new Date().toISOString(),
        });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/retraining/status") {
        const pendingCount = ["pending_review", "approved_pending_runner"].includes(latestRetrainingStatus) ? retrainingCount : 0;
        sendJson(response, { request_count: retrainingCount, pending_count: pendingCount, latest_request: latestRetrainingRequestId ? { id: latestRetrainingRequestId, status: latestRetrainingStatus } : null, feedback: { feedback_count: feedbackCount, feedback_accuracy: feedbackCount > 0 ? 1 : null } });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/deployment/status") {
        sendJson(response, { status: "ok", active_model_id: "model", mode: latestDeploymentKind && latestDeploymentKind !== "rollback" ? latestDeploymentKind : "active", latest_rollout: latestDeploymentId ? { id: latestDeploymentId, kind: latestDeploymentKind, status: latestDeploymentKind === "rollback" ? "completed" : "active", active_model_id: "model", candidate_model_id: latestDeploymentCandidateId, traffic_percent: latestDeploymentTrafficPercent } : null });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/deployment/shadow") {
        const body = parseRequestJson(await readRequestBody(request));
        latestDeploymentKind = "shadow";
        latestDeploymentId = "deploy-shadow";
        latestDeploymentCandidateId = String(body.model_id ?? "candidate");
        latestDeploymentTrafficPercent = 0;
        sendJson(response, { status: "ok", rollout: { id: latestDeploymentId, kind: "shadow", status: "active", active_model_id: "model", candidate_model_id: latestDeploymentCandidateId, traffic_percent: 0 } });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/deployment/canary") {
        const body = parseRequestJson(await readRequestBody(request));
        latestDeploymentKind = "canary";
        latestDeploymentId = "deploy-canary";
        latestDeploymentCandidateId = String(body.model_id ?? "candidate");
        latestDeploymentTrafficPercent = Number(body.traffic_percent ?? 50);
        sendJson(response, { status: "ok", rollout: { id: latestDeploymentId, kind: "canary", status: "active", active_model_id: "model", candidate_model_id: latestDeploymentCandidateId, traffic_percent: latestDeploymentTrafficPercent } });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/deployment/rollback") {
        await readRequestBody(request);
        latestDeploymentKind = "rollback";
        latestDeploymentId = "deploy-rollback";
        sendJson(response, { status: "ok", rollout: { id: latestDeploymentId, kind: "rollback", status: "completed", active_model_id: "model", candidate_model_id: latestDeploymentCandidateId, traffic_percent: 0 }, deployment: { status: "ok", active_model_id: "model", mode: "active" } });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/dashboard") {
        sendHtml(response, "<!doctype html><title>MLOps Runtime Dashboard</title><body>MLOps Runtime Dashboard</body>");
        return;
      }
      response.statusCode = 404;
      sendJson(response, { message: "not found" });
    })().catch((error) => {
      response.statusCode = 500;
      sendJson(response, { message: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Runtime fake não abriu porta TCP.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function handleFakeMlflowRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, { status: "OK" });
    return;
  }
  if (request.method === "POST" && request.url === "/api/2.0/mlflow/experiments/search") {
    await readRequestBody(request);
    sendJson(response, {
      experiments: [
        {
          experiment_id: "1",
          name: "demo",
          lifecycle_stage: "active",
          artifact_location: "file:///tmp/mlruns/1",
          creation_time: 1000,
          last_update_time: 2000,
        },
      ],
    });
    return;
  }
  if (request.method === "POST" && request.url === "/api/2.0/mlflow/runs/search") {
    await readRequestBody(request);
    sendJson(response, {
      runs: [
        {
          info: {
            run_id: "mlflow-run-1",
            run_name: "train-demo",
            experiment_id: "1",
            status: "FINISHED",
            start_time: 1000,
            end_time: 2000,
            artifact_uri: "file:///tmp/mlruns/1/mlflow-run-1/artifacts",
          },
          data: {
            metrics: [{ key: "f1_macro", value: 0.91 }],
            params: [{ key: "algorithm", value: "xgboost" }],
            tags: [{ key: "mlops.project_id", value: "demo" }],
          },
        },
      ],
    });
    return;
  }
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && requestUrl.pathname === "/api/2.0/mlflow/registered-models/search") {
    sendJson(response, {
      registered_models: [
        {
          name: "ticket-router",
          creation_timestamp: 1000,
          last_updated_timestamp: 2000,
          latest_versions: [{ name: "ticket-router", version: "1", run_id: "mlflow-run-1", current_stage: "None", status: "READY" }],
        },
      ],
    });
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/2.0/mlflow/model-versions/search") {
    sendJson(response, {
      model_versions: [
        {
          name: "ticket-router",
          version: "1",
          run_id: "mlflow-run-1",
          current_stage: "None",
          status: "READY",
          source: "file:///tmp/model",
          creation_timestamp: 1000,
          last_updated_timestamp: 2000,
        },
      ],
    });
    return;
  }
  if (request.method === "POST" && request.url === "/api/2.0/mlflow/registered-models/alias") {
    const payload = parseRequestJson(await readRequestBody(request));
    sendJson(response, {
      registered_model_alias: {
        name: payload.name,
        version: payload.version,
        alias: payload.alias,
      },
    });
    return;
  }
  if (request.method === "DELETE" && request.url === "/api/2.0/mlflow/registered-models/alias") {
    const payload = parseRequestJson(await readRequestBody(request));
    sendJson(response, {
      deleted_alias: {
        name: payload.name,
        alias: payload.alias,
      },
    });
    return;
  }
  if (request.method === "POST" && request.url === "/api/2.0/mlflow/model-versions/transition-stage") {
    const payload = parseRequestJson(await readRequestBody(request));
    sendJson(response, {
      model_version: {
        name: payload.name,
        version: payload.version,
        current_stage: payload.stage,
        archive_existing_versions: payload.archive_existing_versions,
      },
    });
    return;
  }
  response.statusCode = 404;
  sendJson(response, { message: "not found" });
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return body;
}

function parseRequestJson(body: string): Record<string, unknown> {
  const parsed = body.trim() ? JSON.parse(body) as unknown : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function sendJson(response: ServerResponse, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.setHeader("content-type", "application/json");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

function sendHtml(response: ServerResponse, body: string): void {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}
