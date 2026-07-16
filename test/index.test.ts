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
	it("registers immutable read handlers and the Azure DevOps dispatcher", () => {
		const tools: string[] = [];
		adoPrExtension(extensionApi(tools));
		const router = InternalUrlRouter.instance();
		const pullRequestHandler = router.getHandler("ado-pr");
		const buildHandler = router.getHandler("ado-build");

		expect(pullRequestHandler?.immutable).toBe(true);
		expect(buildHandler?.immutable).toBe(true);
		expect(tools).toEqual(["azure_devops"]);
		adoPrExtension(extensionApi(tools));
		expect(router.getHandler("ado-pr")).toBe(pullRequestHandler);
		expect(router.getHandler("ado-build")).toBe(buildHandler);
		expect(tools).toEqual(["azure_devops", "azure_devops"]);
	});
});
