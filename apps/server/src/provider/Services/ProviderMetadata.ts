import type { ServerProviderCatalogs, ServerProviderStatus } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

export interface ProviderMetadataSnapshot {
  readonly providers: ReadonlyArray<ServerProviderStatus>;
  readonly providerCatalogs: ServerProviderCatalogs;
}

export interface ProviderMetadataShape {
  readonly getSnapshot: Effect.Effect<ProviderMetadataSnapshot>;
  readonly refresh: Effect.Effect<void>;
  readonly changes: Stream.Stream<ProviderMetadataSnapshot>;
}

export class ProviderMetadata extends ServiceMap.Service<ProviderMetadata, ProviderMetadataShape>()(
  "t3/provider/Services/ProviderMetadata",
) {}
