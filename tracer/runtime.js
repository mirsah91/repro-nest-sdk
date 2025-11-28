// runtime.js
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage(); // { traceId, depth }
const listeners = new Set();
let EMITTING = false;
const quietEnv = process.env.TRACE_QUIET === '1';
const DEBUG_UNAWAITED = process.env.TRACE_DEBUG_UNAWAITED !== '0';
let functionLogsEnabled = !quietEnv;
let SPAN_COUNTER = 0;

// ---- console patch: trace console.* as top-level calls (safe; no recursion) ----
let CONSOLE_PATCHED = false;
function patchConsole() {
    if (CONSOLE_PATCHED) return; CONSOLE_PATCHED = true;

    const orig = {};
    for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
        if (typeof console[m] !== 'function') continue;
        orig[m] = console[m];
        console[m] = function tracedConsoleMethod(...args) {
            // mark as core so it's obvious in logs
            trace.enter(`console.${m}`, { file: 'node:console', line: null });
            try {
                return orig[m].apply(this, args);
            } finally {
                trace.exit({ fn: `console.${m}`, file: 'node:console', line: null });
            }
        };
    }
}

function isThenable(value) {
    return value != null && typeof value.then === 'function';
}

function isMongooseQuery(value) {
    return (
        isThenable(value) &&
        typeof value.exec === 'function' &&
        (value?.constructor?.name === 'Query' || value?.model != null)
    );
}

function pushSpan(ctx, depth) {
    const stack = ctx.__repro_span_stack || (ctx.__repro_span_stack = []);
    const parent = stack.length ? stack[stack.length - 1] : null;
    const span = { id: ++SPAN_COUNTER, parentId: parent ? parent.id : null, depth };
    stack.push(span);
    return span;
}

function popSpan(ctx) {
    const stack = ctx.__repro_span_stack;
    if (!Array.isArray(stack) || !stack.length) return { id: null, parentId: null, depth: null };
    return stack.pop() || { id: null, parentId: null, depth: null };
}

const trace = {
    on(fn){ listeners.add(fn); return () => listeners.delete(fn); },
    withTrace(id, fn, depth = 0){ return als.run({ traceId: id, depth }, fn); },
    enter(fn, meta, detail){
        const ctx = als.getStore() || {};
        ctx.depth = (ctx.depth || 0) + 1;

        const frameStack = ctx.__repro_frame_unawaited || (ctx.__repro_frame_unawaited = []);
        const pendingQueue = ctx.__repro_pending_unawaited;
        let frameUnawaited = false;
        if (Array.isArray(pendingQueue) && pendingQueue.length) {
            const marker = pendingQueue.shift();
            frameUnawaited = !!(marker && marker.unawaited);
        }
        if (DEBUG_UNAWAITED) {
            try { process.stderr.write(`[unawaited] enter ${fn} -> ${frameUnawaited}\n`); } catch {}
        }
        frameStack.push(frameUnawaited);

        const span = pushSpan(ctx, ctx.depth);

        emit({
            type: 'enter',
            t: Date.now(),
            fn,
            file: meta?.file,
            line: meta?.line,
            functionType: meta?.functionType || null,
            traceId: ctx.traceId,
            depth: ctx.depth,
            args: detail?.args,
            spanId: span.id,
            parentSpanId: span.parentId
        });
    },
    exit(meta, detail){
        const ctx = als.getStore() || {};
        const depthAtExit = ctx.depth || 0;
        const traceIdAtExit = ctx.traceId;
        const baseMeta = {
            fn: meta?.fn,
            file: meta?.file,
            line: meta?.line,
            functionType: meta?.functionType || null
        };
        const frameStack = ctx.__repro_frame_unawaited;
        const frameUnawaited = Array.isArray(frameStack) && frameStack.length
            ? !!frameStack.pop()
            : false;
        const spanStack = Array.isArray(ctx.__repro_span_stack) ? ctx.__repro_span_stack.slice() : [];
        const spanInfo = popSpan(ctx);
        const baseDetail = {
            args: detail?.args,
            returnValue: detail?.returnValue,
            error: detail?.error,
            threw: detail?.threw === true,
            unawaited: detail?.unawaited === true || frameUnawaited
        };

        const promiseTaggedUnawaited = !!(baseDetail.returnValue && baseDetail.returnValue[SYM_UNAWAITED]);
        const forceUnawaited = baseDetail.unawaited || promiseTaggedUnawaited;

        const runWithExitCtx = (fn) => {
            if (!traceIdAtExit) return fn();
            const store = { traceId: traceIdAtExit, depth: spanInfo.depth ?? depthAtExit, __repro_span_stack: spanStack.slice() };
            return als.run(store, fn);
        };

        const emitExit = (overrides = {}) => {
            const finalDetail = {
                returnValue: overrides.hasOwnProperty('returnValue')
                    ? overrides.returnValue
                    : baseDetail.returnValue,
                threw: overrides.hasOwnProperty('threw')
                    ? overrides.threw
                    : baseDetail.threw,
                error: overrides.hasOwnProperty('error')
                    ? overrides.error
                    : baseDetail.error,
                unawaited: overrides.hasOwnProperty('unawaited')
                    ? overrides.unawaited
                    : forceUnawaited,
                args: overrides.hasOwnProperty('args')
                    ? overrides.args
                    : baseDetail.args
            };

            emit({
                type: 'exit',
                t: Date.now(),
                fn: baseMeta.fn,
                file: baseMeta.file,
                line: baseMeta.line,
                functionType: baseMeta.functionType || null,
                traceId: traceIdAtExit,
                depth: spanInfo.depth ?? depthAtExit,
                spanId: spanInfo.id,
                parentSpanId: spanInfo.parentId,
                returnValue: finalDetail.returnValue,
                threw: finalDetail.threw === true,
                error: finalDetail.error,
                args: finalDetail.args,
                unawaited: finalDetail.unawaited === true
            });
        };

        ctx.depth = Math.max(0, depthAtExit - 1);

        if (!baseDetail.threw) {
            const rv = baseDetail.returnValue;
            const isQuery = isMongooseQuery(rv);
            if (isThenable(rv)) {
                if (isQuery) {
                    emitExit({ unawaited: forceUnawaited });
                    return;
                }

                let settled = false;
                const finalize = (value, threw, error) => {
                    if (settled) return value;
                    settled = true;
                    runWithExitCtx(() => emitExit({ returnValue: value, threw, error, unawaited: forceUnawaited }));
                    return value;
                };

                try {
                    rv.then(
                        value => finalize(value, false, null),
                        err => finalize(undefined, true, err)
                    );
                } catch (err) {
                    finalize(undefined, true, err);
                }
                return;
            }

            if (isQuery) {
                runWithExitCtx(() => emitExit({ unawaited: forceUnawaited }));
                return;
            }
        }

        if (DEBUG_UNAWAITED) {
            try { process.stderr.write(`[unawaited] exit ${baseMeta.fn} -> ${forceUnawaited}\n`); } catch {}
        }
        runWithExitCtx(() => emitExit({ unawaited: forceUnawaited }));
    }
};
global.__trace = trace; // called by injected code

// ===== Symbols used by the loader to tag function origins =====
const SYM_SRC_FILE = Symbol.for('__repro_src_file'); // function's defining file (set by require hook)
const SYM_IS_APP   = Symbol.for('__repro_is_app');   // boolean: true if function is from app code
const SYM_SKIP_WRAP= Symbol.for('__repro_skip_wrap'); // guard to avoid wrapping our own helpers
const SYM_UNAWAITED = Symbol.for('__repro_unawaited');

function emit(ev){
    if (EMITTING) return;
    EMITTING = true;
    try { for (const l of listeners) l(ev); }
    finally { EMITTING = false; }
}

let loggerState = null;
let loggerBeforeExitInstalled = false;

function ensureFunctionLogger() {
    if (loggerState) return loggerState;

    // ---- filtered logger: full detail for app code, top-level only for node_modules ----
    const isNodeModules = (file) => !!file && file.replace(/\\/g, '/').includes('/node_modules/');

    // per-trace logger state
    const stateByTrace = new Map();
    function getState(traceId) {
        const k = traceId || '__global__';
        let s = stateByTrace.get(k);
        if (!s) {
            s = { stack: [], muteDepth: null, lastLine: null, repeat: 0 };
            stateByTrace.set(k, s);
        }
        return s;
    }

    function flushRepeat(s) {
        if (s.repeat > 1) process.stdout.write(`  … ×${s.repeat - 1}\n`);
        s.repeat = 0;
        s.lastLine = null;
    }

    function printLine(ev, st) {
        const d = ev.depth || 0;
        const indent = '  '.repeat(Math.max(0, d - (ev.type === 'exit' ? 1 : 0)));
        const loc = ev.file ? ` (${short(ev.file)}:${ev.line ?? ''})` : '';
        const id  = ev.traceId ? `  [${ev.traceId}]` : '';
        const line = ev.type === 'enter'
            ? `${indent}→ enter ${ev.fn}${loc}${id}`
            : `${indent}← exit${id}`;

        // coalesce exact repeats
        if (line === st.lastLine) { st.repeat++; return; }
        if (st.repeat > 0) flushRepeat(st);
        process.stdout.write(line + '\n');
        st.lastLine = line; st.repeat = 1;
    }

    // Re-entrancy guard for emitting
    let IN_LOG = false;
    trace.on(ev => {
        if (!functionLogsEnabled) return;
        if (IN_LOG) return;
        IN_LOG = true;
        try {
            const st = getState(ev.traceId);
            const nm = isNodeModules(ev.file);

            if (ev.type === 'enter') {
                const prev = st.stack.length ? st.stack[st.stack.length - 1] : null;
                const prevIsNM = prev ? prev.isNM : false;

                // If we are already muting deeper node_modules frames, and this is another dep frame at/under mute depth -> skip
                if (nm && st.muteDepth !== null && ev.depth >= st.muteDepth) {
                    st.stack.push({ isNM: true }); // keep structural parity
                    return;
                }

                // Crossing app -> dep: print this top-level dep fn, then mute deeper dep frames
                if (nm && !prevIsNM) {
                    printLine(ev, st);
                    st.muteDepth = ev.depth + 1;
                    st.stack.push({ isNM: true });
                    return;
                }

                // App code (or dep -> app bounce): always print
                printLine(ev, st);
                st.stack.push({ isNM: nm });
                return;
            }

            // EXIT
            if (ev.type === 'exit') {
                const cur = st.stack.length ? st.stack[st.stack.length - 1] : null;
                const curIsNM = cur ? cur.isNM : false;

                // If this is a muted nested dep frame, skip printing
                if (curIsNM && st.muteDepth !== null && ev.depth >= st.muteDepth) {
                    st.stack.pop();
                    return;
                }

                // Print exits for app frames and for the top-level dep frame
                printLine(ev, st);

                // If we just exited the top-level dep frame, unmute deeper deps
                if (curIsNM && st.muteDepth !== null && ev.depth === st.muteDepth - 1) {
                    st.muteDepth = null;
                }

                st.stack.pop();
                return;
            }
        } finally {
            IN_LOG = false;
        }
    });

    if (!loggerBeforeExitInstalled) {
        // flush any coalesced repeats before exiting
        process.on('beforeExit', () => {
            for (const s of stateByTrace.values()) flushRepeat(s);
        });
        loggerBeforeExitInstalled = true;
    }

    loggerState = { stateByTrace };
    return loggerState;
}

function setFunctionLogsEnabled(enabled) {
    functionLogsEnabled = !!enabled;
    if (functionLogsEnabled) ensureFunctionLogger();
}

if (functionLogsEnabled) ensureFunctionLogger();

function short(p){ try{ const cwd = process.cwd().replace(/\\/g,'/'); return String(p).replace(cwd+'/',''); } catch { return p; } }

function markPromiseUnawaited(value) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return;
    try {
        Object.defineProperty(value, SYM_UNAWAITED, { value: true, configurable: true });
    } catch {
        try { value[SYM_UNAWAITED] = true; } catch {}
    }
}

// ========= Generic call-site shim (used by Babel transform) =========
// Decides whether to emit a top-level event based on callee origin tags.
// No hardcoded library names or file paths.
if (!global.__repro_call) {
    Object.defineProperty(global, '__repro_call', {
        value: function __repro_call(fn, thisArg, args, callFile, callLine, label, isUnawaitedCall) {
            try {
                if (typeof fn !== 'function' || fn[SYM_SKIP_WRAP]) {
                    return fn.apply(thisArg, args);
                }

                const isApp = fn[SYM_IS_APP] === true;
                if (isApp) {
                    const ctx = als.getStore();
                    let pendingMarker = null;
                    if (ctx && isUnawaitedCall) {
                        const queue = ctx.__repro_pending_unawaited || (ctx.__repro_pending_unawaited = []);
                        pendingMarker = { unawaited: true, id: Symbol('unawaited') };
                        queue.push(pendingMarker);
                    }

                    try {
                        const out = fn.apply(thisArg, args);
                        if (isUnawaitedCall && isThenable(out)) markPromiseUnawaited(out);
                        return out;
                    } finally {
                        if (pendingMarker) {
                            const store = als.getStore();
                            const queue = store && store.__repro_pending_unawaited;
                            if (Array.isArray(queue)) {
                                const idx = queue.indexOf(pendingMarker);
                                if (idx !== -1) queue.splice(idx, 1);
                            }
                        }
                    }
                }

                const name = (label && label.length) || fn.name
                    ? (label && label.length ? label : fn.name)
                    : '(anonymous)';
                const sourceFile = fn[SYM_SRC_FILE];
                const meta = {
                    file: sourceFile || callFile || null,
                    line: sourceFile ? null : (callLine || null)
                };

                trace.enter(name, meta, { args });
                try {
                    const out = fn.apply(thisArg, args);

                    const isThenableValue = isThenable(out);
                    const isQuery = isMongooseQuery(out);
                    const shouldForceExit = !!isUnawaitedCall && isThenableValue;
                    const exitDetailBase = {
                        returnValue: out,
                        args,
                        unawaited: shouldForceExit
                    };

                    if (shouldForceExit) markPromiseUnawaited(out);

                    if (isThenableValue) {
                        if (isQuery) {
                            trace.exit({ fn: name, file: meta.file, line: meta.line }, exitDetailBase);
                            return out;
                        }

                        let settled = false;
                        const finalize = (value, threw, error) => {
                            if (settled) return value;
                            settled = true;
                            const detail = {
                                returnValue: value,
                                args,
                                threw,
                                error
                            };
                            trace.exit({ fn: name, file: meta.file, line: meta.line }, detail);
                            return value;
                        };

                        try {
                            out.then(
                                value => finalize(value, false, null),
                                err => finalize(undefined, true, err)
                            );
                        } catch (err) {
                            finalize(undefined, true, err);
                        }
                        return out;
                    }

                    // Non-thenable: close span now
                    trace.exit({ fn: name, file: meta.file, line: meta.line }, exitDetailBase);
                    return out;
                } catch (e) {
                    trace.exit({ fn: name, file: meta.file, line: meta.line }, { threw: true, error: e, args });
                    throw e;
                }
            } catch {
                return fn ? fn.apply(thisArg, args) : undefined;
            }
        },
        configurable: false,
        writable: false,
        enumerable: false
    });
    // Guard our helper from any instrumentation
    global.__repro_call[SYM_SKIP_WRAP] = true;
}

// ---- automatic per-request context via http/https ----
function patchHttp(){
    try {
        const http = require('node:http');
        const Server = http.Server;
        const _emit = Server.prototype.emit;
        Server.prototype.emit = function(ev, req, res){
            if (ev === 'request' && req && res) {
                const id = `${req.method} ${req.url} #${(Math.random()*1e9|0).toString(36)}`;
                return trace.withTrace(id, () => _emit.call(this, ev, req, res));
            }
            return _emit.apply(this, arguments);
        };
        // https piggybacks http.Server in Node, no extra patch usually needed
    } catch {}
}

// ---- optional V8 sampling summary on SIGINT ----
let inspectorSession = null;
function startV8(samplingMs = 10){
    const inspector = require('node:inspector');
    inspectorSession = new inspector.Session();
    inspectorSession.connect();
    inspectorSession.post('Profiler.enable');
    inspectorSession.post('Profiler.setSamplingInterval', { interval: samplingMs * 1000 });
    inspectorSession.post('Profiler.start');
    if (!quietEnv) process.stdout.write(`[v8] profiler started @ ${samplingMs}ms\n`);
}
function stopV8(){ return new Promise((resolve, reject) => {
    if (!inspectorSession) return resolve(null);
    inspectorSession.post('Profiler.stop', (err, payload) => {
        if (err) return reject(err);
        try { inspectorSession.disconnect(); } catch {}
        inspectorSession = null;
        resolve(payload?.profile ?? null);
    });
});}
function summarize(profile, topN=10){
    if (!profile) return { top: [] };
    const nodes = new Map(profile.nodes.map(n=>[n.id,n]));
    const { samples=[], timeDeltas=[] } = profile;
    const self = new Map();
    for (let i=0;i<samples.length;i++) self.set(samples[i], (self.get(samples[i])||0)+(timeDeltas[i]||0));
    const top = [...self].map(([id,us])=>({node:nodes.get(id),ms:us/1000}))
        .sort((a,b)=>b.ms-a.ms).slice(0,topN)
        .map(({node,ms})=>({ ms:+ms.toFixed(2),
            fn: node?.callFrame?.functionName || '(anonymous)',
            url: node?.callFrame?.url, line: node?.callFrame?.lineNumber!=null ? node.callFrame.lineNumber+1 : undefined }));
    return { top };
}
async function printV8(){ const p=await stopV8(); const s=summarize(p);
    if (!quietEnv) { process.stdout.write('\n[v8] Top self-time:\n');
        for (const r of s.top) process.stdout.write(`  ${r.ms}ms  ${r.fn}  ${r.url ?? ''}:${r.line ?? ''}\n`);
    }
}

function getCurrentTraceId() {
    const s = als.getStore();
    return s && s.traceId || null;
}

module.exports = {
    trace,
    patchHttp,
    startV8,
    printV8,
    patchConsole,
    getCurrentTraceId,
    setFunctionLogsEnabled,
    // export symbols so the require hook can tag function origins
    SYM_SRC_FILE,
    SYM_IS_APP,
    SYM_SKIP_WRAP
};
