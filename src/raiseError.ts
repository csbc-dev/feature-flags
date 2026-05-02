export function raiseError(message: string): never {
  throw new Error(`[@csbc-dev/feature-flags] ${message}`);
}
