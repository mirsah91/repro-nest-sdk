// wrap-plugin.js
module.exports = function makeWrapPlugin(filenameForMeta, opts = {}) {
    return ({ types: t }) => {
        const {
            mode = 'all',                 // 'all' | 'allowlist'
            allowFns = [],                // regexes or strings
            wrapGettersSetters = false,   // skip noisy accessors by default
            skipAnonymous = false,        // don't wrap anon fns in node_modules
            mapOriginalPosition = null,
        } = opts;

        const allowFnRegexes = allowFns.map(p =>
            typeof p === 'string' ? new RegExp(`^${escapeRx(p)}$`) : p
        );

        function escapeRx(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

        const markInternal = (node) => {
            if (node && typeof node === 'object') {
                node.__repro_internal = true;
            }
            return node;
        };

        function describeExpression(node, depth = 0) {
            if (!node || depth > 5) return '';
            if (t.isIdentifier(node)) return node.name;
            if (t.isThisExpression(node)) return 'this';
            if (t.isSuper(node)) return 'super';
            if (t.isStringLiteral(node)) return node.value;
            if (t.isNumericLiteral(node)) return String(node.value);
            if (t.isMemberExpression(node)) {
                const obj = describeExpression(node.object, depth + 1) || '';
                let prop = '';
                if (!node.computed && t.isIdentifier(node.property)) {
                    prop = node.property.name;
                } else if (!node.computed && t.isStringLiteral(node.property)) {
                    prop = node.property.value;
                } else if (!node.computed && t.isNumericLiteral(node.property)) {
                    prop = String(node.property.value);
                } else {
                    const inner = describeExpression(node.property, depth + 1) || '?';
                    prop = node.computed ? `[${inner}]` : inner;
                }
                if (!obj) return prop || '';
                if (prop.startsWith('[')) return `${obj}${prop}`;
                return prop ? `${obj}.${prop}` : obj;
            }
            return '';
        }

        const obj = kv => t.objectExpression(
            Object.entries(kv)
                .filter(([, v]) => v != null)
                .map(([k, v]) => {
                    let valueNode;
                    if (typeof v === 'string') valueNode = t.stringLiteral(v);
                    else if (typeof v === 'number') valueNode = t.numericLiteral(v);
                    else if (typeof v === 'boolean') valueNode = t.booleanLiteral(v);
                    else if (v && typeof v === 'object' && v.type) valueNode = v;
                    else if (v === null) valueNode = t.nullLiteral();
                    else throw new Error(`Unsupported object literal value for key ${k}`);
                    return t.objectProperty(t.identifier(k), valueNode);
                })
        );

        function nameFor(path){
            const n = path.node;
            if (n.id?.name) return n.id.name;
            if ((path.isClassMethod() || path.isObjectMethod()) && n.key) {
                if (t.isIdentifier(n.key)) return n.key.name;
                if (t.isStringLiteral(n.key)) return n.key.value;
                if (t.isNumericLiteral(n.key)) return String(n.key.value);
            }
            if (path.parentPath?.isVariableDeclarator() && t.isIdentifier(path.parentPath.node.id))
                return path.parentPath.node.id.name;
            if (path.parentPath?.isAssignmentExpression()) {
                const left = path.parentPath.node.left;
                if (t.isIdentifier(left)) return left.name;
                if (t.isMemberExpression(left)) {
                    const p = left.property;
                    if (t.isIdentifier(p)) return p.name;
                    if (t.isStringLiteral(p)) return p.value;
                    if (t.isNumericLiteral(p)) return String(p.value);
                }
            }
            return '(anonymous)';
        }

        function classifyFunction(path){
            const n = path.node;

            if (path.isClassMethod() || path.isClassPrivateMethod?.()) {
                if (n.kind === 'constructor') return 'constructor';
                if (n.kind === 'get') return 'getter';
                if (n.kind === 'set') return 'setter';
                if (n.static) return 'static-method';
                return 'method';
            }

            if (path.isObjectMethod && path.isObjectMethod()) {
                if (n.kind === 'get') return 'getter';
                if (n.kind === 'set') return 'setter';
                return 'method';
            }

            if (path.isClassPrivateProperty?.()) return 'method';

            if (path.isArrowFunctionExpression()) return 'arrow';

            if (path.isFunctionDeclaration()) return 'function';
            if (path.isFunctionExpression()) {
                if (path.parentPath?.isClassProperty?.()) return 'method';
                return 'function';
            }

            return 'function';
        }

        function shouldWrap(path, name){
            // skip getters/setters unless asked
            if (!wrapGettersSetters &&
                (path.node.kind === 'get' || path.node.kind === 'set')) return false;

            if (skipAnonymous && name === '(anonymous)') return false;

            if (mode === 'allowlist') {
                return allowFnRegexes.length === 0
                    ? false
                    : allowFnRegexes.some(rx => rx.test(name));
            }
            return true; // mode 'all'
        }

        function wrap(path){
            const n = path.node;
            if (n.__wrapped) return;

            const name = nameFor(path);
            if (!shouldWrap(path, name)) return;

            const loc = n.loc?.start || null;
            const mapped = loc && typeof mapOriginalPosition === 'function'
                ? mapOriginalPosition(loc.line ?? null, loc.column ?? 0)
                : null;

            const file = mapped?.file || filenameForMeta;
            const line = mapped?.line ?? loc?.line ?? null;
            const fnType = classifyFunction(path);

            if (t.isArrowFunctionExpression(n) && !t.isBlockStatement(n.body)) {
                const bodyExprPath = path.get('body');
                const origBody = t.cloneNode(bodyExprPath.node, true);
                bodyExprPath.replaceWith(t.blockStatement([ t.returnStatement(origBody) ]));
            }

            const bodyPath = path.get('body');
            if (!bodyPath.isBlockStatement()) return;
            const body = bodyPath.node;

            const argsId = path.scope.generateUidIdentifier('args');
            const resultId = path.scope.generateUidIdentifier('result');
            const errorId = path.scope.generateUidIdentifier('error');
            const threwId = path.scope.generateUidIdentifier('threw');

            const typeofArgs = t.unaryExpression('typeof', t.identifier('arguments'));
            const arrayProto = t.memberExpression(t.identifier('Array'), t.identifier('prototype'));
            const arraySlice = t.memberExpression(arrayProto, t.identifier('slice'));
            const sliceCall = t.memberExpression(arraySlice, t.identifier('call'));
            const argsArray = markInternal(t.callExpression(sliceCall, [ t.identifier('arguments') ]));
            const canUseArguments = !path.isArrowFunctionExpression();
            const argsInit = canUseArguments
                ? t.conditionalExpression(
                    t.binaryExpression('===', typeofArgs, t.stringLiteral('undefined')),
                    t.arrayExpression([]),
                    argsArray
                )
                : t.arrayExpression(
                    n.params.map(param => {
                        if (t.isIdentifier(param)) return t.cloneNode(param, true);
                        if (t.isRestElement(param) && t.isIdentifier(param.argument)) {
                            return t.cloneNode(param.argument, true);
                        }
                        if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
                            return t.cloneNode(param.left, true);
                        }
                        return t.identifier('undefined');
                    })
                );

            const argsDecl = t.variableDeclaration('const', [
                t.variableDeclarator(argsId, argsInit)
            ]);

            const localsDecl = t.variableDeclaration('let', [
                t.variableDeclarator(resultId, t.identifier('undefined')),
                t.variableDeclarator(errorId, t.nullLiteral()),
                t.variableDeclarator(threwId, t.booleanLiteral(false))
            ]);

            const enter = t.expressionStatement(
                markInternal(t.callExpression(
                    t.memberExpression(t.identifier('__trace'), t.identifier('enter')),
                    [ t.stringLiteral(name), obj({ file, line, functionType: fnType }), obj({ args: argsId }) ]
                ))
            );

            const exit = t.expressionStatement(
                markInternal(t.callExpression(
                    t.memberExpression(t.identifier('__trace'), t.identifier('exit')),
                    [
                        obj({ fn: name, file, line, functionType: fnType }),
                        obj({ returnValue: resultId, error: errorId, threw: threwId, args: argsId })
                    ]
                ))
            );

            const errId = path.scope.generateUidIdentifier('err');
            bodyPath.traverse({
                ReturnStatement(retPath) {
                    if (retPath.node.__repro_wrapped) return;
                    if (retPath.getFunctionParent() !== path) return;
                    const arg = retPath.node.argument
                        ? t.cloneNode(retPath.node.argument, true)
                        : t.identifier('undefined');
                    const seq = t.sequenceExpression([
                        t.assignmentExpression('=', resultId, arg),
                        resultId
                    ]);
                    const newReturn = t.returnStatement(seq);
                    newReturn.__repro_wrapped = true;
                    retPath.replaceWith(newReturn);
                }
            });

            const wrappedTry = t.tryStatement(
                body,
                t.catchClause(errId, t.blockStatement([
                    t.expressionStatement(
                        t.assignmentExpression('=', threwId, t.booleanLiteral(true))
                    ),
                    t.expressionStatement(
                        t.assignmentExpression('=', errorId, errId)
                    ),
                    t.throwStatement(errId)
                ])),
                t.blockStatement([ exit ])
            );

            const prologue = [ argsDecl, localsDecl, enter ];
            const wrapped = t.blockStatement([ ...prologue, wrappedTry ]);

            if (path.isFunction() || path.isClassMethod() || path.isObjectMethod()) {
                bodyPath.replaceWith(wrapped);
            }
            n.__wrapped = true;
        }

        function isSkippableParent(p) {
            if (!p) return false;
            if (p.isParenthesizedExpression && p.isParenthesizedExpression()) return true;
            if (p.isTSAsExpression && p.isTSAsExpression()) return true;
            if (p.isTSTypeAssertion && p.isTSTypeAssertion()) return true;
            if (p.isTSNonNullExpression && p.isTSNonNullExpression()) return true;
            if (p.isTypeCastExpression && p.isTypeCastExpression()) return true;
            if (p.isSequenceExpression && p.isSequenceExpression()) return true;
            if (p.isConditionalExpression && p.isConditionalExpression()) return true;
            if (p.isLogicalExpression && p.isLogicalExpression()) return true;
            if (p.isBinaryExpression && p.isBinaryExpression()) return true;
            if (p.isUnaryExpression && p.isUnaryExpression()) return true;
            if (p.isArrayExpression && p.isArrayExpression()) return true;
            if (p.isObjectExpression && p.isObjectExpression()) return true;
            if (p.isObjectProperty && p.isObjectProperty()) return true;
            if (p.isObjectMethod && p.isObjectMethod()) return true;
            if (p.isSpreadElement && p.isSpreadElement()) return true;
            if (p.isNewExpression && p.isNewExpression()) return true;
            if (p.isMemberExpression && p.isMemberExpression()) return true;
            if (p.isOptionalMemberExpression && p.isOptionalMemberExpression()) return true;
            if (p.isTaggedTemplateExpression && p.isTaggedTemplateExpression()) return true;
            if (p.isTemplateLiteral && p.isTemplateLiteral()) return true;
            return false;
        }

        function isAwaitedCall(path) {
            let current = path;
            const funcParent = path.getFunctionParent();

            while (current && current.parentPath) {
                const parent = current.parentPath;

                if (parent.isAwaitExpression && parent.isAwaitExpression()) return true;
                if (parent.isYieldExpression && parent.isYieldExpression()) return true;

                if (parent.isReturnStatement && parent.isReturnStatement()) {
                    if (parent.node.argument === current.node &&
                        funcParent &&
                        (funcParent.node.async || funcParent.node.generator)) {
                        return true;
                    }
                }

                if (parent.isForOfStatement && parent.isForOfStatement()) {
                    if (parent.node.await === true && parent.node.right === current.node) {
                        return true;
                    }
                }

                if (!isSkippableParent(parent)) break;
                current = parent;
            }

            return false;
        }

        // ---- NEW: wrap every call-site with __repro_call(...) ----
        function wrapCall(path, state) {
            const { node: n } = path;
            if (n.__repro_call_wrapped) return;
            if (n.__repro_internal) return;

            // Skip our helper, super(), import(), optional calls for now
            if (t.isIdentifier(n.callee, { name: '__repro_call' })) return;
            if (t.isSuper(n.callee)) return;
            if (t.isImport(n.callee)) return;
            if (n.optional === true) return;

            if (t.isMemberExpression(n.callee) && t.isIdentifier(n.callee.object, { name: '__trace' })) {
                return;
            }
            if (t.isIdentifier(n.callee, { name: '__trace' })) return;

            const loc = n.loc?.start || null;
            const mapped = loc && typeof mapOriginalPosition === 'function'
                ? mapOriginalPosition(loc.line ?? null, loc.column ?? 0)
                : null;

            const file = mapped?.file || filenameForMeta || state.file.opts.filename || '';
            const line = mapped?.line ?? loc?.line ?? 0;

            const fileLit = t.stringLiteral(file ?? '');
            const lineLit = t.numericLiteral(line ?? 0);

            const unawaited = !isAwaitedCall(path);

            // Default: no thisArg, label from identifier name if any
            let label = '';
            let callExpr;

            if (t.isMemberExpression(n.callee)) {
                // --- Member call: obj.method(...args)
                // Hoist obj and fn into temps so obj is evaluated ONCE.
                const objOrig = n.callee.object;
                const prop = n.callee.property;
                const computed = n.callee.computed === true;

                const objId = path.scope.generateUidIdentifierBasedOnNode(objOrig, 'obj');
                const fnId  = path.scope.generateUidIdentifier('fn');

                // label = property name when available
                label = describeExpression(n.callee) || label;

                const fnMember = t.memberExpression(objId, prop, computed);
                const argsArray = t.arrayExpression(n.arguments.map(arg => t.cloneNode(arg, true)));

                const reproCall = t.callExpression(
                    t.identifier('__repro_call'),
                    [
                        fnId,
                        objId,
                        argsArray,
                        fileLit,
                        lineLit,
                        t.stringLiteral(label || ''),
                        t.booleanLiteral(unawaited)
                    ]
                );

                // Build a single expression that:
                //   const _obj = (origObj), _fn = _obj.prop, __repro_call(_fn, _obj, args, ...)
                // We use a sequence expression so it works anywhere an expression is allowed.
                callExpr = t.sequenceExpression([
                    t.assignmentExpression('=', objId, objOrig),
                    t.assignmentExpression('=', fnId, fnMember),
                    reproCall
                ]);

                // Ensure the temps are declared in the current scope
                path.scope.push({ id: objId });
                path.scope.push({ id: fnId });
            } else {
                // --- Plain call: fn(...args)
                // Evaluate callee ONCE into a temp as well (avoids re-evaluation when nested).
                const fnOrig = n.callee;
                const fnId = path.scope.generateUidIdentifier('fn');
                const argsArray = t.arrayExpression(n.arguments.map(arg => t.cloneNode(arg, true)));

                label = describeExpression(fnOrig) || label;

                const reproCall = t.callExpression(
                    t.identifier('__repro_call'),
                    [
                        fnId,
                        t.nullLiteral(),
                        argsArray,
                        fileLit,
                        lineLit,
                        t.stringLiteral(label || ''),
                        t.booleanLiteral(unawaited)
                    ]
                );

                callExpr = t.sequenceExpression([
                    t.assignmentExpression('=', fnId, fnOrig),
                    reproCall
                ]);

                path.scope.push({ id: fnId });
            }

            path.replaceWith(callExpr);
            path.node.__repro_call_wrapped = true;
        }

        return {
            name: 'omnitrace-wrap-functions-and-calls',
            visitor: {
                // function body enter/exit
                FunctionDeclaration: wrap,
                FunctionExpression: wrap,
                ArrowFunctionExpression: wrap,
                ObjectMethod: wrap,
                ClassMethod: wrap,
                ClassPrivateMethod: wrap,

                // call-site wrapping
                CallExpression: {
                    exit(path, state) { wrapCall(path, state); }
                },
                // (If you also want to wrap OptionalCallExpression in older Babel ASTs,
                // add the same handler here)
            }
        };
    };
};
