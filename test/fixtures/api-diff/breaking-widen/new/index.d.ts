export interface Status<T> { data: T | undefined; ok: boolean; }
export declare function useThing<T>(): Status<T>;
export {};
