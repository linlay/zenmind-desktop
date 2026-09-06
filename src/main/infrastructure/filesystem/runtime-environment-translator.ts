export type RuntimeEnvironmentTranslator = (key: any, values?: any) => string;

let translateRuntimeEnvironment: RuntimeEnvironmentTranslator = (key, values) => {
  if (!values) return key;
  return Object.entries(values).reduce(
    (message, [name, value]) => `${message} ${name}=${String(value)}`,
    key
  );
};

export function configureRuntimeEnvironmentTranslator(translator: RuntimeEnvironmentTranslator) {
  translateRuntimeEnvironment = translator;
}

export const t = (key: string, values?: Record<string, unknown>) =>
  translateRuntimeEnvironment(key, values);
