# Trilha — common tasks.
# The compose file lives in infra/local/; these targets save repeating -f.

COMPOSE := docker compose -f infra/local/docker-compose.yml
API     := apps/api
MOBILE  := apps/mobile

.DEFAULT_GOAL := help
.PHONY: help up up-infra down clean logs ps api-install api-dev api-migrate api-test \
        api-test-integration api-check mobile-install mobile-run mobile-test mobile-check \
        openapi check

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

## ---- Infrastructure ----

up: ## Start postgres, redis and the API
	$(COMPOSE) up -d --build

up-infra: ## Start only postgres and redis (run the API from source)
	$(COMPOSE) up -d postgres redis

down: ## Stop everything, keeping data
	$(COMPOSE) down

clean: ## Stop everything and DELETE all local data volumes
	$(COMPOSE) down -v

logs: ## Follow logs from all services
	$(COMPOSE) logs -f

ps: ## Show service status
	$(COMPOSE) ps

## ---- API ----

api-install: ## Install API dependencies
	cd $(API) && npm ci

api-dev: ## Run the API in watch mode (needs `make up-infra`)
	cd $(API) && npm run start:dev

api-migrate: ## Apply database migrations
	cd $(API) && npm run build && npm run db:migrate

api-test: ## Run API unit tests
	cd $(API) && npm run test

api-test-integration: ## Run API integration tests (needs `make up-infra`)
	cd $(API) && npm run test:integration

api-check: ## Run every API quality gate
	cd $(API) && npm run format:check && npm run lint && npm run typecheck && npm run test && npm run build

openapi: ## Regenerate the OpenAPI contract
	cd $(API) && npm run build && npm run openapi:generate

## ---- Mobile ----

mobile-install: ## Resolve Flutter dependencies
	cd $(MOBILE) && flutter pub get

mobile-run: ## Run the app on the connected device
	cd $(MOBILE) && flutter run

mobile-test: ## Run Flutter tests
	cd $(MOBILE) && flutter test

mobile-check: ## Run every mobile quality gate
	cd $(MOBILE) && dart format --output=none --set-exit-if-changed lib test && flutter analyze && flutter test

## ---- Everything ----

check: api-check mobile-check ## Run all quality gates
