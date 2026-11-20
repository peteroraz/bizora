import base from "@bizora/config/eslint";
// The same rule as the business app: every word on screen comes from messages/en.json.
import noHardcodedUi from "../web/eslint-rules/no-hardcoded-ui.mjs";

export default [
  ...base,
  {
    files: ["src/**/*.tsx"],
    plugins: {
      bizora: { rules: { "no-hardcoded-ui": noHardcodedUi } },
    },
    rules: {
      "bizora/no-hardcoded-ui": "error",
    },
  },
];
