// wrap-plugin.js
module.exports = function makeWrapPlugin(filenameForMeta, opts = {}) {
    return ({ types: t }) => {
        const {
            mode = 'all',                 // 'all' | 'allowlist'
            allowFns = [],                // regexes or strings
            wrapGettersSetters = false,   // skip noisy accessors by default
            skipAnonymous = false,        // don't wrap anon fns in node_modules
        } = opts;

        const allowFnRegexes = allowFns.map(p =>
            typeof p === 'string' ? new RegExp(`^${escapeRx(p)}$`) : p
        );

        function escapeRx(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

        const obj = kv => t.objectExpression(
            Object.entries(kv).filter(([,v])=>v!=null)
                .map(([k,v]) => t.objectProperty(
                    t.identifier(k),
                    typeof v === 'string' ? t.stringLiteral(v) : t.numericLiteral(v)
                ))
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

            const line = n.loc?.start?.line ?? null;
            const file = filenameForMeta;

            let body = n.body;
            if (t.isArrowFunctionExpression(n) && !t.isBlockStatement(body)) {
                body = t.blockStatement([ t.returnStatement(body) ]);
            }
            if (!t.isBlockStatement(body)) return;

            const enter = t.expressionStatement(
                t.callExpression(
                    t.memberExpression(t.identifier('__trace'), t.identifier('enter')),
                    [ t.stringLiteral(name), obj({ file, line }) ]
                )
            );
            const exit = t.expressionStatement(
                t.callExpression(
                    t.memberExpression(t.identifier('__trace'), t.identifier('exit')),
                    [ obj({ fn: name, file, line }) ]
                )
            );

            const wrapped = t.blockStatement([ enter, t.tryStatement(body, null, t.blockStatement([ exit ])) ]);
            if (path.isFunction() || path.isClassMethod() || path.isObjectMethod()) {
                path.get('body').replaceWith(wrapped);
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

            const fileLit = t.stringLiteral(state.file.opts.filename || '');
            const lineLit = t.numericLiteral(n.loc?.start?.line ?? 0);

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
