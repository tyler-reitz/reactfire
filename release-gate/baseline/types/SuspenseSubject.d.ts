import { Observable, Subject, Subscriber, Subscription } from 'rxjs';
import { ObservableStatus } from './useObservable';
export declare class SuspenseSubject<T> extends Subject<T> {
    private _timeoutWindow;
    private _suspenseEnabled;
    private _value;
    private _hasValue;
    private _timeoutHandler;
    private _firstEmission;
    private _error;
    private _innerObservable;
    private _warmupSubscription;
    private _immutableStatus;
    private _isComplete;
    private _innerSubscriber;
    private _resolveFirstEmission;
    constructor(innerObservable: Observable<T>, _timeoutWindow: number, _suspenseEnabled: boolean);
    get hasValue(): boolean;
    get value(): T;
    get firstEmission(): Promise<void>;
    private _updateImmutableStatus;
    private _next;
    private _reset;
    _subscribe(subscriber: Subscriber<T>): Subscription;
    get ourError(): any;
    get immutableStatus(): ObservableStatus<T>;
}
