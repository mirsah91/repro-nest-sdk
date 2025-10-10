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

        const makeMetaObject = (entries) => t.objectExpression(
            entries
                .filter(Boolean)
                .map(([key, value]) => t.objectProperty(t.identifier(key), value))
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

            let body = n.body;
            if (t.isArrowFunctionExpression(n) && !t.isBlockStatement(body)) {
                body = t.blockStatement([ t.returnStatement(body) ]);
                path.get('body').replaceWith(body);
            }
            if (!t.isBlockStatement(body)) return;

            const argsId = path.scope.generateUidIdentifier('args');
            const retId = path.scope.generateUidIdentifier('ret');
            const hasRetId = path.scope.generateUidIdentifier('hasRet');
            const errId = path.scope.generateUidIdentifier('err');
            const hasErrId = path.scope.generateUidIdentifier('hasErr');
            const caughtId = path.scope.generateUidIdentifier('caught');

            const sliceCall = t.callExpression(
                t.memberExpression(
                    t.memberExpression(
                        t.memberExpression(t.identifier('Array'), t.identifier('prototype')),
                        t.identifier('slice')
                    ),
                    t.identifier('call')
                ),
                [ t.identifier('arguments') ]
            );

            const argsExpr = t.conditionalExpression(
                t.binaryExpression('===',
                    t.unaryExpression('typeof', t.identifier('arguments')),
                    t.stringLiteral('undefined')
                ),
                t.identifier('undefined'),
                sliceCall
            );

            const fileNode = file ? t.stringLiteral(file) : t.nullLiteral();
            const lineNode = line != null ? t.numericLiteral(line) : t.nullLiteral();

            const enterMeta = makeMetaObject([
                ['file', fileNode],
                ['line', lineNode],
                ['args', argsId],
            ]);

            const exitMeta = makeMetaObject([
                ['fn', t.stringLiteral(name)],
                ['file', fileNode],
                ['line', lineNode],
                ['returnValue', t.conditionalExpression(hasRetId, retId, t.identifier('undefined'))],
                ['error', t.conditionalExpression(hasErrId, errId, t.identifier('undefined'))],
            ]);

            const enter = t.expressionStatement(
                t.callExpression(
                    t.memberExpression(t.identifier('__trace'), t.identifier('enter')),
                    [ t.stringLiteral(name), enterMeta ]
                )
            );

            const exit = t.expressionStatement(
                t.callExpression(
                    t.memberExpression(t.identifier('__trace'), t.identifier('exit')),
                    [ exitMeta ]
                )
            );

            const bodyPath = path.get('body');
            bodyPath.traverse({
                ReturnStatement(retPath) {
                    if (retPath.getFunctionParent() !== path) return;
                    const arg = retPath.node.argument;
                    if (!arg) {
                        retPath.replaceWith(
                            t.blockStatement([
                                t.expressionStatement(t.assignmentExpression('=', hasRetId, t.booleanLiteral(true))),
                                t.expressionStatement(t.assignmentExpression('=', retId, t.identifier('undefined'))),
                                t.returnStatement(),
                            ])
                        );
                        return;
                    }

                    const clonedArg = t.cloneNode(arg);
                    const valueExpr = path.node.async && !t.isAwaitExpression(clonedArg)
                        ? t.awaitExpression(clonedArg)
                        : clonedArg;
                    const tempId = retPath.scope.generateUidIdentifier('ret');
                    retPath.replaceWith(
                        t.blockStatement([
                            t.variableDeclaration('const', [ t.variableDeclarator(tempId, valueExpr) ]),
                            t.expressionStatement(t.assignmentExpression('=', hasRetId, t.booleanLiteral(true))),
                            t.expressionStatement(t.assignmentExpression('=', retId, tempId)),
                            t.returnStatement(tempId),
                        ])
                    );
                },
                Function(inner) {
                    inner.skip();
                }
            });

            const tryBlock = t.blockStatement(body.body);
            const catchBlock = t.catchClause(
                caughtId,
                t.blockStatement([
                    t.expressionStatement(t.assignmentExpression('=', hasErrId, t.booleanLiteral(true))),
                    t.expressionStatement(t.assignmentExpression('=', errId, caughtId)),
                    t.throwStatement(caughtId),
                ])
            );
            const finallyBlock = t.blockStatement([ exit ]);

            const wrapped = t.blockStatement([
                t.variableDeclaration('const', [ t.variableDeclarator(argsId, argsExpr) ]),
                t.variableDeclaration('let', [ t.variableDeclarator(retId) ]),
                t.variableDeclaration('let', [ t.variableDeclarator(hasRetId, t.booleanLiteral(false)) ]),
                t.variableDeclaration('let', [ t.variableDeclarator(errId) ]),
                t.variableDeclaration('let', [ t.variableDeclarator(hasErrId, t.booleanLiteral(false)) ]),
                enter,
                t.tryStatement(tryBlock, catchBlock, finallyBlock),
            ]);

            if (path.isFunction() || path.isClassMethod() || path.isObjectMethod()) {
                bodyPath.replaceWith(wrapped);
            }
            n.__wrapped = true;
        }

        // ---- NEW: wrap every call-site with __repro_call(...) ----
        function wrapCall(path, state) {
            const { node: n } = path;
            if (n.__repro_call_wrapped) return;

            // Skip our helper, super(), import(), optional calls for now
            if (t.isIdentifier(n.callee, { name: '__repro_call' })) return; // guard: don't wrap helper
            if (t.isSuper(n.callee)) return;
            if (t.isImport(n.callee)) return;
            if (n.optional === true) return;

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
                const argsArray = t.arrayExpression(n.arguments); // preserves spreads

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
                const argsArray = t.arrayExpression(n.arguments);

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
