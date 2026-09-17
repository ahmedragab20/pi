import { createBrowserExtension } from "./index.ts";

/** Worker entry: browser checks without clicks, typing, uploads, or prompts. */
export default createBrowserExtension({ readOnly: true });
