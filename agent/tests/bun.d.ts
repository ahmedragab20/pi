declare module "bun:test" {
	interface Matchers {
		readonly not: Matchers;
		toBe(expected: unknown): void;
		toBeDefined(): void;
		toBeNull(): void;
		toBeUndefined(): void;
		toContain(expected: unknown): void;
		toEqual(expected: unknown): void;
		toHaveLength(expected: number): void;
		toMatchObject(expected: unknown): void;
	}

	export function beforeEach(callback: () => unknown | Promise<unknown>): void;
	export function describe(name: string, callback: () => void): void;
	export function expect(actual: unknown): Matchers;
	export function test(
		name: string,
		callback: () => unknown | Promise<unknown>,
	): void;
}

declare module "bun" {
	interface PluginBuild {
		module(specifier: string, factory: () => unknown): void;
	}

	interface PluginDefinition {
		name: string;
		setup(build: PluginBuild): void;
	}

	export function plugin(definition: PluginDefinition): void;
}
