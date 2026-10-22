# Root entry points. The server and UI keep their own toolchains (make/go, pnpm); these targets just
# run them in the right order.

.PHONY: all build ui server gen dev-server dev-ui test e2e lint image

all: build

## gen: regenerate every generated artifact (Go and TS from proto, TS from the Argo schema, the route tree)
gen:
	$(MAKE) -C server api config
	cd ui && pnpm gen:api && pnpm gen:argo && pnpm exec tsr generate

## ui: build the SPA into server/web/dist
ui:
	cd ui && pnpm install --frozen-lockfile && pnpm build

## server: build the single binary (embeds whatever is in server/web/dist)
server:
	$(MAKE) -C server build

## build: UI first, then the binary that embeds it
build: ui server

## dev-server: run the API with the defaults plus server/configs/local (cp server/configs/local.example.yaml server/configs/local/config.yaml first)
dev-server:
	cd server && go run ./cmd server

## dev-ui: Vite dev server on :5173, proxying /api to dev-server
dev-ui:
	cd ui && pnpm dev

test:
	$(MAKE) -C server test
	cd ui && pnpm test

## e2e: Playwright smoke tests against a running server (default http://localhost:4100) and its cluster
e2e:
	cd ui && pnpm e2e

lint:
	$(MAKE) -C server lint
	cd ui && pnpm typecheck && pnpm lint

image:
	docker build -t argonaut:dev .
