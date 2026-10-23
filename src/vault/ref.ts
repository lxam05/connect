export const REF_PREFIX = "keysmith://";

export interface ParsedRef {
  project: string;
  service: string;
  envVar: string;
}

const SEGMENT = /^[a-z0-9._-]+$/;
const ENV_VAR = /^[A-Z_][A-Z0-9_]*$/;

export function makeRef(project: string, service: string, envVar: string): string {
  return `${REF_PREFIX}${project}/${service}/${envVar}`;
}

export function isRef(value: string): boolean {
  return value.startsWith(REF_PREFIX);
}

export function parseRef(ref: string): ParsedRef {
  if (!isRef(ref)) throw new Error(`not a keysmith ref: ${ref}`);
  const parts = ref.slice(REF_PREFIX.length).split("/");
  const [project, service, envVar] = parts;
  if (
    parts.length !== 3 ||
    !project ||
    !service ||
    !envVar ||
    !SEGMENT.test(project) ||
    !SEGMENT.test(service) ||
    !ENV_VAR.test(envVar)
  ) {
    throw new Error(`malformed keysmith ref: ${ref}`);
  }
  return { project, service, envVar };
}

/** Keychain account name for a ref: <project>/<service>/<VAR>. */
export function refAccount(ref: string): string {
  const { project, service, envVar } = parseRef(ref);
  return `${project}/${service}/${envVar}`;
}
