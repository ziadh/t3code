// @ts-nocheck
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CliConfig, t3Cli } from "./main";
import { OpenLive } from "./open";
import { Command } from "effect/unstable/cli";
import { version } from "../package.json" with { type: "json" };
import { ServerLive } from "./wsServer";
import { NetService } from "@t3tools/shared/Net";
import { FetchHttpClient } from "effect/unstable/http";
import { makeServerProviderLayer, makeServerRuntimeServicesLayer } from "./serverLayers";
import { ProviderHealthLive } from "./provider/Layers/ProviderHealth";
import { ProviderMetadataLive } from "./provider/Layers/ProviderMetadata";
import { AnalyticsServiceLayerLive } from "./telemetry/Layers/AnalyticsService";
import { ServerLoggerLive } from "./serverLogger";
import * as SqlitePersistence from "./persistence/Layers/Sqlite";

const ServerRuntimeLayer = ServerLive.pipe(
  Layer.provideMerge(makeServerRuntimeServicesLayer()),
  Layer.provideMerge(makeServerProviderLayer()),
  Layer.provideMerge(ProviderHealthLive),
  Layer.provideMerge(ProviderMetadataLive),
  Layer.provideMerge(SqlitePersistence.layerConfig),
  Layer.provideMerge(ServerLoggerLive),
  Layer.provideMerge(AnalyticsServiceLayerLive),
);

const RuntimeLayer = Layer.empty.pipe(
  Layer.provideMerge(CliConfig.layer),
  Layer.provideMerge(ServerRuntimeLayer),
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);

Command.run(t3Cli, { version }).pipe(Effect.provide(RuntimeLayer as never), NodeRuntime.runMain);
