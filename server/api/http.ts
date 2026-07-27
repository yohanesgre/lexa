import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpServerResponse } from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { d1Live } from "../db/d1";
import { errorResponse, errorToStatus } from "./errors";
import { ProjectService } from "../services/project.service";
import { ProjectRepo } from "../repos/project.repo";

const healthEndpoint = HttpApiEndpoint.get("health", "/health").addSuccess(
  Schema.Struct({ ok: Schema.Boolean })
);

const healthGroup = HttpApiGroup.make("health").add(healthEndpoint);

const ProjectSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  description: Schema.String,
  githubRepo: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const ProjectListResponse = Schema.Struct({
  data: Schema.Array(ProjectSchema),
  nextCursor: Schema.NullOr(Schema.String),
});

const CreateProjectPayload = Schema.Struct({
  name: Schema.String,
  slug: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  githubRepo: Schema.optional(Schema.NullOr(Schema.String)),
});

const SlugPath = Schema.Struct({
  slug: Schema.String,
});

const listEndpoint = HttpApiEndpoint.get("list", "/projects").addSuccess(ProjectListResponse, { status: 200 });

const createEndpoint = HttpApiEndpoint.post("create", "/projects")
  .setPayload(CreateProjectPayload)
  .addSuccess(ProjectSchema, { status: 201 });

const getBySlugEndpoint = HttpApiEndpoint.get("getBySlug", "/projects/:slug")
  .setPath(SlugPath)
  .addSuccess(ProjectSchema, { status: 200 });

const projectsGroup = HttpApiGroup.make("projects")
  .add(listEndpoint)
  .add(createEndpoint)
  .add(getBySlugEndpoint);

export const LexaApi = HttpApi.make("lexa")
  .add(healthGroup)
  .add(projectsGroup)
  .prefix("/api");

const apiLayer = HttpApiBuilder.api(LexaApi);

const respond = <A, E, R>(eff: Effect.Effect<A, E, R>): Effect.Effect<A | HttpServerResponse.HttpServerResponse, never, R> =>
  eff.pipe(
    Effect.catchAll((e) =>
      Effect.succeed(
        HttpServerResponse.unsafeJson(errorResponse(e as { _tag: string } & Record<string, unknown>), {
          status: errorToStatus(e as { _tag: string }),
        })
      )
    )
  );

const healthLive = HttpApiBuilder.group(LexaApi, "health", (handlers) =>
  handlers.handle("health", () => Effect.succeed({ ok: true as const }))
);

const projectsLive = HttpApiBuilder.group(LexaApi, "projects", (handlers) =>
  handlers
    .handle("list", () =>
      respond(
        Effect.gen(function* () {
          const service = yield* ProjectService;
          const projects = yield* service.list();
          const nextCursor: string | null = null;
          return {
            data: projects.map((p) => ({
              id: p.id,
              name: p.name,
              slug: p.slug,
              description: p.description,
              githubRepo: p.githubRepo,
              createdAt: p.createdAt,
              updatedAt: p.updatedAt,
            })),
            nextCursor,
          };
        })
      )
    )
    .handle("create", (req) =>
      respond(
        Effect.gen(function* () {
          const service = yield* ProjectService;
          const project = yield* service.create({
            name: req.payload.name,
            slug: req.payload.slug,
            description: req.payload.description,
            githubRepo: req.payload.githubRepo,
          });
          return {
            id: project.id,
            name: project.name,
            slug: project.slug,
            description: project.description,
            githubRepo: project.githubRepo,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          };
        })
      )
    )
    .handle("getBySlug", (req) =>
      respond(
        Effect.gen(function* () {
          const service = yield* ProjectService;
          const project = yield* service.findBySlug(req.path.slug);
          return {
            id: project.id,
            name: project.name,
            slug: project.slug,
            description: project.description,
            githubRepo: project.githubRepo,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          };
        })
      )
    )
);

export function createApiHandler() {
  const serviceLayer = Layer.mergeAll(ProjectRepo.Default, ProjectService.Default);
  const handlerLayer = Layer.mergeAll(healthLive, projectsLive).pipe(
    Layer.provide(serviceLayer),
    Layer.provide(d1Live),
  );
  const merged = Layer.mergeAll(apiLayer, handlerLayer);
  return HttpApiBuilder.toWebHandler(merged as unknown as Parameters<typeof HttpApiBuilder.toWebHandler>[0]);
}
