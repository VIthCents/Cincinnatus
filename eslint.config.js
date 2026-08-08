import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

/**
 * Layer 2 of the src/core purity boundary. (Layer 1 is tsconfig.core.json,
 * layer 3 is keeping tests out of src/.)
 *
 * tsconfig.core.json already makes most of this a compile error. This config
 * exists so the failure arrives as a readable sentence on the offending line
 * instead of "Cannot find name 'fetch'".
 */

/** Node builtins, with and without the `node:` prefix. */
const NODE_BUILTINS = [
  "fs",
  "path",
  "os",
  "crypto",
  "child_process",
  "http",
  "https",
  "net",
  "url",
  "util",
  "stream",
  "worker_threads",
  "sqlite",
];

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src-tauri/**",
      "coverage/**",
      ".data/**",
      ".models/**",
      ".tsbuild/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // A leading underscore marks something deliberately discarded, e.g. the
      // `content` field destructured off a Greenhouse record so the rest can be
      // stored without it.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // src/core — must run unchanged in Node, in vitest, and in the Tauri webview.
  // ---------------------------------------------------------------------------
  {
    files: ["src/core/**/*.ts"],
    languageOptions: {
      // No environment globals at all. Anything core needs comes in through a
      // port in src/core/ports.ts.
      globals: {},
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@tauri-apps/*", "@tauri-apps/**"],
              message:
                "src/core must not import Tauri. It has to run headless in the CLI harness too. Put the Tauri call in an adapter and depend on a port from src/core/ports.ts instead.",
            },
            {
              group: ["node:*"],
              message:
                "src/core must not import Node builtins. It has to run in the webview too. Add a port to src/core/ports.ts and implement it in src/node/ or src/tauri/.",
            },
            {
              group: ["react", "react-dom", "react/**", "react-dom/**"],
              message:
                "src/core is not UI code. Move anything React-shaped to src/ui/.",
            },
            {
              group: ["@huggingface/transformers", "onnxruntime-*"],
              message:
                "src/core must not load the embedding model directly. Depend on the Embedder port; the model is loaded by the Node adapter.",
            },
          ],
          paths: NODE_BUILTINS.map((name) => ({
            name,
            message: `src/core must not import "${name}". Add a port to src/core/ports.ts instead.`,
          })),
        },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message:
            "src/core must not do network I/O directly. Use the Http port so tests can inject recorded fixtures and the allowlist can be enforced.",
        },
        {
          name: "console",
          message:
            "src/core must not log. Return data and let the harness or the UI decide how to present it.",
        },
        { name: "process", message: "Not available in the webview. Use a port." },
        { name: "window", message: "Not available in Node. Use a port." },
        { name: "document", message: "Not available in Node. Use a port." },
        { name: "navigator", message: "Not available in Node. Use a port." },
        { name: "localStorage", message: "Not available in Node. Use the Db port." },
        {
          name: "Buffer",
          message: "Node-only. Use the base64 helpers in src/core/util/.",
        },
        { name: "crypto", message: "Use the Hasher port." },
        {
          name: "setTimeout",
          message: "Use the Clock port's sleep() so tests do not actually wait.",
        },
        { name: "setInterval", message: "Use the Clock port." },
        { name: "__dirname", message: "Node-only. Pass paths in from the caller." },
        { name: "__filename", message: "Node-only. Pass paths in from the caller." },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message:
            "src/core must be deterministic. Use the Clock port's jitter source so backoff is reproducible in tests.",
        },
        {
          object: "Date",
          property: "now",
          message:
            "src/core must not read the clock. Use the Clock port, so `now` is read exactly once per run and two jobs cannot land on opposite sides of a day boundary because one was processed later.",
        },
      ],
      // Bans reading the clock without banning Date outright. `Date.parse` and
      // `Date.UTC` are pure string/number maths and are exactly what the source
      // clients need to turn a published-at string into epoch ms; it is
      // `new Date()` and `Date.now()` that make a run non-reproducible.
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date']",
          message:
            "src/core must not construct Dates. Use the Clock port for the current time, and Date.parse(...) for turning a source's timestamp string into epoch milliseconds.",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // src/ui — webview only.
  // ---------------------------------------------------------------------------
  {
    files: ["src/ui/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // v7 moved the flat-config entry point; `configs.recommended.rules` is
      // undefined here and throws at load time.
      ...reactHooks.configs["recommended-latest"].rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },

  // ---------------------------------------------------------------------------
  // Node-side: harness, tests, build config.
  // ---------------------------------------------------------------------------
  {
    files: ["scripts/**/*.ts", "tests/**/*.ts", "*.config.{ts,js}"],
    languageOptions: { globals: globals.node },
  },
);
