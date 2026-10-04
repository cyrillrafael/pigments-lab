// End-to-end test of build() against an in-memory Hub and GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "./fetch.mjs";

const HF = "https://hf.test";
const GH = "https://gh.test";
const PREV = "https://site.test/weights/data/watch.json";
const json = (body, init = {}) => new Response(JSON.stringify(body), {
  status: init.status || 200,
  headers: { "content-type": "application/json", ...(init.headers || {}) }
});

function makeFakeWorld({ previous = null } = {}) {
  const calls = [];
  let flaky = 0;

  const models = {
    "deepseek-ai/DeepSeek-R1": {
      id: "deepseek-ai/DeepSeek-R1", downloads: 1000, likes: 50, createdAt: "2025-01-20T00:00:00Z",
      cardData: { license: "mit" }, safetensors: { total: 684_500_000_000 }, tags: ["license:mit"]
    },
    "openai/gpt-oss-20b": {
      id: "openai/gpt-oss-20b", downloads: 500, likes: 20, cardData: { license: "apache-2.0" },
      safetensors: { total: 12_000_000_000 } // packed MXFP4: should raise a params check
    },
    "google/gemma-4-31b-it": {
      id: "google/gemma-4-31b-it", downloads: 300, likes: 9, cardData: { license: "apache-2.0" }
    },
    "Qwen/Qwen3-235B-A22B": {
      id: "Qwen/Qwen3-235B-A22B", downloads: 50, likes: 5, cardData: { license: "llama3" } // mismatch on purpose
    }
  };

  async function fetchImpl(input) {
    const url = new URL(String(input));
    calls.push(url.href);
    if (url.href === PREV) return previous ? json(previous) : new Response("nope", { status: 404 });

    if (url.origin === GH) {
      if (url.pathname === "/repos/ggml-org/llama.cpp") {
        return json({ html_url: "https://github.com/ggml-org/llama.cpp", full_name: "ggml-org/llama.cpp", stargazers_count: 90000,
                      forks_count: 1, open_issues_count: 2, pushed_at: "2026-10-04T00:00:00Z", license: { spdx_id: "MIT" } });
      }
      if (url.pathname === "/repos/ggml-org/llama.cpp/releases/latest") {
        return json({ tag_name: "b9999", published_at: "2026-10-03T00:00:00Z", html_url: "https://github.com/x" });
      }
      return new Response("not found", { status: 404 });
    }

    const p = url.pathname;
    const q = url.searchParams;
    if (p === "/api/models") {
      const filter = q.get("filter");
      if (filter === "base_model:quantized:deepseek-ai/DeepSeek-R1") {
        if (q.get("cursor") === "2") return json([{ id: "c/r1-mlx", downloads: 7, tags: ["mlx"] }]);
        return json(
          [{ id: "a/r1-gguf", downloads: 100, tags: ["gguf"] }, { id: "b/r1-awq", downloads: 40, tags: ["awq"] }],
          { headers: { link: `<${HF}/api/models?filter=${encodeURIComponent(filter)}&cursor=2>; rel="next"` } }
        );
      }
      if (filter === "base_model:finetune:deepseek-ai/DeepSeek-R1") return json([{ id: "f/1", downloads: 1, tags: [] }]);
      if (filter) return json([]);
      if (q.get("author") === "google" && q.get("search") === "gemma-4") {
        return json([
          { id: "google/gemma-4-31b-it", downloads: 300, tags: [] },
          { id: "google/gemma-4-2b-it", downloads: 900, tags: [] }
        ]);
      }
      if (q.get("pipeline_tag") === "text-generation") {
        return json([
          { id: "newlab/Shiny-9B", trendingScore: 99, downloads: 10, likes: 3, tags: ["license:apache-2.0"] },
          { id: "fan/Shiny-9B-GGUF", trendingScore: 98, tags: ["base_model:quantized:newlab/Shiny-9B"] },
          { id: "deepseek-ai/DeepSeek-R1", trendingScore: 50, tags: [] }
        ]);
      }
      return json([]);
    }
    if (p.startsWith("/api/models/")) {
      const id = decodeURIComponent(p.slice("/api/models/".length));
      if (q.getAll("expand[]").length) return models[id] ? json({ id, downloadsAllTime: 12345, trendingScore: 7 }) : new Response("", { status: 404 });
      if (id === "openai/gpt-oss-120b") return new Response("boom", { status: 500 }); // permanent failure
      if (id === "openai/gpt-oss-20b" && flaky++ < 2) return new Response("busy", { status: 503 }); // transient
      if (id === "newlab/Shiny-9B") return json({ id, downloads: 10, likes: 3, cardData: { license: "apache-2.0" }, safetensors: { total: 9e9 } });
      return models[id] ? json(models[id]) : new Response("not found", { status: 404 });
    }
    if (p === "/api/spaces") {
      if (q.get("models") === "deepseek-ai/DeepSeek-R1") return json([{ id: "lab/arena", likes: 400 }]);
      return json([]);
    }
    if (p === "/api/spaces/lab/arena") {
      return json({ id: "lab/arena", likes: 401, sdk: "gradio", cardData: { title: "Arena", emoji: "🎨" },
                    runtime: { stage: "RUNNING" }, models: ["deepseek-ai/DeepSeek-R1", "openai/gpt-oss-20b", "x/unknown"] });
    }
    return new Response("unrouted", { status: 404 });
  }
  return { fetchImpl, calls };
}

const env = { HF_ENDPOINT: HF, GITHUB_API_URL: GH, OWW_PREVIOUS_URL: PREV, OWW_CONCURRENCY: "3" };
const quiet = () => {};
const noSleep = async () => {};

test("build enriches pigments, resolves hints, tallies formats and composes mosaics", async () => {
  const world = makeFakeWorld();
  const doc = await build({ fetchImpl: world.fetchImpl, env, log: quiet, sleepImpl: noSleep, now: new Date("2026-10-04T12:00:00Z") });

  assert.equal(doc.schema, 1);
  assert.equal(doc.generatedAt, "2026-10-04T12:00:00.000Z");
  assert.ok(doc.pigments.length >= 40);

  const r1 = doc.pigments.find((p) => p.id === "deepseek-r1");
  assert.equal(r1.hub.found, true);
  assert.equal(r1.hub.resolvedBy, "registry");
  assert.equal(r1.hub.downloadsAllTime, 12345);
  assert.equal(r1.tier, "II");
  assert.equal(r1.transparency, "O");
  assert.equal(r1.hub.derivatives.quantized.count, 3, "follows pagination");
  assert.equal(r1.hub.derivatives.quantized.formats.gguf.repos, 1);
  assert.equal(r1.hub.derivatives.quantized.formats.mlx.repos, 1);
  assert.equal(r1.hub.derivatives.finetune.count, 1);
  assert.deepEqual(r1.checks, [], "684.5B is within 15% of 671B");
  assert.equal(r1.history.length, 1);

  const gemma = doc.pigments.find((p) => p.id === "gemma-4-31b");
  assert.equal(gemma.hub.id, "google/gemma-4-31b-it", "regex hint beats raw download rank");
  assert.equal(gemma.hub.resolvedBy, "search");

  const oss20 = doc.pigments.find((p) => p.id === "gpt-oss-20b");
  assert.equal(oss20.hub.found, true, "retried through transient 503s");
  assert.ok(oss20.checks.some((c) => c.kind === "params"));

  const qwen = doc.pigments.find((p) => p.id === "qwen3-235b");
  assert.ok(qwen.checks.some((c) => c.kind === "licence"));

  const oss120 = doc.pigments.find((p) => p.id === "gpt-oss-120b");
  assert.equal(oss120.hub.found, false);
  assert.ok(doc.errors.some((e) => e.id === "gpt-oss-120b"));

  const missing = doc.pigments.find((p) => p.id === "mimo-v2.6-pro");
  assert.equal(missing.hub.found, false);
  assert.ok(missing.checks.some((c) => c.kind === "missing"));

  assert.deepEqual(doc.discovered.map((d) => d.id), ["newlab/Shiny-9B"], "excludes quantisations and catalogued ids");
  assert.equal(doc.discovered[0].licenseClass, "osi");
  assert.equal(doc.discovered[0].params, 9e9);

  const llamacpp = doc.runtimes.find((r) => r.repo === "ggml-org/llama.cpp");
  assert.equal(llamacpp.github.stars, 90000);
  assert.equal(llamacpp.github.release.tag, "b9999");
  assert.deepEqual(llamacpp.composition, [{ pigment: "deepseek-r1", weight: 1 }]);
  const vllm = doc.runtimes.find((r) => r.repo === "vllm-project/vllm");
  assert.equal(vllm.github, null, "unknown repo yields null, not a crash");
  assert.deepEqual(vllm.composition, [{ pigment: "deepseek-r1", weight: 1 }]);

  assert.equal(doc.spaces.length, 1);
  assert.deepEqual(doc.spaces[0].pigments.sort(), ["deepseek-r1", "gpt-oss-20b"]);
  assert.deepEqual(doc.spaces[0].otherModels, ["x/unknown"]);
  assert.equal(doc.spaces[0].stage, "RUNNING");
});

test("build falls back to previous values per item and keeps history", async () => {
  const first = await build({ fetchImpl: makeFakeWorld().fetchImpl, env, log: quiet, sleepImpl: noSleep, now: new Date("2026-10-04T09:00:00Z") });
  // Pretend gpt-oss-120b had been live in the previous document.
  const previous = structuredClone(first);
  const prev120 = previous.pigments.find((p) => p.id === "gpt-oss-120b");
  prev120.hub = { found: true, id: "openai/gpt-oss-120b", downloads: 77, likes: 1 };
  prev120.history = [{ t: "2026-10-04T06:00:00.000Z", d: 70, l: 1 }];

  const world = makeFakeWorld({ previous });
  const doc = await build({ fetchImpl: world.fetchImpl, env, log: quiet, sleepImpl: noSleep, now: new Date("2026-10-04T12:00:00Z") });

  const oss120 = doc.pigments.find((p) => p.id === "gpt-oss-120b");
  assert.equal(oss120.hub.found, true);
  assert.equal(oss120.hub.stale, true);
  assert.equal(oss120.hub.staleSince, "2026-10-04T09:00:00.000Z");
  assert.equal(oss120.history.length, 1, "stale items do not append points");

  const r1 = doc.pigments.find((p) => p.id === "deepseek-r1");
  assert.deepEqual(r1.history.map((h) => h.t), ["2026-10-04T09:00:00.000Z", "2026-10-04T12:00:00.000Z"]);
  assert.ok(world.calls.includes(PREV));
});

test("total outage republishes the previous document with a failure note", async () => {
  const previous = await build({ fetchImpl: makeFakeWorld().fetchImpl, env, log: quiet, sleepImpl: noSleep });
  const down = async (input) => {
    if (String(input) === PREV) return json(previous);
    return new Response("down", { status: 503 });
  };
  const doc = await build({ fetchImpl: down, env, log: quiet, sleepImpl: noSleep });
  assert.equal(doc.generatedAt, previous.generatedAt);
  assert.ok(doc.lastAttempt?.at);
  assert.ok(doc.lastAttempt.errors.length > 0);
});
