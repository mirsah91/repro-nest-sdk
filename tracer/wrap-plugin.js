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
                    [ t.stringLiteral(name), obj({ file, line }), obj({ args: argsId }) ]
                ))
            );

            const exit = t.expressionStatement(
                markInternal(t.callExpression(
                    t.memberExpression(t.identifier('__trace'), t.identifier('exit')),
                    [
                        obj({ fn: name, file, line }),
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

            // Default: no thisArg, label from identifier name if any
            let labelLit = t.stringLiteral('');
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
                if (!computed && t.isIdentifier(prop)) {
                    labelLit = t.stringLiteral(prop.name);
                } else if (t.isStringLiteral(prop)) {
                    labelLit = t.stringLiteral(prop.value);
                }

                const fnMember = t.memberExpression(objId, prop, computed);
                const argsArray = t.arrayExpression(n.arguments.map(arg => t.cloneNode(arg, true)));

                const reproCall = t.callExpression(
                    t.identifier('__repro_call'),
                    [ fnId, objId, argsArray, fileLit, lineLit, labelLit ]
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

                if (t.isIdentifier(fnOrig)) {
                    labelLit = t.stringLiteral(fnOrig.name);
                }

                const reproCall = t.callExpression(
                    t.identifier('__repro_call'),
                    [ fnId, t.nullLiteral(), argsArray, fileLit, lineLit, labelLit ]
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
