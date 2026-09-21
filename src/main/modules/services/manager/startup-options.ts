import { StartServiceOptions } from "./manager-contracts";
import { getStartupServiceStateReadOptions, getStartupResponsiveServiceStateReadOptions } from "./service-state";

export function getPreparedStartupStartOptions(): StartServiceOptions {
  const stateReadOptions = getStartupServiceStateReadOptions();
  const responsiveReadOptions = getStartupResponsiveServiceStateReadOptions();
  return {
    skipPreStartRequirements: true,
    skipBuiltinAssetRefresh: true,
    stateReadOptions,
    commandStateReadOptions: responsiveReadOptions,
    verificationOptions: {
      stateReadOptions: responsiveReadOptions,
      skipManagedPortProbe: true
    }
  };
}

export function yieldStartupScheduler() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
