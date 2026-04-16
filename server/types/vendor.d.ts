// Vendor module declarations for packages without @types definitions

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare module 'node-cron' {
  const cron: any;
  export = cron;
}
