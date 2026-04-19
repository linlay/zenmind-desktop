import { shouldStartInitialWorkerRefresh } from './useWorkerData';

describe('shouldStartInitialWorkerRefresh', () => {
  it('starts immediately for non-ws transport before the first fetch', () => {
    expect(shouldStartInitialWorkerRefresh({
      transportMode: 'sse',
      wsStatus: 'disconnected',
      hasStarted: false,
      accessToken: '',
      lastStartedToken: '',
    })).toBe(true);
  });

  it('waits for websocket connection before auto refresh in ws mode', () => {
    expect(shouldStartInitialWorkerRefresh({
      transportMode: 'ws',
      wsStatus: 'disconnected',
      hasStarted: false,
      accessToken: '',
      lastStartedToken: '',
    })).toBe(false);
    expect(shouldStartInitialWorkerRefresh({
      transportMode: 'ws',
      wsStatus: 'connecting',
      hasStarted: false,
      accessToken: '',
      lastStartedToken: '',
    })).toBe(false);
    expect(shouldStartInitialWorkerRefresh({
      transportMode: 'ws',
      wsStatus: 'error',
      hasStarted: false,
      accessToken: '',
      lastStartedToken: '',
    })).toBe(false);
    expect(shouldStartInitialWorkerRefresh({
      transportMode: 'ws',
      wsStatus: 'connected',
      hasStarted: false,
      accessToken: '',
      lastStartedToken: '',
    })).toBe(true);
  });

  it('does not auto refresh again after the initial refresh has started with the same token', () => {
    expect(shouldStartInitialWorkerRefresh({
      transportMode: 'ws',
      wsStatus: 'connected',
      hasStarted: true,
      accessToken: 'token_a',
      lastStartedToken: 'token_a',
    })).toBe(false);
    expect(shouldStartInitialWorkerRefresh({
      transportMode: 'sse',
      wsStatus: 'disconnected',
      hasStarted: true,
      accessToken: '',
      lastStartedToken: '',
    })).toBe(false);
  });

  it('retries once after websocket token hydration finishes', () => {
    expect(shouldStartInitialWorkerRefresh({
      transportMode: 'ws',
      wsStatus: 'connected',
      hasStarted: true,
      accessToken: 'token_b',
      lastStartedToken: '',
    })).toBe(true);
  });

  it('matches the intended first-load sequence for websocket mode', () => {
    let hasStarted = false;

    expect(shouldStartInitialWorkerRefresh({
      transportMode: 'ws',
      wsStatus: 'disconnected',
      hasStarted,
      accessToken: '',
      lastStartedToken: '',
    })).toBe(false);

    expect(shouldStartInitialWorkerRefresh({
      transportMode: 'ws',
      wsStatus: 'connected',
      hasStarted,
      accessToken: '',
      lastStartedToken: '',
    })).toBe(true);
    hasStarted = true;

    expect(shouldStartInitialWorkerRefresh({
      transportMode: 'ws',
      wsStatus: 'connected',
      hasStarted,
      accessToken: '',
      lastStartedToken: '',
    })).toBe(false);

    expect(shouldStartInitialWorkerRefresh({
      transportMode: 'ws',
      wsStatus: 'connected',
      hasStarted,
      accessToken: 'token_b',
      lastStartedToken: '',
    })).toBe(true);
  });
});
