#!/usr/bin/env bun
/** The published skill entry point; implementation lives in the extension module. */
export { classifyPath, flattenInventory, main, runWorktreeSweep } from "../../../src/worktree-sweep";

import { main } from "../../../src/worktree-sweep";

if (import.meta.main) main();
