import { test } from "node:test";
import assert from "node:assert/strict";
import * as L from "./lib.mjs";

test("licenseClassFromHub maps known identifiers to §2 classes", () => {
  assert.equal(L.licenseClassFromHub("apache-2.0"), "osi");
  assert.equal(L.licenseClassFromHub("MIT"), "osi");
  assert.equal(L.licenseClassFromHub("cc-by-4.0"), "cond");
  assert.equal(L.licenseClassFromHub("cc-by-nc-4.0"), "restr");
  assert.equal(L.licenseClassFromHub("llama3.1"), "restr");
  assert.equal(L.licenseClassFromHub("gemma"), "restr");
  assert.equal(L.licenseClassFromHub("bigscience-openrail-m"), "restr");
  assert.equal(L.licenseClassFromHub("other"), "unk");
  assert.equal(L.licenseClassFromHub(null), "unk");
  assert.equal(L.licenseClassFromHub(42), "unk");
});

test("hubLicense prefers cardData and falls back to tags", () => {
  assert.equal(L.hubLicense({ cardData: { license: "MIT" }, tags: ["license:apache-2.0"] }), "mit");
  assert.equal(L.hubLicense({ cardData: { license: ["apache-2.0", "mit"] } }), "apache-2.0");
  assert.equal(L.hubLicense({ tags: ["text-generation", "license:llama3"] }), "llama3");
  assert.equal(L.hubLicense({}), null);
  assert.equal(L.hubLicense(null), null);
});

test("tierOf applies §4 in order", () => {
  assert.equal(L.tierOf({ cls: "osi", code: true, data: 2 }), "I");
  assert.equal(L.tierOf({ cls: "osi", code: true, data: 1 }), "II");
  assert.equal(L.tierOf({ cls: "osi", code: null, data: null }), "II");
  assert.equal(L.tierOf({ cls: "cond", code: true, data: 2 }), "III");
  assert.equal(L.tierOf({ cls: "restr" }), "IV");
  assert.equal(L.tierOf({ cls: "unk", code: true, data: 2 }), "—");
});

test("opennessScore sums §3 components and treats unknowns as 0", () => {
  assert.equal(L.opennessScore({ cls: "osi", code: true, data: 2, report: true }), 6);
  assert.equal(L.opennessScore({ cls: "cond", code: false, data: 0, report: true }), 2);
  assert.equal(L.opennessScore({ cls: "restr", code: null, data: null, report: null }), 0);
  assert.equal(L.opennessScore({ cls: "unk", code: true, data: 1, report: false }), 2);
});

test("transparencyOf follows the watercolour T/ST/O convention", () => {
  assert.deepEqual([2, 1, 0, null, undefined].map(L.transparencyOf), ["T", "ST", "O", "?", "?"]);
});

test("formatsFromTags recognises formats case-insensitively and in canonical order", () => {
  assert.deepEqual(L.formatsFromTags(["MLX", "gguf", "text-generation", 7]), ["gguf", "mlx"]);
  assert.deepEqual(L.formatsFromTags(undefined), []);
});

test("tallyFormats counts repos, sums downloads and tracks the top repo per format", () => {
  const t = L.tallyFormats([
    { id: "a/q4", downloads: 10, tags: ["gguf"] },
    { id: "b/q8", downloads: 30, tags: ["gguf", "8-bit"] },
    { id: "c/mlx", downloads: 5, tags: ["mlx", "gguf"] },
    { id: "d/none", downloads: 99, tags: ["safetensors"] }
  ]);
  assert.deepEqual(t.gguf, { repos: 3, downloads: 45, top: { id: "b/q8", downloads: 30 } });
  assert.deepEqual(t.mlx, { repos: 1, downloads: 5, top: { id: "c/mlx", downloads: 5 } });
  assert.equal(t.awq, undefined);
});

test("isFirstPartyRelease excludes derivatives and third-party fine-tunes", () => {
  assert.equal(L.isFirstPartyRelease({ id: "Qwen/Qwen3-8B", tags: ["base_model:finetune:Qwen/Qwen3-8B-Base"] }), true);
  assert.equal(L.isFirstPartyRelease({ id: "someone/Qwen3-8B-tuned", tags: ["base_model:finetune:Qwen/Qwen3-8B"] }), false);
  assert.equal(L.isFirstPartyRelease({ id: "Qwen/Qwen3-8B-GGUF", tags: ["base_model:quantized:Qwen/Qwen3-8B"] }), false);
  assert.equal(L.isFirstPartyRelease({ id: "x/merge", tags: ["base_model:merge:a/b"] }), false);
  assert.equal(L.isFirstPartyRelease({ id: "x/plain", tags: ["base_model:a/b"] }), true);
  assert.equal(L.isFirstPartyRelease({ id: "x/none" }), true);
});

test("apportion uses largest remainder, sums to n and is stable", () => {
  const r = L.apportion([{ key: "a", weight: 1 }, { key: "b", weight: 1 }, { key: "c", weight: 1 }], 10);
  assert.equal(r.reduce((s, x) => s + x.tiles, 0), 10);
  assert.deepEqual(r, [{ key: "a", tiles: 4 }, { key: "b", tiles: 3 }, { key: "c", tiles: 3 }]);
  const skew = L.apportion([{ key: "big", weight: 997 }, { key: "tiny", weight: 3 }, { key: "zero", weight: 0 }], 144);
  assert.equal(skew.reduce((s, x) => s + x.tiles, 0), 144);
  assert.ok(!skew.some((x) => x.key === "zero"));
  assert.deepEqual(L.apportion([], 10), []);
  assert.deepEqual(L.apportion([{ key: "a", weight: 1 }], 0), []);
});

test("runtimeEvidence combines formats and relations per pigment", () => {
  const pigments = [
    { id: "p1", hub: { derivatives: { quantized: { formats: { gguf: { repos: 5 }, mlx: { repos: 2 } } }, finetune: { count: 7 } } } },
    { id: "p2", hub: { derivatives: { quantized: { formats: { gguf: { repos: 9 } } }, finetune: { count: 0 } } } },
    { id: "p3", hub: { found: false } }
  ];
  assert.deepEqual(L.runtimeEvidence({ evidence: { formats: ["gguf"] } }, pigments),
    [{ pigment: "p2", weight: 9 }, { pigment: "p1", weight: 5 }]);
  assert.deepEqual(L.runtimeEvidence({ evidence: { formats: ["mlx"], relations: ["finetune"] } }, pigments),
    [{ pigment: "p1", weight: 9 }]);
  assert.deepEqual(L.runtimeEvidence({}, pigments), []);
});

test("mergeHistory de-duplicates by timestamp, sorts and caps", () => {
  const prev = [{ t: "2026-01-01T00:00:00Z", d: 1 }, { t: "2026-01-01T03:00:00Z", d: 2 }, null, { nope: 1 }];
  const out = L.mergeHistory(prev, { t: "2026-01-01T03:00:00Z", d: 3 }, 56);
  assert.deepEqual(out, [{ t: "2026-01-01T00:00:00Z", d: 1 }, { t: "2026-01-01T03:00:00Z", d: 3 }]);
  const capped = L.mergeHistory(prev, { t: "2026-01-01T06:00:00Z", d: 4 }, 2);
  assert.deepEqual(capped.map((p) => p.d), [2, 4]);
  assert.deepEqual(L.mergeHistory(undefined, undefined), []);
});

test("nextLink parses RFC 8288 Link headers", () => {
  assert.equal(L.nextLink('<https://x/api/models?cursor=abc>; rel="next"'), "https://x/api/models?cursor=abc");
  assert.equal(L.nextLink('<https://x/p1>; rel="prev", <https://x/p3>; rel="next"'), "https://x/p3");
  assert.equal(L.nextLink('<https://x/p1>; rel="prev"'), null);
  assert.equal(L.nextLink(null), null);
});

test("retryAfterSeconds handles delta-seconds and HTTP dates", () => {
  assert.equal(L.retryAfterSeconds("7"), 7);
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(L.retryAfterSeconds("Thu, 01 Jan 2026 00:00:30 GMT", now), 30);
  assert.equal(L.retryAfterSeconds("garbage"), null);
  assert.equal(L.retryAfterSeconds(null), null);
});

test("pickResolved filters by author, regex and first-party, then ranks by downloads", () => {
  const c = [
    { id: "google/gemma-4-31b-it", downloads: 900, tags: [] },
    { id: "google/gemma-4-2b-it", downloads: 5000, tags: [] },
    { id: "unsloth/gemma-4-31b-it-GGUF", downloads: 9999, tags: ["base_model:quantized:google/gemma-4-31b-it"] },
    { id: "google/gemma-4-31b-it-qat", downloads: 100, tags: ["base_model:quantized:google/gemma-4-31b-it"] }
  ];
  assert.equal(L.pickResolved(c, { author: "google", search: "gemma-4", match: "31b" }), "google/gemma-4-31b-it");
  assert.equal(L.pickResolved(c, { author: "google", search: "gemma-4" }), "google/gemma-4-2b-it");
  assert.equal(L.pickResolved(c, { author: "meta" }), null);
  assert.equal(L.pickResolved(null, { author: "x" }), null);
});

test("isRepack detects format tags and repack markers in repo names", () => {
  assert.equal(L.isRepack({ id: "a/Model-7B-GGUF" }), true);
  assert.equal(L.isRepack({ id: "mistralai/Mistral-Large-3-675B-Instruct-2512-NVFP4" }), true);
  assert.equal(L.isRepack({ id: "a/Gemma-4-E4B-Uncensored-Aggressive" }), true);
  assert.equal(L.isRepack({ id: "a/GLM-5.3-abliterated" }), true);
  assert.equal(L.isRepack({ id: "a/Model-4bit" }), true);
  assert.equal(L.isRepack({ id: "a/plain", tags: ["mlx"] }), true);
  for (const id of ["openai/gpt-oss-20b", "Qwen/Qwen3-Next-80B-A3B-Instruct", "moonshotai/Kimi-K2-Instruct",
                    "deepseek-ai/DeepSeek-V3.1", "meta-llama/Llama-4-Scout-17B-16E-Instruct", "zai-org/GLM-5.3"]) {
    assert.equal(L.isRepack({ id }), false, id);
  }
});

test("pickResolved requires the search text in the repo name and honours exclusion patterns", () => {
  const olmo = [{ id: "allenai/OLMo-2-0325-32B-Instruct", downloads: 9e4, tags: [] }];
  assert.equal(L.pickResolved(olmo, { author: "allenai", search: "Olmo-3", match: "32B" }), null, "fuzzy Hub hit is rejected");
  const glm = [
    { id: "zai-org/GLM-5.3-Flash", downloads: 5e6, tags: [] },
    { id: "zai-org/GLM-5.3", downloads: 2e6, tags: [] },
    { id: "zai-org/GLM-5.3-FP8", downloads: 9e6, tags: [] }
  ];
  assert.equal(L.pickResolved(glm, { author: "zai-org", search: "GLM-5.3", match: "^zai-org/GLM-5\\.3(?!.*(flash|air))" }), "zai-org/GLM-5.3");
  const ml3 = [
    { id: "mistralai/Mistral-Large-3-675B-Instruct-2512-NVFP4", downloads: 11470, tags: [] },
    { id: "mistralai/Mistral-Large-3-675B-Instruct-2512", downloads: 9000, tags: [] }
  ];
  assert.equal(L.pickResolved(ml3, { author: "mistralai", search: "Large-3" }), "mistralai/Mistral-Large-3-675B-Instruct-2512");
});

test("registry resolve patterns compile and exclude known wrong matches", async () => {
  const { readFile } = await import("node:fs/promises");
  const reg = JSON.parse(await readFile(new URL("./registry/pigments.json", import.meta.url), "utf8"));
  const ids = new Set();
  for (const p of reg) {
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`); ids.add(p.id);
    assert.ok(p.hf || p.resolve, `${p.id} needs hf or resolve`);
    if (p.resolve?.match) new RegExp(p.resolve.match, "i");
  }
  const re = (id) => new RegExp(reg.find((p) => p.id === id).resolve.match, "i");
  assert.equal(re("deepseek-v4").test("deepseek-ai/DeepSeek-V4-Flash-0731"), false);
  assert.equal(re("deepseek-v4").test("deepseek-ai/DeepSeek-V4.1-Flash"), false);
  assert.equal(re("deepseek-v4").test("deepseek-ai/DeepSeek-V4"), true);
  assert.equal(re("glm-5.3").test("zai-org/GLM-5.3-Flash"), false);
  assert.equal(re("glm-5.3").test("zai-org/GLM-5.3"), true);
});
