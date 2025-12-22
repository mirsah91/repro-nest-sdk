require('../tracer/register');
const { trace } = require('../tracer/runtime');
const { getCurrentTraceId } = require('../tracer/runtime');
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const handlers = [
    {
        getRecipients: async () => { await wait(10); return ['a']; },
        getTemplate: () => 'tmpl1',
    },
    {
        getRecipients: async () => { await wait(1); return ['b']; },
        getTemplate: () => 'tmpl2',
    },
];

async function handlerWorker(handler) {
    const recipients = await handler.getRecipients();
    const template = await handler.getTemplate();
    return { recipients, template };
}

async function runScenario() {
    const results = handlers.map(handler => handlerWorker(handler));
    return Promise.all(results);
}

async function main() {
    const events = [];
    const off = trace.on(ev => { events.push(ev); });

    await trace.withTrace('map-loop', async () => {
        console.log('traceId at start of withTrace callback', getCurrentTraceId());
        await runScenario();
    });

    await wait(20);
    off();

    console.log('events len', events.length);
    console.log('traceIds', Array.from(new Set(events.map(e => e.traceId))));
    console.log('first 5', events.slice(0, 5));
    console.log('handlerWorker enters', events.filter(e => e.type==='enter' && e.fn==='handlerWorker'));
}

main().catch(err => { console.error(err); process.exitCode = 1; });
