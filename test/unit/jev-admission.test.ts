import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runChildSession } from "../../src/runs/background/run-child-session.ts";
import { admitJevLaunch, chooseCheapestQualifiedModel, consumeJevDispatchAdmission, filterJevSkillPrompt, jevAbortRecoveryAllowed, recordJevExecution, resolveJevAdmissionMode, resolveJevSkillPolicy, validateJevSkillCatalogFiles, validateJevSkillSelection } from "../../src/runs/shared/jev-admission.ts";

function response(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }

const need = { task: "review", capabilities: [], input_tokens: 1, output_tokens: 1, deadline_ms: 99_999_999_999, max_cost: 1, snapshot_ttl_ms: 15_000, pinned_model: null };

test("Jev admission preserves existing launch behavior while disabled", async () => {
	assert.equal(await admitJevLaunch({ config: undefined, candidates: ["openai/example"], task: "review" }), undefined);
});

test("workflow bindings resolve explicit Jev admission modes", () => {
	assert.equal(resolveJevAdmissionMode(undefined), "optional");
	assert.equal(resolveJevAdmissionMode({ "pi-subagents.jev-admission/1": { mode: "required" } }), "required");
	assert.equal(resolveJevAdmissionMode({ "pi-subagents.jev-admission/1": { mode: "optional" } }), "optional");
	assert.equal(resolveJevAdmissionMode({ "pi-subagents.jev-admission/1": { mode: "disabled" } }), "disabled");
	assert.throws(() => resolveJevAdmissionMode({ "pi-subagents.jev-admission/1": { mode: "sometimes" } }), /jev_admission_mode_invalid/);
});

test("workflow bindings validate a bounded hash-bound skill catalog", () => {
	const hash = "a".repeat(64);
	const policy = resolveJevSkillPolicy({ "pi-subagents.jev-admission/1": { mode: "required", skills: [{ id: "workflow", hash, mandatory: true }, { id: "jev", hash }] } });
	assert.deepEqual(policy?.candidates, [{ id: "workflow", hash, mandatory: true }, { id: "jev", hash }]);
	assert.deepEqual(validateJevSkillSelection(policy, [{ id: "jev", hash }]), { skills: [{ id: "jev", hash }, { id: "workflow", hash }], mandatorySkillsRestored: true });
	assert.throws(() => validateJevSkillSelection(policy, [{ id: "unknown", hash }]), /jev_skill_selection_invalid/);
	assert.throws(() => resolveJevSkillPolicy({ "pi-subagents.jev-admission/1": { skills: [{ id: "jev", hash: "stale" }] } }), /jev_skill_catalog_invalid/);
});

test("shared Jev helper validates catalog hashes against the exact skill bytes", () => {
	const dir = mkdtempSync(join(tmpdir(), "jev-skill-"));
	const path = join(dir, "SKILL.md");
	writeFileSync(path, "exact skill bytes\n");
	const hash = createHash("sha256").update("exact skill bytes\n").digest("hex");
	const prompt = `<available_skills><skill><name>jev</name><location>${path}</location></skill></available_skills>`;
	validateJevSkillCatalogFiles({ candidates: [{ id: "jev", hash, mandatory: true }] }, prompt);
	assert.throws(() => validateJevSkillCatalogFiles({ candidates: [{ id: "jev", hash: "0".repeat(64) }] }, prompt), /jev_skill_catalog_mismatch/);
});

test("shared Jev helper narrows the child skill manifest without rewriting skill bytes", () => {
	const prompt = `<available_skills>\n<skill><name>workflow</name><location>/a</location></skill>\n<skill><name>jev</name><location>/b</location></skill>\n</available_skills>`;
	const filtered = filterJevSkillPrompt(prompt, ["jev"]);
	assert.doesNotMatch(filtered ?? "", /<name>workflow<\/name>/);
	assert.match(filtered ?? "", /<name>jev<\/name>/);
	assert.match(filtered ?? "", /<location>\/b<\/location>/);
});

test("native Jev admission jointly retains model and selected skill evidence", async () => {
	const requiredHash = "a".repeat(64);
	const optionalHash = "b".repeat(64);
	const offerBodies: unknown[] = [];
	const fetcher: typeof fetch = async (url, init) => {
		if (String(url).endsWith("/offers")) {
			offerBodies.push(JSON.parse(String(init?.body)));
			return response({ offers: [{ model_id: "openai/example", quota_tokens: 10, cost: 0.01, offer_hash: "offer" }], need, selected_skills: [{ id: "jev", hash: optionalHash }] });
		}
		return response({ model_id: "openai/example", offer_hash: "offer", lease_id: "lease", expires_ms: 10_000 });
	};
	const admission = await admitJevLaunch({
		config: { endpoint: "http://scheduler" }, candidates: ["openai/example"], task: "review", nowMs: 100, fetcher,
		skillPolicy: { candidates: [{ id: "workflow", hash: requiredHash, mandatory: true }, { id: "jev", hash: optionalHash }] },
	});
	assert.deepEqual(admission?.skills, [{ id: "jev", hash: optionalHash }, { id: "workflow", hash: requiredHash }]);
	assert.equal(admission?.evidence?.mandatorySkillsRestored, true);
	assert.deepEqual((offerBodies[0] as { skills: unknown }).skills, [{ id: "workflow", hash: requiredHash, mandatory: true }, { id: "jev", hash: optionalHash }]);
});

test("native Jev admission fails closed when the host offers no known quota", async () => {
	const fetcher: typeof fetch = async () => response({ offers: [{ model_id: "openai/example", quota_tokens: null, offer_hash: "unknown" }], need });
	await assert.rejects(admitJevLaunch({ config: { endpoint: "http://scheduler" }, candidates: ["openai/example"], task: "review", fetcher }), /jev_no_admissible_proposal/);
});

test("native Jev chooses the cheapest qualified model from the allowed roster", () => {
	const proposal = chooseCheapestQualifiedModel([
		{ model_id: "openai-codex/gpt-5.6-luna", quota_tokens: 10, cost: 0.02, offer_hash: "luna" },
		{ model_id: "openai/example", quota_tokens: 10, cost: 0.01, offer_hash: "example" },
		{ model_id: "not-allowed", quota_tokens: 1, cost: 0, offer_hash: "other" },
	], ["openai-codex/gpt-5.6-luna", "openai/example"]);
	assert.deepEqual(proposal, { model: "openai/example", offerHash: "example" });
});

test("Jev admission matches a thinking-suffixed roster ID to the base offer and preserves the child setting", async () => {
	let leaseBody: unknown;
	const offerBodies: unknown[] = [];
	const fetcher: typeof fetch = async (url, init) => {
		if (String(url).endsWith("/offers")) {
			offerBodies.push(JSON.parse(String(init?.body)));
			return response({ offers: [{ model_id: "openai-codex/gpt-5.6-luna", quota_tokens: 10, offer_hash: "luna", cost: 0.01 }], need });
		}
		leaseBody = JSON.parse(String(init?.body));
		return response({ model_id: "openai-codex/gpt-5.6-luna", offer_hash: "luna", lease_id: "lease-luna", expires_ms: 10_000 });
	};
	const admission = await admitJevLaunch({ config: { endpoint: "http://scheduler" }, candidates: ["openai-codex/gpt-5.6-luna:low"], task: "review", nowMs: 100, fetcher });
	assert.equal(admission?.model, "openai-codex/gpt-5.6-luna:low");
	assert.deepEqual(offerBodies, [
		{ candidates: ["openai-codex/gpt-5.6-luna"], task: "review" },
		{ candidates: ["openai-codex/gpt-5.6-luna"], task: "review" },
	]);
	assert.deepEqual(leaseBody, { model_id: "openai-codex/gpt-5.6-luna", offer_hash: "luna" });
});

test("Jev admission leases a refreshed offer for the same model", async () => {
	const calls: Array<{ url: string; auth: string | null }> = [];
	let offers = 0;
	const fetcher: typeof fetch = async (url, init) => {
		calls.push({ url: String(url), auth: new Headers(init?.headers).get("Authorization") });
		if (String(url).endsWith("/offers")) return response({ offers: [{ id: "openai/example", quota_tokens: 10, hash: ++offers === 1 ? "old" : "fresh" }], need });
		return response({ model_id: "openai/example", offer_hash: "fresh", lease_id: "lease-1", expires_ms: Date.now() + 10_000 });
	};
	const admission = await admitJevLaunch({ config: { endpoint: "http://scheduler", authToken: "token" }, candidates: ["openai/example"], task: "review", fetcher });
	assert.deepEqual(admission && { model: admission.model, offerHash: admission.offerHash, leaseId: admission.leaseId }, { model: "openai/example", offerHash: "fresh", leaseId: "lease-1" });
	assert.deepEqual(admission?.evidence, { schema: "pi-subagents.jev_admission.v1", state: "admitted", model: "openai/example", offerHash: "fresh", offersRefreshed: 2, leaseConsumed: false });
	assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ["/offers", "/offers", "/lease"]);
	assert.deepEqual(calls.map((call) => call.auth), ["Bearer token", "Bearer token", "Bearer token"]);
});

test("Jev admission blocks changed models, unknown quota, and invalid leases", async () => {
	let offers = 0;
	const changed: typeof fetch = async (url) => String(url).endsWith("/offers")
		? response({ offers: [{ id: ++offers === 1 ? "openai/example" : "other/model", quota_tokens: 10, hash: "fresh" }], need })
		: response({});
	await assert.rejects(admitJevLaunch({ config: { endpoint: "http://scheduler" }, candidates: ["openai/example", "other/model"], task: "review", fetcher: changed }), /jev_proposal_changed_reselect_required/);
	const unknownQuota: typeof fetch = async () => response({ offers: [{ id: "openai/example", quota_tokens: null, hash: "none" }], need });
	await assert.rejects(admitJevLaunch({ config: { endpoint: "http://scheduler" }, candidates: ["openai/example"], task: "review", fetcher: unknownQuota }), /jev_no_admissible_proposal/);
	const invalidHash: typeof fetch = async () => response({ offers: [{ id: "openai/example", quota_tokens: 10, hash: { invalid: true } }], need });
	await assert.rejects(admitJevLaunch({ config: { endpoint: "http://scheduler" }, candidates: ["openai/example"], task: "review", fetcher: invalidHash }), /jev_no_admissible_proposal/);
	const expiredLease: typeof fetch = async (url) => String(url).endsWith("/offers")
		? response({ offers: [{ id: "openai/example", quota_tokens: 10, hash: "same" }], need })
		: response({ model_id: "openai/example", offer_hash: "wrong", lease_id: "", expires_ms: Date.now() - 1 });
	await assert.rejects(admitJevLaunch({ config: { endpoint: "http://scheduler" }, candidates: ["openai/example"], task: "review", fetcher: expiredLease }), /jev_lease_invalid/);
});

test("Jev dispatch atomically consumes its matching host lease once and never enters recovery", async () => {
	const admission = { model: "openai/example", offerHash: "offer", leaseId: "secret-token", expiresMs: 101 };
	let body: unknown;
	let consumeCalls = 0;
	let auth: string | null = null;
	await consumeJevDispatchAdmission({
		endpoint: "http://scheduler",
		admission,
		selectedModel: "openai/example",
		nowMs: 100,
		authToken: "token",
		fetcher: async (_url, init) => {
			consumeCalls++;
			auth = new Headers(init?.headers).get("Authorization");
			body = JSON.parse(String(init?.body));
			return response({ model_id: "openai/example", offer_hash: "offer", lease_id: "secret-token", expires_ms: 101 });
		},
	});
	assert.deepEqual(body, { lease_id: "secret-token", model_id: "openai/example", offer_hash: "offer" });
	await assert.rejects(
		consumeJevDispatchAdmission({ endpoint: "http://scheduler", admission, selectedModel: "openai/example", nowMs: 100, fetcher: async () => { throw new Error("same lease consumed twice"); } }),
		/jev_lease_already_consumed/,
	);
	assert.equal(consumeCalls, 1);
	assert.equal(jevAbortRecoveryAllowed(admission), false);
	assert.equal(JSON.stringify(admission).includes("leaseId"), true);
	assert.equal(JSON.stringify(admission.evidence).includes("secret-token"), false);
	assert.equal(auth, "Bearer token");
});

test("Jev dispatch blocks revoked, replaced, expired, and unavailable leases", async () => {
	const admission = { model: "openai/example", offerHash: "offer", leaseId: "secret-token", expiresMs: 101 };
	const rejected = async () => response({}, 409);
	await assert.rejects(consumeJevDispatchAdmission({ endpoint: "http://scheduler", admission, selectedModel: "openai/example", nowMs: 100, fetcher: rejected }), /jev_lease_consume_rejected/);
	const replaced = async () => response({ model_id: "other", offer_hash: "offer", lease_id: "secret-token", expires_ms: 101 });
	await assert.rejects(consumeJevDispatchAdmission({ endpoint: "http://scheduler", admission, selectedModel: "openai/example", nowMs: 100, fetcher: replaced }), /jev_lease_consume_invalid/);
	const unavailable = async () => { throw new Error("offline"); };
	await assert.rejects(consumeJevDispatchAdmission({ endpoint: "http://scheduler", admission, selectedModel: "openai/example", nowMs: 100, fetcher: unavailable }), /jev_lease_consume_failed/);
	await assert.rejects(consumeJevDispatchAdmission({ endpoint: "http://scheduler", admission, selectedModel: "other", nowMs: 100, fetcher: rejected }), /jev_dispatch_admission_invalid/);
	await assert.rejects(consumeJevDispatchAdmission({ endpoint: "http://scheduler", admission: { ...admission, expiresMs: 100 }, selectedModel: "openai/example", nowMs: 100, fetcher: rejected }), /jev_dispatch_admission_invalid/);
});

test("Jev admission blocks before the child provider is constructed", async () => {
	let providerConstructed = false;
	const result = await runChildSession({
		factory: { create: async () => { providerConstructed = true; throw new Error("must not construct"); } } as never,
		launch: {} as never,
		prompt: "Task: review",
		appendChildEvent: () => {},
		writeOutputLine: () => {},
		beforeDispatch: () => consumeJevDispatchAdmission({
			endpoint: "http://scheduler",
			admission: { model: "openai/example", offerHash: "offer", leaseId: "lease", expiresMs: 100 },
			selectedModel: "replaced-model",
			nowMs: 0,
		}),
	});
	assert.equal(providerConstructed, false);
	assert.equal(result.exitCode, 1);
	assert.match(result.error ?? "", /jev_dispatch_admission_invalid/);
});

test("Jev completion telemetry is best effort and does not retry", async () => {
	let calls = 0;
	await recordJevExecution("http://scheduler", { status: "done" }, async () => { calls++; throw new Error("offline"); });
	assert.equal(calls, 1);
});
