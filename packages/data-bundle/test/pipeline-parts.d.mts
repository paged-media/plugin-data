// Types for pipeline-parts.mjs (the engine is the wasm-bindgen DataEngine;
// the parts treat it as loosely as its JSON boundary is).
/* eslint-disable @typescript-eslint/no-explicit-any */
export declare const BIN: string;
export declare const TODAY: number;
export declare function defineCatalog(engine: any): void;
export declare function assertLowered(lowered: any, label: string): any;
export declare function bootEngine(): Promise<any>;
export declare function partA(): Promise<{ kind: string; text: string; rows: unknown[] }>;
export declare function partC(): Promise<void>;
export declare function partD(): Promise<void>;
export declare function partE(): Promise<void>;
