import * as React from 'react';
import type { FirebaseApp, FirebaseOptions } from 'firebase/app';
export interface FirebaseAppProviderProps {
    firebaseApp?: FirebaseApp;
    firebaseConfig?: FirebaseOptions;
    appName?: string;
    suspense?: boolean;
}
export declare const version: string;
export declare function FirebaseAppProvider(props: React.PropsWithChildren<FirebaseAppProviderProps>): React.JSX.Element;
export declare function useIsSuspenseEnabled(): boolean;
export declare function useSuspenseEnabledFromConfigAndContext(suspenseFromConfig?: boolean): boolean;
export declare function useFirebaseApp(): FirebaseApp;
