import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../mocks/chrome';

let mock: ChromeMock;

beforeEach(async () => {
  mock = installChromeMock({ manifestVersion: '1.2.3' });
  // The service worker registers its listeners at import time, exactly as MV3 requires, so the
  // mock has to be in place first and the module registry has to be clean between tests.
  vi.resetModules();
  await import('../../../src/background/index');
});

afterEach(() => {
  uninstallChromeMock();
});

describe('service-worker message router', () => {
  it('answers PING with the running version', async () => {
    await expect(mock.sendMessage({ type: 'PING' })).resolves.toEqual({
      type: 'PONG',
      version: '1.2.3',
    });
  });

  it('stays silent for messages that are not ours', async () => {
    for (const message of [null, undefined, 'PING', 42, {}, { type: 'NOT_OURS' }, []]) {
      await expect(mock.sendMessage(message)).resolves.toBeUndefined();
    }
  });

  it('registers an onInstalled handler that does not throw', () => {
    expect(() => {
      mock.triggerInstalled();
    }).not.toThrow();
  });
});
