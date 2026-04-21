import { shouldStartInitialWorkerRefresh } from '@/features/workers/hooks/useWorkerData';

describe('shouldStartInitialWorkerRefresh', () => {
  it('starts immediately for standalone pages once the first refresh has not started', () => {
    expect(shouldStartInitialWorkerRefresh({
      hasStarted: false,
      appMode: false,
      accessToken: '',
      lastStartedToken: '',
    })).toBe(true);
    expect(shouldStartInitialWorkerRefresh({
      hasStarted: false,
      appMode: false,
      accessToken: 'desktop-token',
      lastStartedToken: '',
    })).toBe(true);
  });

  it('does not auto refresh again after the initial refresh has started with the same token', () => {
    expect(shouldStartInitialWorkerRefresh({
      hasStarted: true,
      appMode: false,
      accessToken: 'desktop-token',
      lastStartedToken: 'desktop-token',
    })).toBe(false);
  });

  it('waits for app-mode token hydration before the first fetch', () => {
    expect(shouldStartInitialWorkerRefresh({
      hasStarted: false,
      appMode: true,
      accessToken: '',
      lastStartedToken: '',
    })).toBe(false);

    expect(shouldStartInitialWorkerRefresh({
      hasStarted: false,
      appMode: true,
      accessToken: 'desktop-token',
      lastStartedToken: '',
    })).toBe(true);
  });

  it('retries once after desktop token hydration finishes', () => {
    expect(shouldStartInitialWorkerRefresh({
      hasStarted: true,
      appMode: true,
      accessToken: 'desktop-token',
      lastStartedToken: '',
    })).toBe(true);
  });

  it('does not retry when app-mode token stays empty after the first attempt', () => {
    expect(shouldStartInitialWorkerRefresh({
      hasStarted: true,
      appMode: true,
      accessToken: '',
      lastStartedToken: '',
    })).toBe(false);
  });

  it('keeps the first-fetch rule independent from websocket readiness in standalone mode', () => {
    expect(shouldStartInitialWorkerRefresh({
      hasStarted: false,
      appMode: false,
      accessToken: 'desktop-token',
      lastStartedToken: '',
    })).toBe(true);
  });
});
