import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
} from "@oh-my-pi/pi-coding-agent/internal-urls";

const LIST_LIMIT_DEFAULT = 30;
const LIST_LIMIT_MAX = 100;
const CHANGE_PAGE_SIZE = 1_000;
const CHANGE_PAGE_MAX = 10;

export interface AdoRepository {
	organization: string;
	project: string;
	repository: string;
}

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type CommandRunner = (
	command: string,
	args: readonly string[],
	options: { cwd?: string; signal?: AbortSignal },
) => Promise<CommandResult>;

type ParsedUrl =
	| { kind: "list"; repository?: AdoRepository; limit: number }
	| { kind: "single"; repository?: AdoRepository; pullRequestId: number }
	| { kind: "changes"; repository?: AdoRepository; pullRequestId: number };

interface PullRequest {
	pullRequestId?: number;
	title?: string;
	status?: string;
	isDraft?: boolean;
	creationDate?: string;
	closedDate?: string;
	createdBy?: { displayName?: string; uniqueName?: string };
	sourceRefName?: string;
	targetRefName?: string;
	url?: string;
	repository?: { name?: string; project?: { name?: string } };
}

interface IterationsResponse {
	value?: Array<{ id?: number }>;
}

interface ChangesResponse {
	changeEntries?: Array<{
		changeId?: number;
		changeType?: string;
		item?: { path?: string };
	}>;
	nextSkip?: number | null;
}

function displayRef(ref: string | undefined): string {
	return ref?.replace(/^refs\/heads\//, "") ?? "?";
}

function parsePositiveInt(value: string | undefined): number | undefined {
	if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function decodeSegment(value: string, scheme: string): string {
	try {
		const decoded = decodeURIComponent(value);
		if (!decoded || decoded === "." || decoded === ".." || decoded.includes("/")) {
			throw new Error("unsafe path segment");
		}
		return decoded;
	} catch {
		throw new Error(`Invalid ${scheme}:// URL: empty or unsafe path segment.`);
	}
}

function parseLimit(url: InternalUrl): number {
	const raw = url.searchParams.get("limit");
	if (raw === null) return LIST_LIMIT_DEFAULT;
	const parsed = parsePositiveInt(raw);
	if (parsed === undefined) {
		throw new Error(`Invalid ado-pr:// list limit '${raw}'. Expected a positive integer (max ${LIST_LIMIT_MAX}).`);
	}
	return Math.min(parsed, LIST_LIMIT_MAX);
}

/** Parse the supported read-only ado-pr:// URI shapes. */
export function parseAdoPrUrl(url: InternalUrl): ParsedUrl {
	const scheme = "ado-pr";
	const host = url.rawHost || url.hostname;
	const rawPath = url.rawPathname ?? url.pathname;
	const stripped = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
	const parts = stripped === "" ? [] : stripped.split("/").map(part => decodeSegment(part, scheme));

	// ado-pr:// and ado-pr://123 resolve the repository from the caller's cwd.
	if (!host && parts.length === 0) return { kind: "list", limit: parseLimit(url) };
	if (host && parts.length === 0) {
		const pullRequestId = parsePositiveInt(host);
		if (pullRequestId === undefined) {
			throw new Error("Invalid ado-pr:// URL. Use ado-pr://<number> or ado-pr://<organization>/<project>/<repository>[/<number>[/changes]].");
		}
		return { kind: "single", pullRequestId };
	}

	// Fully-qualified paths avoid ambiguity across Azure DevOps organizations.
	if (!host || parts.length < 2 || parts.length > 4) {
		throw new Error("Invalid ado-pr:// URL. Use ado-pr://<number> or ado-pr://<organization>/<project>/<repository>[/<number>[/changes]].");
	}
	const repository = { organization: decodeSegment(host, scheme), project: parts[0], repository: parts[1] };
	if (parts.length === 2) return { kind: "list", repository, limit: parseLimit(url) };
	const pullRequestId = parsePositiveInt(parts[2]);
	if (pullRequestId === undefined) throw new Error(`Invalid ado-pr:// pull request number '${parts[2]}'.`);
	if (parts.length === 3) return { kind: "single", repository, pullRequestId };
	if (parts[3] !== "changes") {
		throw new Error("Invalid ado-pr:// sub-path. Use ado-pr://<organization>/<project>/<repository>/<number>/changes.");
	}
	return { kind: "changes", repository, pullRequestId };
}

/** Derive an Azure DevOps repository identity from HTTPS or SSH origin URLs. */
export function parseAdoRemote(remote: string): AdoRepository | undefined {
	const ssh = remote.match(/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
	if (ssh) return { organization: ssh[1], project: ssh[2], repository: ssh[3] };
	const https = remote.match(/^https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/i);
	if (https) return { organization: https[1], project: https[2], repository: https[3] };
	return undefined;
}

export async function bunCommandRunner(
	command: string,
	args: readonly string[],
	options: { cwd?: string; signal?: AbortSignal },
): Promise<CommandResult> {
	const process = Bun.spawn([command, ...args], {
		cwd: options.cwd,
		stdout: "pipe",
		stderr: "pipe",
		signal: options.signal,
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	return { code, stdout, stderr };
}

function renderReference(repository: AdoRepository, pullRequestId: number): string {
	return `ado-pr://${repository.organization}/${repository.project}/${repository.repository}/${pullRequestId}`;
}

function parseJson<T>(output: string, source: string): T {
	try {
		return JSON.parse(output) as T;
	} catch {
		throw new Error(`${source} returned invalid JSON.`);
	}
}

/** A read-only InternalUrlRouter handler backed by Azure CLI's authenticated REST client. */
export class AdoPrProtocolHandler implements ProtocolHandler {
	readonly scheme = "ado-pr";
	readonly immutable = true;

	constructor(private readonly run: CommandRunner = bunCommandRunner) {}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const parsed = parseAdoPrUrl(url);
		const repository = parsed.repository ?? (await this.resolveDefaultRepository(context));
		switch (parsed.kind) {
			case "list":
				return this.list(repository, parsed.limit, url);
			case "single":
				return this.single(repository, parsed.pullRequestId, url, context?.signal);
			case "changes":
				return this.changes(repository, parsed.pullRequestId, url, context?.signal);
		}
	}

	private async resolveDefaultRepository(context?: ResolveContext): Promise<AdoRepository> {
		const result = await this.run("git", ["config", "--get", "remote.origin.url"], {
			cwd: context?.cwd,
			signal: context?.signal,
		});
		if (result.code !== 0) {
			throw new Error("ado-pr:// could not resolve a default Azure DevOps repository. Use a fully-qualified ado-pr://<organization>/<project>/<repository>/... URI.");
		}
		const repository = parseAdoRemote(result.stdout.trim());
		if (!repository) {
			throw new Error("ado-pr:// current origin is not an Azure DevOps remote. Use a fully-qualified ado-pr://<organization>/<project>/<repository>/... URI.");
		}
		return repository;
	}

	private async invokeAz(
		args: string[],
		repository: AdoRepository,
		signal?: AbortSignal,
	): Promise<string> {
		const result = await this.run("az", args, { signal });
		if (result.code !== 0) {
			const detail = (result.stderr || result.stdout).trim();
			throw new Error(detail || "Azure CLI request failed. Authenticate with 'az login' and install the 'azure-devops' extension.");
		}
		return result.stdout;
	}

	private async list(repository: AdoRepository, limit: number, url: InternalUrl): Promise<InternalResource> {
		const output = await this.invokeAz(
			[
				"repos", "pr", "list", "--org", `https://dev.azure.com/${repository.organization}`,
				"--project", repository.project, "--repository", repository.repository,
				"--status", "active", "--top", String(limit), "--output", "json",
			],
			repository,
		);
		const pullRequests = parseJson<PullRequest[]>(output, "az repos pr list");
		const heading = `# Azure DevOps pull requests — ${repository.organization}/${repository.project}/${repository.repository}`;
		const entries = pullRequests.map(pr => {
			const id = pr.pullRequestId ?? "?";
			const state = pr.status?.toLowerCase() ?? "?";
			const draft = pr.isDraft ? " [draft]" : "";
			const author = pr.createdBy?.displayName ?? pr.createdBy?.uniqueName ?? "?";
			const reference = typeof id === "number" ? renderReference(repository, id) : `ado-pr://${repository.organization}/${repository.project}/${repository.repository}`;
			return `- [${state}${draft}] #${id} @${author}\n  ${pr.title ?? "(no title)"}\n  ${reference}`;
		});
		return {
			url: url.href,
			content: `${heading}\n\n${entries.length === 0 ? "No active pull requests." : entries.join("\n")}`,
			contentType: "text/markdown",
		};
	}

	private async single(
		repository: AdoRepository,
		pullRequestId: number,
		url: InternalUrl,
		signal?: AbortSignal,
	): Promise<InternalResource> {
		const output = await this.invokeAz(
			[
				"repos", "pr", "show", "--id", String(pullRequestId),
				"--org", `https://dev.azure.com/${repository.organization}`, "--output", "json",
			],
			repository,
			signal,
		);
		const pr = parseJson<PullRequest>(output, "az repos pr show");
		const canonical = renderReference(repository, pullRequestId);
		const author = pr.createdBy?.displayName ?? pr.createdBy?.uniqueName ?? "?";
		const lines = [
			`# PR #${pr.pullRequestId ?? pullRequestId}: ${pr.title ?? "(no title)"}`,
			"",
			`- **Repository:** ${repository.organization}/${repository.project}/${repository.repository}`,
			`- **Status:** ${pr.status ?? "?"}${pr.isDraft ? " (draft)" : ""}`,
			`- **Author:** ${author}`,
			`- **Branches:** ${displayRef(pr.sourceRefName)} → ${displayRef(pr.targetRefName)}`,
			`- **Created:** ${pr.creationDate ?? "?"}`,
			`- **Azure DevOps:** ${pr.url ?? "?"}`,
			"",
			"## Resources",
			`- Changed files: ${canonical}/changes`,
		];
		return { url: url.href, content: lines.join("\n"), contentType: "text/markdown" };
	}

	private async changes(
		repository: AdoRepository,
		pullRequestId: number,
		url: InternalUrl,
		signal?: AbortSignal,
	): Promise<InternalResource> {
		const baseArgs = [
			"devops", "invoke", "--area", "git", "--org", `https://dev.azure.com/${repository.organization}`,
			"--api-version", "7.1", "--http-method", "GET",
		];
		const iterations = parseJson<IterationsResponse>(
			await this.invokeAz(
				[...baseArgs, "--resource", "pullRequestIterations", "--route-parameters", `project=${repository.project}`, `repositoryId=${repository.repository}`, `pullRequestId=${pullRequestId}`],
				repository,
				signal,
			),
			"Azure DevOps pull-request iterations endpoint",
		);
		const iterationId = iterations.value?.at(-1)?.id;
		if (!iterationId) throw new Error(`Azure DevOps returned no iterations for pull request #${pullRequestId}.`);

		const changes: NonNullable<ChangesResponse["changeEntries"]> = [];
		let skip = 0;
		for (let page = 0; page < CHANGE_PAGE_MAX; page += 1) {
			const response = parseJson<ChangesResponse>(
				await this.invokeAz(
					[
						...baseArgs, "--resource", "pullRequestIterationChanges", "--route-parameters",
						`project=${repository.project}`, `repositoryId=${repository.repository}`,
						`pullRequestId=${pullRequestId}`, `iterationId=${iterationId}`,
						"--query-parameters", `$top=${CHANGE_PAGE_SIZE}`, `$skip=${skip}`,
					],
					repository,
					signal,
				),
				"Azure DevOps pull-request changes endpoint",
			);
			changes.push(...(response.changeEntries ?? []));
			if (response.nextSkip === null || response.nextSkip === undefined) break;
			skip = response.nextSkip;
			if (page === CHANGE_PAGE_MAX - 1) throw new Error(`Changed-file list exceeds ${CHANGE_PAGE_MAX * CHANGE_PAGE_SIZE} entries.`);
		}
		const canonical = renderReference(repository, pullRequestId);
		const entries = changes.map(change => `- [${change.changeType ?? "?"}] ${change.item?.path ?? "?"}`);
		return {
			url: url.href,
			content: `# Changed files — PR #${pullRequestId}\n\n${entries.length === 0 ? "No changed files." : entries.join("\n")}\n\nSource: ${canonical}`,
			contentType: "text/markdown",
		};
	}
}
