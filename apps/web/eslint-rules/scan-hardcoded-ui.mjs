import ts from "typescript";

const uiAttributes = new Set([
  "label",
  "title",
  "placeholder",
  "description",
  "hint",
  "alt",
  "aria-label",
  "aria-description",
  "content",
  "pendingLabel",
  "emptyLabel",
]);

function translatorCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const expr = node.expression;
  if (ts.isIdentifier(expr) && (expr.text === "t" || expr.text === "getTranslations" || expr.text === "useTranslations")) return true;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    return expr.name.text === "raw" || expr.name.text === "has" || expr.name.text === "rich";
  }
  return false;
}

function attributeName(node) {
  return ts.isIdentifier(node.name) ? node.name.text : "";
}

function inTranslator(node) {
  let current = node.parent;
  while (current) {
    if (translatorCall(current)) return true;
    current = current.parent;
  }
  return false;
}

function inClassName(node) {
  let current = node.parent;
  while (current) {
    if (ts.isJsxAttribute(current) && attributeName(current) === "className") return true;
    current = current.parent;
  }
  return false;
}

function uiAttributeValue(node) {
  const parent = node.parent;
  if (parent && ts.isJsxAttribute(parent)) return uiAttributes.has(attributeName(parent));
  if (parent && ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent)) {
    return uiAttributes.has(attributeName(parent.parent));
  }
  return false;
}

const comparisons = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

function renderedChild(node) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isBinaryExpression(parent) && comparisons.has(parent.operatorToken.kind)) return false;
    if (ts.isConditionalExpression(parent) && current === parent.condition) return false;
    if (ts.isJsxExpression(parent)) {
      const owner = parent.parent;
      return Boolean(owner && (ts.isJsxElement(owner) || ts.isJsxFragment(owner)));
    }
    if (
      ts.isConditionalExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isTemplateSpan(parent) ||
      ts.isTemplateExpression(parent) ||
      ts.isBinaryExpression(parent)
    ) {
      current = parent;
      continue;
    }
    return false;
  }
  return false;
}

function looksLikeCopy(text) {
  if (/[=<>{}]|https?:|\/api\//.test(text)) return false;
  return /[A-Za-z]/.test(text) && /\s/.test(text) && (/[A-Z]/.test(text) || /[.!?]/.test(text));
}

export function hardcodedUiStrings(source, fileName = "file.tsx") {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits = [];

  function report(node, text) {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!/[A-Za-z]/.test(trimmed)) return;
    if (inTranslator(node) || inClassName(node)) return;
    const visible = ts.isJsxText(node) || uiAttributeValue(node) || renderedChild(node);
    if (!visible && !looksLikeCopy(trimmed)) return;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    hits.push({ line: line + 1, column: character, text: trimmed });
  }

  function visit(node) {
    if (ts.isJsxText(node)) report(node, node.getText(sourceFile));
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) report(node, node.text);
    if (ts.isTemplateExpression(node)) {
      for (const part of node.templateSpans) report(part.literal, part.literal.text);
      if (node.head) report(node.head, node.head.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return hits;
}
