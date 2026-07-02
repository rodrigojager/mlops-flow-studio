import { spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const root = process.cwd();
const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) {
  throw new Error("npm_execpath não está definido; execute via npm run audit:visual.");
}
const controlPort = await findFreePort(Number(process.env.CONTROL_API_PORT || 3335));
const uiPort = await findFreePort(Number(process.env.MLOPS_UI_PORT || 5175), new Set([controlPort]));
const controlUrl = `http://127.0.0.1:${controlPort}`;
const uiUrl = `http://127.0.0.1:${uiPort}`;
const started = [];

try {
  started.push(startProcess("control-api", process.execPath, npmArgs(["run", "dev:control-api"]), {
    ...process.env,
    PORT: String(controlPort),
  }));
  await waitForJson(`${controlUrl}/health`, 30_000);

  started.push(startProcess("mlops-ui", process.execPath, npmArgs(["--workspace", "@mlops-flow-studio/mlops-ui", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(uiPort)]), {
    ...process.env,
    VITE_CONTROL_API_URL: controlUrl,
  }));
  await waitForText(uiUrl, 30_000);

  const result = await auditUi(uiUrl);
  console.log(JSON.stringify({ status: "ok", controlUrl, uiUrl, ...result }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: "error", controlUrl, uiUrl, message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await Promise.allSettled(started.map((item) => item.stop()));
}

function npmArgs(args) {
  return [npmExecPath, ...args];
}

async function auditUi(url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      const text = message.text();
      if (!text.includes("favicon.ico")) {
        consoleErrors.push(text);
      }
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await expectText(page, "MLOps Flow Studio", "marca do Studio");
    await expectVisible(page, "role=button[name=/Projeto/i]", "aba Projeto");
    await expectVisible(page, "role=button[name=/Pipeline/i]", "aba Pipeline");
    await expectVisible(page, "role=button[name=/Studio/i]", "aba Studio");

    await selectProject(page);
    const sourceAudit = await auditVisualSources(page);
    await page.getByRole("button", { name: /Pipeline/i }).click();
    await page.waitForSelector(".react-flow__node", { timeout: 10_000 });
    await page.waitForSelector(".react-flow__edge", { state: "attached", timeout: 10_000 });
    const nodeCount = await page.locator(".react-flow__node").count();
    const edgeCount = await page.locator(".react-flow__edge").count();
    if (nodeCount < 5 || edgeCount < 3) {
      throw new Error(`Canvas renderizou poucos elementos: ${nodeCount} nós, ${edgeCount} arestas.`);
    }
    await page.locator(".react-flow__node").first().click({ force: true });
    await expectText(page, "Tipo", "inspector");

    await page.getByRole("button", { name: /Studio/i }).click();
    await expectText(page, "Rule builder", "rule builder");
    const beforeRules = await page.locator(".rule-card").count();
    await page.getByRole("button", { name: /Adicionar regra/i }).click();
    const afterRules = await page.locator(".rule-card").count();
    if (afterRules !== beforeRules + 1) {
      throw new Error(`Adicionar regra não atualizou o rule builder: antes=${beforeRules}, depois=${afterRules}.`);
    }
    await expectVisible(page, "label=/Valor esperado/i", "campo de valor esperado");

    await page.getByRole("button", { name: /Runtime/i }).click();
    await expectText(page, "/environment/gpu", "endpoint GPU no Runtime");
    await expectText(page, "/promotion/status", "endpoint de promoção no Runtime");
    await expectText(page, "Scraping Playwright", "painel de scraping Playwright");
    await expectText(page, "Wizard de contrato antes da importação", "wizard de contrato do scrape");
    await expectText(page, "Pré-visualizar importação", "ação de pré-visualizar importação do scrape");
    await expectText(page, "Validar OpenAPI", "ação de validar OpenAPI do scrape");
    await expectText(page, "Importar scrape", "ação de importar scrape");

    await page.getByRole("button", { name: /Artefatos/i }).click();
    await expectText(page, "Reimportação", "aba Artefatos");
    const reimportAudit = await auditReimportedCanvas(page);

    if (consoleErrors.length || pageErrors.length) {
      throw new Error(`Erros no console: ${[...consoleErrors, ...pageErrors].join(" | ")}`);
    }

    return { nodeCount, edgeCount, ruleCardsBefore: beforeRules, ruleCardsAfter: afterRules, ...sourceAudit, ...reimportAudit };
  } finally {
    await browser.close();
  }
}

async function auditVisualSources(page) {
  await page.getByRole("button", { name: "Projeto", exact: true }).click();
  await expectText(page, "CSV de tickets rotulados", "fonte CSV");
  await expectText(page, "Histórico SQL", "fonte SQL");
  await expectText(page, "API externa de suporte", "fonte API externa");

  const apiSource = page.locator(".mock-source", { hasText: "support_api" }).first();
  await apiSource.waitFor({ state: "visible", timeout: 10_000 });
  const contractGrid = apiSource.locator(".api-contract-grid").first();
  await contractGrid.getByLabel("Método").selectOption("POST");
  await contractGrid.getByLabel("URL").fill("https://api.audit.local/tickets");
  await contractGrid.getByLabel("Timeout").fill("45");
  await contractGrid.getByLabel("Paginação").selectOption("cursor");
  await contractGrid.getByLabel("Cursor path").fill("meta.next_cursor");

  const apiMockCardsBefore = await apiSource.locator(".mock-card").count();
  await apiSource.getByRole("button", { name: /Adicionar mock/i }).click();
  const apiMockCardsAfter = await apiSource.locator(".mock-card").count();
  if (apiMockCardsAfter !== apiMockCardsBefore + 1) {
    throw new Error(`Adicionar mock de API não atualizou a fonte: antes=${apiMockCardsBefore}, depois=${apiMockCardsAfter}.`);
  }

  await expectVisible(page, "label=/URL/i", "campo URL da API");
  await page.getByRole("button", { name: /Pipeline/i }).click();
  await page.waitForSelector(".react-flow__node", { timeout: 10_000 });
  await page.locator(".react-flow__node", { hasText: "API externa" }).first().click({ force: true });
  const sourceSelect = page.locator(".inspector .inspector-body label").filter({ hasText: /^Fonte/ }).locator("select").first();
  await sourceSelect.waitFor({ state: "visible", timeout: 10_000 });
  await sourceSelect.selectOption({ label: "Histórico SQL" });
  await sourceSelect.selectOption({ label: "API externa de suporte" });
  const visualSourceBinding = await sourceSelect.inputValue();
  if (visualSourceBinding !== "support_api") {
    throw new Error(`Inspector não preservou vínculo visual de fonte: ${visualSourceBinding}.`);
  }

  return {
    visualSourceTypes: ["csv", "sql", "api"],
    apiMockCardsBefore,
    apiMockCardsAfter,
    visualSourceBinding,
  };
}

async function auditReimportedCanvas(page) {
  const targetProjectId = `visual_audit_reimport_${Date.now()}`;
  const generatedRuntimePath = "generated/support-ticket-runtime";
  const artifactSections = page.locator(".artifact-list");
  await artifactSections.first().locator("input").first().fill(generatedRuntimePath);

  const reimportSection = page.locator(".artifact-list", {
    has: page.getByRole("heading", { name: "Reimportação" }),
  });
  await reimportSection.locator("input").nth(0).fill(targetProjectId);

  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().includes("/projects/import-runtime") &&
        candidate.request().method() === "POST",
      { timeout: 30_000 }
    ),
    reimportSection.getByRole("button", { name: /Reimportar \.mlops/i }).click(),
  ]);

  if (!response.ok()) {
    throw new Error(`Reimportação .mlops falhou com status ${response.status()}.`);
  }

  await page.waitForFunction(
    (projectId) => {
      const select = document.querySelector(".project-switcher select");
      if (!select) {
        return false;
      }
      return Array.from(select.querySelectorAll("option")).some((option) => option.value === projectId);
    },
    targetProjectId,
    { timeout: 10_000 }
  );

  const [projectResponse] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().includes(`/projects/${targetProjectId}`) &&
        candidate.request().method() === "GET",
      { timeout: 30_000 }
    ),
    page.locator(".project-switcher select").selectOption(targetProjectId),
  ]);
  if (!projectResponse.ok()) {
    throw new Error(`Carregamento do projeto reimportado falhou com status ${projectResponse.status()}.`);
  }

  await page.getByRole("button", { name: /Pipeline/i }).click();
  await waitForCanvasCounts(page, 5, 3, "canvas reimportado");

  const reimportedNodeCount = await page.locator(".react-flow__node").count();
  const reimportedEdgeCount = await page.locator(".react-flow__edge").count();
  if (reimportedNodeCount < 5 || reimportedEdgeCount < 3) {
    throw new Error(`Canvas reimportado incompleto: ${reimportedNodeCount} nós, ${reimportedEdgeCount} arestas.`);
  }

  await page.locator(".react-flow__node").first().click({ force: true });
  await expectText(page, "Tipo", "inspector do projeto reimportado");

  return { reimportedProjectId: targetProjectId, reimportedNodeCount, reimportedEdgeCount };
}

async function waitForCanvasCounts(page, minNodes, minEdges, label) {
  await page.waitForFunction(
    ({ expectedNodes, expectedEdges }) =>
      document.querySelectorAll(".react-flow__node").length >= expectedNodes &&
      document.querySelectorAll(".react-flow__edge").length >= expectedEdges,
    { expectedNodes: minNodes, expectedEdges: minEdges },
    { timeout: 10_000 }
  ).catch(async (error) => {
    const nodeCount = await page.locator(".react-flow__node").count();
    const edgeCount = await page.locator(".react-flow__edge").count();
    throw new Error(`${label} incompleto: ${nodeCount} nós, ${edgeCount} arestas. ${error.message}`);
  });
}

async function selectProject(page) {
  const select = page.locator(".project-switcher select");
  await select.waitFor({ timeout: 10_000 });
  const options = await select.locator("option").evaluateAll((items) => items.map((item) => ({ value: item.value, text: item.textContent || "" })));
  const project = options.find((item) => item.value === "support_ticket_classification") || options.find((item) => item.value);
  if (!project) {
    throw new Error("Nenhum projeto disponível no seletor.");
  }
  await select.selectOption(project.value);
  await page.getByText(project.text.trim() || project.value).waitFor({ timeout: 10_000 }).catch(() => undefined);
}

async function expectText(page, text, label) {
  await page.getByText(text).first().waitFor({ state: "visible", timeout: 10_000 }).catch((error) => {
    throw new Error(`Não encontrou ${label}: ${error.message}`);
  });
}

async function expectVisible(page, selector, label) {
  const locator = selector.startsWith("role=")
    ? roleLocator(page, selector)
    : selector.startsWith("label=")
      ? page.getByLabel(new RegExp(selector.slice("label=/".length, -2), "i"))
      : page.locator(selector);
  await locator.first().waitFor({ state: "visible", timeout: 10_000 }).catch((error) => {
    throw new Error(`Não encontrou ${label}: ${error.message}`);
  });
}

function roleLocator(page, selector) {
  const match = selector.match(/^role=([a-z]+)\[name=\/(.+)\/i\]$/);
  if (!match) {
    throw new Error(`Seletor role inválido: ${selector}`);
  }
  return page.getByRole(match[1], { name: new RegExp(match[2], "i") });
}

function startProcess(name, command, args, env) {
  let stopping = false;
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.on("exit", (code, signal) => {
    if (!stopping && code !== 0 && code !== null && process.exitCode !== 1) {
      console.error(`${name} saiu com código ${code}${signal ? ` (${signal})` : ""}.\n${output.slice(-4000)}`);
    }
  });
  return {
    child,
    stop: async () => {
      if (child.exitCode !== null || child.killed) {
        return;
      }
      stopping = true;
      if (process.platform === "win32") {
        await runDetached("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
        return;
      }
      child.kill("SIGTERM");
      await delay(500);
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
    },
  };
}

function runDetached(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
}

async function waitForJson(url, timeoutMs) {
  const text = await waitForText(url, timeoutMs);
  JSON.parse(text);
}

async function waitForText(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.text();
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(500);
  }
  throw new Error(`Timeout aguardando ${url}: ${lastError}`);
}

async function findFreePort(start, reserved = new Set()) {
  let port = start;
  while (reserved.has(port) || !(await isPortFree(port))) {
    port += 1;
  }
  return port;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}
