import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AdoBuildProtocolHandler } from "./ado-build-protocol";
import { AdoPrProtocolHandler } from "./ado-pr-protocol";
import { AdoToolDispatcher, ADO_TOOL_OPS, type AdoToolInput } from "./ado-tool";

/** Register immutable Azure DevOps reads and one op-dispatched mutation tool. */
export default function adoExtension(pi: ExtensionAPI): void {
	const router = InternalUrlRouter.instance();
	// The router is process-global. Keep already-registered handlers so a second
	// session or extension reload cannot replace live resource backends.
	if (!router.getHandler("ado-pr")) router.register(new AdoPrProtocolHandler());
	if (!router.getHandler("ado-build")) router.register(new AdoBuildProtocolHandler());

	const { z } = pi.zod;
	const dispatcher = new AdoToolDispatcher();
	pi.registerTool({
		name: "azure_devops",
		label: "Azure DevOps",
		description: "One op-based dispatcher for Azure DevOps operations beyond reads. Supports PR create/update/vote/abandon/auto-complete/complete, PR thread creation/replies/status updates, repository create/update/delete, and cross-repository literal Code Search. Read PRs, threads, and builds with ado-pr:// and ado-build:// resources. Work-item management is intentionally unsupported.",
		parameters: z.object({
			op: z.enum(ADO_TOOL_OPS).describe("Azure DevOps operation"),
			organization: z.string().optional().describe("Azure DevOps organization; defaults from the current checkout"),
			project: z.string().optional().describe("Azure DevOps project; defaults from the current checkout"),
			repository: z.string().optional().describe("Repository name or ID; defaults from the current checkout where applicable"),
			pullRequestId: z.number().int().positive().optional().describe("Pull request ID"),
			title: z.string().optional().describe("Pull request title"),
			description: z.string().optional().describe("Pull request Markdown description"),
			sourceBranch: z.string().optional().describe("Pull request source branch"),
			targetBranch: z.string().optional().describe("Pull request target branch"),
			draft: z.boolean().optional().describe("Create or update as draft"),
			reviewers: z.array(z.string()).optional().describe("Required pull request reviewers"),
			optionalReviewers: z.array(z.string()).optional().describe("Optional pull request reviewers"),
			vote: z.enum(["approve", "approve-with-suggestions", "reject", "reset", "wait-for-author"]).optional().describe("Current user's pull request vote"),
			autoComplete: z.boolean().optional().describe("Enable or disable auto completion with pr_set_auto_complete"),
			deleteSourceBranch: z.boolean().optional().describe("Delete source branch after pr_complete"),
			mergeCommitMessage: z.string().optional().describe("Merge message for pr_complete"),
			bypassPolicy: z.boolean().optional().describe("Bypass required policy when completing; requires bypassPolicyReason"),
			bypassPolicyReason: z.string().optional().describe("Reason required when bypassPolicy is true"),
			threadId: z.number().int().positive().optional().describe("Pull request thread ID for reply or status update"),
			parentCommentId: z.number().int().positive().optional().describe("Comment ID to reply to within a pull request thread"),
			comment: z.string().optional().describe("Initial pull request thread comment or reply text"),
			threadStatus: z.enum(["active", "fixed", "wontFix", "closed", "byDesign", "pending"]).optional().describe("Pull request thread status for pr_thread_update_status"),
			name: z.string().optional().describe("Repository name for repo_create or repo_update"),
			defaultBranch: z.string().optional().describe("Default branch for repo_update"),
			query: z.string().optional().describe("Literal text for code_search; regular expressions are unsupported"),
			path: z.string().optional().describe("Optional Code Search path filter"),
			branch: z.string().optional().describe("Optional Code Search branch filter"),
			limit: z.number().int().positive().max(1000).optional().describe("Code Search result limit; maximum 1000"),
			skip: z.number().int().nonnegative().optional().describe("Code Search result offset"),
			confirm: z.boolean().optional().describe("Must be true for pr_complete and repo_delete"),
		}),
		approval: "write",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await dispatcher.execute(params as AdoToolInput, ctx.cwd, signal);
			return { content: [{ type: "text", text: result.content }], details: result.details };
		},
	});
}
