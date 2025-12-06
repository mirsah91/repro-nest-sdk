// register.js
const escapeRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const path = require('node:path');
const cwd = process.cwd().replace(/\\/g, '/');
const hook = require('require-in-the-middle');
const { instrumentExports } = require('./dep-hook');

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
];

function shouldHandleCacheFile(file) {
    const f = String(file || '').replace(/\\/g, '/');
    if (!f) return false;
    if (excludeMatchers.some(rx => rx.test(f))) return false;
    return includeMatchers.some(rx => rx.test(f));
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
