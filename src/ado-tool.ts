import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseAdoRemote, type AdoRepository, type CommandRunner, bunCommandRunner } from "./ado-pr-protocol";

export const ADO_TOOL_OPS = [
	"pr_create",
	"pr_update",
	"pr_vote",
	"pr_abandon",
	"pr_set_auto_complete",
	"pr_complete",
	"pr_thread_create",
	"pr_thread_reply",
	"pr_thread_update_status",
	"repo_create",
	"repo_update",
	"repo_delete",
	"code_search",
] as const;

export type AdoToolOp = (typeof ADO_TOOL_OPS)[number];

export interface AdoToolInput {
	op: AdoToolOp;
	organization?: string;
	project?: string;
	repository?: string;
	pullRequestId?: number;
	title?: string;
	description?: string;
	sourceBranch?: string;
	targetBranch?: string;
	draft?: boolean;
	reviewers?: string[];
	optionalReviewers?: string[];
	vote?: "approve" | "approve-with-suggestions" | "reject" | "reset" | "wait-for-author";
	autoComplete?: boolean;
	deleteSourceBranch?: boolean;
	mergeCommitMessage?: string;
	bypassPolicy?: boolean;
	bypassPolicyReason?: string;
	threadId?: number;
	parentCommentId?: number;
	comment?: string;
	threadStatus?: "active" | "fixed" | "wontFix" | "closed" | "byDesign" | "pending";
	name?: string;
	defaultBranch?: string;
	query?: string;
	path?: string;
	branch?: string;
	limit?: number;
	skip?: number;
	confirm?: boolean;
}

export interface AdoToolResult {
	content: string;
	details: {
		op: AdoToolOp;
		organization: string;
		project: string;
		repository?: string;
	};
}

export interface CodeSearchRequest {
	organization: string;
	project: string;
	query: string;
	repository?: string;
	path?: string;
	branch?: string;
	limit: number;
	skip: number;
}

export interface CodeSearchResponse {
	count?: number;
	results?: Array<{
		path?: string;
		repository?: { name?: string };
		versions?: Array<{ branchName?: string }>;
	}>;
}

export type CodeSearchRunner = (request: CodeSearchRequest, signal?: AbortSignal) => Promise<CodeSearchResponse>;

interface AdoContext {
	organization: string;
	project: string;
	repository?: string;
}

interface SpawnedProcess {
	exited: Promise<number>;
	stdout: ReadableStream<Uint8Array> | null;
	stderr: ReadableStream<Uint8Array> | null;
}

const CODE_SEARCH_LIMIT_DEFAULT = 100;
const CODE_SEARCH_LIMIT_MAX = 1_000;


const THREAD_STATUS_CODES = {
	active: 1,
	fixed: 2,
	wontFix: 3,
	closed: 4,
	byDesign: 5,
	pending: 6,
} as const;

type ThreadMutationOp = "pr_thread_create" | "pr_thread_reply" | "pr_thread_update_status";

function isThreadMutation(op: AdoToolOp): op is ThreadMutationOp {
	return op === "pr_thread_create" || op === "pr_thread_reply" || op === "pr_thread_update_status";
}
const CODE_SEARCH_SCRIPT = String.raw`
import json
import os
import sys
from azext_devops.dev.common.services import _get_credentials

request = json.loads(os.environ["OMP_ADO_CODE_SEARCH_REQUEST"])
credentials = _get_credentials(f"https://dev.azure.com/{request['organization']}")
session = credentials.signed_session()
url = f"https://almsearch.dev.azure.com/{request['organization']}/{request['project']}/_apis/search/codesearchresults?api-version=7.1"
payload = {"searchText": request["query"], "$top": request["limit"], "$skip": request["skip"], "includeSnippet": False}
filters = {}
if request.get("repository"):
    filters["Repository"] = [request["repository"]]
if request.get("path"):
    filters["Path"] = [request["path"]]
if request.get("branch"):
    filters["Branch"] = [request["branch"]]
if filters:
    payload["filters"] = filters
response = session.post(url, json=payload, headers={"Content-Type": "application/json"})
if response.status_code != 200:
    print(f"HTTP {response.status_code}: {response.text[:500]}", file=sys.stderr)
    sys.exit(1)
print(json.dumps(response.json()))
`;

function parseJson<T>(value: string, source: string): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		throw new Error(`${source} returned invalid JSON.`);
	}
}

function requireNonBlank(value: string | undefined, name: string): string {
	if (!value?.trim()) throw new Error(`${name} is required for this Azure DevOps operation.`);
	return value.trim();
}

function positiveInteger(value: number | undefined, name: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${name} must be a positive integer.`);
	return value as number;
}

function resolveLimit(value: number | undefined): number {
	if (value === undefined) return CODE_SEARCH_LIMIT_DEFAULT;
	if (!Number.isSafeInteger(value) || value < 1) throw new Error("limit must be a positive integer.");
	return Math.min(value, CODE_SEARCH_LIMIT_MAX);
}

function resolveSkip(value: number | undefined): number {
	if (value === undefined) return 0;
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("skip must be a non-negative integer.");
	return value;
}

function addString(args: string[], flag: string, value: string | undefined): void {
	if (value?.trim()) args.push(flag, value.trim());
}

function addBoolean(args: string[], flag: string, value: boolean | undefined): void {
	if (value !== undefined) args.push(flag, String(value));
}

async function readChildOutput(process: SpawnedProcess): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

/** Execute Azure DevOps Code Search using the Azure CLI extension's signed session. */
export const bunCodeSearchRunner: CodeSearchRunner = async (request, signal) => {
	const azPath = Bun.which("az");
	if (!azPath) throw new Error("Azure CLI was not found. Install Azure CLI and its azure-devops extension.");
	const launcher = await Bun.file(azPath).text();
	const interpreter = launcher.match(/^#!([^\n]+)$/m)?.[1]?.trim();
	if (!interpreter) throw new Error("Unable to identify the Azure CLI Python runtime for Code Search.");

	const extensionProcess = Bun.spawn([azPath, "extension", "show", "--name", "azure-devops", "--query", "path", "--output", "tsv"], {
		stdout: "pipe",
		stderr: "pipe",
		signal,
	});
	const extension = await readChildOutput(extensionProcess);
	if (extension.exitCode !== 0 || !extension.stdout.trim()) {
		throw new Error(extension.stderr.trim() || "Azure DevOps CLI extension is required for Code Search.");
	}

	const cliSitePackages = join(dirname(azPath), "src");
	const pythonPath = [cliSitePackages, extension.stdout.trim(), process.env.PYTHONPATH].filter(Boolean).join(":");
	const searchProcess = Bun.spawn([interpreter, "-c", CODE_SEARCH_SCRIPT], {
		env: { ...process.env, PYTHONPATH: pythonPath, OMP_ADO_CODE_SEARCH_REQUEST: JSON.stringify(request) },
		stdout: "pipe",
		stderr: "pipe",
		signal,
	});
	const output = await readChildOutput(searchProcess);
	if (output.exitCode !== 0) throw new Error(output.stderr.trim() || output.stdout.trim() || "Azure DevOps Code Search failed.");
	return parseJson<CodeSearchResponse>(output.stdout, "Azure DevOps Code Search");
};

/** One operation-dispatched mutation and Code Search surface for Azure DevOps. */
export class AdoToolDispatcher {
	constructor(
		private readonly run: CommandRunner = bunCommandRunner,
		private readonly searchCode: CodeSearchRunner = bunCodeSearchRunner,
	) {}

	async execute(input: AdoToolInput, cwd?: string, signal?: AbortSignal): Promise<AdoToolResult> {
		const requiresRepository = input.op !== "repo_create" && input.op !== "code_search";
		const context = await this.resolveContext(input, requiresRepository, cwd, signal);
		if (input.op === "code_search") return this.codeSearch(input, context, signal);
		if (isThreadMutation(input.op)) return this.mutateThread(input, context, cwd, signal);
		const args = this.operationArgs(input, context);
		const result = await this.run("az", args, { cwd, signal });
		if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Azure DevOps ${input.op} failed.`);
		return {
			content: this.successMessage(input.op, result.stdout),
			details: { op: input.op, organization: context.organization, project: context.project, repository: context.repository },
		};
	}

	private async resolveContext(input: AdoToolInput, requiresRepository: boolean, cwd?: string, signal?: AbortSignal): Promise<AdoContext> {
		if (input.organization?.trim() && input.project?.trim()) {
			const context: AdoContext = { organization: input.organization.trim(), project: input.project.trim(), repository: input.repository?.trim() };
			if (requiresRepository) context.repository = requireNonBlank(context.repository, "repository");
			return context;
		}
		const remote = await this.run("git", ["config", "--get", "remote.origin.url"], { cwd, signal });
		if (remote.code !== 0) throw new Error("Azure DevOps organization and project are required outside an Azure DevOps checkout.");
		const repository = parseAdoRemote(remote.stdout.trim());
		if (!repository) throw new Error("Current origin is not an Azure DevOps remote. Provide organization and project explicitly.");
		return this.contextFromRemote(repository, input.repository, requiresRepository);
	}

	private contextFromRemote(remote: AdoRepository, requestedRepository: string | undefined, requiresRepository: boolean): AdoContext {
		const context: AdoContext = { organization: remote.organization, project: remote.project, repository: requestedRepository?.trim() || remote.repository };
		if (requiresRepository) context.repository = requireNonBlank(context.repository, "repository");
		return context;
	}

	private baseArgs(context: AdoContext): string[] {
		return ["--org", `https://dev.azure.com/${context.organization}`, "--project", context.project, "--output", "json"];
	}

	private operationArgs(input: AdoToolInput, context: AdoContext): string[] {
		const base = this.baseArgs(context);
		switch (input.op) {
			case "pr_create": {
				const args = ["repos", "pr", "create", "--repository", requireNonBlank(context.repository, "repository"), "--source-branch", requireNonBlank(input.sourceBranch, "sourceBranch"), "--title", requireNonBlank(input.title, "title"), "--squash", "true", ...base];
				addString(args, "--target-branch", input.targetBranch);
				addString(args, "--description", input.description);
				addBoolean(args, "--draft", input.draft);
				if (input.reviewers?.length) args.push("--required-reviewers", ...input.reviewers);
				if (input.optionalReviewers?.length) args.push("--optional-reviewers", ...input.optionalReviewers);
				return args;
			}
			case "pr_update": {
				const args = ["repos", "pr", "update", "--id", String(positiveInteger(input.pullRequestId, "pullRequestId")), ...base];
				if (input.title === undefined && input.description === undefined && input.draft === undefined) throw new Error("pr_update requires title, description, or draft.");
				addString(args, "--title", input.title);
				addString(args, "--description", input.description);
				addBoolean(args, "--draft", input.draft);
				return args;
			}
			case "pr_set_auto_complete":
				if (input.autoComplete === undefined) throw new Error("pr_set_auto_complete requires autoComplete.");
				return ["repos", "pr", "update", "--id", String(positiveInteger(input.pullRequestId, "pullRequestId")), "--auto-complete", String(input.autoComplete), ...base];
			case "pr_vote":
				return ["repos", "pr", "set-vote", "--id", String(positiveInteger(input.pullRequestId, "pullRequestId")), "--vote", requireNonBlank(input.vote, "vote"), ...base];
			case "pr_abandon":
				return ["repos", "pr", "update", "--id", String(positiveInteger(input.pullRequestId, "pullRequestId")), "--status", "abandoned", ...base];
			case "pr_complete": {
				if (input.confirm !== true) throw new Error("pr_complete requires confirm: true.");
				if (input.bypassPolicy && !input.bypassPolicyReason?.trim()) throw new Error("bypassPolicyReason is required when bypassPolicy is true.");
				const args = ["repos", "pr", "update", "--id", String(positiveInteger(input.pullRequestId, "pullRequestId")), "--status", "completed", "--squash", "true", ...base];
				addBoolean(args, "--delete-source-branch", input.deleteSourceBranch);
				addString(args, "--merge-commit-message", input.mergeCommitMessage);
				addBoolean(args, "--bypass-policy", input.bypassPolicy);
				addString(args, "--bypass-policy-reason", input.bypassPolicyReason);
				return args;
			}
			case "pr_thread_create":
			case "pr_thread_reply":
			case "pr_thread_update_status":
				throw new Error("PR thread mutations are dispatched through Azure DevOps REST.");
			case "repo_create":
				return ["repos", "create", "--name", requireNonBlank(input.name, "name"), ...base];
			case "repo_update": {
				if (!input.name?.trim() && !input.defaultBranch?.trim()) throw new Error("repo_update requires name or defaultBranch.");
				const args = ["repos", "update", "--repository", requireNonBlank(context.repository, "repository"), ...base];
				addString(args, "--name", input.name);
				addString(args, "--default-branch", input.defaultBranch);
				return args;
			}
			case "repo_delete":
				if (input.confirm !== true) throw new Error("repo_delete requires confirm: true.");
				return ["repos", "delete", "--id", requireNonBlank(context.repository, "repository"), "--yes", ...base];
			case "code_search":
				throw new Error("code_search does not invoke Azure CLI repository operations.");
		}
	}

	private async mutateThread(
		input: AdoToolInput,
		context: AdoContext,
		cwd?: string,
		signal?: AbortSignal,
	): Promise<AdoToolResult> {
		const pullRequestId = positiveInteger(input.pullRequestId, "pullRequestId");
		const threadId = input.op === "pr_thread_create" ? undefined : positiveInteger(input.threadId, "threadId");
		const bodyPath = join(tmpdir(), `omp-azure-devops-${crypto.randomUUID()}.json`);
		await Bun.write(bodyPath, JSON.stringify(this.threadBody(input)));
		try {
			const resource = input.op === "pr_thread_reply" ? "pullRequestThreadComments" : "pullRequestThreads";
			const routeParameters = [
				`project=${context.project}`,
				`repositoryId=${requireNonBlank(context.repository, "repository")}`,
				`pullRequestId=${pullRequestId}`,
				...(threadId === undefined ? [] : [`threadId=${threadId}`]),
			];
			const result = await this.run("az", [
				"devops", "invoke", "--area", "git", "--resource", resource,
				"--org", `https://dev.azure.com/${context.organization}`, "--api-version", "7.1",
				"--http-method", input.op === "pr_thread_update_status" ? "PATCH" : "POST",
				"--route-parameters", ...routeParameters, "--in-file", bodyPath, "--output", "json",
			], { cwd, signal });
			if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Azure DevOps ${input.op} failed.`);
			return {
				content: this.successMessage(input.op, result.stdout),
				details: { op: input.op, organization: context.organization, project: context.project, repository: context.repository },
			};
		} finally {
			await unlink(bodyPath).catch(() => undefined);
		}
	}

	private threadBody(input: AdoToolInput): object {
		switch (input.op) {
			case "pr_thread_create":
				return { comments: [{ parentCommentId: 0, content: requireNonBlank(input.comment, "comment"), commentType: 1 }], status: THREAD_STATUS_CODES.active };
			case "pr_thread_reply":
				return { parentCommentId: positiveInteger(input.parentCommentId, "parentCommentId"), content: requireNonBlank(input.comment, "comment"), commentType: 1 };
			case "pr_thread_update_status": {
				const status = requireNonBlank(input.threadStatus, "threadStatus") as keyof typeof THREAD_STATUS_CODES;
				const statusCode = THREAD_STATUS_CODES[status];
				if (statusCode === undefined) throw new Error("threadStatus must be active, fixed, wontFix, closed, byDesign, or pending.");
				return { status: statusCode };
			}
		}
		throw new Error("Unsupported PR thread operation.");
	}

	private async codeSearch(input: AdoToolInput, context: AdoContext, signal?: AbortSignal): Promise<AdoToolResult> {
		const response = await this.searchCode({
			organization: context.organization,
			project: context.project,
			query: requireNonBlank(input.query, "query"),
			repository: input.repository?.trim(),
			path: input.path?.trim(),
			branch: input.branch?.trim(),
			limit: resolveLimit(input.limit),
			skip: resolveSkip(input.skip),
		}, signal);
		const entries = (response.results ?? []).map(result => `- ${result.repository?.name ?? "?"} | ${result.path ?? "?"}`);
		return {
			content: `Code Search returned ${response.count ?? entries.length} result(s).\n\n${entries.length ? entries.join("\n") : "No matches."}`,
			details: { op: input.op, organization: context.organization, project: context.project, repository: input.repository?.trim() },
		};
	}

	private successMessage(op: AdoToolOp, output: string): string {
		const data = output.trim();
		if (!data) return `Azure DevOps ${op} completed.`;
		try {
			return `Azure DevOps ${op} completed.\n\n${JSON.stringify(JSON.parse(data), null, 2)}`;
		} catch {
			return `Azure DevOps ${op} completed.\n\n${data}`;
		}
	}
}
