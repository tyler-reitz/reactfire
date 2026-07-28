export interface A { b: B; tag: string | undefined; }
export interface B { a?: A; tag: string | undefined; }
export {};
