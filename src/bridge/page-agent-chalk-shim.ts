type ChalkFunction = ((value: unknown) => string) & {
  bold: (value: unknown) => string;
};

function identity(value: unknown) {
  return String(value ?? "");
}

function color(): ChalkFunction {
  const fn = ((value: unknown) => identity(value)) as ChalkFunction;
  fn.bold = identity;
  return fn;
}

const chalk = {
  black: color(),
  gray: color(),
  grey: color(),
  white: color(),
  yellow: color(),
  green: color(),
  red: color(),
  cyan: color(),
  blue: color(),
  magenta: color(),
  bold: identity,
  dim: identity
};

export default chalk;
