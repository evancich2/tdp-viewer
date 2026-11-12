declare module "occt-import-js" {
  const factory: (options?: { locateFile?: (path: string) => string; wasmBinary?: Uint8Array }) => Promise<unknown>;
  export default factory;
}

declare module "virtual:occt-wasm" {
  const base64: string;
  export default base64;
}
