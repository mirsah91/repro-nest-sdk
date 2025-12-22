"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Foo = void 0;
const MapperManager = {
    mapToClass(cls, data) {
        return { cls, data };
    }
};
function handleNotificationError(p) {
    p.catch(() => { });
}
function tets() {
    console.log('test');
}
class Mailer {
    async generateShipmentRequestNotifications(payload) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        tets();
        return payload;
    }
}
class Foo {
    constructor() {
        this.mailer = new Mailer();
    }
    async createShipment() {
        handleNotificationError(this.mailer.generateShipmentRequestNotifications({ protocolId: 123 }));
        return MapperManager.mapToClass('ShipmentOutput', { foo: 'bar' });
    }
}
exports.Foo = Foo;
