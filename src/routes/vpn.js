import { listDevices, addDevice, removeDevice, vpnInfoFor } from '../vpn.js';

export default async function vpnRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/vpn', async (req) => ({
    ...vpnInfoFor(req.account.id),
    devices: vpnInfoFor(req.account.id).enabled ? await listDevices(req.account.id) : [],
  }));

  app.post('/api/vpn/devices', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: { name: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[\\w .()-]+$' } },
      },
    },
  }, async (req, reply) => {
    const result = await addDevice(req, req.body.name.trim());
    // Contains the private key: never cache.
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send(result);
  });

  app.delete('/api/vpn/devices/:id', async (req, reply) => {
    await removeDevice(req, Number(req.params.id));
    return reply.code(204).send();
  });
}
