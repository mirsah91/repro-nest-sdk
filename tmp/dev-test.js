const { reproMiddleware, initReproTracing } = require('../dist');
const tracer = require('../tracer');
const { EventEmitter } = require('events');

initReproTracing({ instrument: true, traceInterceptors: true, logFunctionCalls: false });

const posts = [];
global.fetch = async (url, opts = {}) => {
  posts.push({ url: String(url), body: opts.body });
  return { ok: true, json: async () => ({ ok: true }) };
};

const cfg = { appId: 'app', tenantId: 'tenant', appSecret: 'secret' };
const middleware = reproMiddleware(cfg);

function makeReqRes(sessionId) {
  const req = new EventEmitter();
  req.headers = {
    'x-bug-session-id': sessionId,
    'x-bug-action-id': `action-${sessionId}`,
    'x-bug-request-start': '12345', // force same header for collision testing
  };
  req.method = 'GET';
  req.url = '/test';
  req.body = { hello: 'world' };
  req.params = { id: 1 };
  req.query = { q: '1' };

  const res = new EventEmitter();
  res.statusCode = 200;
  res.getHeader = () => undefined;
  res.setHeader = () => {};
  res.json = function (body) { this.body = body; return this; };
  res.send = function (body) { this.body = body; return this; };
  res.write = () => true;
  res.end = () => {};

  return { req, res };
}

async function runSession(sessionId) {
  posts.length = 0;
  const { req, res } = makeReqRes(sessionId);

  await new Promise(resolve => {
    middleware(req, res, () => {
      tracer.tracer.enter('handler', { file: 'app.js', line: 1, functionType: 'function' });
      tracer.tracer.exit({ fn: 'handler', file: 'app.js', line: 1, functionType: 'function' }, { returnValue: 42 });
      // mark request finished
      setImmediate(() => {
        res.emit('finish');
        resolve();
      });
    });
  });

  // wait for flush timers to run
  await new Promise(r => setTimeout(r, 3000));
  console.log('session', sessionId, 'posts', posts.length);
  posts.forEach((p, i) => {
    console.log(`#${i + 1}`, p.url, p.body);
  });
}

(async () => {
  await Promise.all([runSession('s1'), runSession('s2')]);
})();
