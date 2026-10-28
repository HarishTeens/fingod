# The deployable artifact: one static Go binary with the React build embedded.
# Serves the SPA at / and the JSON API at /api/v1, so there is no CORS in
# production and a future mobile client hits identical routes.

# --- 1. build the UI -------------------------------------------------------
FROM node:24-alpine AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- 2. build the API, embedding the UI ------------------------------------
FROM golang:1.24-alpine AS api
WORKDIR /src
COPY api/go.mod api/go.sum ./
RUN go mod download
COPY api/ ./
# go:embed cannot reach outside the module, so the UI lands inside it.
COPY --from=web /web/dist ./internal/httpapi/webdist
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /fingod ./cmd/fingod

# --- 3. runtime ------------------------------------------------------------
FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata \
 && adduser -D -u 10001 fingod
ENV TZ=Asia/Kolkata
USER fingod
COPY --from=api /fingod /fingod
EXPOSE 8080
ENTRYPOINT ["/fingod"]
