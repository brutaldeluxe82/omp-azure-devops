import { afterEach, describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import adoPrExtension from "../src/index";

function extensionApi(tools: string[]): never {
	const schema = {
		describe: () => schema,
		optional: () => schema,
		int: () => schema,
		positive: () => schema,
		nonnegative: () => schema,
		max: () => schema,
	};
	const z = {
		object: () => schema,
		enum: () => schema,
		string: () => schema,
		number: () => schema,
		boolean: () => schema,
		array: () => schema,
	};
	return { zod: { z }, registerTool: (tool: { name: string }) => tools.push(tool.name) } as never;
}

afterEach(() => InternalUrlRouter.resetForTests());

describe("Azure DevOps extension", () => {
	it("replaces immutable read handlers when extensions reload", () => {
		const tools: string[] = [];
		adoPrExtension(extensionApi(tools));
		const router = InternalUrlRouter.instance();
		const firstPullRequestHandler = router.getHandler("ado-pr");
		const firstBuildHandler = router.getHandler("ado-build");

		expect(firstPullRequestHandler?.immutable).toBe(true);
		expect(firstBuildHandler?.immutable).toBe(true);
		expect(tools).toEqual(["azure_devops"]);

		adoPrExtension(extensionApi(tools));
		const reloadedPullRequestHandler = router.getHandler("ado-pr");
		const reloadedBuildHandler = router.getHandler("ado-build");

		expect(reloadedPullRequestHandler).not.toBe(firstPullRequestHandler);
		expect(reloadedBuildHandler).not.toBe(firstBuildHandler);
		expect(reloadedPullRequestHandler?.immutable).toBe(true);
		expect(reloadedBuildHandler?.immutable).toBe(true);
		expect(tools).toEqual(["azure_devops", "azure_devops"]);
		expect(router.getHandler("ado-pr")).toBe(reloadedPullRequestHandler);
		expect(router.getHandler("ado-build")).toBe(reloadedBuildHandler);
	});
});
