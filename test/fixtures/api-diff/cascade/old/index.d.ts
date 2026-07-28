export interface Status<T> { data: T; }
type Hook<T> = () => Status<T>;
export declare const useA: Hook<string>;
export declare const useB: Hook<number>;
export declare function useC(): Status<boolean>;
export {};