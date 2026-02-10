// eslint.config.js
import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default [
  { ignores: ["node_modules/**", "dist/**", "coverage/**"] },

  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser, ...globals.es2022 },
    },
  },

  {
    files: ["**/*.{js,mjs,cjs}"],
    ...js.configs.recommended,
  },

  {
    files: ["**/*.{ts,tsx}"],
    ...js.configs.recommended,
  },
  ...tseslint.configs.recommendedTypeChecked.map((c) => ({
    ...c,
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ...(c.languageOptions ?? {}),
      globals: { ...globals.node, ...globals.browser, ...globals.es2022 },
      parserOptions: {
        ...(c.languageOptions?.parserOptions ?? {}),
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
  })),

  prettier,
];
