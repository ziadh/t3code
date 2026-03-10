import {
  MODEL_OPTIONS_BY_PROVIDER,
  type ProviderCatalogModel,
  type ServerProviderCatalogs,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Path, PubSub, Ref, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { ProviderHealth } from "../Services/ProviderHealth.ts";
import {
  ProviderMetadata,
  type ProviderMetadataShape,
  type ProviderMetadataSnapshot,
} from "../Services/ProviderMetadata.ts";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_CACHE_FILE = "openrouter-models.json";

function toCodexCatalog(): ServerProviderCatalogs["codex"] {
  return MODEL_OPTIONS_BY_PROVIDER.codex.map(
    (model) =>
      ({
        slug: model.slug,
        name: model.name,
        supportsTools: true,
      }) satisfies ProviderCatalogModel,
  );
}

function normalizePositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function supportsTools(model: Record<string, unknown>): boolean {
  const supportedParameters = Array.isArray(model.supported_parameters)
    ? model.supported_parameters.filter((value): value is string => typeof value === "string")
    : [];
  if (supportedParameters.length === 0) {
    return true;
  }
  return supportedParameters.some(
    (parameter) =>
      parameter === "tools" || parameter === "tool_choice" || parameter === "parallel_tool_calls",
  );
}

function normalizeOpenRouterCatalogPayload(payload: unknown): ServerProviderCatalogs["openrouter"] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const model = entry as Record<string, unknown>;
      const slug = typeof model.id === "string" ? model.id.trim() : "";
      const nameCandidate =
        typeof model.name === "string" ? model.name.trim() : typeof model.id === "string" ? model.id.trim() : "";
      if (!slug || !nameCandidate) {
        return [];
      }
      return [
        {
          slug,
          name: nameCandidate,
          supportsTools: supportsTools(model),
          ...(normalizePositiveInt(model.context_length) !== undefined
            ? { contextWindowTokens: normalizePositiveInt(model.context_length) }
            : {}),
        } satisfies ProviderCatalogModel,
      ];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name) || left.slug.localeCompare(right.slug));
}

function isServerProviderCatalogs(value: unknown): value is ServerProviderCatalogs {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.codex) && Array.isArray(candidate.openrouter);
}

const defaultCatalogs = (): ServerProviderCatalogs => ({
  codex: toCodexCatalog(),
  openrouter: [],
});

const loadCachedCatalogs = Effect.fn(function* () {
  const { stateDir } = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cachePath = path.join(stateDir, "provider-model-catalogs", OPENROUTER_CACHE_FILE);
  const raw = yield* fileSystem.readFileString(cachePath).pipe(Effect.catch(() => Effect.succeed(null)));
  if (!raw) {
    return defaultCatalogs();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isServerProviderCatalogs(parsed)) {
      return defaultCatalogs();
    }
    return {
      codex: toCodexCatalog(),
      openrouter: parsed.openrouter,
    } satisfies ServerProviderCatalogs;
  } catch {
    return defaultCatalogs();
  }
});

const persistCachedCatalogs = Effect.fn(function* (catalogs: ServerProviderCatalogs) {
  const { stateDir } = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cacheDir = path.join(stateDir, "provider-model-catalogs");
  const cachePath = path.join(cacheDir, OPENROUTER_CACHE_FILE);
  yield* fileSystem.makeDirectory(cacheDir, { recursive: true }).pipe(Effect.catch(() => Effect.void));
  yield* fileSystem
    .writeFileString(cachePath, JSON.stringify(catalogs, null, 2))
    .pipe(Effect.catch(() => Effect.void));
});

const fetchOpenRouterCatalog = Effect.fn(function* (): Effect.Effect<
  ServerProviderCatalogs["openrouter"],
  never
> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return [];
  }
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(OPENROUTER_MODELS_URL, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }),
    catch: () => null,
  });
  if (!response || !response.ok) {
    return [];
  }
  const payload = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: () => null,
  });
  return normalizeOpenRouterCatalogPayload(payload);
});

const makeProviderMetadata = Effect.gen(function* () {
  const providerHealth = yield* ProviderHealth;
  const cachedCatalogs = yield* loadCachedCatalogs();
  const initialSnapshot: ProviderMetadataSnapshot = {
    providers: yield* providerHealth.getStatuses,
    providerCatalogs: cachedCatalogs,
  };
  const snapshotRef = yield* Ref.make(initialSnapshot);
  const pubsub = yield* PubSub.unbounded<ProviderMetadataSnapshot>();

  const refresh: ProviderMetadataShape["refresh"] = Effect.gen(function* () {
    const providers = yield* providerHealth.getStatuses;
    const fetchedOpenRouterCatalog = yield* fetchOpenRouterCatalog();
    const fallbackCatalogs = yield* loadCachedCatalogs();
    const nextCatalogs: ServerProviderCatalogs = {
      codex: toCodexCatalog(),
      openrouter:
        fetchedOpenRouterCatalog.length > 0
          ? fetchedOpenRouterCatalog
          : fallbackCatalogs.openrouter,
    };
    const nextSnapshot: ProviderMetadataSnapshot = {
      providers,
      providerCatalogs: nextCatalogs,
    };
    const previousSnapshot = yield* Ref.get(snapshotRef);
    if (JSON.stringify(previousSnapshot) === JSON.stringify(nextSnapshot)) {
      return;
    }
    yield* Ref.set(snapshotRef, nextSnapshot);
    if (fetchedOpenRouterCatalog.length > 0) {
      yield* persistCachedCatalogs(nextCatalogs);
    }
    yield* PubSub.publish(pubsub, nextSnapshot);
  });

  return {
    getSnapshot: Ref.get(snapshotRef),
    refresh,
    changes: Stream.fromPubSub(pubsub),
  } satisfies ProviderMetadataShape;
});

export const ProviderMetadataLive = Layer.effect(ProviderMetadata, makeProviderMetadata);
