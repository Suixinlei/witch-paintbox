import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".local/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-globals": ["error", "document", "window"],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["src/ui/**/*.ts", "src/main.ts"],
    rules: { "no-restricted-globals": "off" },
  },
  {
    files: ["src/step1/**/*.ts", "src/step2/**/*.ts", "src/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/ui/**"],
              message: "Business services must not depend on UI.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/step2/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/step1/**", "**/ui/**"],
              message:
                "Step two only receives a read-only library port; no extraction or UI dependency.",
            },
          ],
        },
      ],
    },
  },
);
