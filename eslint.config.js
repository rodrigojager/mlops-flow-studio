import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/generated/**",
      "**/node_modules/**",
      "projects/visual_audit_reimport_*/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...eslint.configs.recommended,
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...eslint.configs.recommended.rules,
      "no-unused-vars": "off",
    },
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
);
