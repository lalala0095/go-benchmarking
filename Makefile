# Go vs FastAPI ADK bench — see README.md and docs/.
SHELL := /bin/bash
.DEFAULT_GOAL := help
COMPOSE := docker compose
BENCH_COMPOSE := docker compose -f docker-compose.yml -f docker-compose.bench.yml
GIT_SHA := $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)
export GIT_SHA
OVERLAY ?= dev
REGISTRY ?= localhost:5000
TAG ?= $(GIT_SHA)

.PHONY: help
help: ## List targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n",$$1,$$2}'

## ── Compose ────────────────────────────────────────────────────────────
.PHONY: env up up-bench down logs ps reset-db corpus fixtures
env: ## Create .env from .env.example if missing
	@test -f .env || (cp .env.example .env && chmod 600 .env && echo "created .env — add GOOGLE_API_KEY")

up: env ## Build and start the stack (dev)
	$(COMPOSE) up -d --build

up-bench: env ## Start with CPU pinning (official numbers, Linux only)
	$(BENCH_COMPOSE) up -d --build

down: ## Stop the stack
	$(COMPOSE) down

logs: ## Follow logs (SVC=go-server to filter)
	$(COMPOSE) logs -f $(SVC)

ps: ## Show service status
	$(COMPOSE) ps

reset-db: ## Wipe the Postgres volume (init scripts re-run on next up)
	$(COMPOSE) down -v

corpus: ## Refresh the default RAG corpus from docs/
	mkdir -p corpus/docs && cp docs/*.md corpus/docs/

fixtures: ## Regenerate parity fixtures from the reference implementation
	python3 contracts/tools/reference.py generate

## ── Tests (all run in containers) ──────────────────────────────────────
.PHONY: test test-go test-py test-dash test-contract bench-smoke
test: test-go test-py test-dash ## Unit tests for all services

test-go: ## Go unit tests
	docker build -f go-server/Dockerfile --target test .

test-py: ## Python unit tests
	docker build -f fastapi-server/Dockerfile --target test .

test-dash: ## Dashboard unit tests
	docker build -f dashboard/Dockerfile --target test .

test-contract: ## Parity/contract suite against the running stack (make up first)
	docker run --rm --network go-benchmarking_default \
	  -v "$(CURDIR)/contracts:/contracts" -w /contracts/tests \
	  -e GO_URL=http://go-server:8080 -e PY_URL=http://fastapi-server:8080 \
	  node:22-alpine sh -c "npm ci --no-audit --no-fund && npm test"

bench-smoke: ## Short end-to-end benchmark via the dashboard API
	./scripts/bench-smoke.sh

## ── Ubuntu host ────────────────────────────────────────────────────────
.PHONY: setup-host tune-host untune-host
setup-host: ## One-time Ubuntu 24.04 setup (Docker Engine, k3s, tools)
	./scripts/ubuntu-setup.sh

tune-host: ## Benchmark quiet mode
	./scripts/ubuntu-tune.sh

untune-host: ## Revert quiet mode
	./scripts/ubuntu-tune.sh --revert

## ── Kubernetes (k3s) ── see docs/07-KUBERNETES.md ───────────────────────
.PHONY: registry-up images k8s-sync k8s-secrets k8s-up k8s-down k8s-status k8s-open k8s-logs k8s-reset-db mode-compose mode-k8s
registry-up: ## Local image registry on 127.0.0.1:5000
	./deploy/k8s/scripts/registry-up.sh

images: ## Build + push images to the local registry (TAG=git sha)
	REGISTRY=$(REGISTRY) TAG=$(TAG) ./deploy/k8s/scripts/images.sh

k8s-sync: ## Copy db/init, corpus into the kustomize generated/ dir
	./deploy/k8s/scripts/sync.sh

k8s-secrets: ## Create Secrets from .env (never committed)
	./deploy/k8s/scripts/secrets.sh

k8s-up: k8s-sync k8s-secrets ## Apply overlay (OVERLAY=dev|bench|scale)
	REGISTRY=$(REGISTRY) TAG=$(TAG) OVERLAY=$(OVERLAY) ./deploy/k8s/scripts/apply.sh

k8s-down: ## Delete the bench namespace
	kubectl delete namespace bench --ignore-not-found

k8s-status: ## Pods, services, HPA in the bench namespace
	kubectl -n bench get pods,svc,hpa,pvc -o wide

k8s-open: ## Port-forward the dashboard to http://localhost:8080
	kubectl -n kube-system port-forward svc/traefik 8080:80

k8s-logs: ## Logs (SVC=go-server)
	kubectl -n bench logs -f deploy/$(SVC) --all-containers

k8s-reset-db: ## Delete the Postgres StatefulSet + PVC
	./deploy/k8s/scripts/reset-db.sh

mode-compose: ## Stop k3s, start Compose
	./deploy/k8s/scripts/mode.sh compose

mode-k8s: ## Stop Compose, start k3s + deploy (OVERLAY=...)
	OVERLAY=$(OVERLAY) ./deploy/k8s/scripts/mode.sh k8s
