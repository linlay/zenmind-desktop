export type LogStreamSubscription = {
  webContentsId: number;
  cleanup: () => void;
};

export class LogStreamSubscriptionRegistry {
  private readonly subscriptions = new Map<string, LogStreamSubscription>();

  get(subscriptionId: string) {
    return this.subscriptions.get(subscriptionId);
  }

  set(subscriptionId: string, subscription: LogStreamSubscription) {
    this.subscriptions.set(subscriptionId, subscription);
    return this;
  }

  delete(subscriptionId: string) {
    return this.subscriptions.delete(subscriptionId);
  }

  replace(subscriptionId: string, subscription: LogStreamSubscription) {
    this.subscriptions.get(subscriptionId)?.cleanup();
    this.subscriptions.set(subscriptionId, subscription);
  }

  cleanupOwned(subscriptionId: string, webContentsId: number) {
    const current = this.subscriptions.get(subscriptionId);
    if (!current || current.webContentsId !== webContentsId) {
      return false;
    }
    current.cleanup();
    this.subscriptions.delete(subscriptionId);
    return true;
  }

  clear() {
    for (const subscription of this.subscriptions.values()) {
      subscription.cleanup();
    }
    this.subscriptions.clear();
  }
}

export function createLogStreamSubscriptionRegistry() {
  return new LogStreamSubscriptionRegistry();
}
