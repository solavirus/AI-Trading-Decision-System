# DATA_SOURCE_SPEC.md

Version: v1.0

Status: Frozen

Project: Quant Decision System

---

## Purpose

Defines the Dashboard data layer's architecture — the Connector → Normalize → Snapshot pattern every data source follows, and what every source must expose (Overview Card, Detail Page, Structured Data, Historical Charts).

## When To Read

Read this document when:
- Adding or modifying a Dashboard data source
- Building a new Detail Page
- Changing how a source is fetched, normalized, or stored

Do NOT read this document when:
- Working on Research, Analysis Payload, Prompt Builder, AI Engine, or Strategy
- Checking current per-source implementation status (see `PROJECT.md` instead)

---

# Goal

Redesign the Dashboard data layer.

The Dashboard should become a Data Hub.

Each card represents ONE data source.

Every data source has:

- Overview Card
- Detail Page
- Structured Data
- Historical Charts

The AI should NEVER consume raw API responses.

Everything must first become a structured Snapshot or Event.

---

# Current Data Sources

The system currently has the following modules.

## 1. Market

Purpose

Market price and trading activity.

Data

- Current Price
- 24H Change
- 24H Volume
- 24H Quote Volume
- High
- Low
- Best Bid
- Best Ask

Charts

- Candlestick
- Volume
- Volatility

Primary Source

Binance Spot REST API

---

## 2. Technical

Purpose

Technical indicators calculated locally.

Raw Source

Binance Kline

Indicators

- SMA
- EMA
- RSI
- MACD
- Bollinger Bands
- ATR
- ADX

Charts

- Moving Average
- RSI
- MACD
- ATR

Important

Indicators should NOT be requested from any API.

Always calculate locally.

---

## 3. Macro

Purpose

Global macro events.

Data

- CPI
- PPI
- FOMC
- Interest Rate
- GDP
- Employment

Charts

Timeline

Future calendar

Historical releases

---

## 4. News

Purpose

Market events.

Pipeline

RSS

↓

Article

↓

Deduplication

↓

Event

↓

Dashboard

Dashboard Card

Show only

- Event Count
- Latest Events
- Last Update

Detail Page

Show

- Event Timeline
- Event Categories
- Related Assets

Never display hundreds of articles.

Always aggregate into Events.

---

## 5. ETF Flow

Data

- Daily Inflow
- Daily Outflow
- Net Flow

Charts

- Daily Flow
- Weekly Flow
- Monthly Flow

---

## 6. On-chain

Data

- Exchange Inflow
- Exchange Outflow
- Whale Activity
- Active Addresses
- Network Fees

Charts

- Exchange Flow
- Whale History
- Address Growth

---

## 7. Sentiment

Data

- Fear & Greed
- Social Sentiment
- Market Confidence

Charts

- Fear & Greed History
- Sentiment Trend

---

## 8. Derivatives

Purpose

Derivative market information.

Data

Open Interest

Funding Rate

Global Long Short Ratio

Top Trader Account Ratio

Top Trader Position Ratio

Taker Buy Sell Ratio

Basis

Charts

OI History

Funding History

Long Short Ratio

Top Trader Ratio

Basis History

Primary Source

Binance Futures API

---

## 9. Stablecoin

Data

USDT Supply

USDC Supply

FDUSD Supply

Stablecoin Market Cap

Charts

Supply History

Dominance

Growth

---

## 10. Liquidation

Purpose

Liquidation Events

Primary Source

Binance Futures WebSocket

Future

OKX

Bybit

Bitget

Dashboard Card

Display

- 1H Liquidation
- 24H Liquidation
- Long Liquidation
- Short Liquidation
- Largest Liquidation

Charts

1H History

4H History

24H History

Asset Distribution

Exchange Distribution

Store

Liquidation Event

instead of raw websocket messages.

---

## 11. Options

Future Module

Data

- Put Call Ratio
- Implied Volatility
- Open Interest
- Max Pain

Current Status

Placeholder only.

No implementation required.

---

# Dashboard Rules

Every module has

Overview Card

↓

Detail Page

↓

Charts

↓

Structured Snapshot

No module should directly expose API responses.

---

# Data Model

Every datasource should be normalized.

Market Snapshot

Technical Snapshot

Macro Snapshot

News Event

ETF Snapshot

Onchain Snapshot

Sentiment Snapshot

Derivatives Snapshot

Stablecoin Snapshot

Liquidation Event

Every snapshot should include

timestamp

source

symbol

status

---

# Binance First Strategy

Current MVP should prioritize Binance.

Implement all available FREE Binance endpoints.

Market

Technical

Derivatives

Liquidation

These four modules should become production-ready.

---

# Binance APIs

Spot

- ticker/24hr
- klines
- depth
- trades
- aggTrades
- bookTicker

Futures

- openInterest
- fundingRate
- globalLongShortRatio
- topLongShortAccountRatio
- topLongShortPositionRatio
- takerBuySellRatio

WebSocket

- liquidation
- depth
- bookTicker

Do NOT call APIs directly from UI.

Build a Connector layer.

---

# Architecture

Binance API

↓

Connector

↓

Normalize

↓

Snapshot

↓

Dashboard

↓

Research

↓

AI

AI should only consume structured snapshots.

Never raw API responses.

---

# Detail Pages

Every Dashboard module should support

Overview

↓

Historical Charts

↓

Statistics

↓

Latest Updates

↓

Raw Values

Use charts whenever possible.

Avoid long text.

---

# Future Connectors

Current

Binance

RSS

Future

OKX

Bybit

CoinGlass

Glassnode

DefiLlama

TradingView

All connectors should implement the same interface.

Dashboard should never depend on a specific provider.

---

# Constraints

Do NOT redesign Dashboard.

Keep current cards.

Enhance each card by

adding

Detail Page

Charts

Historical Data

Snapshot Layer

Do NOT introduce AI into Dashboard.

Dashboard is a Data Hub only.

# Golden Rule

Every API endpoint should first become a reusable data object.

UI reads data objects.

Research reads data objects.

AI reads data objects.

Never allow UI or AI to directly depend on external APIs.
