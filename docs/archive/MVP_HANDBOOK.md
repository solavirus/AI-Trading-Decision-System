# MVP Handbook
Version: v1.0
Status: Frozen
Project: Quant Decision System

---

# Project Vision

This is NOT another trading terminal.

This is NOT TradingView.

This is NOT CoinGlass.

This is NOT Bloomberg.

The goal of this product is:

> Build a decision workflow that helps users continuously improve their own trading decision model.

The core asset of this system is NOT market data.

The core asset is:

**Decision Weight Model**

Every trade is an experiment.

Every experiment improves the user's decision model.

---

# Current Development Stage

Current target:

High Fidelity Interactive Prototype

NOT:

- Backend
- Database
- AI API
- Exchange API
- Authentication

Everything uses mock data.

The goal is ONLY to validate the workflow.

---

# Core Workflow

Dashboard

↓

New Trade Experiment

↓

Research Input

↓

AI Strategy

↓

Execution

↓

Trade List

↓

Trade Detail

This workflow is frozen.

Do NOT redesign it.

---

# Design Philosophy

## Principle 1

Each page has ONLY ONE responsibility.

Do not mix responsibilities.

---

## Principle 2

AI appears ONLY in Strategy.

Dashboard

NO AI.

Research

NO AI.

Execution

NO AI.

Trade List

NO AI.

Trade Detail

NO AI analysis.

---

## Principle 3

Dashboard is a Data Hub.

Research is an Input Configuration.

Strategy is AI Output.

Never mix them.

---

## Principle 4

Research is NOT for browsing information.

Research is ONLY for configuring inputs.

---

## Principle 5

Dashboard and Research use the SAME data sources.

Dashboard

Display Data Sources.

Research

Configure Data Source Weight.

One-to-one mapping.

---

## Principle 6

Prototype validates workflow.

Do NOT add extra features.

---

# Frozen Pages

---

## 00 Dashboard

Purpose

Display all available market data sources.

This page contains NO AI.

Modules

- Market
- Technical
- Macro
- News
- ETF Flow
- On-chain
- Sentiment
- Derivatives

Main Action

New Trade Experiment

Do NOT show:

- Trading strategy
- AI suggestion
- AI opinion

Only raw data.

---

## 01 Research Input

Purpose

Configure ONE analysis.

Modules

- Asset
- Timeframe
- Data Source Weight
- Additional Evidence
- Analyze

Important

Additional Evidence also has Weight.

Weight participates in the total 100%.

Examples

- Screenshot
- News
- Tweet
- User Opinion
- PDF

Everything contributes to the final analysis.

---

## 02 Strategy

Purpose

Display AI generated strategy.

Modules

- Strategy Summary
- Trading Plan
- Weight Contribution
- Strategy Reasoning
- Actions

AI ONLY exists here.

No market browsing.

No configuration.

---

## 03 Execution

Purpose

Record actual execution.

Execution Types

- Execute as AI
- Execute with Modification
- Cancel

Record

- Entry
- Stop Loss
- Take Profit
- Position
- Leverage
- Notes

---

## 04 Trade List

Purpose

Manage all trades.

Status

- Running
- Closed
- Cancelled

Each row opens

Trade Detail.

---

## 05 Trade Detail

Purpose

View the complete lifecycle of ONE trade.

Includes

- AI Strategy
- Execution
- Timeline
- Current Position
- Notes

Do NOT regenerate strategy.

Do NOT modify weight.

Read-only history.

---

# Dashboard Rules

Dashboard displays:

Raw Data ONLY.

NO AI.

Every Dashboard card corresponds to ONE configurable data source inside Research.

If a new data source is added:

Dashboard

+

Research Weight

must both be updated.

---

# Research Rules

Research is an Input Configuration page.

NOT a market analysis page.

Users configure:

- Weight
- Evidence
- Analysis scope

Click

Analyze

↓

Strategy

---

# Weight Rules

Weight is the core of the product.

All weights

=

100%

Including

Additional Evidence.

Future Learning will optimize Weight.

Current prototype does NOT implement learning.

---

# UI Style

Modern

Minimal

Professional

Large spacing

Card Layout

No information overload.

Every page should be readable within 30 seconds.

---

# Prototype Scope

Implement ONLY:

Dashboard

↓

Research

↓

Strategy

↓

Execution

↓

Trade List

↓

Trade Detail

Everything else is OUT OF SCOPE.

---

# Out Of Scope

Do NOT implement

- AI API
- Backend
- Database
- Login
- Exchange API
- Auto Trading
- Learning
- Weight Optimization
- Portfolio
- Backtest
- Notification
- Settings
- Admin Panel

Everything should be mocked.

---

# Interaction

All buttons should work.

Navigation should be complete.

Workflow should be smooth.

Use mock data.

No loading dead ends.

---

# Development Priority

Priority 1

Workflow

Priority 2

Interaction

Priority 3

Visual consistency

Priority 4

Animation

NOT

Business Logic

---

# IMPORTANT

Do NOT redesign the product.

Do NOT introduce new pages.

Do NOT change the information architecture.

If anything is unclear,

keep the current workflow.

Faithfully implement the frozen prototype into a clickable high-fidelity prototype using mock data only.

This document has the highest priority.

---

# Addendum — Analysis Snapshot Integrity (2026-08-07)

This section does not modify the frozen content above. It elaborates the single step this document already names under Research Rules:

Click Analyze ↓ Strategy

That single arrow is now governed by a separate Frozen Product Decision — Analysis Snapshot Integrity, recorded in full in `product-docs/PRODUCT_STATUS.md`. In short: real-time data is collected only after the user clicks Run Analysis, never reused from Dashboard's cache; only sources with configured weight greater than zero are collected; any required-source failure cancels the analysis rather than falling back to stale data; once every required source succeeds, exactly one immutable Analysis Payload is frozen and becomes the only input to Strategy.

This is documentation only — no code has been changed by this addendum. It does not add a page, does not change the Core Workflow's page sequence above, and does not touch any of the Design Philosophy principles. See `product-docs/PRODUCT_STATUS.md`'s "Analysis Lifecycle" section for the full decision text, and `PROJECT.md` for current implementation status.