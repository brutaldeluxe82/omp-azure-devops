import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import {
	bunCommandRunner,
	parseAdoRemote,
	type AdoRepository,
	type CommandRunner,
} from "./ado-pr-protocol";

const LIST_LIMIT_DEFAULT = 30;
const LIST_LIMIT_MAX = 100;
const LOG_PAGE_SIZE = 2_000;

type BuildAction = "detail" | "timeline" | "log";

type ParsedUrl =
	| { kind: "list"; context?: AdoBuildContext; pipeline?: string; limit: number }
	| { kind: "build"; context?: AdoBuildContext; buildId: number; action: BuildAction; logId?: number; startLine?: number; endLine?: number };

interface AdoBuildContext {
	organization: string;
	project: string;
}

interface Build {
	id?: number;
	buildNumber?: string;
	status?: string;
	result?: string | null;
	queueTime?: string;
	startTime?: string;
	finishTime?: string;
	reason?: string;
	sourceBranch?: string;
	sourceVersion?: string;
	definition?: { id?: number; name?: string };
	repository?: { name?: string };
	requestedFor?: { displayName?: string; uniqueName?: string };
	url?: string;
}

interface Definition {
	id?: number;
	name?: string;
}

interface Timeline {
	records?: Array<{
		id?: string;
		type?: string;
		name?: string;
		state?: string;
		result?: string | null;
		log?: { id?: number };
	}>;
}

interface LogResponse {
	value?: string[];
}

function parsePositiveInt(value: string | undefined): number | undefined {
	if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function decodeSegment(value: string): string {
	try {
		const decoded = decodeURIComponent(value);
		if (!decoded || decoded === "." || decoded === ".." || decoded.includes("/")) throw new Error("unsafe segment");
		return decoded;
	} catch {
		throw new Error("Invalid ado-build:// URL: empty or unsafe path segment.");
	}
}

function parseLimit(url: InternalUrl): number {
	const raw = url.searchParams.get("limit");
	if (raw === null) return LIST_LIMIT_DEFAULT;
	const limit = parsePositiveInt(raw);
	if (limit === undefined) throw new Error(`Invalid ado-build:// list limit '${raw}'. Expected a positive integer (max ${LIST_LIMIT_MAX}).`);
	return Math.min(limit, LIST_LIMIT_MAX);
}

function parseLogRange(url: InternalUrl): { startLine: number; endLine: number } {
	const startLine = parsePositiveInt(url.searchParams.get("startLine") ?? undefined) ?? 1;
	const endLine = parsePositiveInt(url.searchParams.get("endLine") ?? undefined) ?? startLine + LOG_PAGE_SIZE - 1;
	if (endLine < startLine || endLine - startLine >= LOG_PAGE_SIZE) {
		throw new Error(`Invalid ado-build:// log range. Request at most ${LOG_PAGE_SIZE} lines with startLine and endLine.`);
	}
	return { startLine, endLine };
}

function contextFromRepository(repository: AdoRepository): AdoBuildContext {
	return { organization: repository.organization, project: repository.project };
}

/** Parse supported build, timeline, and log resource paths. */
export function parseAdoBuildUrl(url: InternalUrl): ParsedUrl {
	const host = url.rawHost || url.hostname;
	const rawPath = url.rawPathname ?? url.pathname;
	const stripped = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
	const parts = stripped === "" ? [] : stripped.split("/").map(decodeSegment);

	if (!host && parts.length === 0) return { kind: "list", limit: parseLimit(url) };
	if (host && parts.length === 0) {
		const buildId = parsePositiveInt(host);
		if (buildId === undefined) throw new Error("Invalid ado-build:// URL. Use ado-build://<build-id> or ado-build://<organization>/<project>[/<pipeline>|/<build-id>[/timeline|/logs/<log-id>]].");
		return { kind: "build", buildId, action: "detail" };
	}
	if (!host || parts.length < 1 || parts.length > 5) {
		throw new Error("Invalid ado-build:// URL. Use ado-build://<build-id> or ado-build://<organization>/<project>[/<pipeline>|/<build-id>[/timeline|/logs/<log-id>]].");
	}

	const context = { organization: decodeSegment(host), project: parts[0] };
	if (parts.length === 1) return { kind: "list", context, limit: parseLimit(url) };

	const secondAsBuildId = parsePositiveInt(parts[1]);
	const numericSecond = /^\d+$/.test(parts[1]);
	if (numericSecond && secondAsBuildId === undefined) {
		throw new Error(`Invalid ado-build:// build number '${parts[1]}'.`);
	}
	if (parts.length === 2) {
		if (secondAsBuildId !== undefined) return { kind: "build", context, buildId: secondAsBuildId, action: "detail" };
		return { kind: "list", context, pipeline: parts[1], limit: parseLimit(url) };
	}

	const hasPipeline = secondAsBuildId === undefined;
	const buildIndex = hasPipeline ? 2 : 1;
	const buildId = parsePositiveInt(parts[buildIndex]);
	if (buildId === undefined) throw new Error(`Invalid ado-build:// build number '${parts[buildIndex]}'.`);
	const actionIndex = buildIndex + 1;
	if (parts.length === actionIndex) return { kind: "build", context, buildId, action: "detail" };

	const action = parts[actionIndex];
	if (action === "timeline" && parts.length === actionIndex + 1) return { kind: "build", context, buildId, action: "timeline" };
	if (action === "logs" && parts.length === actionIndex + 2) {
		const logId = parsePositiveInt(parts[actionIndex + 1]);
		if (logId === undefined) throw new Error(`Invalid ado-build:// log number '${parts[actionIndex + 1]}'.`);
		return { kind: "build", context, buildId, action: "log", logId, ...parseLogRange(url) };
	}
	throw new Error("Invalid ado-build:// sub-path. Use /timeline or /logs/<log-id> after a build ID.");
}

function parseJson<T>(output: string, source: string): T {
	try {
		return JSON.parse(output) as T;
	} catch {
		throw new Error(`${source} returned invalid JSON.`);
	}
}

function displayBranch(branch: string | undefined): string {
	return branch?.replace(/^refs\/heads\//, "") ?? "?";
}

function buildUri(context: AdoBuildContext, buildId: number): string {
	return `ado-build://${context.organization}/${context.project}/${buildId}`;
}

/** A read-only InternalUrlRouter handler backed by Azure CLI build APIs. */
export class AdoBuildProtocolHandler implements ProtocolHandler {
	readonly scheme = "ado-build";
	readonly immutable = true;

	constructor(private readonly run: CommandRunner = bunCommandRunner) {}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const parsed = parseAdoBuildUrl(url);
		const buildContext = parsed.context ?? (await this.resolveDefaultContext(context));
		if (parsed.kind === "list") return this.list(buildContext, parsed.pipeline, parsed.limit, url, context?.signal);
		if (parsed.action === "detail") return this.detail(buildContext, parsed.buildId, url, context?.signal);
		if (parsed.action === "timeline") return this.timeline(buildContext, parsed.buildId, url, context?.signal);
		return this.log(buildContext, parsed.buildId, parsed.logId as number, parsed.startLine as number, parsed.endLine as number, url, context?.signal);
	}

	private async resolveDefaultContext(context?: ResolveContext): Promise<AdoBuildContext> {
		const result = await this.run("git", ["config", "--get", "remote.origin.url"], { cwd: context?.cwd, signal: context?.signal });
		if (result.code !== 0) {
			throw new Error("ado-build:// could not resolve a default Azure DevOps project. Use ado-build://<organization>/<project>/... outside an Azure DevOps checkout.");
		}
		const repository = parseAdoRemote(result.stdout.trim());
		if (!repository) {
			throw new Error("ado-build:// current origin is not an Azure DevOps remote. Use ado-build://<organization>/<project>/... outside an Azure DevOps checkout.");
		}
		return contextFromRepository(repository);
	}

	private async invokeAz(args: string[], signal?: AbortSignal): Promise<string> {
		const result = await this.run("az", args, { signal });
		if (result.code !== 0) {
			const detail = (result.stderr || result.stdout).trim();
			throw new Error(detail || "Azure CLI request failed. Authenticate with 'az login' and install the 'azure-devops' extension.");
		}
		return result.stdout;
	}

	private baseArgs(context: AdoBuildContext): string[] {
		return ["--org", `https://dev.azure.com/${context.organization}`, "--project", context.project];
	}

	private async resolveDefinitionId(context: AdoBuildContext, pipeline: string, signal?: AbortSignal): Promise<number> {
		const numeric = parsePositiveInt(pipeline);
		if (numeric !== undefined) return numeric;
		const definitions = parseJson<Definition[]>(
			await this.invokeAz(["pipelines", "build", "definition", "list", ...this.baseArgs(context), "--output", "json"], signal),
			"az pipelines build definition list",
		);
		const definition = definitions.find(candidate => candidate.name === pipeline);
		if (!definition?.id) throw new Error(`Azure DevOps pipeline '${pipeline}' was not found in ${context.organization}/${context.project}.`);
		return definition.id;
	}

	private async list(
		context: AdoBuildContext,
		pipeline: string | undefined,
		limit: number,
		url: InternalUrl,
		signal?: AbortSignal,
	): Promise<InternalResource> {
		const args = ["pipelines", "build", "list", ...this.baseArgs(context), "--top", String(limit), "--output", "json"];
		if (pipeline) args.push("--definition-ids", String(await this.resolveDefinitionId(context, pipeline, signal)));
		const builds = parseJson<Build[]>(await this.invokeAz(args, signal), "az pipelines build list");
		const heading = pipeline
			? `# Azure DevOps builds — ${context.organization}/${context.project}/${pipeline}`
			: `# Azure DevOps builds — ${context.organization}/${context.project}`;
		const entries = builds.map(build => {
			const id = build.id ?? "?";
			const state = build.result ?? build.status ?? "?";
			const definition = build.definition?.name ?? "?";
			const reference = typeof id === "number" ? buildUri(context, id) : `ado-build://${context.organization}/${context.project}`;
			return `- [${state}] #${id} ${build.buildNumber ?? "(no build number)"}\n  Pipeline: ${definition} · Branch: ${displayBranch(build.sourceBranch)}\n  ${reference}`;
		});
		return { url: url.href, content: `${heading}\n\n${entries.length === 0 ? "No builds." : entries.join("\n")}`, contentType: "text/markdown" };
	}

	private async detail(context: AdoBuildContext, buildId: number, url: InternalUrl, signal?: AbortSignal): Promise<InternalResource> {
		const build = parseJson<Build>(
			await this.invokeAz(["pipelines", "build", "show", "--id", String(buildId), ...this.baseArgs(context), "--output", "json"], signal),
			"az pipelines build show",
		);
		const canonical = buildUri(context, buildId);
		const requester = build.requestedFor?.displayName ?? build.requestedFor?.uniqueName ?? "?";
		return {
			url: url.href,
			content: [
				`# Build #${build.id ?? buildId}: ${build.buildNumber ?? "(no build number)"}`,
				"",
				`- **Pipeline:** ${build.definition?.name ?? "?"} (${build.definition?.id ?? "?"})`,
				`- **Status:** ${build.status ?? "?"}${build.result ? ` / ${build.result}` : ""}`,
				`- **Branch:** ${displayBranch(build.sourceBranch)}`,
				`- **Commit:** ${build.sourceVersion ?? "?"}`,
				`- **Requested by:** ${requester}`,
				`- **Queued:** ${build.queueTime ?? "?"}`,
				`- **Started:** ${build.startTime ?? "?"}`,
				`- **Finished:** ${build.finishTime ?? "?"}`,
				"",
				"## Resources",
				`- Timeline: ${canonical}/timeline`,
			].join("\n"),
			contentType: "text/markdown",
		};
	}

	private async timeline(context: AdoBuildContext, buildId: number, url: InternalUrl, signal?: AbortSignal): Promise<InternalResource> {
		const timeline = parseJson<Timeline>(
			await this.invokeAz([
				"devops", "invoke", "--area", "build", "--resource", "timeline",
				"--route-parameters", `project=${context.project}`, `buildId=${buildId}`,
				"--api-version", "7.1", "--http-method", "GET", "--org", `https://dev.azure.com/${context.organization}`,
			], signal),
			"Azure DevOps build timeline endpoint",
		);
		const records = (timeline.records ?? []).filter(record => ["Stage", "Job", "Task"].includes(record.type ?? ""));
		const canonical = buildUri(context, buildId);
		const entries = records.map(record => {
			const state = record.result ?? record.state ?? "?";
			const log = record.log?.id ? ` · Log: ${canonical}/logs/${record.log.id}` : "";
			return `- [${state}] ${record.type ?? "?"}: ${record.name ?? "?"}${log}`;
		});
		return { url: url.href, content: `# Build timeline — #${buildId}\n\n${entries.length === 0 ? "No stages, jobs, or tasks." : entries.join("\n")}`, contentType: "text/markdown" };
	}

	private async log(context: AdoBuildContext, buildId: number, logId: number, startLine: number, endLine: number, url: InternalUrl, signal?: AbortSignal): Promise<InternalResource> {
		const log = parseJson<LogResponse>(
			await this.invokeAz([
				"devops", "invoke", "--area", "build", "--resource", "logs",
				"--route-parameters", `project=${context.project}`, `buildId=${buildId}`, `logId=${logId}`,
				"--query-parameters", `startLine=${startLine}`, `endLine=${endLine}`,
				"--api-version", "7.1", "--http-method", "GET", "--org", `https://dev.azure.com/${context.organization}`,
			], signal),
			"Azure DevOps build log endpoint",
		);
		return { url: url.href, content: (log.value ?? []).join("\n"), contentType: "text/plain" };
	}
}
