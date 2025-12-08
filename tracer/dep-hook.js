// dep-hook.js
'use strict';

const path = require('node:path');
const shimmer = require('shimmer');

const {
    SYM_SKIP_WRAP
} = require('./runtime');

// ---- config / guards ----
const CWD = process.cwd().replace(/\\/g, '/');
const isOurFile = (f) => f && f.replace(/\\/g,'/').includes('/omnitrace/') || f.includes('/repro/');
const isInNodeModules = (f) => f && f.replace(/\\/g,'/').includes('/node_modules/');

const SKIP_METHOD_NAMES = new Set([
    // thenables + common promise-ish
    'then','catch','finally',
    // mongoose query/aggregate “execute” hooks — we log via schema middleware
    'exec',
    // avoid patching Node’s Symbol-based internals
    Symbol.toStringTag
]);

// Don’t double-wrap
function alreadyWrapped(fn) { return !!(fn && fn.__repro_wrapped); }
function markWrapped(fn) { try { Object.defineProperty(fn, '__repro_wrapped', { value: true }); } catch {} }

// our call bridge -> uses your global helper, preserves return value identity
function wrapFunction(original, label, file, line) {
    if (typeof original !== 'function') return original;
    if (alreadyWrapped(original)) return original;

    const wrapped = function reproWrapped() {
        // Use the call-site shim to classify app/dep and to safely handle thenables
        return global.__repro_call
            ? global.__repro_call(original, this, Array.from(arguments), file, line, label || original.name || '', false)
            : original.apply(this, arguments);
    };

    // copy a few common props (name/length are non-writable; don’t force)
    try { wrapped[SYM_SKIP_WRAP] = true; } catch {}
    try { Object.defineProperty(wrapped, '__repro_instrumented', { value: true, configurable: true }); } catch {}
    markWrapped(wrapped);
    return wrapped;
}

function wrapObjectMethods(obj, file) {
    const seen = new WeakSet();
    const maxDepth = 4;

    const visit = (target, depth = 0) => {
        if (!target || (typeof target !== 'object' && typeof target !== 'function')) return;
        if (seen.has(target)) return;
        if (depth > maxDepth) return;
        seen.add(target);

        // own props
        for (const k of Object.getOwnPropertyNames(target)) {
            const d = Object.getOwnPropertyDescriptor(target, k);
            if (!d) continue;
            if (d.get || d.set) continue; // never wrap accessors
            if (SKIP_METHOD_NAMES.has(k)) continue;

            if (typeof d.value === 'function') {
                const v = d.value;
                if (!alreadyWrapped(v)) {
                    const w = wrapFunction(v, String(k), file, 0);
                    try { shimmer.wrap(target, k, () => w); } catch {
                        try { target[k] = w; } catch {}
                    }
                }
                continue;
            }

            if (d.value && (typeof d.value === 'object' || typeof d.value === 'function')) {
                visit(d.value, depth + 1);
            }
        }

        // class prototype methods (walk depth once)
        const proto = Object.getPrototypeOf(target);
        if (proto && proto !== Object.prototype) {
            visit(proto, depth + 1);
        }
    };

    visit(obj, 0);
    return obj;
}

function shouldInstrument(filename, moduleName) {
    const f = String(filename || '').replace(/\\/g,'/');

    if (!f) return false;
    if (isOurFile(f)) return false;                        // never instrument tracer itself
    if (f.includes('/@babel/')) return false;              // avoid babel internals
    if (!isInNodeModules(f) && !f.startsWith(CWD + '/')) { // odd cases
        return false;
    }
    return true;
}

function instrumentExports(exports, filename, moduleName) {
    if (!shouldInstrument(filename, moduleName)) return exports;

    // Avoid breaking common patterns:
    // - Don’t mutate Mongoose core types (Query/Aggregate) — you already log via schema hooks
    try {
        if (moduleName === 'mongoose' || /[\\/]mongoose[\\/]/.test(filename)) {
            // wrap top-level exported functions only; skip prototype types
            if (exports && typeof exports === 'object') {
                for (const k of Object.getOwnPropertyNames(exports)) {
                    const d = Object.getOwnPropertyDescriptor(exports, k);
                    if (!d || d.get || d.set) continue;
                    if (typeof d.value === 'function' && !SKIP_METHOD_NAMES.has(k)) {
                        const w = wrapFunction(d.value, `${moduleName}.${k}`, filename, 0);
                        try { shimmer.wrap(exports, k, () => w); } catch {}
                    }
                }
            }
            return exports;
        }
    } catch {}

    // Generic: recursively wrap functions on object exports
    try {
        if (typeof exports === 'function') {
            const wrapped = wrapFunction(exports, moduleName || path.basename(filename), filename, 0);
            try { wrapObjectMethods(wrapped.prototype, filename); } catch {}
            return wrapped;
        }
        if (exports && typeof exports === 'object') {
            const wrappedObj = wrapObjectMethods(exports, filename);
            return wrappedObj;
        }
    } catch {}

    return exports;
}

module.exports = { instrumentExports };
