# One image for API and UI: the SPA is built first and embedded into the Go binary.

FROM node:24-alpine AS ui
WORKDIR /src/ui
RUN corepack enable
COPY ui/package.json ui/pnpm-lock.yaml ui/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY ui/ ./
RUN mkdir -p /src/server/web/dist && pnpm build

FROM golang:1.26-alpine AS server
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
COPY --from=ui /src/server/web/dist ./web/dist
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X argonaut/internal/service.Version=${VERSION}" -o /out/argonaut ./cmd

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=server /out/argonaut /app/argonaut
COPY server/db/migration /app/db/migration
USER nonroot:nonroot
EXPOSE 4100
ENTRYPOINT ["/app/argonaut"]
CMD ["server", "-c", "/app/configs"]
