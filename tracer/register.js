// register.js
const escapeRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cwd = process.cwd().replace(/\\/g, '/');

// include: your project (excluding its node_modules), plus the specific third-party files we care about
const projectNoNodeModules = new RegExp('^' + escapeRx(cwd) + '/(?!node_modules/)');
// match these files via the hook’s per-file logic; include broad paths so the hook sees them:
const expressPath  = /node_modules[\\/]express[\\/]/;
const mongoosePath = /node_modules[\\/]mongoose[\\/]/;

require('./index').init({
    instrument: true,
    mode: process.env.TRACE_MODE || 'v8',
    include: [ projectNoNodeModules, expressPath, mongoosePath ],
    exclude: [
        /[\\/]omnitrace[\\/].*/,            // don't instrument the tracer
    ],
});
