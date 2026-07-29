import { expectTypeOf, describe, it } from 'vitest';
import type { ObservableStatus } from '../src/useObservable';

/**
 * Type-level regression guards for the public type surface (#749).
 *
 * 4.2.4 shipped a breaking type change as a patch: `ObservableStatus<T>` went
 * from a flat interface to a discriminated union, so `data` became
 * `T | undefined` and the documented destructure-and-use pattern stopped
 * compiling for strict-TS consumers.
 *
 * These assert the shape directly rather than exercising it through a hook.
 * Reading `result.current.data?.a` in a runtime test does **not** catch that
 * regression, because optional chaining compiles against both shapes.
 */
describe('ObservableStatus', () => {
  it('exposes data as T, not T | undefined', () => {
    expectTypeOf<ObservableStatus<string>['data']>().toEqualTypeOf<string>();
  });

  it('does not admit undefined into data', () => {
    expectTypeOf<ObservableStatus<string>['data']>().not.toEqualTypeOf<string | undefined>();
  });

  it('keeps the documented destructure-and-use pattern compiling', () => {
    const use = (status: ObservableStatus<{ a: string }>) => {
      const { data } = status;
      // The exact shape 4.2.4 broke: a property read with no narrowing and no
      // optional chaining.
      return data.a;
    };
    expectTypeOf(use).returns.toEqualTypeOf<string>();
  });

  it('keeps status a literal union rather than string', () => {
    expectTypeOf<ObservableStatus<string>['status']>().toEqualTypeOf<'loading' | 'error' | 'success'>();
  });

  it('keeps error optional-by-union rather than always present', () => {
    expectTypeOf<ObservableStatus<string>['error']>().toEqualTypeOf<Error | undefined>();
  });
});
