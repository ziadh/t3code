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
      const name =
        typeof model.name === "string"
          ? model.name.trim()
          : typeof model.id === "string"
            ? model.id.trim()
            : "";
      if (!slug || !name || !supportsTools(model)) {
        return [];
      }

      const contextWindowTokens = normalizePositiveInt(model.context_length);
      return [
        {
          slug,
          name,
          supportsTools: true,
          ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
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

const fetchOpenRouterCatalog = (): Effect.Effect<ServerProviderCatalogs["openrouter"]> => {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return Effect.succeed([]);
  }

  return Effect.promise(async () => {
    try {
      const response = await fetch(OPENROUTER_MODELS_URL, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      if (!response.ok) {
        return [];
      }
      const payload = await response.json();
      return normalizeOpenRouterCatalogPayload(payload);
    } catch {
      return [];
    }
  });
};

const makeProviderMetadata = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providerHealth = yield* ProviderHealth;
  const cacheDir = path.join(stateDir, "provider-model-catalogs");
  const cachePath = path.join(cacheDir, OPENROUTER_CACHE_FILE);

  const loadCachedCatalogs = Effect.sync(() => cachePath).pipe(
    Effect.flatMap((resolvedCachePath) =>
      fileSystem.readFileString(resolvedCachePath).pipe(Effect.catch(() => Effect.succeed(""))),
    ),
    Effect.flatMap((raw) => {
      if (!raw) {
        return Effect.succeed(defaultCatalogs());
      }
      return Effect.sync(() => {
        try {
          const parsed = JSON.parse(raw) as unknown;
          return isServerProviderCatalogs(parsed)
            ? ({
                codex: toCodexCatalog(),
                openrouter: parsed.openrouter,
              } satisfies ServerProviderCatalogs)
            : defaultCatalogs();
        } catch {
          return defaultCatalogs();
        }
      });
    }),
  );

  const persistCachedCatalogs = (catalogs: ServerProviderCatalogs) =>
    fileSystem.makeDirectory(cacheDir, { recursive: true }).pipe(
      Effect.catch(() => Effect.void),
      Effect.flatMap(() =>
        fileSystem
          .writeFileString(cachePath, JSON.stringify(catalogs, null, 2))
          .pipe(Effect.catch(() => Effect.void)),
      ),
    );

  const cachedCatalogs = yield* loadCachedCatalogs;
  const initialSnapshot: ProviderMetadataSnapshot = {
    providers: yield* providerHealth.getStatuses,
    providerCatalogs: cachedCatalogs,
  };
  const snapshotRef = yield* Ref.make(initialSnapshot);
  const pubsub = yield* PubSub.unbounded<ProviderMetadataSnapshot>();

  const refresh: ProviderMetadataShape["refresh"] = Effect.gen(function* () {
    const providers = yield* providerHealth.getStatuses;
    const fetchedOpenRouterCatalog = yield* fetchOpenRouterCatalog();
    const fallbackCatalogs = yield* loadCachedCatalogs;
    const nextCatalogs: ServerProviderCatalogs = {
      codex: toCodexCatalog(),
      openrouter:
        fetchedOpenRouterCatalog.length > 0 ? fetchedOpenRouterCatalog : fallbackCatalogs.openrouter,
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
