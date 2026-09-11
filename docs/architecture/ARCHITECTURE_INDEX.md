# Architecture Index

Navigation only — not a spec. See `EXECUTION_SPEC.md`/`PROJECT.md` for behavior contracts. All frontend items are in `prototype/index.html` (single file); line numbers drift as the file grows, so functions are named, not line-numbered.

## AI / Strategy
- `resolveScenarioPlan(analysisId, scenarioPlanId)` — reads immutable `AIResponseRecord.scenarioPlans`
- `AI_RESPONSE_SPEC.md` — `ScenarioPlan` contract (entry/stopLoss/takeProfit/triggerStructured/invalidation/reviewHorizon)
- Strategy render: `renderStrategyPage()` area (`/* Sprint 3.3A: Strategy Integration */`)

## Execution
- `ExecutionDraft` model + `MANUAL`/`NOTIFY` modes: `createOrReuseExecutionDraft()`, `effectiveExecutionPlan()`, `confirmExecutionDraft()`
- Trigger Monitor (frontend, browser-timer, existing/unchanged): `evaluateTrigger()`, `isConditionMet()`, `evalOperator()`, `runTriggerMonitorTick()`, `startTriggerMonitorLoop()` (`/* Sprint 3.4B */`)
- Numeric readiness gate: `evaluateScenarioExecutionReadiness()`

## Risk Guard
- Pure rules: `evaluateMaxNotional/MaxLeverage/StopLoss/ActiveTrades/SameSymbolConflict/MarketFreshness/AccountBalance/ExchangePositionConflict/ExistingPositionProtection()`, aggregator `evaluateRiskGuard()`
- Context building (impure): `buildRiskContext()`, `buildAccountRiskContext()`, `resolveRiskExchangeConnectionId()`
- Entry point: `runRiskGuardForOrder(executionId)` — writes `order.riskGuard`
- **3.6B addition**: backend port for MONITORED_AUTO — `pipeline/src/strategy/riskGuardCore.ts`

## Exchange
- Types: `pipeline/src/exchange/types.ts` (`ExchangeAccount`, `ExchangeConnection`, snapshots)
- Adapter (real Binance calls): `pipeline/src/exchange/binanceFuturesAdapter.ts`
- Service layer (connection resolution + TESTNET guard): `pipeline/src/exchange/exchangeService.ts`
- Account store: `pipeline/src/exchange/exchangeAccountStore.ts` (`ensureAccountsBootstrapped`, startup-only since 3.6A.2.1)
- Connection store: `pipeline/src/exchange/exchangeConnectionStore.ts`
- Signing: `pipeline/src/exchange/binanceSign.ts`; sizing: `pipeline/src/exchange/orderSizing.ts`
- SSE (account/order events): `pipeline/src/exchange/userDataStreamManager.ts` → `subscribeUserDataStream()`, frontend `startAccountEventStream()`

## Orders
- `RealOrder` (browser localStorage, `qa_orders`): `saveRealOrder/loadRealOrders/getRealOrderById`
- Submission: `submitRealOrderToTestnet()` (frontend) → `resolveConnectionForRealOrder()` → `POST /api/exchange/connections/:id/orders` → `exchangeService.resolveAndSubmitEntryOrder()` → `binanceFuturesAdapter.resolveAndSubmitEntryOrder/submitBinanceFuturesEntryOrder()`
- Cancel: `cancelRealOrderOnTestnet()` → `DELETE /api/exchange/connections/:id/orders/:id` → `cancelBinanceFuturesTestnetOrder()`
- Sync: `syncRealOrderFromExchange()`, `syncOrderAndPositionForTrade()`

## Positions
- `RealPosition` (`qa_positions`): `syncPositionsFromExchange(connectionId)` — the one create/dedup path, account-scoped since 3.6A.2
- Rendering lookup (best-effort, account-first since 3.6A.2.1): `findLocalPositionForAccount()`, `findPositionByExchangeAccountIdentity()`, `findPositionByExchangeIdentity()`

## Position Allocation
- `PositionAllocation` (`qa_position_allocations`): `reconcilePositionAllocations()`, `getPositionAllocationSummary()`
- Lifecycle (3.6A.1): `positionLifecycleId`, `isEntryFillAlreadyAllocated()`, `activeAllocationsForPosition()`

## Protection
- `reconcileTradeProtection(tradeId)` — auto SL/TP after real fill, TESTNET-only
- Algo cancel (3.6A.2 Phase C): `cancelAlgoOrderOnTestnet()` → `DELETE /api/exchange/connections/:id/algo-orders/:algoId`

## Account
- Account page: `renderAccountPage()`, `loadAccountPageData()`, `verifyAllAccountsCleanForReset()` (Data Management)
- Leverage sync (5th write): `openLeverageSyncConfirmationModal()` → `confirmLeverageSyncAndResubmit()` → `POST /api/exchange/connections/:id/leverage`

## Frontend routes
`#/dashboard #/research #/strategy #/execution/:id #/trades #/trades/:id #/account #/settings` — dispatch in `render()` (`/* Router */`)

## Backend routes
Full list printed at startup in `server.ts` (`console.log` block near `server.listen`). Exchange group: `/api/exchange/accounts`, `/api/exchange/connections[/:id[/test|account|order|orders|algo-orders|algo-order|leverage|stream]]`. Strategy group adds `/api/strategy/auto-risk-policy` (`GET`/`PUT`, 3.6B.1) and (3.7) `/api/strategy/autonomous-policy` (`GET`/`PUT`), `/api/strategy/autonomous-scheduler` (`GET`, read-only status), `/api/strategy/autonomous-cycles[/:id][?limit=]` (`GET`, read-only), `/api/strategy/autonomous-cycles/run-now` (`POST`, still fully gated). Market data (reusable in-process, no HTTP hop needed from backend code): `getSource('market')` + `parsePrices()` (price), `getMarketDetail(symbol,interval,limit)` (candles) — both already used by `/api/prices`/`/api/market/detail`.

## Real write functions (frozen count: 5)
1. `submitBinanceFuturesEntryOrder` — `POST /fapi/v1/order`
2. `cancelBinanceFuturesTestnetOrder` — `DELETE /fapi/v1/order`
3. `submitBinanceFuturesProtectionOrder` — `POST /fapi/v1/algoOrder`
4. `cancelBinanceFuturesProtectionOrder` — `DELETE /fapi/v1/algoOrder`
5. `changeBinanceFuturesLeverage` — `POST /fapi/v1/leverage`

**3.6B does not add a 6th.** `MONITORED_AUTO` is a new *caller* of function 1, orchestrated backend-side. **3.6B.1 doesn't either** — headless protection reconciliation calls function 3/4, remainder cancellation calls function 2, both verbatim. **3.6B.2 doesn't either** — orphan detection is a new, symbol-explicit *caller* of the existing read-only `GET /fapi/v1/openAlgoOrders` capability, no write of any kind. **3.6B.2.1 doesn't either** — the orphan-reconciliation retry loop is read-only, same capability, no cancel. **3.7 doesn't either** — `AUTONOMOUS` WAIT/OPEN submission is a new *caller* of function 1 via the identical `attemptAutoSubmission()` chain `MONITORED_AUTO` already uses.

## Relevant tests (scratchpad, session-only copies — see HANDOFF_README.md for the convention)
`v3_5a_risk_guard_test.js`, `v3_6a_1_lifecycle_test.js`, `v3_6a_2_account_*_test.*`, `v3_6a_2_phaseB/phaseC_test.js`, `v3_6a_2_1_account_scope_frontend_test.js`, `v3_6a_2_2_open_orders_truth_test.js`, `v3_4b_monitor_test.js` (existing Trigger Monitor, NOT touched this sprint), `v3_4c_order_trade_test.js`, `protection_*_test.*`, `cancel_*_test.*`, `v3_6b_1_headless_backend_test.ts`, `v3_6b_2_external_close_backend/frontend_test.*`, `v3_6b_2_1_orphan_protection_backend/frontend_test.*`, `v3_7_autonomous_backend/frontend_test.*`.

## 3.6B new modules (this sprint)
- `pipeline/src/strategy/types.ts` — `StrategyOrder`, `Trigger`, enums
- `pipeline/src/strategy/strategyOrderStore.ts` — backend-persisted CRUD (`data/strategy_orders.json`)
- `pipeline/src/strategy/triggerEngine.ts` — ported deterministic evaluator (backend copy of `evaluateTrigger`/`isConditionMet`/`evalOperator`, same semantics)
- `pipeline/src/strategy/capabilityRouter.ts` — EXCHANGE_NATIVE / APP_MONITORED / UNSUPPORTED
- `pipeline/src/strategy/executionGuard.ts` — deterministic price-deviation guard
- `pipeline/src/strategy/riskGuardCore.ts` — backend port of the 9 Risk Guard rules for the AUTO path
- `pipeline/src/strategy/monitorEngine.ts` — backend tick loop, owns ARMED strategy evaluation + AUTO submission orchestration
- `pipeline/src/strategy/auditLogStore.ts` — append-only audit trail (`data/strategy_audit_log.json`)
- `pipeline/src/strategy/killSwitch.ts` — `data/strategy_kill_switch.json`, `MONITORED_AUTO_ENABLED`/`MONITORED_AUTO_PAUSED`

## 3.6B.1 new modules (Headless AUTO Safety Closure) — see EXECUTION_SPEC.md's "Headless AUTO Execution" section for the full contract
- `pipeline/src/strategy/autoRiskPolicyStore.ts` — backend-persisted AUTO Risk Policy (`data/strategy_auto_risk_policy.json`), TESTNET-only, fails closed
- `pipeline/src/strategy/autoRiskPolicyCore.ts` — pure evaluator `evaluateAutoRiskPolicy()`, `calculateMaxRiskPerTrade()`
- `pipeline/src/strategy/orderReconciliation.ts` — real order-status → `StrategyOrder.execution` sync, `syncStrategyOrderExecutionState()`
- `pipeline/src/strategy/protectionReconciliation.ts` — headless port of `reconcileTradeProtection()`'s decision logic, `reconcileStrategyOrderProtection()`
- `monitorEngine.ts` additions: `progressStrategyOrderPostSubmission()` (headless post-fill lifecycle), `cancelRemainderIfExpired()` (partial-fill expiry)
- `capabilityRouter.ts`: `routeTriggerCapability()` gained a `direction` param + price-level/direction-match checks (bugfix, see EXECUTION_SPEC.md)

## 3.6B.2 changes (External Position Closure Reconciliation) — see EXECUTION_SPEC.md's own section for the full contract
- `monitorEngine.ts`: `detectExternalPositionClose()` — new, runs every tick for `POSITION_ACTIVE` orders + at `recoverOnStartup()`; completes `StrategyOrder` when real quantity hits zero
- `binanceFuturesAdapter.ts#getProtectiveOrdersForSymbol()` / `exchangeService.ts#fetchProtectiveOrdersForSymbol()` — new, symbol-explicit protective-order read (reuses `GET /fapi/v1/openAlgoOrders`, bypasses the account snapshot's own zero-position scoping)
- `autoRiskPolicyCore.ts`: `symbol_allowed` check now canonical-normalized (bugfix, `toBinanceFuturesSymbol()`)
- `prototype/index.html#syncPositionsFromExchange()`: CLOSED-transition branch additionally completes linked `RealTrade`(s) via `activeAllocationsForPosition()` — `closeSource:'EXTERNAL'`
- `prototype/index.html#renderRealTradeDetail()`: fixed a real crash (`rt.executionIds` unguarded) for any Trade with no `ExecutionDraft` lineage (every MONITORED_AUTO Trade)

## 3.6B.2.1 changes (Orphaned Protection Reconciliation Hotfix) — see EXECUTION_SPEC.md's own section for the full contract
- `types.ts`: `StrategyOrder.execution` gains `postCloseProtectionState` (`null|PENDING|ORPHANED_PROTECTION|CONFIRMED_NONE|READ_FAILED`) — a dimension deliberately separate from `protectionStatus`, which is now frozen the instant `status` becomes `COMPLETED`
- `monitorEngine.ts`: `detectExternalPositionClose()` no longer touches `protectionStatus` on close (Section 3's "don't overload PROTECTED"); new `reconcileClosedPositionProtection()` — runs every tick + `recoverOnStartup()` for any `COMPLETED`-via-`EXTERNAL_POSITION_CLOSE` order not yet at `CONFIRMED_NONE`, requires two consecutive clean reads before finalizing, self-heals from `ORPHANED_PROTECTION`
- `prototype/index.html#renderStrategyOrderProtectionRow()` / `renderRealTradeDetail()`: current vs historical protection now rendered from the two separate backend fields, never one field read two ways; new `POST_CLOSE_PROTECTION_LABEL`

## 3.7 new modules (Autonomous Trading V1) — see EXECUTION_SPEC.md's own section for the full contract
- `pipeline/src/strategy/autonomousPolicyStore.ts` — account-level permission (`autonomousEnabled`/`allowedSymbols`/`analysisIntervalHours`/`allowLong`/`allowShort`/`allowOpen`/limits), TESTNET-frozen, fail-closed defaults
- `pipeline/src/strategy/autonomousSchedulerStore.ts` — operational scheduler state (`nextRunAt`/`lastRunAt`/`lastSuccessfulRunAt`/`lastFailureReason`) + `computeSchedulerHealth()`
- `pipeline/src/strategy/autonomousCycleStore.ts` — `AutonomousCycle` records, `genAutonomousCycleId(symbol, scheduledAt, manual)` — the whole idempotency mechanism
- `pipeline/src/strategy/autonomousDecisionContract.ts` — `validateAutonomousDecision()`, the new narrow NO_ACTION/WAIT/OPEN schema (deliberately not a reuse of the frontend AI_RESPONSE_SPEC.md pipeline)
- `pipeline/src/strategy/autonomousPrompt.ts` — `buildAutonomousPromptText()`, business-data-only prompt (no credentials)
- `pipeline/src/strategy/autonomousScheduler.ts` — `runAutonomousCycleForSymbol()`/`runAutonomousSchedulerTick()`/`runManualAutonomousCycle()` — Pre-AI Gate, AI call via the existing `ai/engine.ts#runAIAnalysis()`, WAIT/OPEN handoff into `monitorEngine.ts`'s existing chain
- `monitorEngine.ts`: `attemptAutoSubmission()`'s authorization-mode check now accepts `'AUTONOMOUS'` alongside `'MONITORED_AUTO'`; new `triggerImmediateAutonomousSubmission()` (OPEN's immediate-submit path, honest audit reason distinct from EXCHANGE_NATIVE's); `resolvePreferredConnectionForAccount()` now exported for reuse
- `types.ts`: `ExecutionMode`/`authorization.mode` gain `'AUTONOMOUS'`; new `AutonomousDecision`/`AutonomousCycle` types; `execution.activeOrphanProtectionOrderIds` (orphan-count precision fix, Section 67)
- `ai/connectionStore.ts` / `ai/configStore.ts`: gained test-path overrides (`__setAiConnectionsPathForTesting`/`__setAiRoleConfigPathForTesting`) — previously untested-in-isolation, now safely isolatable
- `prototype/index.html`: new AUTO Control Center card on the Monitoring page (`renderAutoControlCenter()`); Trade List's `buildTradeListViewModel()` shared projection replaces scattered status logic (`renderRealTradeRow()`)
