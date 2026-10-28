# fingod — dev commands. `make` alone lists them.
#
# Normal dev loop:  make up  →  make migrate  →  make api  (and make web in another shell)

SHELL := /bin/bash
.DEFAULT_GOAL := help
.PHONY: help env claude demo up up-tools up-all down nuke ps logs psql migrate migrate-status api web web-install web-smoke build test tidy import-tradebooks import-us-orders import-orders fetch-mf-navs import-prices

# .env is the single source of config for both compose and the native processes.
ifneq (,$(wildcard .env))
include .env
export
endif

COMPOSE  := docker compose
MIGDIR   := api/migrations
PSQL     := $(COMPOSE) exec -T db psql -v ON_ERROR_STOP=1 -U $(POSTGRES_USER) -d $(POSTGRES_DB)

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2}'

env: ## Create .env with freshly generated secrets (refuses to clobber)
	@test ! -f .env || { echo ".env already exists — delete it first if you really mean this"; exit 1; }
	@sed -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$$(openssl rand -hex 24)|" \
		    -e "s|^FINGOD_API_TOKEN=.*|FINGOD_API_TOKEN=$$(openssl rand -hex 32)|" .env.example > .env
	@chmod 600 .env && echo "wrote .env — now fix FINGOD_DB_URL to match POSTGRES_PASSWORD"

up: ## Start Postgres (the normal dev loop)
	@$(COMPOSE) up -d db
	@$(COMPOSE) ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}'

up-tools: ## Start Postgres + Adminer on :8081
	@$(COMPOSE) --profile tools up -d
	@echo "adminer → http://localhost:$(ADMINER_PORT)  (server: db, user: $(POSTGRES_USER))"

up-all: ## Start the full stack including the packaged api image
	@$(COMPOSE) --profile full --profile tools up -d --build

down: ## Stop everything (data survives)
	@$(COMPOSE) --profile tools --profile full down

nuke: ## Stop everything AND delete the database volume
	@read -p "This destroys all fingod data. Type 'yes': " a; [ "$$a" = yes ] || exit 1
	@$(COMPOSE) --profile tools --profile full down -v

ps: ## Show container status
	@$(COMPOSE) ps

logs: ## Tail logs
	@$(COMPOSE) logs -f --tail=100

psql: ## Open a psql shell
	@$(COMPOSE) exec db psql -U $(POSTGRES_USER) -d $(POSTGRES_DB)

migrate: ## Apply any unapplied migrations in api/migrations
	@$(PSQL) -c "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());" >/dev/null
	@for f in $(MIGDIR)/*.sql; do \
		v=$$(basename $$f .sql); \
		n=$$($(PSQL) -tAc "SELECT count(*) FROM schema_migrations WHERE version='$$v'"); \
		if [ "$$n" = "0" ]; then \
		  echo "  applying $$v"; \
		  $(PSQL) < $$f >/dev/null || exit 1; \
		  $(PSQL) -c "INSERT INTO schema_migrations (version) VALUES ('$$v');" >/dev/null; \
		else echo "  skip     $$v (already applied)"; fi; \
	done
	@echo "migrations up to date"

migrate-status: ## List applied migrations
	@$(PSQL) -c "SELECT version, applied_at FROM schema_migrations ORDER BY version;"

api: ## Run the Go API natively with hot-ish reload
	@cd api && go run ./cmd/fingod

# Vite 7 needs Node >= 20.19 (see .nvmrc). If your default `node` is older, point
# NODE_BIN at a newer install: make web NODE_BIN=$$HOME/.nvm/versions/node/v24.0.0/bin
NODE_BIN ?=
NODE_PATH_PREFIX = $(if $(NODE_BIN),$(NODE_BIN):)

web: ## Run the Vite dev server on :5173 (proxies /api to :8080 with the token)
	@cd web && PATH="$(NODE_PATH_PREFIX)$$PATH" npm run dev

web-install: ## Install web dependencies
	@cd web && PATH="$(NODE_PATH_PREFIX)$$PATH" npm install

web-smoke: ## Render every dashboard component against the live API
	@cd web && PATH="$(NODE_PATH_PREFIX)$$PATH" node scripts/smoke.mjs

build: ## Build the deployable single binary (UI embedded)
	@cd web && PATH="$(NODE_PATH_PREFIX)$$PATH" npm ci && PATH="$(NODE_PATH_PREFIX)$$PATH" npm run build
	@rm -rf api/internal/httpapi/webdist && mkdir -p api/internal/httpapi/webdist
	@cp -R web/dist/. api/internal/httpapi/webdist/
	@touch api/internal/httpapi/webdist/.gitkeep
	@cd api && go build -o bin/fingod ./cmd/fingod
	@echo "built api/bin/fingod (UI embedded)"

import-tradebooks: ## Seed realised P&L from broker tradebooks: make import-tradebooks EXPORTS="~/Downloads/..."
	@test -n "$(EXPORTS)" || { echo 'usage: make import-tradebooks EXPORTS="~/Downloads/<export dir>"'; exit 1; }
	@python3 scripts/import-tradebooks.py "$(EXPORTS)" $(ARGS)

# INDmoney exports a legacy OLE2 .xls, which needs xlrd 1.2.0 (2.x dropped .xls
# entirely). Rather than ask for a global install, bootstrap it into a throwaway
# venv the first time — a hand-rolled BIFF parser is not something a cost basis
# should depend on.
XLSVENV := .venv-xls

import-us-orders: ## Seed true USD+INR cost basis for US equity: make import-us-orders EXPORTS="~/Downloads/..."
	@test -n "$(EXPORTS)" || { echo 'usage: make import-us-orders EXPORTS="~/Downloads/<export dir>" [ARGS=--dry-run]'; exit 1; }
	@if python3 -c "import xlrd" 2>/dev/null; then PY=python3; else \
	   test -d $(XLSVENV) || { echo "  creating $(XLSVENV) (xlrd, for legacy .xls)"; \
	     python3 -m venv $(XLSVENV) >/dev/null && $(XLSVENV)/bin/pip -q install 'xlrd==1.2.0'; }; \
	   PY=$(XLSVENV)/bin/python; \
	 fi; \
	 $$PY scripts/import-us-orders.py "$(EXPORTS)" $(ARGS)

import-orders: ## Seed the full order tape (all asset classes): make import-orders EXPORTS="~/Downloads/..."
	@test -n "$(EXPORTS)" || { echo 'usage: make import-orders EXPORTS="~/Downloads/<export dir>" [ARGS=--dry-run]'; exit 1; }
	@if python3 -c "import xlrd" 2>/dev/null; then PY=python3; else \
	   test -d $(XLSVENV) || { echo "  creating $(XLSVENV) (xlrd, for legacy .xls)"; \
	     python3 -m venv $(XLSVENV) >/dev/null && $(XLSVENV)/bin/pip -q install 'xlrd==1.2.0'; }; \
	   PY=$(XLSVENV)/bin/python; \
	 fi; \
	 $$PY scripts/import-orders.py "$(EXPORTS)" $(ARGS)

fetch-mf-navs: ## Backfill mutual fund NAV history from AMFI (Kite has no MF history)
	@python3 scripts/fetch-mf-navs.py

import-prices: ## Load fetched daily bars: make import-prices FILE=bars.json
	@test -n "$(FILE)" || { echo 'usage: make import-prices FILE=bars.json'; exit 1; }
	@python3 scripts/import-prices.py "$(FILE)" $(ARGS)

demo: ## Run the dashboard on invented data — no accounts, database or API needed
	@cd web && PATH="$(NODE_PATH_PREFIX)$$PATH" bash -c 'trap "kill 0" EXIT; PORT=8099 node scripts/mock-api.mjs & FINGOD_API_TOKEN=demo FINGOD_API_ORIGIN=http://127.0.0.1:8099 npm run dev'

test: ## Run Go tests
	@cd api && go test ./... -count=1

tidy: ## Tidy Go modules
	@cd api && go mod tidy

claude: ## Launch Claude Code here with .env loaded (so the Wallet MCP token resolves)
	@set -a && . ./.env && set +a && claude
