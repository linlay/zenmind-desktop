import { type ServiceId } from "../../../../shared/contracts";

export const startedThisSession = new Set<ServiceId>();

export const inFlightBuiltinInstalls = new Map<string, Promise<string>>();

export const backgroundStartupPreparationTasks = new Set<Promise<void>>();
