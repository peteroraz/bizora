import { hardcodedUiStrings } from "./scan-hardcoded-ui.mjs";

const rule = {
  meta: {
    type: "problem",
    docs: { description: "UI copy must come from the message catalog." },
    schema: [],
    messages: { hardcoded: "Hard-coded UI string \"{{text}}\". Move it to messages/en.json." },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (filename.includes("/design-preview/") || filename.endsWith(".test.tsx")) return {};
    const hits = hardcodedUiStrings(context.sourceCode.getText(), filename);
    return {
      Program(node) {
        for (const hit of hits) {
          context.report({
            node,
            loc: { start: { line: hit.line, column: hit.column }, end: { line: hit.line, column: hit.column + hit.text.length } },
            messageId: "hardcoded",
            data: { text: hit.text },
          });
        }
      },
    };
  },
};

export default rule;
