import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface ProjectContext {
  /** Absolute path of the project root (where .env lives). */
  root: string;
  /** Slug used in refs: keysmith://<name>/<service>/<VAR>. */
  name: string;
}

/** Walk up from `cwd` to the nearest directory holding package.json or .git. */
export function findProjectRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, "package.json")) || existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

/** Refs use "/" as a separator, so scoped names like "@acme/web" become "acme-web". */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

export function resolveProject(cwd: string = process.cwd()): ProjectContext {
  const root = findProjectRoot(cwd);
  let name = basename(root);
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown };
      if (typeof pkg.name === "string" && pkg.name.trim()) name = pkg.name;
    } catch {
      // Malformed package.json: fall back to the folder name.
    }
  }
  return { root, name: slugify(name) };
}
