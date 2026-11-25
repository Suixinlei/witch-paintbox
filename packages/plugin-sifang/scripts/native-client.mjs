import { resolve } from 'node:path';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';

/** Specialize only imported host-mode predicates, never source strings or unrelated names. */
export function nativeClientPlugin() {
  return { name: 'sifang-native-client', setup(build) {
    // Native entry calls setup explicitly. Unused imported local-only modules must not run their initializers.
    build.onResolve({ filter: /^\.\.?\/.*\.js$/ }, ({ path, resolveDir }) => ({
      path: resolve(resolveDir, path).replace(/\.js$/, '.ts'), sideEffects: false,
    }));
    build.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8');
      const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const constants = new Map();
      for (const node of ast.statements) {
        if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
        const bindings = node.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        for (const specifier of bindings.elements) {
          const imported = (specifier.propertyName ?? specifier.name).text;
          const module = node.moduleSpecifier.text;
          if (module === './sifang-host.js' && imported === 'isSifangEnvironment') constants.set(specifier.name.text, true);
          if (module === './service-client.js' && imported === 'isServiceEditor') constants.set(specifier.name.text, false);
          if (module === './model-settings.js' && imported === 'isImageSizeModeSaving') constants.set(specifier.name.text, false);
        }
      }
      const transformed = ts.transform(ast, [context => {
        const visit = node => {
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && !node.arguments.length && constants.has(node.expression.text)) {
            return constants.get(node.expression.text) ? ts.factory.createTrue() : ts.factory.createFalse();
          }
          // Native clients have no editable local service-config mirror to flush.
          if (path.replaceAll('\\', '/').endsWith('/service-client.ts') && ts.isFunctionDeclaration(node) && node.name?.text === 'readyForTask') {
            return ts.factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type,
              ts.factory.createBlock([ts.factory.createExpressionStatement(ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('signal'), 'throwIfAborted'), undefined, []))], true));
          }
          const updated = ts.visitEachChild(node, visit, context);
          const boolean = expression => {
            if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
            if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
            if (ts.isParenthesizedExpression(expression)) return boolean(expression.expression);
            if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
              const value = boolean(expression.operand); return value === undefined ? undefined : !value;
            }
            if (ts.isBinaryExpression(expression)) {
              const left = boolean(expression.left), right = boolean(expression.right);
              if (left !== undefined && right !== undefined) {
                if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) return left || right;
                if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return left && right;
              }
            }
          };
          if (ts.isIfStatement(updated)) {
            const value = boolean(updated.expression);
            if (value !== undefined) return value ? updated.thenStatement : updated.elseStatement ?? ts.factory.createEmptyStatement();
          }
          if (ts.isConditionalExpression(updated)) {
            const value = boolean(updated.condition);
            if (value !== undefined) return value ? updated.whenTrue : updated.whenFalse;
          }
          if (ts.isBlock(updated)) {
            const ends = statement => ts.isReturnStatement(statement) || ts.isThrowStatement(statement)
              || ts.isBlock(statement) && statement.statements.length > 0 && ends(statement.statements.at(-1));
            const statements = []; let terminated = false;
            for (const statement of updated.statements) {
              // Preserve hoisted functions even when their declaration follows a return.
              if (!terminated || ts.isFunctionDeclaration(statement)) statements.push(statement);
              if (ends(statement)) terminated = true;
            }
            return ts.factory.updateBlock(updated, statements);
          }
          return updated;
        };
        return root => ts.visitNode(root, visit);
      }]);
      try { return { contents: ts.createPrinter().printFile(transformed.transformed[0]), loader: 'ts' }; }
      finally { transformed.dispose(); }
    });
  } };
}
