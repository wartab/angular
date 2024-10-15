/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {DestroyRef} from "@angular/core";
import {takeUntilDestroyed, toSignal} from "@angular/core/rxjs-interop";
import {isObservable, Observable, Subscription} from 'rxjs';
import {Injector} from '../../di/injector';
import {inject} from '../../di/injector_compatibility';
import {Signal} from './api';
import {computed} from './computed';
import {effect} from './effect';
import {signal, WritableSignal} from './signal';
import {untracked} from './untracked';

type ResourceState = "loading" | "ready" | "error" | "refreshing";

type ResourceSource<SourceType> = Signal<SourceType> | Observable<SourceType>;

type ResourceFetcher<SourceType, ResourceType> = (
  sourceValue: SourceType,
  currentValue: ResourceType | undefined,
  refreshing: boolean,
) => ResourceType | Promise<ResourceType> | Observable<ResourceType>;

interface ResourceOptions<ResourceType, ErrorType> {
  initialValue?: ResourceType;
  injector?: Injector;
}

class ResourceImpl<ResourceType, SourceType, ErrorType = any> {
  private readonly injector: Injector;

  private readonly source: Signal<SourceType> | null;
  private readonly fetcher: ResourceFetcher<SourceType, ResourceType>;

  public readonly data: WritableSignal<ResourceType>;
  public readonly error = signal<ErrorType | undefined>(undefined);
  public readonly state = signal<ResourceState>("ready");

  public readonly isReady = computed(() => this.state() !== "loading");
  public readonly isLoading = computed(() => {
    const state = this.state();
    return state === "loading" || state === "refreshing";
  });
  public readonly isRefreshing = computed(() => this.state() === "refreshing");
  public readonly isError = computed(() => this.state() === "error");

  private fetchResult!: ResourceType | Promise<ResourceType> | Observable<ResourceType>;
  private previousSubscription: Subscription | null = null;

  constructor(
    source: ResourceSource<SourceType>,
    fetcher: ResourceFetcher<SourceType, ResourceType>,
    options?: ResourceOptions<ResourceType, ErrorType>,
  ) {
    this.injector = options?.injector ?? inject(Injector);
    this.data = signal(options?.initialValue) as WritableSignal<ResourceType>;

    if (source) {
      if (isObservable(source)) {
        this.source = toSignal(source, {injector: this.injector}) as Signal<SourceType>;
      } else {
        this.source = source;
      }

      effect(() => {
        const sourceValue = this.source!();

        untracked(() => {
          this.runFetcher(sourceValue, false);
        });
      }, {injector: this.injector});

    } else {
      this.source = null;
      this.runFetcher(undefined, false);
    }
    this.fetcher = fetcher;
  }

  public mutate(value: ResourceType) {
    this.data.set(value);
  }

  public refresh(refreshingValue: boolean) {
    const sourceValue = this.source ? this.source() : undefined;
    this.runFetcher(sourceValue, refreshingValue);
  }

  private runFetcher(sourceValue: SourceType | undefined, refreshing: boolean) {
    if (this.previousSubscription) {
      this.previousSubscription.unsubscribe();
      this.previousSubscription = null;
    }

    const newState = refreshing ? "refreshing" : "loading";
    const fetchResult = this.fetcher(sourceValue!, this.data(), refreshing);
    this.fetchResult = fetchResult;

    if (isPromise(fetchResult)) {
      this.state.set(newState);

      fetchResult.then(
        value => {
          if (this.fetchResult === fetchResult) {
            this.data.set(value);
            this.state.set("ready");
          }
        },
        error => {
          if (this.fetchResult === fetchResult) {
            this.error.set(error);
            this.state.set("error");
          }
        },
      );
    } else if (isObservable) {
      this.state.set(newState);

      this.previousSubscription = fetchResult
        .pipe(takeUntilDestroyed(this.injector.get(DestroyRef)))
        .subscribe({
          next: value => {
            if (this.fetchResult === fetchResult) {
              this.data.set(value);
              this.state.set("ready");
            }
          },
          error: error => {
            if (this.fetchResult === fetchResult) {
              this.error.set(error);
              this.state.set("error");
            }
          },
        });
    } else {
      this.data.set(fetchResult);
      this.state.set("ready");
    }
  }
}

function isPromise(value: any): value is Promise<any> {
  return typeof value === "object" && "then" in value;
}

export interface Resource<ResourceType, ErrorType = any> extends Signal<ResourceType> {
  readonly data: Signal<ResourceType | undefined>;
  readonly error: Signal<ErrorType | undefined>;
  readonly state: Signal<ResourceState>;
  readonly isReady: Signal<boolean>;
  readonly isLoading: Signal<boolean>;
  readonly isError: Signal<boolean>;

  mutate(value: ResourceType | undefined): void;
  refresh(): void;

  (): ResourceType;
}


function createResource<ResourceType, SourceType, ErrorType = any>(
  source: ResourceSource<SourceType>,
  fetcher: ResourceFetcher<SourceType, ResourceType>,
  options?: ResourceOptions<ResourceType, ErrorType>,
): Resource<ResourceType, ErrorType> {
  const resource = new ResourceImpl(source, fetcher, options);

  Object.assign(resource.data, resource);
  Object.setPrototypeOf(resource.data, Object.getPrototypeOf(resource));

  return resource.data as any;
}

export function resource<ResourceType, SourceType, ErrorType = any>(
  source: ResourceSource<SourceType> | null,
  fetcher: ResourceFetcher<SourceType, ResourceType>,
  options?: ResourceOptions<ResourceType, ErrorType>,
): Resource<ResourceType, ErrorType>;

export function resource<ResourceType, ErrorType = any>(
  fetcher: ResourceFetcher<undefined, ResourceType>,
  options?: ResourceOptions<ResourceType, ErrorType>,
): Resource<ResourceType, ErrorType>;

export function resource<ResourceType, SourceType, ErrorType = any>(
  param1: ResourceSource<SourceType> | ResourceFetcher<undefined, ResourceType>,
  param2?: ResourceFetcher<SourceType, ResourceType> | ResourceOptions<ResourceType, ErrorType>,
  param3?: ResourceOptions<ResourceType, ErrorType>,
): Resource<ResourceType, ErrorType> {
  let source: ResourceSource<SourceType> | null;
  let fetcher: ResourceFetcher<SourceType, ResourceType>;
  let options: ResourceOptions<ResourceType, ErrorType> | undefined;

  if (arguments.length === 1 || (arguments.length === 2 && typeof param2 === "object")) {
    source = null;
    fetcher = param1 as ResourceFetcher<SourceType, ResourceType>;
    options = param2 as ResourceOptions<ResourceType, ErrorType>;
  } else {
    source = param1 as ResourceSource<SourceType>;
    fetcher = param2 as ResourceFetcher<SourceType, ResourceType>;
    options = param3;
  }

  return createResource(source, fetcher, options);
}
