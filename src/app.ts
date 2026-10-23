import { DialogCapture, type SecretCapture } from "./capture/index.js";
import { type ProjectContext, resolveProject } from "./context.js";
import type { ConnectOptions, RecipeContext } from "./recipes/types.js";
import { type System, realSystem } from "./sys.js";
import { Vault } from "./vault/index.js";

export interface ContextOverrides {
  project?: ProjectContext;
  vault?: Vault;
  capture?: SecretCapture;
  sys?: System;
  fetch?: typeof fetch;
  now?: () => Date;
  options?: ConnectOptions;
  progress?: (msg: string) => void;
}

export function createContext(o: ContextOverrides = {}): RecipeContext {
  const sys = o.sys ?? realSystem;
  return {
    project: o.project ?? resolveProject(process.env.KEYSMITH_PROJECT_ROOT ?? process.cwd()),
    vault: o.vault ?? new Vault(),
    capture: o.capture ?? new DialogCapture(sys),
    sys,
    fetch: o.fetch ?? globalThis.fetch,
    now: o.now ?? (() => new Date()),
    options: o.options ?? {},
    progress: o.progress ?? (() => {}),
  };
}
