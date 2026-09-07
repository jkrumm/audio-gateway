REPO         := $(shell pwd)
LABEL        := com.jkrumm.audio-gateway
LAUNCHD_DIR  := $(REPO)/launchd
LAUNCHAGENTS := $(HOME)/Library/LaunchAgents
PLIST        := $(LAUNCHAGENTS)/$(LABEL).plist
LOG          := $(HOME)/Library/Logs/audio-gateway.log
ERR          := $(HOME)/Library/Logs/audio-gateway.err

# ============================================================================
# LaunchAgent — the podcast-pipeline instance on :7719 (mini only). STT/TTS
# stays on the VPS container; this repo's Makefile only manages the mini's
# second instance. See docs/podcast-editorial-room.md §10.
# ============================================================================

.PHONY: launchd-install
launchd-install: ## Render the plist template (__HOME__ substituted) and (re)load com.jkrumm.audio-gateway
	@mkdir -p "$(LAUNCHAGENTS)"
	@sed "s|__HOME__|$(HOME)|g" "$(LAUNCHD_DIR)/$(LABEL).plist.template" > "$(PLIST)"
	@launchctl bootout "gui/$$(id -u)/$(LABEL)" 2>/dev/null || true
	@launchctl bootstrap "gui/$$(id -u)" "$(PLIST)"
	@echo "installed $(LABEL) -> $(PLIST)"

.PHONY: launchd-uninstall
deploy: ## Pull master and restart the LaunchAgent — refuses while a podcast job is running
	@busy=$$(curl -sf -H "Authorization: Bearer make" http://localhost:7719/v1/podcasts | /usr/bin/python3 -c 'import sys,json; j=json.load(sys.stdin)["jobs"]; print(sum(1 for x in j if x["status"] not in ("done","failed")))' 2>/dev/null || echo 0); \
	if [ "$$busy" != "0" ]; then echo "  ✗ $$busy podcast job(s) running — a restart would kill them (no resume). Retry later."; exit 1; fi; \
	git pull --ff-only && bun install --frozen-lockfile && $(MAKE) launchd-restart && sleep 2 && $(MAKE) launchd-status

launchd-uninstall: ## Unload and remove the LaunchAgent
	@launchctl bootout "gui/$$(id -u)/$(LABEL)" 2>/dev/null || true
	@rm -f "$(PLIST)"
	@echo "removed $(LABEL)"

.PHONY: launchd-status
launchd-status: ## Show LaunchAgent state + a live health check on :7719
	@launchctl print "gui/$$(id -u)/$(LABEL)" 2>&1 | head -n 40
	@echo ""
	@curl -s localhost:7719/health || echo "localhost:7719/health unreachable"

.PHONY: launchd-restart
launchd-restart: ## Kickstart (restart) the running LaunchAgent
	@launchctl kickstart -k "gui/$$(id -u)/$(LABEL)"

.PHONY: launchd-logs
launchd-logs: ## Tail both LaunchAgent logs (stdout + stderr)
	@tail -n 100 -f "$(LOG)" "$(ERR)"

# ============================================================================
# Data
# ============================================================================

.PHONY: seed-ledger
seed-ledger: ## Copy the VPS podcast job ledger + episode artifacts onto this machine (pass ARGS=--force to overwrite)
	@bun scripts/seed-ledger.ts $(ARGS)

# ============================================================================
# Validation
# ============================================================================

.PHONY: check
check: ## typecheck + test
	@bun run typecheck && bun test

# ============================================================================
# Help
# ============================================================================

.PHONY: help
help:
	@echo ""
	@echo "  audio-gateway"
	@echo ""
	@echo "  make check              typecheck + test"
	@echo ""
	@echo "  Mini podcast-pipeline instance (:7719) — see docs/podcast-editorial-room.md"
	@echo "  make launchd-install    Render the plist + (re)load com.jkrumm.audio-gateway"
	@echo "  make launchd-uninstall  Unload + remove the LaunchAgent"
	@echo "  make launchd-status     LaunchAgent state + curl localhost:7719/health"
	@echo "  make launchd-restart    Kickstart (restart) the running instance"
	@echo "  make launchd-logs       Tail ~/Library/Logs/audio-gateway.{log,err}"
	@echo "  make seed-ledger        Copy the VPS podcast ledger + episode dirs onto this machine"
	@echo ""

.DEFAULT_GOAL := help
