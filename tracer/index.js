// index.js

const {
    trace,
    patchHttp,
    startV8,
    printV8,
    patchConsole,
    getCurrentTraceId
} = require('./runtime');
const { installCJS } = require('./cjs-hook');

let INIT = false;

function init(opts = {}) {
    if (INIT) return api();
    INIT = true;

    const {
        instrument = true,
        include,                // e.g. [ new RegExp('^'+process.cwd().replace(/\\/g,'/')+'/') ]
        exclude = [ /node_modules[\\/]/ ],
        parserPlugins = [
            'jsx',
            ['decorators', { version: 'legacy' }], // pick '2023-05' mode if you use stage-3
            'classProperties','classPrivateProperties','classPrivateMethods',
            'dynamicImport','topLevelAwait','typescript',
        ],
        mode = process.env.TRACE_MODE || 'v8',
        samplingMs = 10,
    } = opts;

    // install http ALS context so Express/Nest/Fastify get traceIds without extra code
    patchHttp();
    patchConsole();

    if (instrument) {
        // CJS require hook (for require())
        installCJS({ include, exclude: [...exclude, /node_modules[\\/]@babel[\\/].*/], parserPlugins });
        // ESM users: run with --loader ./omnitrace/esm-loader.mjs (cannot be installed from here)
    }

    if (String(mode).toLowerCase() === 'v8') startV8(samplingMs);
    process.once('SIGINT', async () => { await printV8(); process.exit(0); });

    return api();
}

function api(){
    return {
        init,
        tracer: trace,
        withTrace: trace.withTrace,
        getCurrentTraceId,
    };
}
module.exports = api();
