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
		expect(commands[1]).toEqual(expect.arrayContaining(["az", "repos", "pr", "set-vote", "--id", "42", "--vote", "approve", "--project", "ExampleProject"]));
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
});
