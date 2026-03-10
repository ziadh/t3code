/**
 * OpenRouterAdapter - OpenRouter implementation of the generic provider adapter contract.
 *
 * This service owns the native in-process OpenRouter harness and emits
 * canonical provider runtime events without relying on an external CLI.
 *
 * @module OpenRouterAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface OpenRouterAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "openrouter";
}

export class OpenRouterAdapter extends ServiceMap.Service<
  OpenRouterAdapter,
  OpenRouterAdapterShape
>()("t3/provider/Services/OpenRouterAdapter") {}
