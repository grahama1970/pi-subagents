import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { splitKnownThinkingSuffix } from "../../shared/model-info.ts";

const JEV_BINDING = "pi-subagents.jev-admission/1";
const SKILL_HASH = /^[a-f0-9]{64}$/;

/** Host-owned optional admission gate. Jev only proposes; this endpoint owns offers and leases. */
export interface JevAdmissionConfig { endpoint?: string; authToken?: string; }
export type JevAdmissionMode = "required" | "optional" | "disabled";
export interface JevAdmissionEvidence {
	schema: "pi-subagents.jev_admission.v1";
	state: "admitted" | "consumed" | "blocked";
	model?: string;
	offerHash?: string;
	offersRefreshed: number;
	leaseConsumed: boolean;
	reason?: string;
	selectedSkills?: Array<{ id: string; hash: string }>;
	mandatorySkillsRestored?: boolean;
}
export interface JevSkillCandidate { id: string; hash: string; mandatory?: boolean; }
export interface JevSkillPolicy { candidates: JevSkillCandidate[]; }
type Proposal = { model: string; offerHash: string; leaseModel?: string; skills?: Array<{ id: string; hash: string }>; mandatorySkillsRestored?: boolean };
export type JevLaunchAdmission = Proposal & { leaseId: string; expiresMs: number; evidence?: JevAdmissionEvidence };

const consumedAdmissions = new WeakSet<object>();

export function jevAbortRecoveryAllowed(admission: JevLaunchAdmission | undefined): boolean {
	return admission === undefined;
}
type Fetcher = typeof fetch;
type Offer = Record<string, unknown>;

const MAX_EVIDENCE_REASON_LENGTH = 160;

/** Per-workflow policy is explicit and namespaced; absence preserves optional legacy behavior. */
export function resolveJevAdmissionMode(bindings: unknown): JevAdmissionMode {
	if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) return "optional";
	const value = (bindings as Record<string, unknown>)[JEV_BINDING];
	if (!value || typeof value !== "object" || Array.isArray(value)) return "optional";
	const mode = (value as Record<string, unknown>).mode;
	if (mode === "required" || mode === "optional" || mode === "disabled") return mode;
	throw new Error("jev_admission_mode_invalid");
}

/** Reads the host-approved, hash-bound skill catalog carried by a workflow child. */
export function resolveJevSkillPolicy(bindings: unknown): JevSkillPolicy | undefined {
	if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) return undefined;
	const value = (bindings as Record<string, unknown>)[JEV_BINDING];
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = (value as Record<string, unknown>).skills;
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw) || raw.length > 32) throw new Error("jev_skill_catalog_invalid");
	const ids = new Set<string>();
	const candidates = raw.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("jev_skill_catalog_invalid");
		const { id, hash, mandatory } = item as Record<string, unknown>;
		if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || ids.has(id) || typeof hash !== "string" || !SKILL_HASH.test(hash) || (mandatory !== undefined && typeof mandatory !== "boolean")) throw new Error("jev_skill_catalog_invalid");
		ids.add(id);
		return { id, hash, ...(mandatory === true ? { mandatory: true } : {}) };
	});
	return { candidates };
}

export function validateJevSkillCatalogFiles(policy: JevSkillPolicy | undefined, systemPrompt: string | null | undefined): void {
	if (!policy) return;
	if (!systemPrompt) throw new Error("jev_skill_catalog_mismatch");
	const paths = new Map<string, string>();
	for (const match of systemPrompt.matchAll(/<skill>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<location>([^<]+)<\/location>[\s\S]*?<\/skill>/g)) paths.set(match[1]!.trim(), match[2]!.trim());
	for (const candidate of policy.candidates) {
		const path = paths.get(candidate.id);
		if (!path) throw new Error("jev_skill_catalog_mismatch");
		let actual: string;
		try { actual = createHash("sha256").update(readFileSync(path)).digest("hex"); }
		catch { throw new Error("jev_skill_catalog_mismatch"); }
		if (actual !== candidate.hash) throw new Error("jev_skill_catalog_mismatch");
	}
}

export function filterJevSkillPrompt(systemPrompt: string | null | undefined, selectedSkills: readonly string[]): string | null | undefined {
	if (!systemPrompt || !systemPrompt.includes("<available_skills>")) return systemPrompt;
	const selected = new Set(selectedSkills);
	return systemPrompt.replace(/(<available_skills>)([\s\S]*?)(<\/available_skills>)/g, (_block, open: string, body: string, close: string) => {
		const filtered = [...body.matchAll(/\s*<skill>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/skill>/g)]
			.filter((match) => selected.has(match[1]!.trim()))
			.map((match) => match[0])
			.join("");
		return `${open}${filtered}\n${close}`;
	});
}

export function validateJevSkillSelection(policy: JevSkillPolicy | undefined, selected: unknown): { skills?: Array<{ id: string; hash: string }>; mandatorySkillsRestored?: boolean } {
	if (!policy) return {};
	if (!Array.isArray(selected)) throw new Error("jev_skill_selection_invalid");
	const allowed = new Map(policy.candidates.map((skill) => [skill.id, skill]));
	const picked = new Map<string, { id: string; hash: string }>();
	for (const item of selected) {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("jev_skill_selection_invalid");
		const { id, hash } = item as Record<string, unknown>;
		const candidate = typeof id === "string" ? allowed.get(id) : undefined;
		if (!candidate || hash !== candidate.hash) throw new Error("jev_skill_selection_invalid");
		picked.set(candidate.id, { id: candidate.id, hash: candidate.hash });
	}
	for (const candidate of policy.candidates) if (candidate.mandatory) picked.set(candidate.id, { id: candidate.id, hash: candidate.hash });
	return { skills: [...picked.values()], mandatorySkillsRestored: policy.candidates.every((candidate) => !candidate.mandatory || picked.has(candidate.id)) };
}

function jevHeaders(authToken: string | undefined): Record<string, string> {
	return authToken ? { "Content-Type": "application/json", "Authorization": `Bearer ${authToken}` } : { "Content-Type": "application/json" };
}

function boundedReason(reason: string): string {
	const code = /^jev_[a-z0-9_]+$/i.exec(reason.trim())?.[0];
	return (code ?? "jev_admission_failed").slice(0, MAX_EVIDENCE_REASON_LENGTH);
}

export function jevAdmissionEvidence(input: {
	state: JevAdmissionEvidence["state"];
	model?: string;
	offerHash?: string;
	offersRefreshed?: number;
	leaseConsumed?: boolean;
	reason?: string;
	selectedSkills?: Array<{ id: string; hash: string }>;
	mandatorySkillsRestored?: boolean;
}): JevAdmissionEvidence {
	return {
		schema: "pi-subagents.jev_admission.v1",
		state: input.state,
		...(input.model ? { model: input.model } : {}),
		...(input.offerHash ? { offerHash: input.offerHash } : {}),
		offersRefreshed: Math.max(0, Math.min(2, Math.trunc(input.offersRefreshed ?? 0))),
		leaseConsumed: input.leaseConsumed === true,
		...(input.reason ? { reason: boundedReason(input.reason) } : {}),
		...(input.selectedSkills ? { selectedSkills: input.selectedSkills.map((skill) => ({ ...skill })) } : {}),
		...(input.mandatorySkillsRestored !== undefined ? { mandatorySkillsRestored: input.mandatorySkillsRestored } : {}),
	};
}

function offerModel(offer: Offer): string | undefined {
	for (const key of ["model_id", "model", "id"]) {
		if (typeof offer[key] === "string" && offer[key]) return offer[key] as string;
	}
	return undefined;
}

function offerHash(offer: Offer): string | undefined {
	for (const key of ["offer_hash", "hash"]) {
		if (typeof offer[key] === "string" && offer[key]) return offer[key] as string;
	}
	return undefined;
}

function knownQuota(offer: Offer): number | undefined {
	const quota = offer.quota_tokens;
	return typeof quota === "number" && Number.isFinite(quota) && quota >= 0 ? quota : undefined;
}

function isQualified(offer: Offer): boolean {
	for (const key of ["qualified", "eligible", "available"]) {
		if (offer[key] !== undefined && offer[key] !== true) return false;
	}
	if (offer.status !== undefined && offer.status !== "qualified" && offer.status !== "available" && offer.status !== "proposed") return false;
	return true;
}

function offerCost(offer: Offer): number {
	for (const key of ["cost", "cost_usd", "estimated_cost", "estimated_cost_usd", "total_cost", "unit_cost", "price", "price_usd"]) {
		const value = offer[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	}
	return Number.POSITIVE_INFINITY;
}

/** Native deterministic Jev selector: only qualified offers with known quota are admissible. */
export function chooseCheapestQualifiedModel(offers: unknown[], candidates: readonly string[]): Proposal {
	const allowed = new Set(candidates.map((candidate) => splitKnownThinkingSuffix(candidate).baseModel));
	const qualified = offers.flatMap((value, index) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return [];
		const offer = value as Offer;
		const model = offerModel(offer);
		const hash = offerHash(offer);
		if (!model || !hash || !allowed.has(model) || knownQuota(offer) === undefined || !isQualified(offer)) return [];
		return [{ model, offerHash: hash, cost: offerCost(offer), index }];
	});
	qualified.sort((left, right) => left.cost - right.cost || left.index - right.index);
	const selected = qualified[0];
	if (!selected) throw new Error("jev_no_admissible_proposal");
	return { model: selected.model, offerHash: selected.offerHash };
}

export async function recordJevExecution(endpoint: string | undefined, payload: Record<string, unknown>, fetcher: Fetcher = fetch, authToken?: string): Promise<void> {
	if (!endpoint) return;
	try {
		await fetcher(`${endpoint.replace(/\/$/, "")}/execution-runs`, { method: "POST", headers: jevHeaders(authToken), body: JSON.stringify(payload) });
	} catch { /* completion telemetry is non-authoritative and never retried */ }
}

async function proposalFromLiveOffers(input: { endpoint: string; candidates: readonly string[]; task: string; fetcher: Fetcher; authToken?: string; skillPolicy?: JevSkillPolicy }): Promise<Proposal> {
	const allowedCandidates = input.candidates.map((candidate) => splitKnownThinkingSuffix(candidate).baseModel);
	const response = await input.fetcher(`${input.endpoint.replace(/\/$/, "")}/offers`, {
		method: "POST",
		headers: jevHeaders(input.authToken),
		body: JSON.stringify({ candidates: allowedCandidates, task: input.task, ...(input.skillPolicy ? { skills: input.skillPolicy.candidates } : {}) }),
	});
	if (!response.ok) throw new Error(`jev_offers_http_${response.status}`);
	const payload = await response.json() as { offers?: unknown[]; need?: unknown; selected_skills?: unknown };
	if (!Array.isArray(payload.offers) || !payload.need || typeof payload.need !== "object") throw new Error("jev_offers_invalid");
	const proposal = chooseCheapestQualifiedModel(payload.offers, input.candidates);
	const selectedOffer = payload.offers.find((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const offer = value as Offer;
		return offerModel(offer) === proposal.model && offerHash(offer) === proposal.offerHash && knownQuota(offer) !== undefined && isQualified(offer);
	});
	const launchModel = input.candidates.find((candidate) => splitKnownThinkingSuffix(candidate).baseModel === proposal.model);
	if (!launchModel || !selectedOffer) throw new Error("jev_no_admissible_proposal");
	const skillSelection = validateJevSkillSelection(input.skillPolicy, payload.selected_skills);
	return { model: launchModel, offerHash: proposal.offerHash, leaseModel: proposal.model, ...skillSelection };
}

/** Fetches a second authoritative snapshot immediately before the host lease. */
export async function admitJevLaunch(input: {
	config: JevAdmissionConfig | undefined;
	candidates: readonly string[];
	task: string;
	nowMs?: number;
	fetcher?: Fetcher;
	skillPolicy?: JevSkillPolicy;
}): Promise<JevLaunchAdmission | undefined> {
	const config = input.config;
	const endpoint = config?.endpoint;
	if (!endpoint) return undefined;
	const fetcher = input.fetcher ?? fetch;
	const proposalInput = { endpoint, candidates: input.candidates, task: input.task, fetcher, authToken: config.authToken, skillPolicy: input.skillPolicy };
	const initial = await proposalFromLiveOffers(proposalInput);
	const refreshed = await proposalFromLiveOffers(proposalInput);
	if (initial.model !== refreshed.model || initial.leaseModel !== refreshed.leaseModel || JSON.stringify(initial.skills) !== JSON.stringify(refreshed.skills)) throw new Error("jev_proposal_changed_reselect_required");
	const nowMs = input.nowMs ?? Date.now();
	const leaseResponse = await fetcher(`${endpoint.replace(/\/$/, "")}/lease`, {
		method: "POST", headers: jevHeaders(config.authToken), body: JSON.stringify({ model_id: refreshed.leaseModel ?? refreshed.model, offer_hash: refreshed.offerHash }),
	});
	if (!leaseResponse.ok) throw new Error(`jev_lease_http_${leaseResponse.status}`);
	const lease = await leaseResponse.json() as { model_id?: unknown; offer_hash?: unknown; lease_id?: unknown; expires_ms?: unknown };
	if (lease.model_id !== (refreshed.leaseModel ?? refreshed.model) || lease.offer_hash !== refreshed.offerHash || typeof lease.lease_id !== "string" || !lease.lease_id || typeof lease.expires_ms !== "number" || !Number.isInteger(lease.expires_ms) || lease.expires_ms <= nowMs) throw new Error("jev_lease_invalid");
	return {
		...refreshed,
		leaseId: lease.lease_id,
		expiresMs: lease.expires_ms,
		evidence: jevAdmissionEvidence({ state: "admitted", model: refreshed.model, offerHash: refreshed.offerHash, offersRefreshed: 2, selectedSkills: refreshed.skills, mandatorySkillsRestored: refreshed.mandatorySkillsRestored }),
	};
}

/** Atomically validates and consumes the opaque host lease before provider construction. */
export async function consumeJevDispatchAdmission(input: {
	endpoint: string;
	admission: JevLaunchAdmission;
	selectedModel: unknown;
	nowMs?: number;
	fetcher?: Fetcher;
	authToken?: string;
}): Promise<void> {
	const nowMs = input.nowMs ?? Date.now();
	const { admission } = input;
	if (input.selectedModel !== admission.model || !admission.offerHash || !admission.leaseId || !Number.isInteger(admission.expiresMs)) throw new Error("jev_dispatch_admission_invalid");
	if (consumedAdmissions.has(admission)) throw new Error("jev_lease_already_consumed");
	if (admission.expiresMs <= nowMs) throw new Error("jev_dispatch_admission_invalid");
	let response: Response;
	try {
		response = await (input.fetcher ?? fetch)(`${input.endpoint.replace(/\/$/, "")}/lease/consume`, {
			method: "POST", headers: jevHeaders(input.authToken), body: JSON.stringify({ lease_id: admission.leaseId, model_id: admission.leaseModel ?? admission.model, offer_hash: admission.offerHash }),
		});
	} catch {
		throw new Error("jev_lease_consume_failed");
	}
	if (!response.ok) throw new Error("jev_lease_consume_rejected");
	let consumed: { model_id?: unknown; offer_hash?: unknown; lease_id?: unknown; expires_ms?: unknown };
	try {
		consumed = await response.json() as { model_id?: unknown; offer_hash?: unknown; lease_id?: unknown; expires_ms?: unknown };
	} catch {
		throw new Error("jev_lease_consume_invalid");
	}
	if (consumed.model_id !== (admission.leaseModel ?? admission.model) || consumed.offer_hash !== admission.offerHash || consumed.lease_id !== admission.leaseId || typeof consumed.expires_ms !== "number" || !Number.isInteger(consumed.expires_ms) || consumed.expires_ms <= nowMs) throw new Error("jev_lease_consume_invalid");
	consumedAdmissions.add(admission);
	admission.evidence = jevAdmissionEvidence({ state: "consumed", model: admission.model, offerHash: admission.offerHash, offersRefreshed: admission.evidence?.offersRefreshed ?? 0, leaseConsumed: true, selectedSkills: admission.skills, mandatorySkillsRestored: admission.mandatorySkillsRestored });
}
