.PHONY: up down db test check

up: ## Start Postgres, run migrations and start the API
	docker compose up --build

down: ## Stop the stack and delete its data
	docker compose down --volumes

db: ## Start only Postgres, for running tests locally
	docker compose up -d postgres
	docker compose exec postgres psql -U ledger -d ledger -tc \
	  "SELECT 1 FROM pg_database WHERE datname = 'ledger_test'" | grep -q 1 || \
	  docker compose exec postgres createdb -U ledger ledger_test

test: ## Run the whole test suite (needs `make db`)
	pnpm test

check: ## Everything CI runs
	pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
