import { describe, expect, it } from "bun:test";
import type { InternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls";
import {
	AdoPrProtocolHandler,
	type CommandResult,
	parseAdoPrUrl,
	parseAdoRemote,
} from "../src/ado-pr-protocol";

function internalUrl(value: string): InternalUrl {
	const url = new URL(value) as InternalUrl;
	Object.assign(url, { rawHost: url.host, rawPathname: url.pathname });
	return url;
}

function json(value: unknown): CommandResult {
	return { code: 0, stdout: JSON.stringify(value), stderr: "" };
}

describe("ado-pr:// parser", () => {
	it("accepts contextual, fully-qualified, and changed-file paths", () => {
		expect(parseAdoPrUrl(internalUrl("ado-pr://33328"))).toEqual({ kind: "single", pullRequestId: 33328 });
		expect(parseAdoPrUrl(internalUrl("ado-pr://example-org/ExampleProject/example-repository?limit=5"))).toEqual({
			kind: "list",
			repository: {
				organization: "example-org",
				project: "ExampleProject",
				repository: "example-repository",
			},
			limit: 5,
		});
		expect(parseAdoPrUrl(internalUrl("ado-pr://example-org/ExampleProject/example-repository/33328/changes"))).toEqual({
			kind: "changes",
			repository: {
				organization: "example-org",
				project: "ExampleProject",
				repository: "example-repository",
			},
			pullRequestId: 33328,
		});
	});

	it("rejects malformed path segments and unsupported subpaths", () => {
		expect(() => parseAdoPrUrl(internalUrl("ado-pr://example-org/ExampleProject/example-repository/0"))).toThrow("pull request number");
		expect(() => parseAdoPrUrl(internalUrl("ado-pr://example-org/ExampleProject/example-repository/33328/diff"))).toThrow("sub-path");
		expect(() => parseAdoPrUrl(internalUrl("ado-pr://example-org/ExampleProject/example-repository?limit=0"))).toThrow("list limit");
	});

	it("accepts contextual and fully-qualified thread paths", () => {
		expect(parseAdoPrUrl(internalUrl("ado-pr://33328/threads"))).toEqual({ kind: "threads", pullRequestId: 33328 });
		expect(parseAdoPrUrl(internalUrl("ado-pr://example-org/ExampleProject/example-repository/33328/threads"))).toEqual({
			kind: "threads",
			repository: { organization: "example-org", project: "ExampleProject", repository: "example-repository" },
			pullRequestId: 33328,
		});
	});
});

describe("Azure DevOps remote parsing", () => {
	it("parses both Azure DevOps remote formats", () => {
		expect(parseAdoRemote("git@ssh.dev.azure.com:v3/example-org/ExampleProject/example-repository")).toEqual({
		organization: "example-org",
		project: "ExampleProject",
		repository: "example-repository",
	});
		expect(parseAdoRemote("https://dev.azure.com/example-org/ExampleProject/_git/example-repository")).toEqual({
		organization: "example-org",
		project: "ExampleProject",
		repository: "example-repository",
	});
	});
});

describe("AdoPrProtocolHandler", () => {
	it("renders a PR detail resource without exposing Azure CLI syntax", async () => {
		const commands: string[][] = [];
		const handler = new AdoPrProtocolHandler(async (command, args) => {
			commands.push([command, ...args]);
			return json({
				pullRequestId: 33328,
				title: "Fix RoleBinding ownership",
				status: "active",
				createdBy: { displayName: "Example User" },
				sourceRefName: "refs/heads/feature/example",
				targetRefName: "refs/heads/main",
				creationDate: "2026-07-15T00:00:00Z",
				url: "https://dev.azure.com/example-org/ExampleProject/_git/example-repository/pullrequest/33328",
			});
		});

		const result = await handler.resolve(internalUrl("ado-pr://example-org/ExampleProject/example-repository/33328"));

		expect(commands).toHaveLength(1);
		expect(commands[0]).toContain("repos");
		expect(commands[0]).toContain("show");
		expect(commands[0]).not.toContain("--project");
		expect(handler.immutable).toBe(true);
		expect(result.content).toContain("# PR #33328: Fix RoleBinding ownership");
		expect(result.content).toContain("ado-pr://example-org/ExampleProject/example-repository/33328/changes");
	});

	it("uses the latest PR iteration and paginates changed files", async () => {
		let changesCall = 0;
		const handler = new AdoPrProtocolHandler(async (_command, args) => {
			if (args.includes("pullRequestIterations")) return json({ value: [{ id: 1 }, { id: 5 }] });
			changesCall += 1;
			return changesCall === 1
				? json({ changeEntries: [{ changeType: "edit", item: { path: "/go.mod" } }], nextSkip: 1 })
				: json({ changeEntries: [{ changeType: "add", item: { path: "/vuln-skip-check.txt" } }], nextSkip: null });
		});

		const result = await handler.resolve(internalUrl("ado-pr://example-org/ExampleProject/example-repository/33328/changes"));

		expect(changesCall).toBe(2);
		expect(result.content).toContain("[edit] /go.mod");
		expect(result.content).toContain("[add] /vuln-skip-check.txt");
	});

	it("renders visible PR threads through the authenticated Git REST resource", async () => {
		const commands: string[][] = [];
		const handler = new AdoPrProtocolHandler(async (command, args) => {
			commands.push([command, ...args]);
			return json({ value: [{ id: 17, status: "active", threadContext: { filePath: "/src/app.ts", rightFileStart: { line: 42 } }, comments: [{ id: 1, content: "Handle the error.", author: { displayName: "Example Reviewer" } }] }] });
		});

		const result = await handler.resolve(internalUrl("ado-pr://example-org/ExampleProject/example-repository/33328/threads"));

		expect(commands[0]).toEqual(expect.arrayContaining(["devops", "invoke", "--resource", "pullRequestThreads", "--http-method", "GET", "pullRequestId=33328"]));
		expect(result.content).toContain("[active] thread #17 at /src/app.ts:42");
		expect(result.content).toContain("@Example Reviewer: Handle the error.");
	});
});
