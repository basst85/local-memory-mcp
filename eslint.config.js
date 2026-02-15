export default [
  {
    ignores: ["node_modules/**", ".bun/**", "data/**", "coverage/**"],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {},
  },
];
