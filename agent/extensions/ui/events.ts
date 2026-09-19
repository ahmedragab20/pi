/** Local presentation events. No message content, credentials, or execution policy. */
export const UI_SNAPSHOT_REQUEST = "harness-ui:snapshot-request";
export const UI_TASKS = "harness-ui:tasks";
export const UI_TIMING = "harness-ui:timing";
export const UI_ACTIVITY = "harness-ui:activity";
export const UI_FOOTER = "harness-ui:footer";

export interface FooterSnapshot {
	location: string;
	branch?: string;
	git?: string;
	statuses: [string, string][];
}

export interface TaskProgress {
	done: number;
	total: number;
	next?: string;
}

export interface RunTiming {
	startedAt?: number;
	lastElapsed?: number;
}

export type ActivityUpdate = {
	id: string;
	state: "queued" | "running" | "waiting" | "success" | "error" | "cancelled";
	label: string;
	startedAt?: number;
} | { id: string; remove: true };
