export declare class Holder<T> {
    private _inner;
    private _pending: (
        value: T
    ) => void;
    protected _mode: string;
    #secret: string;
    get value(): T;
}
export declare function makeHolder<T>(): Holder<T>;
export {};
