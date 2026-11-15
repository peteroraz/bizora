import base from "@bizora/config/eslint";
import noHardcodedUi from "./eslint-rules/no-hardcoded-ui.mjs";

export default [
  ...base,
  {
    files: ["src/**/*.tsx"],
    ignores: ["src/app/design-preview/**"],
    plugins: {
      bizora: { rules: { "no-hardcoded-ui": noHardcodedUi } },
    },
    rules: {
      "bizora/no-hardcoded-ui": "error",
    },
  },
];
