# syntax=docker/dockerfile:1
# Build context = repo root:  docker build -f go-server/Dockerfile .
# Stages: deps -> test (make test-go) -> build -> runtime (distroless, non-root).

ARG GO_VERSION=1.26.6

FROM --platform=$BUILDPLATFORM golang:${GO_VERSION} AS deps
WORKDIR /src
COPY go-server/go.mod go-server/go.sum ./
RUN go mod download && go mod verify
COPY go-server/ ./
COPY contracts /contracts

FROM deps AS test
ENV CONTRACTS_DIR=/contracts
RUN --mount=type=cache,target=/root/.cache/go-build \
    go vet ./... && go test ./...

FROM deps AS build
ARG TARGETOS=linux
ARG TARGETARCH
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags "-s -w" -o /out/server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/server /app/server
COPY contracts /contracts
ENV PORT=8080 CONTRACTS_DIR=/contracts
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/app/server"]
