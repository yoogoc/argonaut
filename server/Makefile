.PHONY: migrate
migrate:
	go run ./cmd migrate up -c ./configs --dir ./db/migration

.PHONY: rollup
rollup:
	go run ./cmd migrate down -c ./configs --dir ./db/migration

.PHONY: wire
wire:
	cd cmd && go run -mod=mod github.com/google/wire/cmd/wire

# Protos are compiled with buf rather than protoc: buf bundles its own compiler, so a broken or
# mismatched system protoc cannot break code generation.
.PHONY: config
config:
	buf generate --path internal/conf

.PHONY: api
api:
	buf generate --path api

.PHONY: build
build:
	go build -o bin/argonaut ./cmd/

.PHONY: linux-build
linux-build:
	GOOS=linux GOARCH=amd64 go build -o bin/argonaut ./cmd/

.PHONY: test
test:
	go test ./...

.PHONY: lint
lint:
	go vet ./...
