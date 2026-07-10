import assert from "node:assert/strict";
import test from "node:test";
import type { MLOpsProject, PipelineFlow } from "./types.ts";

test("cliente envia Bearer token, payload de criação e bundle único", async (context) => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { mlopsDesktop: { apiToken: "desktop-test-token-with-32-characters" } },
  });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ status: "ok", project: {}, pipeline: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  });

  const { createProject, saveProjectBundle } = await import("./api.ts");
  await createProject({ name: "Projeto de teste" });
  await saveProjectBundle("demo", { id: "demo" } as MLOpsProject, { id: "flow" } as PipelineFlow);

  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { name: "Projeto de teste" });
  assert.match(calls[1].url, /\/projects\/demo\/bundle$/);
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { project: { id: "demo" }, pipeline: { id: "flow" } });
  for (const call of calls) {
    assert.equal(new Headers(call.init?.headers).get("authorization"), "Bearer desktop-test-token-with-32-characters");
  }
});
