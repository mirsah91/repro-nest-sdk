const fs = require('node:fs');
const path = require('node:path');
const { GenericContainer, Wait } = require('testcontainers');

async function runContainerTest() {
    const workspace = process.cwd();
    const eventsFile = path.join(workspace, 'tmp', 'nest-app-events.json');
    try { fs.unlinkSync(eventsFile); } catch {}

    const container = await new GenericContainer('node:20')
        .withBindMounts([{ source: workspace, target: '/workspace', mode: 'rw' }])
        .withWorkingDir('/workspace')
        .withEnvironment({
            TRACE_DEBUG_UNAWAITED: '0',
            TRACE_QUIET: '1'
        })
        .withCommand(['node', '-r', './tracer/register', 'tmp/nest-app.js'])
        .withWaitStrategy(Wait.forLogMessage('Wrote events'))
        .start();

    try {
        await container.stop();
    } catch (err) {
        console.warn('Failed to stop container cleanly:', err);
    }

    if (!fs.existsSync(eventsFile)) {
        throw new Error(`Events file ${eventsFile} was not generated`);
    }

    const events = JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
    const exitEvent = events.find(ev =>
        ev.type === 'exit' &&
        ev.fn === 'generateShipmentRequestNotifications'
    );

    if (!exitEvent) {
        throw new Error('Expected exit event for generateShipmentRequestNotifications');
    }

    console.log('Container test passed:', {
        exitDepth: exitEvent.depth,
        unawaited: exitEvent.unawaited === true
    });
}

runContainerTest().catch(err => {
    console.error('Container test failed:', err);
    process.exit(1);
});
