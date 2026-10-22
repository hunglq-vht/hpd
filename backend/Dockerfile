# One builder, two tiny runtime images: `--target simulator` and `--target api`.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/simulator ./cmd/simulator && \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

FROM scratch AS simulator
COPY --from=build /out/simulator /simulator
USER 65534:65534
ENTRYPOINT ["/simulator"]

FROM scratch AS api
COPY --from=build /out/api /api
USER 65534:65534
EXPOSE 8090
ENTRYPOINT ["/api"]
