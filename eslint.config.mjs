import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Fail CI on unused bindings — catches generated types/imports that drift out
  // of use (the regression that motivated this; see issue #164). Underscore-
  // prefixed names are the documented opt-out for intentionally-unused values.
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Foundry/Solidity submodules: never our JS/TS. Without this ESLint descends
    // into these vendored dirs and lints (or chokes on) their contents (#180).
    "lib/**",
    // Rust backend + build caches. backend/target is gitignored and full of
    // minified vendored JS (swagger-ui) that produces thousands of bogus
    // findings locally; CI never sees it because it isn't built before lint.
    "backend/**",
    "cache/**",
  ]),
]);

export default eslintConfig;
