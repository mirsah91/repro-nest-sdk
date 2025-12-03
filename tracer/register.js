// register.js
const escapeRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
// match these files via the hook’s per-file logic; include broad paths so the hook sees them:
const expressPath  = /node_modules[\\/]express[\\/]/;
const mongoosePath = /node_modules[\\/]mongoose[\\/]/;

require('./index').init({
    instrument: true,
    mode: process.env.TRACE_MODE || 'trace',
    include: [ projectNoNodeModules, expressPath, mongoosePath ],
    exclude: [
        /[\\/]omnitrace[\\/].*/,            // don't instrument the tracer
    ],
});
