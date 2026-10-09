// Minimal ambient Node types — zero-dependency stand-in for @types/node.
// This plugin only uses fs/os/path + the global Buffer; declare just what it
// needs. (Why: local `npm install` is broken in some dev environments; this
// keeps `tsc` building without a type dependency while staying type-safe on
// the surface actually used.)

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf-8'): string
  export interface Stats {
    isDirectory(): boolean
    mtime: Date
  }
  export function statSync(path: string): Stats
  export interface Dirent {
    name: string
    isDirectory(): boolean
  }
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[]
}

declare module 'node:os' {
  export function homedir(): string
}

declare module 'node:path' {
  export function resolve(...segments: string[]): string
  export function join(...segments: string[]): string
}

// Buffer is a Node global (no import needed); this declares only the method
// this plugin calls, so tsc type-checks it without @types/node.
declare const Buffer: {
  byteLength(string: string, encoding?: string): number
}