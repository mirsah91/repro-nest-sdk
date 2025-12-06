// register.js
const escapeRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const path = require('node:path');
const cwd = process.cwd().replace(/\\/g, '/');
const hook = require('require-in-the-middle');
const { instrumentExports } = require('./dep-hook');
const { SYM_BODY_TRACED } = require('./runtime');

hook([], (exports, name, basedir) => {
    // require-in-the-middle passes resolved filename on exports.__filename in some versions
    // but we can safely compute via Module._resolveFilename if needed.
    try {
        // name: module id (e.g., 'express', './local.js')
        // basedir: path of the requiring module
        // We can’t always get the absolute filename reliably here; rely on name when needed.
        const filename = name || '';
        return instrumentExports(exports, filename, name);
    } catch {
        return exports;
    }
});

try {
    const { addHook } = require('import-in-the-middle');
    const { instrumentExports } = require('./dep-hook');

    addHook((moduleExports, specifier, context) => {
        // specifier: what was imported (e.g., 'kafkajs', 'node:fs', './x.mjs')
        // context.url: the importing module URL (can be 'file:///...')
        // Return the (optionally) modified moduleExports.
        return instrumentExports(moduleExports, specifier || '', specifier || '');
    });
} catch {}

// include: your project (excluding its node_modules), plus the specific third-party files we care about
const projectNoNodeModules = new RegExp('^' + escapeRx(cwd) + '/(?!node_modules/)');
// also include the SDK’s own source inside node_modules so its internal calls are traced
const sdkRoot = path.resolve(__dirname, '..').replace(/\\/g, '/');
const sdkPath = new RegExp('^' + escapeRx(sdkRoot) + '/');
// match these files via the hook’s per-file logic; include broad paths so the hook sees them:
const expressPath  = /node_modules[\\/]express[\\/]/;
const mongoosePath = /node_modules[\\/]mongoose[\\/]/;
const includeMatchers = [ projectNoNodeModules, sdkPath, expressPath, mongoosePath ];
const excludeMatchers = [
    /[\\/]omnitrace[\\/].*/,            // don't instrument the tracer
    /node_modules[\\/]repro-nest[\\/]tracer[\\/].*/, // avoid instrumenting tracer internals
    /[\\/]tracer[\\/].*/,               // skip local tracer sources
];

function shouldHandleCacheFile(file) {
    const f = String(file || '').replace(/\\/g, '/');
    if (!f) return false;
    if (excludeMatchers.some(rx => rx.test(f))) return false;
    return includeMatchers.some(rx => rx.test(f));
}

function hasBodyTracing(value, seen = new WeakSet(), depth = 0) {
    if (!value || depth > 4) return false;
    const ty = typeof value;
    if (ty !== 'object' && ty !== 'function') return false;
    if (seen.has(value)) return false;
    seen.add(value);

    if (ty === 'function') {
        try {
            if (value.__repro_instrumented === true) return true;
            if (value[SYM_BODY_TRACED] === true) return true;
            if (value.__repro_body_traced === true) return true;
        } catch {}
    }

    try {
        for (const k of Object.getOwnPropertyNames(value)) {
            const d = Object.getOwnPropertyDescriptor(value, k);
            if (!d) continue;
            if ('value' in d) {
                if (hasBodyTracing(d.value, seen, depth + 1)) return true;
            }
            if (typeof d.get === 'function' && hasBodyTracing(d.get, seen, depth + 1)) return true;
            if (typeof d.set === 'function' && hasBodyTracing(d.set, seen, depth + 1)) return true;
        }
    } catch {}

    const proto = Object.getPrototypeOf(value);
    if (proto && proto !== Object.prototype) {
        if (hasBodyTracing(proto, seen, depth + 1)) return true;
    }
    return false;
}

function reloadUninstrumentedAppModules() {
    const reloaded = new Set();
    Object.keys(require.cache || {}).forEach((filename) => {
        try {
            if (!shouldHandleCacheFile(filename)) return;
            if (String(filename).replace(/\\/g,'/').includes('/tracer/')) return;
            // Only reload typical app output locations to avoid double-transforming ad-hoc scripts/tests.
            if (!/[\\/]((dist|build|out)[\\/]|src[\\/])/i.test(filename.replace(/\\/g,'/'))) return;
            const cached = require.cache[filename];
            if (!cached || !cached.exports) return;
            if (reloaded.has(filename)) return;
            if (cached.__repro_wrapped) return;
            // If exports already show body-level instrumentation, skip reload.
            if (hasBodyTracing(cached.exports)) return;

            // Reload the module so it passes through the Babel wrap hook now installed.
            delete require.cache[filename];
            try { require(filename); reloaded.add(filename); } catch {}
        } catch {}
    });
}

// Force-wrap live instances/prototypes for late-loaded classes/objects.
function forceWrapLiveTargets() {
    try {
        if (typeof instrumentExports !== 'function') return;

        const seen = new WeakSet();
        const maxDepth = 3;
        const deepInstrument = (val, filename, depth = 0) => {
            if (!val || depth > maxDepth) return;
            const ty = typeof val;
            if (ty !== 'object' && ty !== 'function') return;
            if (seen.has(val)) return;
            seen.add(val);
            try { instrumentExports(val, filename, path.basename(filename)); } catch {}
            try {
                if (ty === 'object') {
                    for (const k of Object.keys(val)) {
                        deepInstrument(val[k], filename, depth + 1);
                    }
                }
            } catch {}
        };

        Object.keys(require.cache || {}).forEach((filename) => {
            try {
                if (!shouldHandleCacheFile(filename)) return;
                const cached = require.cache[filename];
                if (!cached || !cached.exports) return;
                const exp = cached.exports;

                // Wrap exports normally
                instrumentExports(exp, filename, path.basename(filename));

                // If a class/prototype is exported, wrap its prototype too
                if (typeof exp === 'function' && exp.prototype && typeof exp.prototype === 'object') {
                    instrumentExports(exp.prototype, filename + '#prototype', path.basename(filename));
                }

                // If default export is an object instance, wrap its own methods
                if (exp && typeof exp === 'object') {
                    instrumentExports(exp, filename + '#instance', path.basename(filename));
                }

                // Deep instrument nested values to catch pre-created instances.
                deepInstrument(exp, filename, 0);
            } catch {}
        });
    } catch {}
}

require('./index').init({
    instrument: true,
    mode: process.env.TRACE_MODE || 'trace',
    include: includeMatchers,
    exclude: excludeMatchers,
});

// Opportunistically instrument modules that were loaded before the hook was installed.
// This helps when the SDK register is required after some app modules are already in require.cache.
try {
    if (typeof instrumentExports === 'function') {
        Object.keys(require.cache || {}).forEach((filename) => {
            try {
                if (!shouldHandleCacheFile(filename)) return;
                const cached = require.cache[filename];
                if (!cached || !cached.exports) return;
                instrumentExports(cached.exports, filename, path.basename(filename));
            } catch {}
        });
        // Also force-wrap live instances/prototypes after cache pass
        forceWrapLiveTargets();
    }
} catch {}

// Reload already-required app modules that were loaded before the hook so their callsites are wrapped.
try { reloadUninstrumentedAppModules(); } catch {}
