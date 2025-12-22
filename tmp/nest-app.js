require('reflect-metadata');

const path = require('node:path');
const { NestFactory } = require('@nestjs/core');
const { Module, Injectable } = require('@nestjs/common');
const { trace, setFunctionLogsEnabled } = require('../tracer/runtime');

setFunctionLogsEnabled(false);

function handleNotificationError(promise) {
    promise?.catch?.(() => {});
}

class MapperManager {
    static mapToClass(target, payload) {
        return { target, payload };
    }
}

class MailerService {
    async generateShipmentRequestNotifications(payload) {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { delivered: true, payload };
    }
}
Injectable()(MailerService);

class ShipmentService {
    constructor(mailer) {
        this.mailer = mailer;
    }

    async createShipment(input) {
        handleNotificationError(this.mailer.generateShipmentRequestNotifications({
            protocolId: input.protocolId,
            shipmentId: input.shipmentId,
            userId: input.userId
        }));

        return MapperManager.mapToClass('ShipmentOutput', {
            shipmentId: input.shipmentId,
            userId: input.userId
        });
    }
}
Injectable()(ShipmentService);

class AppModule {}
Module({
    providers: [
        MailerService,
        {
            provide: ShipmentService,
            useFactory: (mailer) => new ShipmentService(mailer),
            inject: [MailerService]
        }
    ],
    exports: [ShipmentService]
})(AppModule);

module.exports = {
    MailerService,
    ShipmentService,
    AppModule
};

async function main() {
    const events = [];
    const off = trace.on(ev => {
        if (ev.fn === 'generateShipmentRequestNotifications') {
            events.push(ev);
        }
    });

    const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    const svc = app.get(ShipmentService);
    await svc.createShipment({ protocolId: 'p', shipmentId: 's-1', userId: 'u-1' });
    await new Promise(resolve => setTimeout(resolve, 25));
    await app.close();
    off();

    const outputPath = path.join(__dirname, 'nest-app-events.json');
    require('node:fs').writeFileSync(outputPath, JSON.stringify(events, null, 2));
    console.log(`Wrote events to ${outputPath}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
