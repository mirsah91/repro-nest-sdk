const MapperManager = {
  mapToClass(cls: any, data: any) {
    return { cls, data };
  }
};

function handleNotificationError(p: Promise<any>) {
  p.catch(() => {});
}

function tets() {
  console.log('test')
}

class Mailer {
  async generateShipmentRequestNotifications(payload: any) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    tets();
    return payload;
  }
}

export class Foo {
  private mailer = new Mailer();

  async createShipment() {
    handleNotificationError(this.mailer.generateShipmentRequestNotifications({ protocolId: 123 }));
    return MapperManager.mapToClass('ShipmentOutput', { foo: 'bar' });
  }
}
