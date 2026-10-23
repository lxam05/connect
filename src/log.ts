/**
 * The only place in the codebase allowed to write to the console.
 * Nothing passed here may contain a secret value; callers pass metadata only.
 */
export const log = {
  info: (msg: string) => console.error(msg),
  out: (msg: string) => console.log(msg),
  warn: (msg: string) => console.error(`warning: ${msg}`),
  error: (msg: string) => console.error(`error: ${msg}`),
};
