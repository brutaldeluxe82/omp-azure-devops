import { describe, expect, it } from "bun:test";
import type { InternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AdoBuildProtocolHandler, parseAdoBuildUrl } from "../src/ado-build-protocol";
import type { CommandResult } from "../src/ado-pr-protocol";

function internalUrl(value: string): InternalUrl {
	const url = new URL(value) as InternalUrl;
	Object.assign(url, { rawHost: url.host, rawPathname: url.pathname });
	return url;
}

function json(value: unknown): CommandResult {
	return { code: 0, stdout: JSON.stringify(value), stderr: "" };
}

describe("ado-build:// parser", () => {
	it("accepts contextual builds, project and pipeline listings, timelines, and logs", () => {
		expect(parseAdoBuildUrl(internalUrl("ado-build://150549"))).toEqual({ kind: "build", buildId: 150549, action: "detail" });
		expect(parseAdoBuildUrl(internalUrl("ado-build://example-org/ExampleProject/example-repository?limit=5"))).toEqual({
			kind: "list",
			context: { organization: "example-org", project: "ExampleProject" },
			pipeline: "example-repository",
			limit: 5,
		});
		expect(parseAdoBuildUrl(internalUrl("ado-build://example-org/ExampleProject/150549/timeline"))).toEqual({
			kind: "build",
			context: { organization: "example-org", project: "ExampleProject" },
			buildId: 150549,
			action: "timeline",
		});
		expect(parseAdoBuildUrl(internalUrl("ado-build://example-org/ExampleProject/example-repository/150549/logs/35"))).toEqual({
			kind: "build",
			context: { organization: "example-org", project: "ExampleProject" },
			buildId: 150549,
			action: "log",
			logId: 35,
			startLine: 1,
			endLine: 2000,
		});
	});

	it("rejects malformed build resource paths", () => {
		expect(() => parseAdoBuildUrl(internalUrl("ado-build://example-org/ExampleProject/0"))).toThrow("build number");
		expect(() => parseAdoBuildUrl(internalUrl("ado-build://example-org/ExampleProject/150549/logs/0"))).toThrow("log number");
		expect(() => parseAdoBuildUrl(internalUrl("ado-build://example-org/ExampleProject/150549/logs/35?startLine=1&endLine=2001"))).toThrow("log range");
		expect(() => parseAdoBuildUrl(internalUrl("ado-build://example-org/ExampleProject/150549/diff"))).toThrow("sub-path");
	});
});

describe("AdoBuildProtocolHandler", () => {
	it("renders build details and links to its timeline", async () => {
		const commands: string[][] = [];
		const handler = new AdoBuildProtocolHandler(async (command, args) => {
			commands.push([command, ...args]);
			return json({
				id: 150549,
				buildNumber: "2026.1.0.4",
				status: "completed",
				result: "succeeded",
				definition: { id: 1132, name: "example-repository" },
				sourceBranch: "refs/heads/feature/example",
				sourceVersion: "dafb410",
				requestedFor: { displayName: "Example User" },
			});
		});

		const result = await handler.resolve(internalUrl("ado-build://example-org/ExampleProject/150549"));

		expect(commands[0]).toEqual(expect.arrayContaining(["az", "pipelines", "build", "show", "--id", "150549"]));
		expect(handler.immutable).toBe(true);
		expect(result.content).toContain("# Build #150549: 2026.1.0.4");
		expect(result.content).toContain("ado-build://example-org/ExampleProject/150549/timeline");
	});

	it("renders task logs from the Azure DevOps build log endpoint", async () => {
		const handler = new AdoBuildProtocolHandler(async (_command, args) => {
			expect(args).toContain("logs");
			expect(args).toContain("logId=35");
			expect(args).toContain("startLine=1");
			expect(args).toContain("endLine=2000");
			return json({ value: ["first line", "second line"] });
		});

		const result = await handler.resolve(internalUrl("ado-build://example-org/ExampleProject/150549/logs/35"));

		expect(result.content).toBe("first line\nsecond line");
	});
});
