import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Logging a secret by accident is the one thing this project must never do.
      // All user-facing output goes through src/log.ts.
      "no-console": "error",
    },
  },
  {
    files: ["src/log.ts", "test/**", "*.config.*"],
    rules: { "no-console": "off" },
  },
);
