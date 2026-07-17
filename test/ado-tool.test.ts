import { describe, expect, it } from "bun:test";
import { AdoToolDispatcher, type CodeSearchRequest } from "../src/ado-tool";
import type { CommandResult } from "../src/ado-pr-protocol";

function json(value: unknown): CommandResult {
	return { code: 0, stdout: JSON.stringify(value), stderr: "" };
}

describe("AdoToolDispatcher", () => {
	it("creates squash pull requests with explicit repository routing", async () => {
		const commands: string[][] = [];
		const dispatcher = new AdoToolDispatcher(async (command, args) => {
			commands.push([command, ...args]);
			return json({ pullRequestId: 42, title: "feat: add tool" });
		});

		const result = await dispatcher.execute({
			op: "pr_create",
			organization: "example-org",
			project: "ExampleProject",
			repository: "example-repository",
			sourceBranch: "feature/example",
			targetBranch: "main",
			title: "feat: add tool",
			description: "Description",
			reviewers: ["reviewer@example.com"],
		});

		expect(commands).toEqual([["az", "repos", "pr", "create", "--repository", "example-repository", "--source-branch", "feature/example", "--title", "feat: add tool", "--squash", "true", "--org", "https://dev.azure.com/example-org", "--project", "ExampleProject", "--output", "json", "--target-branch", "main", "--description", "Description", "--required-reviewers", "reviewer@example.com"]]);
		expect(result.content).toContain("Azure DevOps pr_create completed.");
	});

	it("requires explicit confirmation for completion and blocks unreasoned policy bypass", async () => {
		const dispatcher = new AdoToolDispatcher(async () => json({}));
		const input = { op: "pr_complete" as const, organization: "example-org", project: "ExampleProject", repository: "example-repository", pullRequestId: 42 };

		await expect(dispatcher.execute(input)).rejects.toThrow("confirm: true");
		await expect(dispatcher.execute({ ...input, confirm: true, bypassPolicy: true })).rejects.toThrow("bypassPolicyReason");
	});

	it("uses the current Azure DevOps checkout when repository routing is omitted", async () => {
		const commands: string[][] = [];
		const dispatcher = new AdoToolDispatcher(async (command, args) => {
			commands.push([command, ...args]);
			if (command === "git") return { code: 0, stdout: "git@ssh.dev.azure.com:v3/example-org/ExampleProject/example-repository\n", stderr: "" };
			return json({ pullRequestId: 42 });
		});

		await dispatcher.execute({ op: "pr_vote", pullRequestId: 42, vote: "approve" }, "/workspace");

		expect(commands[0]).toEqual(["git", "config", "--get", "remote.origin.url"]);
	expect(commands[1]).toEqual(expect.arrayContaining(["az", "repos", "pr", "set-vote", "--id", "42", "--vote", "approve", "--org", "https://dev.azure.com/example-org"]));
	expect(commands[1]).not.toContain("--project");
	});

	it("does not pass --project to pr_update (az repos pr update does not accept it)", async () => {
		const commands: string[][] = [];
		const dispatcher = new AdoToolDispatcher(async (_command, args) => {
			commands.push([_command, ...args]);
			return json({});
		});

		await dispatcher.execute({ op: "pr_update", organization: "example-org", project: "ExampleProject", repository: "example-repository", pullRequestId: 33393, title: "fix: test", description: "Description" });

		expect(commands[0]).toEqual(expect.arrayContaining(["az", "repos", "pr", "update", "--id", "33393", "--org", "https://dev.azure.com/example-org"]));
		expect(commands[0]).not.toContain("--project");
	});

	it("requires confirmation before deleting a repository", async () => {
		const commands: string[][] = [];
		const dispatcher = new AdoToolDispatcher(async (command, args) => {
			commands.push([command, ...args]);
			return json({});
		});
		const input = { op: "repo_delete" as const, organization: "example-org", project: "ExampleProject", repository: "repository-id" };

		await expect(dispatcher.execute(input)).rejects.toThrow("confirm: true");
		await dispatcher.execute({ ...input, confirm: true });
		expect(commands[0]).toEqual(expect.arrayContaining(["az", "repos", "delete", "--id", "repository-id", "--yes"]));
	});

	it("runs literal Code Search across the requested project and formats repository paths", async () => {
		let request: CodeSearchRequest | undefined;
		const dispatcher = new AdoToolDispatcher(
			async () => json({}),
			async value => {
				request = value;
				return { count: 2, results: [{ repository: { name: "api" }, path: "/src/main.go" }, { repository: { name: "worker" }, path: "/pkg/worker.go" }] };
			},
		);

		const result = await dispatcher.execute({
			op: "code_search",
			organization: "example-org",
			project: "ExampleProject",
			query: "ExampleSymbol",
			repository: "api",
			path: "/src",
			branch: "main",
			limit: 50,
			skip: 10,
		});

		expect(request).toEqual({ organization: "example-org", project: "ExampleProject", query: "ExampleSymbol", repository: "api", path: "/src", branch: "main", limit: 50, skip: 10 });
		expect(result.content).toContain("- api | /src/main.go");
		expect(result.content).toContain("- worker | /pkg/worker.go");
	});

	it("creates a PR thread through the authenticated Git REST resource", async () => {
		const commands: string[][] = [];
		let body: unknown;
		const dispatcher = new AdoToolDispatcher(async (command, args) => {
			commands.push([command, ...args]);
			body = await Bun.file(args[args.indexOf("--in-file") + 1]).json();
			return json({ id: 17, status: "active" });
		});

		await dispatcher.execute({ op: "pr_thread_create", organization: "example-org", project: "ExampleProject", repository: "example-repository", pullRequestId: 42, comment: "Please handle this error." });

		expect(commands[0]).toEqual(expect.arrayContaining(["devops", "invoke", "--resource", "pullRequestThreads", "--http-method", "POST", "pullRequestId=42"]));
		expect(body).toEqual({ comments: [{ parentCommentId: 0, content: "Please handle this error.", commentType: 1 }], status: 1 });
	});

	it("replies to and resolves PR threads with their explicit REST payloads", async () => {
		const requests: Array<{ args: string[]; body: unknown }> = [];
		const dispatcher = new AdoToolDispatcher(async (command, args) => {
			requests.push({ args: [command, ...args], body: await Bun.file(args[args.indexOf("--in-file") + 1]).json() });
			return json({});
		});
		const base = { organization: "example-org", project: "ExampleProject", repository: "example-repository", pullRequestId: 42, threadId: 17 };

		await dispatcher.execute({ ...base, op: "pr_thread_reply", parentCommentId: 3, comment: "Fixed in the latest commit." });
		await dispatcher.execute({ ...base, op: "pr_thread_update_status", threadStatus: "fixed" });

		expect(requests[0]).toEqual({ args: expect.arrayContaining(["--resource", "pullRequestThreadComments", "--http-method", "POST", "threadId=17"]), body: { parentCommentId: 3, content: "Fixed in the latest commit.", commentType: 1 } });
		expect(requests[1]).toEqual({ args: expect.arrayContaining(["--resource", "pullRequestThreads", "--http-method", "PATCH", "threadId=17"]), body: { status: 2 } });
	});

	it("watches a known build, fast-fails on the first failed task, and tails its log", async () => {
		const calls: string[][] = [];
		let buildShowCall = 0;
		const dispatcher = new AdoToolDispatcher(async (command, args) => {
			calls.push([command, ...args]);
			if (args.includes("show") && args.includes("--id")) {
				buildShowCall += 1;
				// First poll: inProgress, second poll: completed/failed
				return buildShowCall === 1
					? json({ status: "inProgress", result: null, definition: { name: "ci-pipeline" }, sourceBranch: "refs/heads/main" })
					: json({ status: "completed", result: "failed", definition: { name: "ci-pipeline" }, sourceBranch: "refs/heads/main" });
			}
			if (args.includes("timeline")) {
				return json({ records: [
					{ id: "stage-1", type: "Stage", name: "Build Stage", state: "completed", result: "succeeded" },
					{ id: "task-5", type: "Task", name: "Run Tests", state: "completed", result: "failed", log: { id: 42 } },
				] });
			}
			if (args.includes("logs")) {
				return json({ value: ["line 1: starting", "line 2: running", "line 3: error: tests failed"] });
			}
			return json({});
		}, async () => ({ count: 0, results: [] }), 50);

		const result = await dispatcher.execute({ op: "build_watch", organization: "example-org", project: "ExampleProject", buildId: 999 });

		expect(buildShowCall).toBe(2);
		expect(result.content).toContain("build #999 failed");
		expect(result.content).toContain("Failed task: Run Tests (log #42)");
		expect(result.content).toContain("error: tests failed");
		expect(result.content).toContain("Full log saved:");
		expect(result.details.op).toBe("build_watch");
	});

	it("watches a successful build and returns a concise summary without log tailing", async () => {
		const dispatcher = new AdoToolDispatcher(async (_command, args) => {
			if (args.includes("show")) return json({ status: "completed", result: "succeeded", definition: { name: "ci-pipeline" }, sourceBranch: "refs/heads/main" });
			return json({});
		}, async () => ({ count: 0, results: [] }), 50);

		const result = await dispatcher.execute({ op: "build_watch", organization: "example-org", project: "ExampleProject", buildId: 888 });

		expect(result.content).toContain("build #888 succeeded");
		expect(result.content).not.toContain("Full log");
	});
});
